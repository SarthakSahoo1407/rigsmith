// Rigsmith: native audio engine (JUCE) + React UI in a web view. The UI owns the rig and sends it
// compiled (src/rig.ts compile()) to the engine (Engine.h).

#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include "Engine.h"
#include "RigFile.h"
#include <mach/mach.h>

using namespace juce;

class MainComponent : public Component, private Timer, private ChangeListener
{
public:
    MainComponent()
    {
        PropertiesFile::Options o;
        o.applicationName = "Rig";
        o.filenameSuffix = ".settings";
        o.osxLibrarySubFolder = "Application Support";
        props.setStorageParameters (o);

        auto* s = settings();
        engine.masterTarget = (float) s->getDoubleValue ("volume", 0.5);

        auto audioXml = s->getXmlValue ("audio");
        deviceManager.initialise (2, 2, audioXml.get(), true);
        deviceManager.addAudioCallback (&engine);
        deviceManager.addChangeListener (this);

        addAndMakeVisible (web);
        // RIG_DEV_URL=http://localhost:5173 loads the Vite dev server for hot reload.
        const auto devUrl = SystemStats::getEnvironmentVariable ("RIG_DEV_URL", {});
        web.goToURL (devUrl.isNotEmpty() ? devUrl : WebBrowserComponent::getResourceProviderRoot());

        startTimerHz (30);
        setSize (1440, 900);
    }

    ~MainComponent() override
    {
        deviceManager.removeChangeListener (this);
        deviceManager.removeAudioCallback (&engine);
    }

    void resized() override { web.setBounds (getLocalBounds()); }

private:
    ApplicationProperties props;
    AudioDeviceManager deviceManager;
    rig::Engine engine;
    WebBrowserComponent web { WebBrowserComponent::Options {}
        .withNativeIntegrationEnabled()
        .withResourceProvider ([] (const String& url) { return serveUi (url); })
        .withNativeFunction ("getState", [this] (const Array<var>&, auto complete) { complete (state()); })
        .withNativeFunction ("set", [this] (const Array<var>& a, auto complete) { set (a[0].toString(), a[1]); complete ({}); })
        .withNativeFunction ("setRig", [this] (const Array<var>& a, auto complete) { engine.setRig (a[0]); complete ({}); })
        // Looper buttons: looper (deviceId, "main" | "stop" | "undo" | "clear").
        .withNativeFunction ("looper", [this] (const Array<var>& a, auto complete) {
            const auto it = engine.nodes().find (a[0].toString());
            if (auto* l = it != engine.nodes().end() ? dynamic_cast<rig::Looper*> (it->second.get()) : nullptr)
            {
                const auto cmd = a[1].toString();
                l->command = cmd == "main" ? rig::Looper::Main : cmd == "stop" ? rig::Looper::Stop
                           : cmd == "undo" ? rig::Looper::Undo : cmd == "clear" ? rig::Looper::Clear : rig::Looper::None;
            }
            complete ({});
        })
        // Standalone tuner: tuner (open, inputChannel). While open, live events carry "tuner": hz.
        .withNativeFunction ("tuner", [this] (const Array<var>& a, auto complete) {
            engine.tunerChannel = jmax (0, (int) a[1]);
            engine.tuning = (bool) a[0];
            complete ({});
        })
        .withNativeFunction ("openAudioSettings", [this] (const Array<var>&, auto complete) { openAudioSettings(); complete ({}); })
        // Rig storage. The UI validates rig JSON (parseRig); this side only moves text.
        .withNativeFunction ("listRigs", [] (const Array<var>&, auto complete) { complete (listRigs()); })
        .withNativeFunction ("loadRig", [] (const Array<var>& a, auto complete) {
            const auto f = rigFile (a[0]);
            complete (f.existsAsFile() ? var (f.loadFileAsString()) : var());
        })
        .withNativeFunction ("saveRig", [] (const Array<var>& a, auto complete) { complete (rigFile (a[0]).replaceWithText (a[1].toString())); })
        .withNativeFunction ("deleteRig", [] (const Array<var>& a, auto complete) { complete (rigFile (a[0]).deleteFile()); })
        .withNativeFunction ("exportRig", [this] (const Array<var>& a, auto complete) { exportRig (a[0].toString(), a[1].toString(), complete); })
        .withNativeFunction ("importRig", [this] (const Array<var>&, auto complete) { importRig (complete); }) };

