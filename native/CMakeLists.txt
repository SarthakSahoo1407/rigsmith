cmake_minimum_required(VERSION 3.22)
project(Rig VERSION 0.1.0)
set(CMAKE_CXX_STANDARD 20)

include(FetchContent)
FetchContent_Declare(JUCE GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.15 GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

juce_add_gui_app(Rig
  PRODUCT_NAME "Rig"
  BUNDLE_ID com.multifx.rig
  MICROPHONE_PERMISSION_ENABLED TRUE
  MICROPHONE_PERMISSION_TEXT "Rig needs your audio interface input to hear your guitar.")

target_sources(Rig PRIVATE Main.cpp)
target_compile_definitions(Rig PRIVATE JUCE_WEB_BROWSER=1 JUCE_USE_CURL=0)
target_link_libraries(Rig
  PRIVATE juce::juce_audio_utils juce::juce_gui_extra juce::juce_dsp
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

# Offline engine check: renders rigs without an audio device and asserts on the output.
juce_add_console_app(RigCheck PRODUCT_NAME "RigCheck")
target_sources(RigCheck PRIVATE check.cpp)
target_compile_definitions(RigCheck PRIVATE JUCE_USE_CURL=0 JUCE_WEB_BROWSER=0)
target_link_libraries(RigCheck PRIVATE juce::juce_audio_devices juce::juce_dsp
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

# The React UI (npm run build → ../dist) ships inside the app bundle. Runs on every build,
# not only when the C++ relinks, and clears old hashed assets first.
add_custom_target(RigUi ALL
  COMMAND ${CMAKE_COMMAND} -E rm -rf $<TARGET_BUNDLE_CONTENT_DIR:Rig>/Resources/ui
  COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_SOURCE_DIR}/../dist $<TARGET_BUNDLE_CONTENT_DIR:Rig>/Resources/ui
  DEPENDS Rig)
