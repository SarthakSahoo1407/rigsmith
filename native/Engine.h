// Audio engine: runs the rig the UI compiles (src/rig.ts compile()) as a graph of nodes.
//
// Threads: setRig()/prepare()/collectGarbage() run on the message thread; the device callback on
// the audio thread. A new graph is built off the audio thread and handed over through `pending`;
// the audio thread swaps it in between blocks with a one-block fade, and the old graph is freed
// back on the message thread. No locks are waited on and nothing is allocated on the audio thread.

#pragma once
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_dsp/juce_dsp.h>

namespace rig
{
using namespace juce;

// Safety limiter as a zero-latency soft clipper: linear below the knee, tanh above, never past ±1.
inline float softClip (float x)
{
    constexpr float k = 0.7f;
    const float a = std::abs (x);
    return a <= k ? x : std::copysign (k + (1.0f - k) * std::tanh ((a - k) / (1.0f - k)), x);
}

inline float dbToGain (float db) { return std::pow (10.0f, db / 20.0f); }

// RBJ cookbook biquad. Retuning computes coefficients in place, so it's safe on the audio thread.
struct Biquad
{
    enum Type { LowPass, HighPass, BandPass, Peak, LowShelf, HighShelf };

    void set (Type t, double sr, double hz, double q = 0.707, double db = 0.0)
    {
        hz = jlimit (10.0, sr * 0.45, hz);
        const double A = std::pow (10.0, db / 40.0), w = MathConstants<double>::twoPi * hz / sr;
        const double c = std::cos (w), al = std::sin (w) / (2.0 * q), sq = 2.0 * std::sqrt (A) * al;
        double B0 = 1, B1 = 0, B2 = 0, A0 = 1, A1 = 0, A2 = 0;
        switch (t)
        {
            case LowPass:   B0 = (1 - c) / 2; B1 = 1 - c; B2 = B0; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
            case HighPass:  B0 = (1 + c) / 2; B1 = -(1 + c); B2 = B0; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
            case BandPass:  B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; break;
            case Peak:      B0 = 1 + al * A; B1 = -2 * c; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * c; A2 = 1 - al / A; break;
            case LowShelf:  B0 = A * ((A + 1) - (A - 1) * c + sq); B1 = 2 * A * ((A - 1) - (A + 1) * c); B2 = A * ((A + 1) - (A - 1) * c - sq);
                            A0 = (A + 1) + (A - 1) * c + sq; A1 = -2 * ((A - 1) + (A + 1) * c); A2 = (A + 1) + (A - 1) * c - sq; break;
            case HighShelf: B0 = A * ((A + 1) + (A - 1) * c + sq); B1 = -2 * A * ((A - 1) + (A + 1) * c); B2 = A * ((A + 1) + (A - 1) * c - sq);
                            A0 = (A + 1) - (A - 1) * c + sq; A1 = 2 * ((A - 1) - (A + 1) * c); A2 = (A + 1) - (A - 1) * c - sq; break;
        }
        b0 = float (B0 / A0); b1 = float (B1 / A0); b2 = float (B2 / A0); a1 = float (A1 / A0); a2 = float (A2 / A0);
    }

    float operator() (float x) // transposed direct form II
    {
        const float y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }

    float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
};

// Runs a waveshaper at 4x the sample rate so distortion doesn't alias into fizz.
struct Shaper
{
    dsp::Oversampling<float> os { 1, 2, dsp::Oversampling<float>::filterHalfBandPolyphaseIIR, true, false };
    void prepare (int maxBlock) { os.initProcessing ((size_t) maxBlock); os.reset(); }

    template <typename F>
    void run (float* x, int n, F&& shape)
    {
        dsp::AudioBlock<float> block (&x, 1, (size_t) n);
        auto up = os.processSamplesUp (block);
        auto* s = up.getChannelPointer (0);
        for (size_t i = 0; i < up.getNumSamples(); ++i)
            s[i] = shape (s[i]);
        os.processSamplesDown (block);
    }
};

// What a node can reach besides its own jacks: the interface input and the final stereo mix.
struct IO
{
    const float* const* deviceIn = nullptr;
    int numDeviceIn = 0;
    float* mixL = nullptr;
    float* mixR = nullptr;
    float peak = 0.0f;
};

struct Node
{
    Node (int ins, int outs) : numIns (ins), numOuts (outs) {}
    virtual ~Node() = default;

