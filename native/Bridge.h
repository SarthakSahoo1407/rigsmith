// Everything the React UI can ask of the native side, shared by the app (Main.cpp) and the plugin
// (Plugin.cpp). A Host supplies what differs between them: the audio device, CPU load, audio
// settings, and where the autosaved rig lives (a file for the app, the host's project for a plugin).

#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include "Engine.h"
#include "RigFile.h"
#include "Llm.h"
#include "Tone3000.h"
#include <mach/mach.h>

namespace rig
{
// Settings shared by the app and the plugin: volume, audio device, TONE3000 key and sign-in.
inline PropertiesFile& sharedSettings()
{
    static ApplicationProperties props;
    static const bool ready = [] {
        PropertiesFile::Options o;
        o.applicationName = "Rig";
        o.filenameSuffix = ".settings";
        o.osxLibrarySubFolder = "Application Support";
        props.setStorageParameters (o);
        return true;
    }();
    ignoreUnused (ready);
    return *props.getUserSettings();
}

struct Host
{
    virtual ~Host() = default;
    virtual void describeAudio (DynamicObject&) = 0; // device, inputs, sampleRate, bufferSize, inputMs, outputMs
    virtual double cpu() = 0;
    virtual double sampleRate() = 0;
    virtual void openAudioSettings() {}
    virtual bool isPlugin() const { return false; }
    // The plugin keeps its rig in the host's project instead of the shared autosave file.
    virtual std::optional<String> autosave() { return std::nullopt; }
    virtual void setAutosave (const String&) {}
    virtual void compiled (const var&) {} // the plugin saves what the engine plays, to play it before the UI opens
};

class Bridge : private Timer
{
public:
    Bridge (Engine& e, Host& h, PropertiesFile& s) : engine (e), host (h), settings (s), t3k (s), llm (s) {}
    ~Bridge() override { stopTimer(); }

    void attach (WebBrowserComponent& w)
    {
        web = &w;
        // RIG_DEV_URL=http://localhost:5173 loads the Vite dev server for hot reload.
        const auto devUrl = SystemStats::getEnvironmentVariable ("RIG_DEV_URL", {});
        w.goToURL (devUrl.isNotEmpty() ? devUrl : WebBrowserComponent::getResourceProviderRoot());
        startTimerHz (30);
    }
    void audioChanged() { emit ("state", state()); }

    WebBrowserComponent::Options options()
    {
        using Args = const Array<var>&;
        using Done = WebBrowserComponent::NativeFunctionCompletion;
        return WebBrowserComponent::Options {}
            .withNativeIntegrationEnabled()
            .withResourceProvider ([] (const String& url) { return serveUi (url); })
            .withNativeFunction ("getState", [this] (Args, Done done) { done (state()); })
            .withNativeFunction ("set", [this] (Args a, Done done) { set (a[0].toString(), a[1]); done ({}); })
            .withNativeFunction ("setRig", [this] (Args a, Done done) { engine.setRig (a[0]); host.compiled (a[0]); done ({}); })
            // Looper buttons: looper (deviceId, "main" | "stop" | "undo" | "clear").
            .withNativeFunction ("looper", [this] (Args a, Done done) {
                const auto it = engine.nodes().find (a[0].toString());
                if (auto* l = it != engine.nodes().end() ? dynamic_cast<Looper*> (it->second.get()) : nullptr)
                {
                    const auto cmd = a[1].toString();
                    l->command = cmd == "main" ? Looper::Main : cmd == "stop" ? Looper::Stop
                               : cmd == "undo" ? Looper::Undo : cmd == "clear" ? Looper::Clear : Looper::None;
                }
                done ({});
            })
            // Standalone tuner: tuner (open, inputChannel). While open, live events carry "__tuner": { hz }.
            .withNativeFunction ("tuner", [this] (Args a, Done done) {
                engine.tunerChannel = jmax (0, (int) a[1]);
                engine.tuning = (bool) a[0];
                done ({});
            })
            .withNativeFunction ("openAudioSettings", [this] (Args, Done done) { host.openAudioSettings(); done ({}); })
            .withNativeFunction ("openUrl", [] (Args a, Done done) {
                const URL u (a[0].toString());
                if (u.getScheme() == "https") u.launchInDefaultBrowser();
                done ({});
            })
            // Rig storage. The UI validates rig JSON (parseRig); this side only moves text.
            .withNativeFunction ("listRigs", [] (Args, Done done) { done (listRigs()); })
            .withNativeFunction ("loadRig", [this] (Args a, Done done) {
                if (a[0].toString() == "_autosave")
                    if (auto saved = host.autosave()) { done (*saved); return; }
                const auto f = rigFile (a[0]);
                done (f.existsAsFile() ? var (f.loadFileAsString()) : var());
            })
            .withNativeFunction ("saveRig", [this] (Args a, Done done) {
                if (a[0].toString() == "_autosave" && host.isPlugin()) { host.setAutosave (a[1].toString()); done (true); return; }
                done (rigFile (a[0]).replaceWithText (a[1].toString()));
            })
            .withNativeFunction ("deleteRig", [] (Args a, Done done) { done (rigFile (a[0]).deleteFile()); })
            .withNativeFunction ("exportRig", [this] (Args a, Done done) { exportRig (a[0].toString(), a[1].toString(), done); })
            .withNativeFunction ("importRig", [this] (Args, Done done) { importRig (done); })
            // The capture library (Library.h).
            .withNativeFunction ("library", [] (Args, Done done) { done (library::list()); })
            .withNativeFunction ("importLibrary", [this] (Args, Done done) { importLibrary (done); })
            .withNativeFunction ("deleteLibrary", [] (Args a, Done done) { done (library::remove (a[0].toString())); })
            // TONE3000 (Tone3000.h). Sign-in answers at once with the code to show; the result comes as a "t3k" event.
            .withNativeFunction ("t3kStatus", [this] (Args, Done done) { done (t3k.status()); })
            .withNativeFunction ("t3kSignIn", [this] (Args, Done done) { t3k.signIn (done, [this] (var r) { emit ("t3k", r); }); })
            .withNativeFunction ("t3kSignOut", [this] (Args, Done done) { t3k.signOut(); done (t3k.status()); })
            .withNativeFunction ("t3kSearch", [this] (Args a, Done done) { t3k.search (a[0], done); })
            .withNativeFunction ("t3kTone", [this] (Args a, Done done) { t3k.tone (a[0].toString(), done); })
            .withNativeFunction ("t3kModels", [this] (Args a, Done done) { t3k.models (a[0].toString(), done); })
            .withNativeFunction ("t3kDownload", [this] (Args a, Done done) { t3k.download (a[0], a[1], done); })
            // The text assistant (Llm.h): chat (request), the free models, and its status.
            .withNativeFunction ("llmStatus", [this] (Args, Done done) { done (llm.status()); })
            .withNativeFunction ("llmChat", [this] (Args a, Done done) { llm.chat (a[0], done); })
            .withNativeFunction ("llmModels", [this] (Args, Done done) { llm.freeModels (done); });
    }

private:
    Engine& engine;
    Host& host;
    PropertiesFile& settings;
    Tone3000 t3k;
    Llm llm;
    WebBrowserComponent* web = nullptr;
    std::unique_ptr<FileChooser> chooser;
    int ticks = 0;

