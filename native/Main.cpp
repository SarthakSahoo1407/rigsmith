// Rig: native audio engine (JUCE) + React UI in a web view. The UI owns the rig and sends it
// compiled (src/rig.ts compile()) to the engine (Engine.h).

#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_extra/juce_gui_extra.h>
#include "Engine.h"

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
        setSize (900, 640);
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

    void exportRig (const String& text, const String& name, WebBrowserComponent::NativeFunctionCompletion complete)
    {
        const auto start = File::getSpecialLocation (File::userDocumentsDirectory).getChildFile (File::createLegalFileName (name) + ".json");
        chooser = std::make_unique<FileChooser> ("Export rig", start, "*.json");
        chooser->launchAsync (FileBrowserComponent::saveMode | FileBrowserComponent::warnAboutOverwriting,
                              [text, complete] (const FileChooser& fc) {
                                  const auto f = fc.getResult();
                                  complete (f != File() && f.replaceWithText (text));
                              });
    }

    void importRig (WebBrowserComponent::NativeFunctionCompletion complete)
    {
        chooser = std::make_unique<FileChooser> ("Import rig", File::getSpecialLocation (File::userDocumentsDirectory), "*.json");
        chooser->launchAsync (FileBrowserComponent::openMode | FileBrowserComponent::canSelectFiles, [complete] (const FileChooser& fc) {
            const auto f = fc.getResult();
            // ponytail: 64 MB cap covers rigs with embedded IRs; stream it if rigs get bigger.
            complete (f.existsAsFile() && f.getSize() < 64 * 1024 * 1024 ? var (f.loadFileAsString()) : var());
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
        o->setProperty ("cpu", deviceManager.getCpuUsage());
        web.emitEventIfBrowserIsVisible ("meter", var (o));
        engine.collectGarbage();
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
    const String getApplicationName() override { return "Rig"; }
    const String getApplicationVersion() override { return "0.1.0"; }
    void initialise (const String&) override { window = std::make_unique<Window>(); }
    void shutdown() override { window = nullptr; }

private:
    struct Window : DocumentWindow
    {
        Window() : DocumentWindow ("Rig", Colours::black, allButtons)
        {
            setUsingNativeTitleBar (true);
            setContentOwned (new MainComponent(), true);
            setResizable (true, true);
            centreWithSize (getWidth(), getHeight());
            setVisible (true);
        }
        void closeButtonPressed() override { JUCEApplication::getInstance()->systemRequestedQuit(); }
    };
    std::unique_ptr<Window> window;
};

START_JUCE_APPLICATION (RigApp)