    const int numIns, numOuts;
    String type;
    std::atomic<bool> on { true };
    std::array<std::atomic<float>, 16> p {}; // knob values, in catalog order (src/catalog.ts)
    std::atomic<int> version { 1 };          // bumped on every param change

    void prepareNode (double rate, int maxBlock)
    {
        sr = rate;
        mix.reset (sr, 0.01);
        mix.setCurrentAndTargetValue (on ? 1.0f : 0.0f);
        prepare (maxBlock);
        seen = 0;
    }

    void process (const float* const* in, float* const* out, int n, IO& io)
    {
        if (const int v = version; v != seen) { seen = v; retune(); }
        render (in, out, n, io);

        // Footswitch: crossfade between the effect and the dry input over 10 ms.
        mix.setTargetValue (on ? 1.0f : 0.0f);
        if (! mix.isSmoothing() && mix.getCurrentValue() == 1.0f)
            return;
        for (int i = 0; i < n; ++i)
        {
            const float g = mix.getNextValue();
            for (int c = 0; c < numOuts; ++c)
                out[c][i] = g * out[c][i] + (1.0f - g) * (numIns > 0 ? in[std::min (c, numIns - 1)][i] : 0.0f);
        }
    }

protected:
    virtual void prepare (int /*maxBlock*/) {}
    virtual void retune() {} // read p[], recompute coefficients; audio thread, no allocation
    virtual void render (const float* const* in, float* const* out, int n, IO& io) = 0;

    // Copies the input to every output (mono in feeds both sides of a stereo out).
    void passThrough (const float* const* in, float* const* out, int n)
    {
        for (int c = 0; c < numOuts; ++c)
            if (numIns > 0) FloatVectorOperations::copy (out[c], in[std::min (c, numIns - 1)], n);
            else FloatVectorOperations::clear (out[c], n);
    }

    double sr = 48000.0;
    SmoothedValue<float> mix;
    int seen = 0;
};

// ponytail: stands in for devices without a sound model yet (phase 5), so chains through them still play.
struct PassThrough : Node
{
    using Node::Node;
    void render (const float* const* in, float* const* out, int n, IO&) override { passThrough (in, out, n); }
};

struct Input : Node // p: channel, trim dB
{
    Input() : Node (0, 1) {}
    SmoothedValue<float> trim;
    void prepare (int) override { trim.reset (sr, 0.02); trim.setCurrentAndTargetValue (dbToGain (p[1])); }
    void render (const float* const*, float* const* out, int n, IO& io) override
    {
        trim.setTargetValue (dbToGain (p[1]));
        const int ch = (int) p[0];
        const float* src = ch < io.numDeviceIn ? io.deviceIn[ch] : nullptr;
        for (int i = 0; i < n; ++i)
        {
            out[0][i] = src != nullptr ? src[i] * trim.getNextValue() : 0.0f;
            io.peak = std::max (io.peak, std::abs (out[0][i]));
        }
    }
};

struct Output : Node // p: volume
{
    Output() : Node (2, 0) {}
    SmoothedValue<float> vol;
    void prepare (int) override { vol.reset (sr, 0.02); vol.setCurrentAndTargetValue (p[0]); }
    void render (const float* const* in, float* const*, int n, IO& io) override
    {
        vol.setTargetValue (p[0]);
        for (int i = 0; i < n; ++i)
        {
            const float g = vol.getNextValue();
            io.mixL[i] += in[0][i] * g;
            io.mixR[i] += in[1][i] * g;
        }
    }
};

struct Splitter : Node
{
    Splitter() : Node (1, 2) {}
    void render (const float* const* in, float* const* out, int n, IO&) override { passThrough (in, out, n); }
};

struct Joiner : Node // p: levelA, levelB, phaseB
{
    Joiner() : Node (2, 1) {}
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float a = p[0], b = p[1] * (p[2] > 0.5f ? -1.0f : 1.0f);
        for (int i = 0; i < n; ++i)
            out[0][i] = in[0][i] * a + in[1][i] * b;
    }
};

