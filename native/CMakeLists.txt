cmake_minimum_required(VERSION 3.22)
project(Rig VERSION 0.1.0)
set(CMAKE_CXX_STANDARD 20)

include(FetchContent)
FetchContent_Declare(JUCE GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.15 GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

# Windows draws the UI with Edge WebView2, which JUCE links statically from Microsoft's NuGet package.
# Fetch it here so a plain `cmake` works without installing NuGet first. Skipped when
# JUCE_WEBVIEW2_PACKAGE_LOCATION already points at a copy.
if(WIN32 AND NOT JUCE_WEBVIEW2_PACKAGE_LOCATION)
  FetchContent_Declare(webview2
    URL https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.3485.44
    DOWNLOAD_NAME Microsoft.Web.WebView2.zip
    SOURCE_DIR ${CMAKE_BINARY_DIR}/webview2/Microsoft.Web.WebView2
    SOURCE_SUBDIR none)
  FetchContent_MakeAvailable(webview2)
  set(JUCE_WEBVIEW2_PACKAGE_LOCATION ${CMAKE_BINARY_DIR}/webview2 CACHE PATH "WebView2 NuGet package folder" FORCE)
endif()

# Neural Amp Modeler core (MIT) and Eigen (MPL2, header-only), compiled once into `nam`.
# SOURCE_SUBDIR points nowhere so their own CMake projects (tests, tools) aren't built.
FetchContent_Declare(namcore GIT_REPOSITORY https://github.com/sdatkinson/NeuralAmpModelerCore.git
  GIT_TAG d3189ed482ded880c128bf312941266c4fa5ceec GIT_SUBMODULES "" SOURCE_SUBDIR none)
FetchContent_Declare(eigen URL https://gitlab.com/libeigen/eigen/-/archive/bc3b39870ecb690a623a3f49149a358b95c5781d/eigen-bc3b39870ecb690a623a3f49149a358b95c5781d.tar.gz
  SOURCE_SUBDIR none DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(namcore eigen)
file(GLOB NAM_SOURCES ${namcore_SOURCE_DIR}/NAM/*.cpp ${namcore_SOURCE_DIR}/NAM/*/*.cpp)
# OBJECT, not STATIC: each model type registers itself from a static initialiser, which a static
# library would drop at link time ("No config parser registered").
add_library(nam OBJECT ${NAM_SOURCES})
target_include_directories(nam SYSTEM PUBLIC ${namcore_SOURCE_DIR} ${namcore_SOURCE_DIR}/NAM ${namcore_SOURCE_DIR}/Dependencies/nlohmann ${eigen_SOURCE_DIR})
target_compile_definitions(nam PUBLIC NAM_SAMPLE_FLOAT NAM_ENABLE_A2_FAST)
if(MSVC)
  target_compile_options(nam PRIVATE /w /O2 /bigobj /utf-8) # Eigen's templates overflow the default object size
  target_compile_definitions(nam PUBLIC _USE_MATH_DEFINES NOMINMAX)
else()
  target_compile_options(nam PRIVATE -w -O3)
endif()
set_target_properties(nam PROPERTIES POSITION_INDEPENDENT_CODE ON)
set(NAM_EXAMPLES ${namcore_SOURCE_DIR}/example_models)

juce_add_gui_app(Rig
  PRODUCT_NAME "Rigsmith"
  BUNDLE_ID com.multifx.rig
  ICON_BIG ${CMAKE_SOURCE_DIR}/icon.png
  MICROPHONE_PERMISSION_ENABLED TRUE
  MICROPHONE_PERMISSION_TEXT "Rigsmith needs your audio interface input to hear your guitar."
  NEEDS_WEBVIEW2 TRUE) # Windows draws the UI with Edge WebView2 (linked statically; ignored elsewhere)

target_sources(Rig PRIVATE Main.cpp)
target_compile_definitions(Rig PRIVATE JUCE_WEB_BROWSER=1 JUCE_USE_CURL=0 JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1)

# Low-latency audio on Windows needs ASIO. Steinberg's SDK can't be bundled: download it, then
# configure with -DRIG_ASIO_SDK=<path to the ASIO SDK folder>. Without it Windows uses WASAPI.
set(RIG_ASIO_SDK "" CACHE PATH "Steinberg ASIO SDK folder (Windows, optional)")
function(rig_enable_asio target)
  if(WIN32 AND RIG_ASIO_SDK)
    target_compile_definitions(${target} PRIVATE JUCE_ASIO=1)
    target_include_directories(${target} PRIVATE ${RIG_ASIO_SDK}/common)
  endif()
endfunction()
rig_enable_asio(Rig)
if(WIN32)
  target_link_libraries(Rig PRIVATE psapi bcrypt)
endif()
target_link_libraries(Rig
  PRIVATE nam juce::juce_audio_utils juce::juce_gui_extra juce::juce_dsp juce::juce_audio_formats
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

# Offline engine check: renders rigs without an audio device and asserts on the output.
juce_add_console_app(RigCheck PRODUCT_NAME "RigCheck")
target_sources(RigCheck PRIVATE check.cpp)
target_compile_definitions(RigCheck PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0 NAM_EXAMPLES="${NAM_EXAMPLES}")
target_link_libraries(RigCheck PRIVATE nam juce::juce_audio_devices juce::juce_audio_formats juce::juce_dsp
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

# The React UI (npm run build → ../dist) ships with the app: inside the bundle on macOS, in a ui folder
# beside Rigsmith.exe on Windows. Runs on every build, not only when the C++ relinks, and clears old
# hashed assets first. macOS bundles change after linking, so each is re-signed (ad hoc) or macOS and
# plugin hosts reject it.
if(APPLE)
  add_custom_target(RigUi ALL
    COMMAND ${CMAKE_COMMAND} -E rm -rf $<TARGET_BUNDLE_CONTENT_DIR:Rig>/Resources/ui
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/../dist $<TARGET_BUNDLE_CONTENT_DIR:Rig>/Resources/ui
    COMMAND codesign --force --deep -s - $<TARGET_BUNDLE_DIR:Rig>
    DEPENDS Rig)
else()
  add_custom_target(RigUi ALL
    COMMAND ${CMAKE_COMMAND} -E rm -rf $<TARGET_FILE_DIR:Rig>/ui
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/../dist $<TARGET_FILE_DIR:Rig>/ui
    DEPENDS Rig)
endif()

# The plugin: same engine and UI. AU and VST3 on macOS, VST3 on Windows. Built bundles get the UI; on
# macOS they're re-signed, then installed into ~/Library/Audio/Plug-Ins. On Windows the VST3 folder is
# left in the build tree to copy into C:/Program Files/Common Files/VST3 (that needs administrator rights).
if(APPLE)
  set(RIG_FORMATS AU VST3)
else()
  set(RIG_FORMATS VST3)
endif()
juce_add_plugin(RigPlugin
  PRODUCT_NAME "Rigsmith"
  COMPANY_NAME "Rigsmith"
  BUNDLE_ID com.multifx.rig.plugin
  PLUGIN_MANUFACTURER_CODE Rgsm
  PLUGIN_CODE Rgs2
  FORMATS ${RIG_FORMATS}
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  EDITOR_WANTS_KEYBOARD_FOCUS TRUE
  NEEDS_WEBVIEW2 TRUE
  ICON_BIG ${CMAKE_SOURCE_DIR}/icon.png
  AU_MAIN_TYPE kAudioUnitType_Effect
  VST3_CATEGORIES Fx Distortion)
target_sources(RigPlugin PRIVATE Plugin.cpp)
target_compile_definitions(RigPlugin PUBLIC JUCE_WEB_BROWSER=1 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0 JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1)
target_link_libraries(RigPlugin
  PRIVATE nam juce::juce_audio_utils juce::juce_gui_extra juce::juce_dsp juce::juce_audio_formats
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
if(WIN32)
  target_link_libraries(RigPlugin PRIVATE psapi bcrypt)
endif()
if(APPLE)
  set(PLUGINS "$ENV{HOME}/Library/Audio/Plug-Ins")
  add_custom_target(RigPluginInstall ALL
    COMMAND ${CMAKE_COMMAND} -E rm -rf $<TARGET_BUNDLE_CONTENT_DIR:RigPlugin_VST3>/Resources/ui $<TARGET_BUNDLE_CONTENT_DIR:RigPlugin_AU>/Resources/ui
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/../dist $<TARGET_BUNDLE_CONTENT_DIR:RigPlugin_VST3>/Resources/ui
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/../dist $<TARGET_BUNDLE_CONTENT_DIR:RigPlugin_AU>/Resources/ui
    COMMAND codesign --force --deep -s - $<TARGET_BUNDLE_DIR:RigPlugin_VST3>
    COMMAND codesign --force --deep -s - $<TARGET_BUNDLE_DIR:RigPlugin_AU>
    COMMAND ${CMAKE_COMMAND} -E rm -rf ${PLUGINS}/VST3/Rigsmith.vst3 ${PLUGINS}/Components/Rigsmith.component
    COMMAND ${CMAKE_COMMAND} -E copy_directory $<TARGET_BUNDLE_DIR:RigPlugin_VST3> ${PLUGINS}/VST3/Rigsmith.vst3
    COMMAND ${CMAKE_COMMAND} -E copy_directory $<TARGET_BUNDLE_DIR:RigPlugin_AU> ${PLUGINS}/Components/Rigsmith.component
    DEPENDS RigPlugin_VST3 RigPlugin_AU)
else()
  # The VST3 module sits in <bundle>/Contents/x86_64-win; the UI goes in <bundle>/Contents/Resources/ui.
  add_custom_target(RigPluginUi ALL
    COMMAND ${CMAKE_COMMAND} -E rm -rf $<TARGET_FILE_DIR:RigPlugin_VST3>/../Resources/ui
    COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/../dist $<TARGET_FILE_DIR:RigPlugin_VST3>/../Resources/ui
    DEPENDS RigPlugin_VST3)
endif()

# Offline renderer: plays a guitar part (synthesised or a DI .wav) through a compiled rig into a WAV.
juce_add_console_app(RigRender PRODUCT_NAME "RigRender")
target_sources(RigRender PRIVATE render.cpp)
target_compile_definitions(RigRender PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0)
target_link_libraries(RigRender PRIVATE nam juce::juce_audio_devices juce::juce_audio_formats juce::juce_dsp
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