    void emit (const Identifier& id, const var& payload) { if (web != nullptr) web->emitEventIfBrowserIsVisible (id, payload); }

    var state()
    {
        auto* o = new DynamicObject();
        o->setProperty ("volume", settings.getDoubleValue ("volume", 0.5));
        o->setProperty ("plugin", host.isPlugin());
        o->setProperty ("t3kKey", settings.getValue ("t3kKey").isNotEmpty());
        host.describeAudio (*o);
        return o;
    }

    void set (const String& key, const var& v)
    {
        if (key == "mute") engine.muted = (bool) v;
        if (key == "orKey") { settings.setValue ("orKey", v.toString().trim()); emit ("state", state()); }
        if (key == "orModel") settings.setValue ("orModel", v.toString().trim());
        if (key == "t3kKey") { settings.setValue ("t3kKey", v.toString().trim()); emit ("state", state()); }
        if (key == "volume")
        {
            const double vol = jlimit (0.0, 1.0, (double) v);
            engine.masterTarget = (float) vol;
            settings.setValue (key, vol);
        }
    }

    static File rigsDir()
    {
        auto d = File::getSpecialLocation (File::userApplicationDataDirectory).getChildFile ("Application Support/Rig/Rigs");
        d.createDirectory();
        return d;
    }

    // Names come from the UI: strip path characters so a name can't leave the folder.
    static File rigFile (const var& name)
    {
        return rigsDir().getChildFile (File::createLegalFileName (name.toString()).replace ("..", "_") + ".json");
    }

    static var listRigs()
    {
        StringArray names;
        for (const auto& f : rigsDir().findChildFiles (File::findFiles, false, "*.json"))
            names.add (f.getFileNameWithoutExtension());
        names.sortNatural();
        Array<var> out;
        for (const auto& n : names) out.add (n);
        return out;
    }

    // Exported rigs are encrypted .rigsmith files (RigFile.h).
    void exportRig (const String& text, const String& name, WebBrowserComponent::NativeFunctionCompletion done)
    {
        const auto start = File::getSpecialLocation (File::userDocumentsDirectory).getChildFile (File::createLegalFileName (name) + ".rigsmith");
        chooser = std::make_unique<FileChooser> ("Export rig", start, "*.rigsmith");
        chooser->launchAsync (FileBrowserComponent::saveMode | FileBrowserComponent::warnAboutOverwriting, [text, done] (const FileChooser& fc) {
            auto f = fc.getResult();
            if (f == File()) { done (false); return; }
            f = f.withFileExtension ("rigsmith");
            const auto data = rigfile::seal (text);
            done (! data.isEmpty() && f.replaceWithData (data.getData(), data.getSize()));
        });
    }