struct Boost : Node // p: gain dB, treble dB
{
    Boost() : Node (1, 1) {}
    Biquad treble;
    SmoothedValue<float> gain;
    void prepare (int) override { gain.reset (sr, 0.02); gain.setCurrentAndTargetValue (dbToGain (p[0])); }
    void retune() override { treble.set (Biquad::HighShelf, sr, 2500, 0.707, p[1]); gain.setTargetValue (dbToGain (p[0])); }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        for (int i = 0; i < n; ++i)
            out[0][i] = treble (in[0][i] * gain.getNextValue());
    }
};

// Overdrive/distortion: mid-hump pre-EQ into an oversampled soft clipper, then a tone lowpass.
struct Drive : Node // p: drive|fuzz 0..10, tone 0..10, level 0..10
{
    explicit Drive (bool fuzzIn) : Node (1, 1), fuzz (fuzzIn) {}
    const bool fuzz;
    Biquad pre, hump, tone;
    Shaper shaper;
    SmoothedValue<float> level;
    float drive = 1;

    void prepare (int maxBlock) override { shaper.prepare (maxBlock); level.reset (sr, 0.02); }
    void retune() override
    {
        pre.set (Biquad::HighPass, sr, fuzz ? 40 : 120);
        hump.set (Biquad::Peak, sr, 720, 0.7, fuzz ? 0 : 6);
        tone.set (Biquad::LowPass, sr, (fuzz ? 600 : 800) * std::pow (10.0, p[1] / 10.0));
        drive = dbToGain (fuzz ? 20 + p[0] * 4 : 6 + p[0] * 4.5f);
        level.setTargetValue (dbToGain (-30 + p[2] * 3.6f));
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        for (int i = 0; i < n; ++i)
            out[0][i] = hump (pre (in[0][i])) * drive;
        if (fuzz) // asymmetric, harder clipping: the splatty, gated fuzz edge
            shaper.run (out[0], n, [] (float x) { return x > 0 ? std::tanh (x * 1.5f) : std::tanh (x * 0.8f) * 0.7f; });
        else
            shaper.run (out[0], n, [] (float x) { return std::tanh (x); });
        for (int i = 0; i < n; ++i)
            out[0][i] = tone (out[0][i]) * level.getNextValue();
    }
};

// Amp preamp: input filter, 1-2 gain stages, tone stack. Output = the Send jack.
struct AmpPre : Node // p: voicing, gain, bass, mid, treble, master
{
    AmpPre() : Node (1, 1) {}
    Biquad inHp, stageHp, stageLp, bass, mid, treble;
    Shaper shaper1, shaper2;
    float gain1 = 1, gain2 = 1, outTrim = 1;
    int voicing = 0;

    void prepare (int maxBlock) override { shaper1.prepare (maxBlock); shaper2.prepare (maxBlock); }
    void retune() override
    {
        voicing = (int) p[0];
        const float g = p[1] / 10.0f;
        inHp.set (Biquad::HighPass, sr, voicing == 2 ? 120 : 80);
        stageHp.set (Biquad::HighPass, sr, 200);
        stageLp.set (Biquad::LowPass, sr, 6500);
        gain1 = voicing == 0 ? 1 + g * 5 : voicing == 1 ? 2 + g * 40 : 4 + g * 120;
        gain2 = voicing == 2 ? 6.0f : 1.0f;
        outTrim = voicing == 0 ? 0.8f : 0.5f;
        bass.set (Biquad::LowShelf, sr, 120, 0.707, (p[2] - 5) * 2.4);
        mid.set (Biquad::Peak, sr, 650, 0.8, (p[3] - 5) * 2.4);
        treble.set (Biquad::HighShelf, sr, 3200, 0.707, (p[4] - 5) * 2.4);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        float* x = out[0];
        for (int i = 0; i < n; ++i)
            x[i] = inHp (in[0][i]) * gain1;
        // tanh with a small bias clips one side earlier: the even harmonics of a tube stage.
        auto tube = [] (float v) { return std::tanh (v + 0.1f) - 0.0997f; };
        shaper1.run (x, n, tube);
        if (voicing == 2)
        {
            for (int i = 0; i < n; ++i)
                x[i] = stageHp (x[i]) * gain2;
            shaper2.run (x, n, tube);
            for (int i = 0; i < n; ++i)
                x[i] = stageLp (x[i]);
        }
        for (int i = 0; i < n; ++i)
            x[i] = treble (mid (bass (x[i]))) * outTrim;
    }
};

