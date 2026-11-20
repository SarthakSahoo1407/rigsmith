// Rigsmith, the standalone app: the audio device, its settings dialog, and the window. Everything
// the UI talks to lives in Bridge.h, shared with the plugin (Plugin.cpp).

#include <juce_audio_utils/juce_audio_utils.h>
#include "Bridge.h"

using namespace juce;

class MainComponent : public Component, private ChangeListener, private rig::Host
{
public:
    MainComponent()
    {
        engine.masterTarget = (float) settings().getDoubleValue ("volume", 0.5);
        auto audioXml = settings().getXmlValue ("audio");
        deviceManager.initialise (2, 2, audioXml.get(), true);
        deviceManager.addAudioCallback (&engine);
        deviceManager.addChangeListener (this);
        addAndMakeVisible (web);
        bridge.attach (web);
        setSize (1440, 900);
    }

    ~MainComponent() override
    {
        deviceManager.removeChangeListener (this);
        deviceManager.removeAudioCallback (&engine);
    }

    void resized() override { web.setBounds (getLocalBounds()); }

    static PropertiesFile& settings() { return rig::sharedSettings(); }

private:
    AudioDeviceManager deviceManager;
    rig::Engine engine;
    rig::Bridge bridge { engine, *this, settings() };
    WebBrowserComponent web { bridge.options() };

    void describeAudio (DynamicObject& o) override
    {
        auto* d = deviceManager.getCurrentAudioDevice();
        if (d == nullptr) return;
        Array<var> inputs;
        const auto names = d->getInputChannelNames();
        const auto active = d->getActiveInputChannels();
        for (int i = 0; i < names.size(); ++i)
            if (active[i]) inputs.add (names[i]);
        const double sr = d->getCurrentSampleRate();
        o.setProperty ("device", d->getName());
        o.setProperty ("inputs", inputs);
        o.setProperty ("sampleRate", sr);
        o.setProperty ("bufferSize", d->getCurrentBufferSizeSamples());
        // JUCE's CoreAudio latency already includes one buffer each way.
        o.setProperty ("inputMs", d->getInputLatencyInSamples() * 1000.0 / sr);
        o.setProperty ("outputMs", d->getOutputLatencyInSamples() * 1000.0 / sr);
    }
    double cpu() override { return deviceManager.getCpuUsage(); }
    double sampleRate() override
    {
        auto* d = deviceManager.getCurrentAudioDevice();
        return d != nullptr ? d->getCurrentSampleRate() : 48000.0;
    }

    void openAudioSettings() override
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
            settings().setValue ("audio", xml.get());
        bridge.audioChanged();
    }
};

class RigApp : public JUCEApplication
{
public:
    const String getApplicationName() override { return "Rigsmith"; }
    const String getApplicationVersion() override { return "2.0.0"; }
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
