// Rigsmith as an AU / VST3 plugin: the same engine and UI as the app, inside a DAW. The host's
// track is the guitar input; the plugin's outputs are the rig's interface outputs. The project
// stores the rig and its compiled form, so the rig plays as soon as the project opens.

#include <juce_audio_utils/juce_audio_utils.h>
#include "Bridge.h"

using namespace juce;

class RigsmithProcessor : public AudioProcessor, public rig::Host
{
public:
    RigsmithProcessor()
        : AudioProcessor (BusesProperties().withInput ("Input", AudioChannelSet::stereo(), true).withOutput ("Output", AudioChannelSet::stereo(), true))
    {
        engine.masterTarget = 1.0f;
    }

    rig::Engine engine;
    String rigJson;  // what the UI edits (src/rig.ts Rig)
    var compiledRig; // what the engine plays (src/rig.ts compile())

    void prepareToPlay (double sr, int block) override
    {
        rate = sr;
        block_ = block;
        inputs.setSize (2, block);
        engine.prepare (sr, block);
    }
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& l) const override
    {
        return l.getMainOutputChannelSet() == AudioChannelSet::stereo()
            && (l.getMainInputChannelSet() == AudioChannelSet::mono() || l.getMainInputChannelSet() == AudioChannelSet::stereo());
    }

    void processBlock (AudioBuffer<float>& buffer, MidiBuffer&) override
    {
        ScopedNoDenormals noDenormals;
        const int n = buffer.getNumSamples(), numIn = getTotalNumInputChannels();
        if (n > inputs.getNumSamples()) { buffer.clear(); return; } // the host broke its block-size promise
        // The engine clears its outputs before reading its inputs, and here they're the same buffer.
        for (int c = 0; c < numIn; ++c) inputs.copyFrom (c, 0, buffer, c, 0, n);
        engine.audioDeviceIOCallbackWithContext (inputs.getArrayOfReadPointers(), numIn, buffer.getArrayOfWritePointers(), buffer.getNumChannels(), n, {});
    }

    void getStateInformation (MemoryBlock& out) override
    {
        auto* o = new DynamicObject();
        o->setProperty ("rig", rigJson);
        o->setProperty ("compiled", compiledRig);
        MemoryOutputStream (out, false).writeString (JSON::toString (var (o), true));
    }
    void setStateInformation (const void* data, int size) override
    {
        const auto state = JSON::parse (MemoryInputStream (data, (size_t) size, false).readString());
        rigJson = state["rig"].toString();
        compiledRig = state["compiled"];
        if (compiledRig.isObject()) engine.setRig (compiledRig);
    }

    // rig::Host
    void describeAudio (DynamicObject& o) override
    {
        o.setProperty ("device", "Plugin");
        o.setProperty ("inputs", Array<var> { "Track input L", "Track input R" });
        o.setProperty ("sampleRate", rate);
        o.setProperty ("bufferSize", block_);
        o.setProperty ("inputMs", 0);
        o.setProperty ("outputMs", 0);
    }
    double cpu() override { return 0; } // the host shows its own meter
    double sampleRate() override { return rate; }
    bool isPlugin() const override { return true; }
    std::optional<String> autosave() override { return rigJson.isNotEmpty() ? std::optional<String> (rigJson) : std::nullopt; }
    void setAutosave (const String& json) override { rigJson = json; }
    void compiled (const var& c) override { compiledRig = c; }

    AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const String getName() const override { return "Rigsmith"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 10.0; } // delays, reverbs and the looper ring on
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const String getProgramName (int) override { return {}; }
    void changeProgramName (int, const String&) override {}

private:
    double rate = 48000.0;
    int block_ = 512;
    AudioBuffer<float> inputs;
};

class RigsmithEditor : public AudioProcessorEditor
{
public:
    explicit RigsmithEditor (RigsmithProcessor& p) : AudioProcessorEditor (p), bridge (p.engine, p, rig::sharedSettings())
    {
        addAndMakeVisible (web);
        bridge.attach (web);
        setResizable (true, true);
        setResizeLimits (960, 600, 2560, 1600);
        setSize (1280, 800);
    }
    void resized() override { web.setBounds (getLocalBounds()); }

private:
    rig::Bridge bridge;
    WebBrowserComponent web { bridge.options() };
};

AudioProcessorEditor* RigsmithProcessor::createEditor() { return new RigsmithEditor (*this); }
AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new RigsmithProcessor(); }