// Amp power section: Return jack in, speaker jack out. Master drives it into soft saturation.
struct AmpPower : Node
{
    AmpPower() : Node (1, 1) {}
    SmoothedValue<float> master;
    void prepare (int) override { master.reset (sr, 0.02); master.setCurrentAndTargetValue (masterGain()); }
    float masterGain() const { const float m = p[5] / 10.0f; return 0.05f + m * m * 3.0f; }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        master.setTargetValue (masterGain());
        for (int i = 0; i < n; ++i)
            out[0][i] = std::tanh (in[0][i] * master.getNextValue()) * 0.9f;
    }
};

// Speaker cab: low cut, low resonance, presence peak, steep high cut. One voicing per size.
struct Cab : Node // p: size (1x12, 2x12, 4x12)
{
    Cab() : Node (1, 1) {}
    Biquad hp, res, dip, presence, lp1, lp2;
    void retune() override
    {
        const int s = (int) p[0];
        hp.set (Biquad::HighPass, sr, s == 0 ? 90 : s == 1 ? 80 : 70);
        res.set (Biquad::Peak, sr, s == 0 ? 120 : s == 1 ? 110 : 100, 1.2, s == 0 ? 3 : s == 1 ? 4 : 5);
        dip.set (Biquad::Peak, sr, 400, 1.0, s == 2 ? -3 : -1);
        presence.set (Biquad::Peak, sr, s == 0 ? 2500 : 2100, 1.0, s == 0 ? 4 : 3.5);
        lp1.set (Biquad::LowPass, sr, s == 0 ? 5500 : s == 1 ? 5000 : 4500);
        lp2.set (Biquad::LowPass, sr, s == 0 ? 5500 : s == 1 ? 5000 : 4500);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        for (int i = 0; i < n; ++i)
            out[0][i] = lp2 (lp1 (presence (dip (res (hp (in[0][i]))))));
    }
};

// Mic on a cab: model EQ; position across the speaker darkens toward the edge;
// distance lowers level, removes proximity bass and adds up to 2 ms delay (comb filtering with other mics).
struct Mic : Node // p: model, position 0..1, distance 0..1
{
    Mic() : Node (1, 1) {}
    Biquad color, air, edge, proximity;
    std::array<float, 512> ring {};
    int write = 0, delay = 0;
    float gain = 1;

    void retune() override
    {
        const int m = (int) p[0];
        const float x = p[1], d = p[2];
        color.set (m == 1 ? Biquad::HighShelf : Biquad::Peak, sr, m == 1 ? 4000 : 4500, m == 1 ? 0.707 : 1.5, m == 0 ? 4 : m == 1 ? -6 : 1);
        air.set (Biquad::HighShelf, sr, 10000, 0.707, m == 2 ? 2 : 0);
        edge.set (Biquad::LowPass, sr, 12000 * std::pow (3500.0 / 12000.0, x));
        proximity.set (Biquad::LowShelf, sr, 150, 0.707, (m == 1 ? 8 : 6) * (1 - d));
        gain = 1 - 0.6f * d;
        delay = jlimit (0, (int) ring.size() - 1, (int) (d * 0.002 * sr));
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        for (int i = 0; i < n; ++i)
        {
            ring[(size_t) write] = proximity (edge (air (color (in[0][i])))) * gain;
            out[0][i] = ring[(size_t) ((write - delay + (int) ring.size()) % (int) ring.size())];
            write = (write + 1) % (int) ring.size();
        }
    }
};

inline std::shared_ptr<Node> makeNode (const String& type)
{
    std::shared_ptr<Node> n;
    if (type == "input") n = std::make_shared<Input>();
    else if (type == "output") n = std::make_shared<Output>();
    else if (type == "splitter") n = std::make_shared<Splitter>();
    else if (type == "joiner") n = std::make_shared<Joiner>();
    else if (type == "boost") n = std::make_shared<Boost>();
    else if (type == "distortion") n = std::make_shared<Drive> (false);
    else if (type == "fuzz") n = std::make_shared<Drive> (true);
    else if (type == "amp/pre") n = std::make_shared<AmpPre>();
    else if (type == "amp/power") n = std::make_shared<AmpPower>();
    else if (type == "cab") n = std::make_shared<Cab>();
    else if (type == "mic") n = std::make_shared<Mic>();
    // Not modelled yet: pass the signal through with the device's jack counts.
    else if (type == "chorus" || type == "delay") n = std::make_shared<PassThrough> (1, 2);
    else if (type == "reverb") n = std::make_shared<PassThrough> (2, 2);
    else n = std::make_shared<PassThrough> (1, 1);
    n->type = type;
    return n;
}