    std::unique_ptr<FileChooser> chooser;

    PropertiesFile* settings() { return props.getUserSettings(); }

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
        for (const auto& n : names)
            out.add (n);
        return out;
    }

    // Exported rigs are encrypted .rigsmith files (RigFile.h).
    void exportRig (const String& text, const String& name, WebBrowserComponent::NativeFunctionCompletion complete)
    {
        const auto start = File::getSpecialLocation (File::userDocumentsDirectory).getChildFile (File::createLegalFileName (name) + ".rigsmith");
        chooser = std::make_unique<FileChooser> ("Export rig", start, "*.rigsmith");
        chooser->launchAsync (FileBrowserComponent::saveMode | FileBrowserComponent::warnAboutOverwriting,
                              [text, complete] (const FileChooser& fc) {
                                  auto f = fc.getResult();
                                  if (f == File()) { complete (false); return; }
                                  f = f.withFileExtension ("rigsmith");
                                  const auto data = rigfile::seal (text);
                                  complete (! data.isEmpty() && f.replaceWithData (data.getData(), data.getSize()));
                              });
    }

    // Opens a .rigsmith file, or an older plain .json rig. Returns the JSON, or { error } when the
    // file is damaged or isn't a rig, or null when the user cancels.
    void importRig (WebBrowserComponent::NativeFunctionCompletion complete)
    {
        chooser = std::make_unique<FileChooser> ("Import rig", File::getSpecialLocation (File::userDocumentsDirectory), "*.rigsmith;*.json");
        chooser->launchAsync (FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles, [complete] (const FileChooser& fc) {
            const auto f = fc.getResult();
            if (! f.existsAsFile()) { complete (var()); return; }
            auto error = [&] (const String& why) { auto* o = new DynamicObject(); o->setProperty ("error", why); complete (var (o)); };
            // ponytail: 64 MB cap covers rigs with embedded IRs; stream it if rigs get bigger.
            if (f.getSize() > 64 * 1024 * 1024) { error ("That file is too big to be a rig"); return; }
            MemoryBlock data;
            f.loadFileAsData (data);
            if (! rigfile::isRigFile (data)) { complete (data.toString()); return; }
            if (auto json = rigfile::open (data)) complete (*json);
            else error ("That .rigsmith file is damaged or was changed outside Rigsmith");
        });
    }

    var state()
    {
        auto* o = new DynamicObject();
        auto* s = settings();
        o->setProperty ("volume", s->getDoubleValue ("volume", 0.5));

        if (auto* d = deviceManager.getCurrentAudioDevice())
        {
            Array<var> inputs;
            const auto names = d->getInputChannelNames();
            const auto active = d->getActiveInputChannels();
            for (int i = 0; i < names.size(); ++i)
                if (active[i])
                    inputs.add (names[i]);

            const double sr = d->getCurrentSampleRate();
            o->setProperty ("device", d->getName());
            o->setProperty ("inputs", inputs);
            o->setProperty ("sampleRate", sr);
            o->setProperty ("bufferSize", d->getCurrentBufferSizeSamples());
            // JUCE's CoreAudio latency already includes one buffer each way.
            o->setProperty ("inputMs", d->getInputLatencyInSamples() * 1000.0 / sr);
            o->setProperty ("outputMs", d->getOutputLatencyInSamples() * 1000.0 / sr);
        }
        return o;
    }

    void set (const String& key, const var& v)
    {
        if (key == "mute")
            engine.muted = (bool) v;
        if (key == "volume")
        {
            const double vol = jlimit (0.0, 1.0, (double) v);
            engine.masterTarget = (float) vol;
            settings()->setValue (key, vol);
        }
    }

    void openAudioSettings()
    {
        auto* selector = new AudioDeviceSelectorComponent (deviceManager, 1, 8, 2, 2, false, false, false, false);
        selector->setSize (520, 460);
        DialogWindow::LaunchOptions o;
        o.content.setOwned (selector);
        o.dialogTitle = "Audio Settings";
        o.useNativeTitleBar = true;
        o.resizable = false;
        o.launchAsync();
    }

    // Device, rate, buffer or channels changed: persist and tell the UI.
    void changeListenerCallback (ChangeBroadcaster*) override
    {
        if (auto xml = deviceManager.createStateXml())
            settings()->setValue ("audio", xml.get());
        web.emitEventIfBrowserIsVisible ("state", state());
    }

    void timerCallback() override
    {
        auto* o = new DynamicObject();
        o->setProperty ("peak", engine.peak.exchange (0.0f));
        o->setProperty ("out", engine.outPeak.exchange (0.0f));
        o->setProperty ("cpu", deviceManager.getCpuUsage());
        o->setProperty ("ram", memoryMb());
        web.emitEventIfBrowserIsVisible ("meter", var (o));
        engine.collectGarbage();
        if (++ticks % 3 == 0 || engine.tuning) // the tuner needle wants 30 updates a second
            web.emitEventIfBrowserIsVisible ("live", live());
    }

    int ticks = 0;

    // What Activity Monitor shows as this app's memory (the audio engine; the web view runs in its own processes).
    static double memoryMb()
    {
        task_vm_info_data_t info {};
        mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
        if (task_info (mach_task_self(), TASK_VM_INFO, (task_info_t) &info, &count) != KERN_SUCCESS) return 0;
        return (double) info.phys_footprint / (1024.0 * 1024.0);
    }

    // Tuner pitch and looper state, ten times a second: { deviceId: {hz} | {mode, length, position} }.
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
            if (auto* t = dynamic_cast<rig::Tuner*> (node.get()))
                d->setProperty ("hz", t->on ? t->detect() : 0.0f);
            else if (auto* g = dynamic_cast<rig::Gate*> (node.get()))
                d->setProperty ("open", g->openOut.load());
            else if (auto* l = dynamic_cast<rig::Looper*> (node.get()))
            {
                const auto sr = deviceManager.getCurrentAudioDevice() != nullptr ? deviceManager.getCurrentAudioDevice()->getCurrentSampleRate() : 48000.0;
                static const char* modes[] = { "empty", "recording", "playing", "overdubbing", "stopped" };
                d->setProperty ("mode", modes[jlimit (0, 4, l->modeOut.load())]);
                d->setProperty ("length", l->lengthOut / sr);
                d->setProperty ("position", l->positionOut / sr);
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

    // Serves the built React UI from Rig.app/Contents/Resources/ui.
    static std::optional<WebBrowserComponent::Resource> serveUi (const String& url)
    {
        static const File root = File::getSpecialLocation (File::currentApplicationFile).getChildFile ("Contents/Resources/ui");
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

class RigApp : public JUCEApplication
{
public:
    const String getApplicationName() override { return "Rigsmith"; }
    const String getApplicationVersion() override { return "0.1.0"; }
    void initialise (const String&) override { window = std::make_unique<Window>(); }
    void shutdown() override { window = nullptr; }

private:
    struct Window : DocumentWindow
    {
        Window() : DocumentWindow ("Rigsmith", Colours::black, allButtons)
        {
            setUsingNativeTitleBar (true);
            setContentOwned (new MainComponent(), true);
            setResizable (true, true);
            setResizeLimits (960, 600, 10000, 10000);
            centreWithSize (getWidth(), getHeight());
            setVisible (true);
        }
        void closeButtonPressed() override { JUCEApplication::getInstance()->systemRequestedQuit(); }
    };
    std::unique_ptr<Window> window;
};

START_JUCE_APPLICATION (RigApp)
