// Rig: native audio engine (JUCE) + React UI in a web view.
// Phase 1: guitar input channel → trim → master → safety limiter → all outputs.

#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_extra/juce_gui_extra.h>

using namespace juce;

// Safety limiter as a zero-latency soft clipper: linear below the knee, tanh above,
// never exceeds ±1.
static float softClip (float x)
{
    constexpr float k = 0.7f;
    const float a = std::abs (x);
    return a <= k ? x : std::copysign (k + (1.0f - k) * std::tanh ((a - k) / (1.0f - k)), x);
}

struct Engine : AudioIODeviceCallback
{
    // Written by the message thread, read by the audio thread.
    std::atomic<float> trimTarget { 1.0f }, masterTarget { 0.5f };
    std::atomic<int> channel { 0 };
    // Written by the audio thread, read and reset by the meter timer.
    std::atomic<float> peak { 0.0f };

    void audioDeviceAboutToStart (AudioIODevice* d) override
    {
        trim.reset (d->getCurrentSampleRate(), 0.02);
        master.reset (d->getCurrentSampleRate(), 0.02);
        trim.setCurrentAndTargetValue (trimTarget);
        master.setCurrentAndTargetValue (masterTarget);
    }

    void audioDeviceStopped() override {}

    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut,
                                           int n, const AudioIODeviceCallbackContext&) override
    {
        trim.setTargetValue (trimTarget);
        master.setTargetValue (masterTarget);
        const int ch = channel;
        const float* src = ch < numIn ? in[ch] : nullptr; // `in` holds only the enabled input channels
        float p = 0.0f;

        for (int i = 0; i < n; ++i)
        {
            const float x = src != nullptr ? src[i] * trim.getNextValue() : 0.0f;
            p = std::max (p, std::abs (x));
            const float y = softClip (x * master.getNextValue());
            for (int c = 0; c < numOut; ++c)
                if (out[c] != nullptr)
                    out[c][i] = y;
        }

        for (float prev = peak; p > prev && ! peak.compare_exchange_weak (prev, p);) {}
    }

private:
    SmoothedValue<float> trim, master;
};

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
        engine.trimTarget = Decibels::decibelsToGain ((float) s->getDoubleValue ("trimDb", 0.0));
        engine.masterTarget = (float) s->getDoubleValue ("volume", 0.5);
        engine.channel = s->getIntValue ("channel", 0);

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
    Engine engine;
    WebBrowserComponent web { WebBrowserComponent::Options {}
        .withNativeIntegrationEnabled()
        .withResourceProvider ([] (const String& url) { return serveUi (url); })
        .withNativeFunction ("getState", [this] (const Array<var>&, auto complete) { complete (state()); })
        .withNativeFunction ("set", [this] (const Array<var>& a, auto complete) { set (a[0].toString(), a[1]); complete ({}); })
        .withNativeFunction ("openAudioSettings", [this] (const Array<var>&, auto complete) { openAudioSettings(); complete ({}); }) };

    PropertiesFile* settings() { return props.getUserSettings(); }

    var state()
    {
        auto* o = new DynamicObject();
        auto* s = settings();
        o->setProperty ("trimDb", s->getDoubleValue ("trimDb", 0.0));
        o->setProperty ("volume", s->getDoubleValue ("volume", 0.5));
        o->setProperty ("channel", engine.channel.load());

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
        const double x = v;
        if (key == "trimDb")
        {
            const double db = jlimit (-24.0, 24.0, x);
            engine.trimTarget = Decibels::decibelsToGain ((float) db);
            settings()->setValue (key, db);
        }
        else if (key == "volume")
        {
            const double vol = jlimit (0.0, 1.0, x);
            engine.masterTarget = (float) vol;
            settings()->setValue (key, vol);
        }
        else if (key == "channel")
        {
            engine.channel = jmax (0, (int) x);
            settings()->setValue (key, engine.channel.load());
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