struct Graph
{
    struct Source { int from, out, in; };
    struct Entry
    {
        String id;
        std::shared_ptr<Node> node;
        std::vector<Source> sources;
        AudioBuffer<float> ins, outs;
    };
    std::vector<Entry> order; // topological: every node after the nodes feeding it
};

class Engine : public AudioIODeviceCallback
{
public:
    std::atomic<float> masterTarget { 0.5f };
    std::atomic<float> peak { 0.0f }; // input level, read and reset by the UI meter

    // Message thread. `compiled` is { nodes: [{id, type, params: [], on}], wires: [{from, out, to, in}] }.
    void setRig (const var& compiled)
    {
        lastRig = compiled;
        if (prepared)
            install (build (compiled, false), false);
    }

    // Message thread: (re)start at a sample rate. Builds every node fresh.
    void prepare (double rate, int block)
    {
        sr = rate;
        maxBlock = block;
        mixL.setSize (1, maxBlock);
        mixR.setSize (1, maxBlock);
        master.reset (sr, 0.02);
        master.setCurrentAndTargetValue (masterTarget);
        prepared = true;
        install (build (lastRig, true), true);
    }

    // Message thread: free graphs the audio thread has swapped out.
    void collectGarbage()
    {
        std::shared_ptr<Graph> old;
        const SpinLock::ScopedLockType l (lock);
        old = std::move (retired);
    }

    const std::map<String, std::shared_ptr<Node>>& nodes() const { return byId; }

    void audioDeviceAboutToStart (AudioIODevice* d) override { prepare (d->getCurrentSampleRate(), d->getCurrentBufferSizeSamples()); }
    void audioDeviceStopped() override {}

    void audioDeviceIOCallbackWithContext (const float* const* in, int numIn, float* const* out, int numOut, int n,
                                           const AudioIODeviceCallbackContext&) override
    {
        for (int c = 0; c < numOut; ++c)
            if (out[c] != nullptr)
                FloatVectorOperations::clear (out[c], n);
        if (n > maxBlock)
            return; // the device broke its promised block size; stay silent rather than overrun

        // Hand the last swapped-out graph to the message thread to free; only then accept a new one.
        std::shared_ptr<Graph> incoming;
        if (const SpinLock::ScopedTryLockType l (lock); l.isLocked())
        {
            if (toRetire != nullptr && retired == nullptr) retired = std::move (toRetire);
            if (toRetire == nullptr) incoming = std::move (pending);
        }

        IO io { in, numIn, mixL.getWritePointer (0), mixR.getWritePointer (0) };
        FloatVectorOperations::clear (io.mixL, n);
        FloatVectorOperations::clear (io.mixR, n);
        if (live != nullptr)
            render (*live, n, io);

        // A rig change fades this block out and the next one in, so re-cabling never clicks.
        master.setTargetValue (masterTarget);
        for (int i = 0; i < n; ++i)
        {
            float g = master.getNextValue();
            if (incoming != nullptr) g *= 1.0f - float (i) / float (n);
            if (fadeIn) g *= float (i) / float (n);
            if (numOut > 0 && out[0] != nullptr) out[0][i] = softClip (io.mixL[i] * g);
            if (numOut > 1 && out[1] != nullptr) out[1][i] = softClip (io.mixR[i] * g);
        }
        fadeIn = false;

        if (incoming != nullptr)
        {
            toRetire = std::move (live);
            live = std::move (incoming);
            fadeIn = true;
        }
        for (float prev = peak; io.peak > prev && ! peak.compare_exchange_weak (prev, io.peak);) {}
    }

private:
    static void render (Graph& g, int n, IO& io)
    {
        for (auto& e : g.order)
        {
            e.ins.clear (0, n);
            for (const auto& s : e.sources)
                e.ins.addFrom (s.in, 0, g.order[(size_t) s.from].outs, s.out, 0, n);
            e.node->process (e.ins.getArrayOfReadPointers(), e.outs.getArrayOfWritePointers(), n, io);
        }
    }