    // Opens a .rigsmith file, or an older plain .json rig. Returns the JSON, or { error } when the
    // file is damaged or isn't a rig, or null when the user cancels.
    void importRig (WebBrowserComponent::NativeFunctionCompletion done)
    {
        chooser = std::make_unique<FileChooser> ("Import rig", File::getSpecialLocation (File::userDocumentsDirectory), "*.rigsmith;*.json");
        chooser->launchAsync (FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles, [done] (const FileChooser& fc) {
            const auto f = fc.getResult();
            if (! f.existsAsFile()) { done (var()); return; }
            auto error = [&] (const String& why) { auto* o = new DynamicObject(); o->setProperty ("error", why); done (var (o)); };
            // ponytail: 64 MB cap covers rigs with embedded IRs; stream it if rigs get bigger.
            if (f.getSize() > 64 * 1024 * 1024) { error ("That file is too big to be a rig"); return; }
            MemoryBlock data;
            f.loadFileAsData (data);
            if (! rigfile::isRigFile (data)) { done (data.toString()); return; }
            if (auto json = rigfile::open (data)) done (*json);
            else error ("That .rigsmith file is damaged or was changed outside Rigsmith");
        });
    }

    void importLibrary (WebBrowserComponent::NativeFunctionCompletion done)
    {
        chooser = std::make_unique<FileChooser> ("Add NAM captures or IRs", File::getSpecialLocation (File::userMusicDirectory), "*.nam;*.wav;*.aif;*.aiff");
        chooser->launchAsync (FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles | FileBrowserComponent::canSelectMultipleItems,
                              [done] (const FileChooser& fc) { done (library::import (fc.getResults())); });
    }

    void timerCallback() override
    {
        auto* o = new DynamicObject();
        o->setProperty ("peak", engine.peak.exchange (0.0f));
        o->setProperty ("out", engine.outPeak.exchange (0.0f));
        o->setProperty ("cpu", host.cpu());
        o->setProperty ("ram", memoryMb());
        emit ("meter", var (o));
        engine.collectGarbage();
        if (++ticks % 3 == 0 || engine.tuning) // the tuner needle wants 30 updates a second
            emit ("live", live());
    }

    // What Activity Monitor shows as this process's memory (the web view runs in its own processes).
    static double memoryMb()
    {
        task_vm_info_data_t info {};
        mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
        if (task_info (mach_task_self(), TASK_VM_INFO, (task_info_t) &info, &count) != KERN_SUCCESS) return 0;
        return (double) info.phys_footprint / (1024.0 * 1024.0);
    }

    // Per-device readouts: tuner pitch, gate state, looper state, NAM capture problems.
    var live()
    {
        auto* o = new DynamicObject();
        if (engine.tuning)
        {
            auto* t = new DynamicObject();
            t->setProperty ("hz", engine.tuner.detect());
            o->setProperty ("__tuner", var (t));
        }
        for (const auto& [id, node] : engine.nodes())
        {
            auto* d = new DynamicObject();
            if (auto* t = dynamic_cast<Tuner*> (node.get()))
                d->setProperty ("hz", t->on ? t->detect() : 0.0f);
            else if (auto* g = dynamic_cast<Gate*> (node.get()))
                d->setProperty ("open", g->openOut.load());
            else if (auto* n = dynamic_cast<Nam*> (node.get()))
            {
                d->setProperty ("missing", n->missing.load());
                d->setProperty ("wrongRate", n->wrongRate.load());
            }
            else if (auto* l = dynamic_cast<Looper*> (node.get()))
            {
                static const char* modes[] = { "empty", "recording", "playing", "overdubbing", "stopped" };
                d->setProperty ("mode", modes[jlimit (0, 4, l->modeOut.load())]);
                d->setProperty ("length", l->lengthOut / host.sampleRate());
                d->setProperty ("position", l->positionOut / host.sampleRate());
            }
            else
            {
                delete d;
                continue;
            }
            o->setProperty (id, var (d));
        }
        return o;
    }

    // Serves the built React UI from <bundle>/Contents/Resources/ui (the app, or the plugin bundle).
    static std::optional<WebBrowserComponent::Resource> serveUi (const String& url)
    {
        static const File root = File::getSpecialLocation (File::currentExecutableFile).getParentDirectory().getSiblingFile ("Resources").getChildFile ("ui");
        const auto path = url == "/" ? String ("index.html") : url.fromFirstOccurrenceOf ("/", false, false).upToFirstOccurrenceOf ("?", false, false);
        const auto file = root.getChildFile (path);
        if (! file.isAChildOf (root) || ! file.existsAsFile())
            return std::nullopt;

        MemoryBlock mb;
        file.loadFileAsData (mb);
        const auto* bytes = static_cast<const std::byte*> (mb.getData());
        static const std::map<String, String> types { { "html", "text/html" }, { "js", "text/javascript" }, { "css", "text/css" },
                                                      { "svg", "image/svg+xml" }, { "png", "image/png" }, { "json", "application/json" } };
        const auto it = types.find (file.getFileExtension().substring (1).toLowerCase());
        return WebBrowserComponent::Resource { { bytes, bytes + mb.getSize() }, it != types.end() ? it->second : "application/octet-stream" };
    }
};
} // namespace rig
