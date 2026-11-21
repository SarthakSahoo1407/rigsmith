// The few things that differ between macOS and Windows: where the app keeps its files, and how much
// memory the process uses. Everything else is JUCE.

#pragma once
#include <juce_core/juce_core.h>

#if JUCE_MAC
 #include <mach/mach.h>
#elif JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #include <windows.h>
 #include <psapi.h>
 #pragma comment(lib, "psapi.lib")
#endif

namespace rig::platform
{
// ~/Library/Application Support/Rig on macOS, %APPDATA%\Rigsmith on Windows.
inline juce::File dataDir()
{
    const auto base = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory);
#if JUCE_MAC
    return base.getChildFile ("Application Support/Rig");
#else
    return base.getChildFile ("Rigsmith");
#endif
}

// This process's own memory in MB (the web view runs in its own processes and isn't counted).
inline double memoryMb()
{
#if JUCE_MAC
    task_vm_info_data_t info {};
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info (mach_task_self(), TASK_VM_INFO, (task_info_t) &info, &count) != KERN_SUCCESS) return 0;
    return (double) info.phys_footprint / (1024.0 * 1024.0);
#elif JUCE_WINDOWS
    PROCESS_MEMORY_COUNTERS_EX info {};
    if (! GetProcessMemoryInfo (GetCurrentProcess(), (PROCESS_MEMORY_COUNTERS*) &info, sizeof (info))) return 0;
    return (double) info.PrivateUsage / (1024.0 * 1024.0);
#else
    return 0;
#endif
}

// Where the built React UI is: <bundle>/Contents/Resources/ui for the macOS app and any plugin, a ui
// folder beside the program for the Windows app. The first that exists wins.
inline juce::File uiRoot()
{
    const auto exe = juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory();
    for (const auto& c : { exe.getSiblingFile ("Resources").getChildFile ("ui"), exe.getChildFile ("ui"), exe.getChildFile ("Resources").getChildFile ("ui") })
        if (c.isDirectory()) return c;
    return exe.getSiblingFile ("Resources").getChildFile ("ui");
}
} // namespace rig::platform