    // Same nodes and wires as the running graph? Then only knobs/footswitches changed.
    static String structureOf (const var& compiled)
    {
        String s;
        for (const auto& n : *compiled["nodes"].getArray())
            s << n["id"].toString() << ':' << n["type"].toString() << ';';
        for (const auto& w : *compiled["wires"].getArray())
            s << w["from"].toString() << '.' << (int) w["out"] << '>' << w["to"].toString() << '.' << (int) w["in"] << ';';
        return s;
    }

    static void applyParams (Node& node, const var& n)
    {
        if (const auto* ps = n["params"].getArray())
            for (int i = 0; i < std::min (ps->size(), (int) node.p.size()); ++i)
                node.p[(size_t) i] = (float) (double) ps->getReference (i);
        node.on = (bool) n["on"];
        node.version++;
    }

    // Returns null when only params changed (they're already applied).
    std::shared_ptr<Graph> build (const var& compiled, bool fresh)
    {
        if (! compiled["nodes"].isArray() || ! compiled["wires"].isArray())
            return std::make_shared<Graph>();
        const auto shape = structureOf (compiled);
        const bool sameShape = ! fresh && shape == lastShape;
        lastShape = shape;

        std::map<String, std::shared_ptr<Node>> next;
        for (const auto& n : *compiled["nodes"].getArray())
        {
            const auto id = n["id"].toString(), type = n["type"].toString();
            auto it = byId.find (id);
            auto node = ! fresh && it != byId.end() && it->second->type == type ? it->second : makeNode (type);
            applyParams (*node, n);
            if (node != (it != byId.end() ? it->second : nullptr) || fresh)
                node->prepareNode (sr, maxBlock);
            next[id] = node;
        }
        byId = std::move (next);
        if (sameShape)
            return nullptr;

        // Kahn's topological sort. The UI refuses loops, so every node gets placed.
        std::map<String, int> indegree;
        std::map<String, std::vector<var>> outgoing;
        for (const auto& [id, node] : byId) indegree[id] = 0;
        for (const auto& w : *compiled["wires"].getArray())
            if (byId.count (w["from"].toString()) && byId.count (w["to"].toString()))
            {
                indegree[w["to"].toString()]++;
                outgoing[w["from"].toString()].push_back (w);
            }

        auto g = std::make_shared<Graph>();
        std::map<String, int> position;
        std::vector<String> ready;
        for (const auto& [id, d] : indegree) if (d == 0) ready.push_back (id);
        while (! ready.empty())
        {
            const auto id = ready.back();
            ready.pop_back();
            position[id] = (int) g->order.size();
            auto& e = g->order.emplace_back();
            e.id = id;
            e.node = byId[id];
            e.ins.setSize (std::max (1, e.node->numIns), maxBlock);
            e.outs.setSize (std::max (1, e.node->numOuts), maxBlock);
            for (const auto& w : outgoing[id])
                if (--indegree[w["to"].toString()] == 0) ready.push_back (w["to"].toString());
        }
        for (const auto& w : *compiled["wires"].getArray())
        {
            const auto from = position.find (w["from"].toString()), to = position.find (w["to"].toString());
            if (from == position.end() || to == position.end()) continue;
            auto& e = g->order[(size_t) to->second];
            const int out = w["out"], in = w["in"];
            if (in >= 0 && in < e.node->numIns && out >= 0 && out < g->order[(size_t) from->second].node->numOuts)
                e.sources.push_back ({ from->second, out, in });
        }
        return g;
    }

    void install (std::shared_ptr<Graph> g, bool now)
    {
        if (g == nullptr) return;
        const SpinLock::ScopedLockType l (lock);
        if (now) { live = std::move (g); pending = toRetire = retired = nullptr; fadeIn = true; } // device stopped: safe to touch live
        else pending = std::move (g);
    }

    double sr = 48000.0;
    int maxBlock = 512;
    bool prepared = false;
    var lastRig;
    String lastShape;
    std::map<String, std::shared_ptr<Node>> byId; // message thread only
    AudioBuffer<float> mixL, mixR;
    SmoothedValue<float> master;
    bool fadeIn = false;

    SpinLock lock; // guards pending and retired; the audio thread only ever try-locks it
    std::shared_ptr<Graph> pending, retired;
    std::shared_ptr<Graph> live, toRetire; // audio thread (or message thread while the device is stopped)
};
} // namespace rig
