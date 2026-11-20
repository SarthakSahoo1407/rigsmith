// One Node per device type in src/catalog.ts. Knob values arrive in p[] in catalog order.

#pragma once
#include "Dsp.h"

namespace rig
{
// Unknown device types (e.g. from a newer rig file) still pass the signal along.
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

// Boost: clean (flat), treble booster (the classic germanium top-end lift), or mid boost.
struct Boost : Node // p: model, gain dB, tone 0..10
{
    Boost() : Node (1, 1) {}
    Biquad shape;
    SmoothedValue<float> gain;
    void prepare (int) override { gain.reset (sr, 0.02); gain.setCurrentAndTargetValue (dbToGain (p[1])); }
    void retune() override
    {
        const int m = (int) p[0];
        const double tone = (p[2] - 5) * 1.2;
        if (m == 0) shape.set (Biquad::HighShelf, sr, 3000, 0.707, tone);
        else if (m == 1) shape.set (Biquad::HighShelf, sr, 1500, 0.6, 8 + tone);
        else shape.set (Biquad::Peak, sr, 900, 0.8, 6 + tone);
        gain.setTargetValue (dbToGain (p[1]));
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        for (int i = 0; i < n; ++i)
            out[0][i] = std::tanh (shape (in[0][i]) * gain.getNextValue() * 0.8f) / 0.8f; // runs out of headroom only when pushed hard
    }
};

// Drive pedals. Overdrive: low end left clean, only mids clip, soft. Distortion: op-amp gain into
// hard clipping. Amp in a box: two tube-like stages. Metal: hard clipping with the low end and
// upper mids pushed and the lower mids scooped.
// Fuzz: germanium (soft one side, hard the other, bass-rich), or sustainer (two hard stages, scooped tone).
struct Drive : Node // p: model, drive|fuzz 0..10, tone 0..10, level 0..10
{
    explicit Drive (bool fuzzIn) : Node (1, 1), fuzz (fuzzIn) {}
    const bool fuzz;
    Biquad pre, hump, post1, post2, tone, toneHp;
    Shaper shaper { 3 };
    std::array<Biquad, 2> stageLp;
    SmoothedValue<float> level;
    int model = 0;
    float drive = 1;

    void prepare (int maxBlock) override { shaper.prepare (maxBlock); level.reset (sr, 0.02); }
    void retune() override
    {
        model = (int) p[0];
        const float d = p[1] / 10.0f, t = p[2] / 10.0f;
        const double os = shaper.rate (sr);
        for (auto& f : stageLp) f.set (Biquad::LowPass, os, 7000);
        if (fuzz)
        {
            pre.set (Biquad::HighPass, sr, model == 0 ? 30 : 60);
            hump.set (Biquad::Peak, sr, 700, 0.7, 0);
            drive = dbToGain (model == 0 ? 20 + d * 30 : 25 + d * 30);
            tone.set (Biquad::LowPass, sr, model == 0 ? 2000 + t * 8000 : 1000);
            toneHp.set (Biquad::HighPass, sr, 1000);
            post1.set (Biquad::Peak, sr, 120, 0.7, model == 0 ? 3 : 2);
            post2.set (Biquad::Peak, sr, 600, 0.7, 0);
        }
        else
        {
            const double preHz[] = { 720, 60, 100, 120 };
            pre.set (Biquad::HighPass, sr, preHz[model], 0.6);
            hump.set (Biquad::Peak, sr, model == 2 ? 800 : 900, 0.7, model == 0 ? 3 : model == 2 ? 4 : 0);
            const float lo[] = { 12, 18, 12, 24 }, hi[] = { 40, 54, 42, 60 }; // an overdrive's mids are boosted ~12 dB even at minimum drive
            drive = dbToGain (lo[model] + d * (hi[model] - lo[model]));
            tone.set (Biquad::LowPass, sr, (model == 1 ? 500 : 1200) * std::pow (model == 1 ? 16.0 : 7.0, (double) t));
            post1.set (Biquad::Peak, sr, model == 3 ? 100 : 120, 0.8, model == 3 ? 8 : 0);
            post2.set (Biquad::Peak, sr, model == 3 ? 500 : 1200, 0.8, model == 3 ? -6 : 0);
            toneHp.set (Biquad::Peak, sr, 1300, 1.0, model == 3 ? 7 : 0);
        }
        level.setTargetValue (dbToGain (-30 + p[3] * 3.6f));
    }

    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        float* x = out[0];
        for (int i = 0; i < n; ++i) x[i] = hump (pre (in[0][i])) * drive;
        auto& lp = stageLp;
        if (fuzz && model == 0)
            shaper.run (x, n, [] (float v) { return v > 0 ? std::tanh (v) : std::max (-0.6f, std::tanh (v * 1.6f) * 0.6f); });
        else if (fuzz)
            shaper.run (x, n, [&lp] (float v) { v = lp[0] (std::tanh (v)) * 8.0f; return std::tanh (v); });
        else if (model == 0) // overdrive: soft diodes
            shaper.run (x, n, [] (float v) { return v / std::pow (1.0f + std::pow (std::abs (v), 2.5f), 0.4f); });
        else if (model == 2)
            shaper.run (x, n, [&lp] (float v) { v = lp[0] (std::tanh (v + 0.15f) - 0.149f) * 6.0f; return std::tanh (v + 0.1f) - 0.0997f; });
        else if (model == 1) // op-amp into hard-kneed diodes
            shaper.run (x, n, [] (float v) { return hardKnee (v); });
        else // metal: two hard stages
            shaper.run (x, n, [&lp] (float v) { return hardKnee (lp[1] (hardKnee (v)) * 6.0f); });
        for (int i = 0; i < n; ++i)
        {
            float y = x[i];
            if (fuzz && model == 1)
            {
                const float t = p[2] / 10.0f; // sustainer tone: crossfade a lowpass and a highpass, scooping the mids
                y = (1 - t) * tone (y) + t * toneHp (y);
            }
            else y = tone (y);
            if (! fuzz && model == 0) y = 0.6f * y + in[0][i]; // overdrive: clipped mids on top of the full clean signal
            x[i] = post2 (post1 (fuzz ? y : toneHp (y))) * level.getNextValue();
        }
    }

    static float hardKnee (float v) { return v / std::pow (1.0f + std::pow (std::abs (v), 4.0f), 0.25f); }
};

// Amp models: gain staging, tone stack voicing and power section per model.
struct AmpModel
{
    int stages;                  // preamp gain stages
    float gainLoDb, gainHiDb;    // first-stage drive across the gain knob
    float interDb;               // gain between stages
    float bias;                  // stage asymmetry (even harmonics)
    float inHp, stageHp, stageLp, brightDb;
    float bassHz, midHz, midQ, midBiasDb, trebleHz;
    float powerDrive, sag, depthHz, depthDb, presenceHz;
    float trim;
    float bassLiftDb; // a real tone stack at noon leaves bass well above the mids
};

// Order matches the model list in src/catalog.ts.
inline const AmpModel AMPS[] = {
    // stg  gainLo gainHi inter bias  inHp stHp stLp  brt  bass mid   midQ midB treb  pDrv sag  depHz depDb presHz trim
    { 1, 0, 20, 0, .05f, 40, 20, 12000, 3, 90, 450, .7f, -5, 2500, .7f, .10f, 90, 3, 4000, 1.76f, 1 },  // US Clean: scooped, sparkly
    { 2, 6, 30, 6, .15f, 45, 20, 5000, 0, 110, 800, .8f, 3, 2200, 1.6f, .50f, 100, 2, 3000, .53f, 0 },  // Tweed: dark, mid-forward, breaks up early
    { 2, 4, 28, 8, .08f, 60, 25, 10000, 4, 120, 1800, 1.f, 3, 2800, 1.2f, .30f, 110, 3, 4500, .5f, 3 },  // UK Chime: jangly upper mids
    { 2, 10, 36, 12, .10f, 80, 30, 7000, 3, 100, 800, .8f, 3, 2500, 1.4f, .25f, 100, 4, 3800, .34f, 1 },  // UK Plexi
    { 3, 12, 40, 18, .12f, 100, 50, 6000, 2, 100, 750, .8f, 4, 2400, 1.3f, .20f, 100, 6, 3800, .33f, 3 },  // UK Lead
    { 4, 14, 44, 20, .10f, 90, 45, 5500, 1, 80, 650, .7f, -3, 2600, 1.5f, .45f, 85, 7, 4500, .38f, 3 }, // US Rectified: huge lows, scooped
    { 4, 16, 46, 22, .12f, 120, 60, 5500, 2, 100, 900, .7f, 2, 3000, 1.3f, .15f, 100, 7, 4200, .26f, 3 }, // Modern High Gain: tight, aggressive
    { 3, 10, 38, 14, .10f, 90, 45, 5500, 0, 100, 700, .6f, 3, 2200, 1.2f, .35f, 100, 4, 3500, .41f, 3 }, // Boutique Lead: smooth, vocal
    { 1, 0, 14, 0, 0, 40, 20, 8000, 0, 100, 400, .7f, 1, 3000, .5f, 0, 100, 2, 5000, 2.55f, 2 }, // Jazz Clean: warm, flat
};

inline const AmpModel& ampModel (float p0) { return AMPS[(size_t) jlimit (0, (int) std::size (AMPS) - 1, (int) p0)]; }

// Amp preamp: input filter and bright cap, then every gain stage at 8x oversampling with
// interstage coupling (highpass) and treble roll-off (lowpass), then the tone stack. Output = the Send jack.
// Amp controls in catalog order (src/catalog.ts). The drive channel uses the original gain/EQ knobs
// so v1 rigs sound the same; clean and lead have their own.
enum AmpParam { Model, Gain, Bass, Mid, Treble, Presence, Master, Channel, Bright, Deep, Fat, Tube, Bias, Sag, Variac,
                CleanGain, CleanBass, CleanMid, CleanTreble, LeadGain, LeadBass, LeadMid, LeadTreble };

// Channels: clean is one gentle stage, drive is the model as voiced, lead adds a stage and 8 dB.
struct AmpPre : Node // p: AmpParam
{
    AmpPre() : Node (1, 1) {}
    Biquad inHp, bright, fat, bass, mid, treble;
    std::array<Biquad, 4> stHp, stLp;
    Shaper shaper { 3 };
    float inGain = 1, inter = 1, bias = 0, biasOffset = 0;
    int stages = 1;

    void prepare (int maxBlock) override { shaper.prepare (maxBlock); }
    void retune() override
    {
        const auto& m = ampModel (p[Model]);
        const double os = shaper.rate (sr);
        const int ch = jlimit (0, 2, (int) p[Channel]);
        auto knob = [&] (int i) { return (float) p[(size_t) (ch == 1 ? i : (ch == 0 ? CleanGain : LeadGain) + i - Gain)]; };
        const float g = knob (Gain);
        stages = ch == 0 ? 1 : ch == 2 ? std::min (4, m.stages + 1) : m.stages;
        inGain = ch == 0 ? dbToGain (m.gainLoDb - 6 + g / 10.0f * 18.0f)
                         : dbToGain (m.gainLoDb + g / 10.0f * (m.gainHiDb - m.gainLoDb) + (ch == 2 ? 8.0f : 0.0f));
        inter = dbToGain (m.interDb);
        bias = m.bias;
        biasOffset = std::tanh (bias);
        inHp.set (Biquad::HighPass, sr, m.inHp);
        // A bright cap matters less as gain rises; the Bright switch adds one on top of the model's own.
        bright.set (Biquad::HighShelf, sr, 2000, 0.6, (m.brightDb + (p[Bright] > 0.5f ? 6.0f : 0.0f)) * (1.0f - g / 20.0f));
        fat.set (Biquad::Peak, sr, 700, 0.8, p[Fat] > 0.5f ? 6.0 : 0.0); // mid push into the first stage
        for (size_t s = 0; s < stHp.size(); ++s)
        {
            stHp[s].set (Biquad::HighPass, os, s == 0 ? m.stageHp * 0.5f : m.stageHp);
            stLp[s].set (Biquad::LowPass, os, m.stageLp);
        }
        bass.set (Biquad::LowShelf, sr, m.bassLiftDb > 3 ? 250 : m.bassHz, 0.7, (knob (Bass) - 5) * 2.4 + m.bassLiftDb);
        mid.set (Biquad::Peak, sr, m.midHz, m.midQ, (knob (Mid) - 5) * 2.4 + m.midBiasDb);
        treble.set (Biquad::HighShelf, sr, m.trebleHz, 0.7, (knob (Treble) - 5) * 2.4);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        float* x = out[0];
        for (int i = 0; i < n; ++i) x[i] = fat (bright (inHp (in[0][i]))) * inGain;
        shaper.run (x, n, [this] (float v) {
            for (int s = 0; s < stages; ++s)
            {
                v = std::tanh (v + bias) - biasOffset;
                v = stHp[(size_t) s] (stLp[(size_t) s] (v));
                if (s + 1 < stages) v *= inter;
            }
            return v;
        });
        for (int i = 0; i < n; ++i) x[i] = treble (mid (bass (x[i])));
    }
};

// Amp power section: Return jack in, speaker jack out. The master pushes the power tubes; the supply
// sags as you play harder; the speaker's resonance (depth) and the presence control shape the result.
// Tube type, bias, sag and supply voltage change how and when it breaks up:
//   EL34 mid-forward and earlier, 6L6 more headroom and scooped, KT88 most headroom, EL84 early and chimey.
//   Cold bias leaves a crossover gap (raspy); hot bias adds even harmonics and squash.
//   Lower voltage breaks up sooner and quieter.
struct AmpPower : Node // p: AmpParam
{
    AmpPower() : Node (1, 1) {}
    struct TubeType { float drive, asym, eqHz, eqDb, sag; };
    static constexpr TubeType TUBES[] = { { 1, 0, 1000, 0, 0 }, { 1.15f, .06f, 1100, 2, 0 }, { .8f, .02f, 600, -1.5f, 0 }, { .6f, .01f, 120, 1.5f, 0 }, { 1.5f, .1f, 2200, 2.5f, .15f } };
    Biquad depth, presence, tubeEq, deep;
    Envelope env;
    SmoothedValue<float> drive;
    float sag = 0, trim = 1, asym = 0, gap = 0, volts = 1;

    const TubeType& tube() const { return TUBES[(size_t) jlimit (0, 4, (int) p[Tube])]; }
    float driveFor() const
    {
        const float m = p[Master] / 10.0f, v = jlimit (0.8f, 1.1f, (float) p[Variac] / 100.0f);
        return (0.08f + m * m * 3.0f) * ampModel (p[Model]).powerDrive * tube().drive / (v * v);
    }
    void prepare (int) override { drive.reset (sr, 0.03); drive.setCurrentAndTargetValue (driveFor()); env.set (sr, 5, 150); }
    void retune() override
    {
        const auto& m = ampModel (p[Model]);
        const auto& t = tube();
        const float b = (p[Bias] - 5) / 5.0f; // -1 cold .. +1 hot
        depth.set (Biquad::Peak, sr, m.depthHz, 0.9, m.depthDb);
        presence.set (Biquad::HighShelf, sr, m.presenceHz, 0.7, (p[Presence] - 5) * 2.0);
        tubeEq.set (Biquad::Peak, sr, t.eqHz, 0.8, t.eqDb);
        deep.set (Biquad::LowShelf, sr, 90, 0.7, p[Deep] > 0.5f ? 5.0 : 0.0);
        sag = (m.sag + t.sag) * (p[Sag] / 5.0f) * (1.0f + 0.3f * std::max (0.0f, b));
        asym = 0.05f + t.asym + 0.08f * std::max (0.0f, b);
        gap = 0.03f * std::max (0.0f, -b);
        volts = jlimit (0.8f, 1.1f, (float) p[Variac] / 100.0f);
        // Level-match the channels (measured with RigRender): clean runs one gentle stage, so it's
        // about 7 dB quieter; lead on a one-stage clean model jumps the most.
        const int ch = jlimit (0, 2, (int) p[Channel]);
        trim = m.trim * (ch == 0 ? 2.2f : ch == 2 ? (m.stages == 1 ? 0.5f : m.stages == 2 ? 0.9f : 1.0f) : 1.0f);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        drive.setTargetValue (driveFor());
        const float offset = std::tanh (asym);
        for (int i = 0; i < n; ++i)
        {
            const float g = drive.getNextValue() / (1.0f + sag * 3.0f * env (in[0][i]));
            float x = in[0][i] * g;
            if (gap > 0) x = x > 0 ? std::max (0.0f, x - gap) : std::min (0.0f, x + gap); // crossover gap of a cold bias
            const float y = std::tanh (x + asym) - offset;
            out[0][i] = deep (presence (depth (tubeEq (y)))) * trim * 0.8f * volts;
        }
    }
};

// Speaker cab as an impulse response, the way modern amp sims do it: the cab size sets the low end
// (a closed 4x12 thumps around 100 Hz, an open 1x12 loses it), the speaker sets mids and highs and
// how steeply they fall above 5-7 kHz, and seeded cone break-up ripple keeps it from sounding like EQ.
// Or real IRs: source = IR plays slot A, or A and B blended. Low and high cut apply to both.
struct Cab : Node // p: size (1x12, 2x12, 4x12), speaker, source (modelled / IR), blend, low cut Hz, high cut Hz
{
    Cab() : Node (1, 1) {}
    dsp::Convolution conv, irA, irB;
    std::vector<float> other;
    Biquad low1, low2, high1, high2;
    int loaded = -1;
    String loadedA = "\x01", loadedB = "\x01";
    std::atomic<bool> hasA { false }, hasB { false };

    static Curve curveFor (int size, int speaker)
    {
        static const Curve lows[] = {
            { { 40, -24 }, { 60, -14 }, { 80, -6 }, { 110, -1.5f }, { 140, -1 }, { 180, -2 }, { 250, 0 } }, // 1x12 open back
            { { 40, -22 }, { 60, -11 }, { 80, -3 }, { 105, 0.5f }, { 125, 1 }, { 180, -0.5f }, { 250, 0 } }, // 2x12
            { { 40, -20 }, { 55, -10 }, { 75, -2 }, { 100, 2 }, { 118, 2 }, { 160, 0 }, { 250, 0 } },        // 4x12 closed
        };
        static const Curve highs[] = {
            { { 400, 0 }, { 800, -1 }, { 1300, 0 }, { 2000, 2.5f }, { 2800, 2 }, { 3600, 0.5f }, { 4500, -4 }, { 5500, -11 }, { 7000, -22 }, { 9000, -32 }, { 14000, -48 } },              // warm 25W
            { { 400, -1 }, { 650, -3.5f }, { 1000, -2 }, { 1600, 1 }, { 2300, 4 }, { 2900, 2.5f }, { 3600, 4.5f }, { 4300, 2 }, { 5200, -5 }, { 6500, -16 }, { 8000, -26 }, { 11000, -40 } }, // aggressive 60W
            { { 400, 0 }, { 800, 0 }, { 1500, 1 }, { 2500, 3 }, { 3500, 3.5f }, { 4500, 1 }, { 5500, -5 }, { 7000, -15 }, { 9000, -27 }, { 14000, -44 } },                                 // chimey alnico
            { { 400, -1 }, { 650, -2 }, { 1000, -1 }, { 2000, 1 }, { 3000, 2 }, { 4500, 2 }, { 6000, -3 }, { 7500, -12 }, { 9500, -24 }, { 14000, -40 } },                                  // sparkly US
        };
        auto c = lows[jlimit (0, 2, size)];
        for (const auto& pt : highs[jlimit (0, 3, speaker)]) c.push_back (pt);
        return c;
    }
    void prepare (int maxBlock) override
    {
        for (auto* c : { &conv, &irA, &irB }) c->prepare ({ sr, (uint32) maxBlock, 1 });
        other.assign ((size_t) maxBlock, 0.0f);
        loaded = -1;
        loadedA = loadedB = "\x01";
    }
    void configure() override
    {
        const int size = jlimit (0, 2, (int) p[0]), speaker = jlimit (0, 3, (int) p[1]), key = size * 4 + speaker;
        if (key != loaded)
        {
            loaded = key;
            conv.loadImpulseResponse (designIr (sr, (int) (sr * 0.05), curveFor (size, speaker), 2.5f, 900, 17 + key), sr,
                                      dsp::Convolution::Stereo::no, dsp::Convolution::Trim::no, dsp::Convolution::Normalise::no);
        }
        auto load = [this] (dsp::Convolution& c, const char* slot, String& was, std::atomic<bool>& has) {
            const auto it = files.find (slot);
            const String path = it != files.end() ? it->second : String();
            if (path == was) return;
            was = path;
            has = File (path).existsAsFile();
            if (has) c.loadImpulseResponse (File (path), dsp::Convolution::Stereo::no, dsp::Convolution::Trim::yes, 0, dsp::Convolution::Normalise::yes);
        };
        load (irA, "irA", loadedA, hasA);
        load (irB, "irB", loadedB, hasB);
    }
    void retune() override
    {
        low1.set (Biquad::HighPass, sr, jlimit (10.0f, 400.0f, (float) p[4]), 0.54);
        low2.set (Biquad::HighPass, sr, jlimit (10.0f, 400.0f, (float) p[4]), 1.31);
        high1.set (Biquad::LowPass, sr, jlimit (2000.0f, 20000.0f, (float) p[5]), 0.54);
        high2.set (Biquad::LowPass, sr, jlimit (2000.0f, 20000.0f, (float) p[5]), 1.31);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        auto run = [n] (dsp::Convolution& c, float* x) {
            dsp::AudioBlock<float> block (&x, 1, (size_t) n);
            c.process (dsp::ProcessContextReplacing<float> (block));
        };
        FloatVectorOperations::copy (out[0], in[0], n);
        const bool ir = p[2] > 0.5f && (hasA || hasB);
        if (! ir) run (conv, out[0]);
        else if (hasA && hasB)
        {
            FloatVectorOperations::copy (other.data(), in[0], n);
            run (irA, out[0]);
            run (irB, other.data());
            const float b = jlimit (0.0f, 1.0f, (float) p[3]);
            for (int i = 0; i < n; ++i) out[0][i] = (1 - b) * out[0][i] + b * other[(size_t) i];
        }
        else run (hasA ? irA : irB, out[0]);
        // JUCE normalises loaded IRs to about 1/8 of full scale; bring them up to the modelled cab's level.
        const float level = ir ? 2.8f : 1.0f;
        for (int i = 0; i < n; ++i) out[0][i] = high2 (high1 (low2 (low1 (out[0][i])))) * level;
    }
};

// Mic on a cab: model EQ; position across the speaker darkens toward the edge; angling it off-axis
// darkens it further and softens the presence; distance lowers level, removes proximity bass and
// adds up to 2 ms delay (comb filtering with other mics). Level, polarity and time-align are the
// mixer channel's controls; pan and solo are applied by the cab's mic mixer (MicMix).
struct Mic : Node // p: model, level dB, pan, phase, align ms, angle °, solo, then position 0..1, distance 0..1
{
    Mic() : Node (1, 1) {}
    Biquad color, air, edge, proximity;
    std::array<float, 512> ring {};
    int write = 0, delay = 0;
    float gain = 1;

    void retune() override
    {
        const int m = (int) p[0];
        const float x = p[7], d = p[8], axis = 1.0f - jlimit (0.0f, 60.0f, (float) p[5]) / 90.0f;
        if (m == 0) color.set (Biquad::Peak, sr, 5000, 1.2, 2.5 * axis);           // dynamic: presence lift
        else if (m == 1) color.set (Biquad::HighShelf, sr, 4000, 0.707, -6);        // ribbon: dark, smooth
        else color.set (Biquad::Peak, sr, 3000, 0.8, 1 * axis);                     // condenser: open
        air.set (Biquad::HighShelf, sr, 10000, 0.707, m == 2 ? 2 : 0);
        edge.set (Biquad::LowPass, sr, 12000 * std::pow (3500.0 / 12000.0, x) * (0.5 + 0.5 * axis));
        proximity.set (Biquad::LowShelf, sr, 150, 0.707, (m == 1 ? 6 : 3) * (1 - d));
        gain = (1 - 0.6f * d) * dbToGain (p[1]) * (p[3] > 0.5f ? -1.0f : 1.0f);
        delay = jlimit (0, (int) ring.size() - 1, (int) ((d * 0.002 + jlimit (0.0f, 3.0f, (float) p[4]) * 0.001) * sr));
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

// The cab's mic mixer: up to four mics summed to a stereo bus (the cab's L/R outs), each with a
// gain and a balance-law pan (centre = full level on both sides). Solo is resolved before it gets here.
struct MicMix : Node // p: gain1, pan1, gain2, pan2, gain3, pan3, gain4, pan4
{
    MicMix() : Node (4, 2) {}
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        FloatVectorOperations::clear (out[0], n);
        FloatVectorOperations::clear (out[1], n);
        for (int k = 0; k < 4; ++k)
        {
            const float g = p[(size_t) (2 * k)], pan = jlimit (-1.0f, 1.0f, (float) p[(size_t) (2 * k + 1)]);
            if (std::abs (g) < 1e-9f) continue;
            FloatVectorOperations::addWithMultiply (out[0], in[k], g * std::min (1.0f, 1.0f - pan), n);
            FloatVectorOperations::addWithMultiply (out[1], in[k], g * std::min (1.0f, 1.0f + pan), n);
        }
    }
};

// Pitch shifter: overlapping grains read the input back at the new speed and crossfade (sin² windows
// sum to one). Each new grain starts at the offset where it lines up best with the grain it fades
// into (input autocorrelation), so the splices don't comb or gargle the way blind splices do.
// Left and right detune in opposite directions for width. +12 with a little detune is a 12-string.
struct PitchShift : Node // p: interval semitones, detune cents, mix
{
    PitchShift() : Node (1, 2) {}
    struct Voice
    {
        struct Grain { float delay = 0; int age = 0; bool live = false; };
        std::array<Grain, 2> grains;
        int sinceStart = 1 << 30, nextGrain = 0;

        float next (const DelayLine& x, float ratio, int len, int search)
        {
            if (sinceStart >= len / 2)
            {
                auto& g = grains[(size_t) nextGrain];
                const auto& other = grains[(size_t) (1 - nextGrain)];
                const float start = 4.0f + std::max (0.0f, (float) len * (ratio - 1.0f));
                g = { start + (other.live ? bestOffset (x, other.delay, start, search) : 0.0f), 0, true };
                nextGrain = 1 - nextGrain;
                sinceStart = 0;
            }
            ++sinceStart;
            float sum = 0;
            for (auto& g : grains)
            {
                if (! g.live) continue;
                const float w = std::sin (MathConstants<float>::pi * (float) g.age / (float) len);
                sum += w * w * x.read (g.delay);
                g.delay -= ratio - 1.0f;
                g.live = ++g.age < len;
            }
            return sum;
        }

        // The extra delay (0..search) at which the input most resembles itself at `from`.
        static float bestOffset (const DelayLine& x, float from, float start, int search)
        {
            constexpr int window = 256;
            float best = -1e9f, at = 0;
            for (int k = 0; k <= search; k += 2)
            {
                float c = 0, e = 1e-9f;
                for (int j = 0; j < window; j += 2)
                {
                    const float v = x.read (start + (float) (k + j));
                    c += x.read (from + (float) j) * v;
                    e += v * v;
                }
                if (c / std::sqrt (e) > best) { best = c / std::sqrt (e); at = (float) k; }
            }
            return at;
        }
    };
    DelayLine line;
    Voice left, right;
    void prepare (int) override { line.prepare ((int) (sr * 0.12)); left = right = {}; }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const int len = (int) (0.03 * sr), search = (int) (0.012 * sr);
        const float base = (float) p[0] / 12.0f, cents = (float) p[1] / 1200.0f, mix = p[2];
        const float rl = std::pow (2.0f, base + cents), rr = std::pow (2.0f, base - cents);
        for (int i = 0; i < n; ++i)
        {
            line.push (in[0][i]);
            out[0][i] = in[0][i] + mix * left.next (line, rl, len, search);
            out[1][i] = in[0][i] + mix * right.next (line, rr, len, search);
        }
    }
};

// Acoustic simulator: an impulse response that turns a magnetic pickup into a miked acoustic. The
// curve adds the body's air and top resonances, scoops the boxy low mids a pickup is heavy in, and
// restores the string sparkle a pickup never had; dense ripple from 150 Hz up is the wood.
struct Acoustic : Node // p: body (dreadnought, jumbo, parlor, nylon), mix, top 0..10, level dB
{
    Acoustic() : Node (1, 1) {}
    Biquad top;
    dsp::Convolution conv;
    std::vector<float> dry;
    int loadedBody = -1;

    static Curve curveFor (int body)
    {
        static const Curve bodies[] = {
            { { 40, -20 }, { 70, -5 }, { 100, 2 }, { 140, 1 }, { 220, 0 }, { 320, -3 }, { 500, -7 }, { 800, -6 }, { 1300, -3 }, { 2200, -1 }, { 3500, 2 }, { 5500, 7 }, { 8000, 10 }, { 12000, 9 }, { 17000, 0 } }, // dreadnought
            { { 40, -16 }, { 65, -3 }, { 90, 3 }, { 130, 2 }, { 200, 1 }, { 320, -2 }, { 500, -6 }, { 800, -6 }, { 1300, -3 }, { 2200, -1 }, { 3500, 1 }, { 5500, 6 }, { 8000, 9 }, { 12000, 8 }, { 17000, 0 } },  // jumbo
            { { 40, -26 }, { 80, -10 }, { 120, -4 }, { 200, 0 }, { 260, 1 }, { 400, -3 }, { 650, -6 }, { 1000, -4 }, { 1800, -1 }, { 3000, 2 }, { 5000, 7 }, { 8000, 10 }, { 12000, 9 }, { 17000, 0 } },   // parlor
            { { 40, -20 }, { 75, -5 }, { 105, 2 }, { 180, 2 }, { 280, 0 }, { 450, -5 }, { 800, -5 }, { 1400, -3 }, { 2500, -1 }, { 4000, 1 }, { 6000, 3 }, { 9000, 2 }, { 13000, -4 }, { 17000, -12 } }, // nylon
        };
        return bodies[jlimit (0, 3, body)];
    }
    void prepare (int maxBlock) override
    {
        conv.prepare ({ sr, (uint32) maxBlock, 1 });
        dry.assign ((size_t) maxBlock, 0.0f);
        loadedBody = -1;
    }
    void configure() override
    {
        const int body = jlimit (0, 3, (int) p[0]);
        if (body == loadedBody) return;
        loadedBody = body;
        conv.loadImpulseResponse (designIr (sr, (int) (sr * 0.08), curveFor (body), 3.0f, 150, 41 + body), sr,
                                  dsp::Convolution::Stereo::no, dsp::Convolution::Trim::no, dsp::Convolution::Normalise::no);
    }
    void retune() override { top.set (Biquad::HighShelf, sr, 7000, 0.7, (p[2] - 5) * 1.5); }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        FloatVectorOperations::copy (dry.data(), in[0], n);
        FloatVectorOperations::copy (out[0], in[0], n);
        dsp::AudioBlock<float> block (const_cast<float**> (out), 1, (size_t) n);
        conv.process (dsp::ProcessContextReplacing<float> (block));
        const float mix = p[1], level = dbToGain (p[3]);
        for (int i = 0; i < n; ++i)
            out[0][i] = top ((1 - mix) * dry[(size_t) i] + mix * out[0][i]) * level;
    }
};

// Tuner: mutes the signal while engaged. The UI asks detect() for the pitch.
struct Tuner : Node // p: reference A4 Hz
{
    Tuner() : Node (1, 1) {}
    static constexpr int size = 8192;
    std::array<std::atomic<float>, size> ring {};
    std::atomic<int> w { 0 };

    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        feed (in[0], n);
        FloatVectorOperations::clear (out[0], n);
    }

    // Audio thread: listen to `n` samples. The standalone tuner calls this with the raw input.
    void feed (const float* x, int n)
    {
        int wi = w.load (std::memory_order_relaxed);
        for (int i = 0; i < n; ++i)
        {
            ring[(size_t) wi].store (x[i], std::memory_order_relaxed);
            wi = (wi + 1) & (size - 1);
        }
        w.store (wi, std::memory_order_release);
    }

    // Message thread. YIN pitch estimate in Hz over the latest samples; 0 when there's no clear note.
    float detect() const
    {
        const int maxLag = (int) (sr / 60.0), minLag = (int) (sr / 1400.0);
        const int len = std::min (size, maxLag * 2 + 1024);
        std::vector<float> x ((size_t) len);
        const int end = w.load (std::memory_order_acquire);
        double energy = 0;
        for (int i = 0; i < len; ++i)
        {
            x[(size_t) i] = ring[(size_t) ((end - len + i + size) & (size - 1))].load (std::memory_order_relaxed);
            energy += x[(size_t) i] * x[(size_t) i];
        }
        if (std::sqrt (energy / len) < 0.003)
            return 0.0f;

        const int window = len - maxLag;
        std::vector<float> d ((size_t) maxLag + 1, 1.0f);
        double running = 0;
        for (int tau = 1; tau <= maxLag; ++tau)
        {
            double sum = 0;
            for (int i = 0; i < window; ++i)
            {
                const float diff = x[(size_t) i] - x[(size_t) (i + tau)];
                sum += diff * diff;
            }
            running += sum;
            d[(size_t) tau] = running > 0 ? (float) (sum * tau / running) : 1.0f; // cumulative mean normalised
        }
        for (int tau = minLag; tau < maxLag; ++tau)
        {
            if (d[(size_t) tau] < 0.15f)
            {
                while (tau + 1 < maxLag && d[(size_t) tau + 1] < d[(size_t) tau]) ++tau;
                const float a = d[(size_t) tau - 1], b = d[(size_t) tau], c = d[(size_t) tau + 1];
                const float shift = (a - c) / (2.0f * (a - 2.0f * b + c) + 1e-12f); // parabolic refinement
                return (float) (sr / ((float) tau + jlimit (-1.0f, 1.0f, shift)));
            }
        }
        return 0.0f;
    }
};

struct Gate : Node // p: threshold dB, release ms
{
    Gate() : Node (1, 1) {}
    Envelope env;
    float gain = 0, gainAtt = 0, gainRel = 0;
    bool open = false;
    std::atomic<bool> openOut { false }; // for the pedal's light

    void retune() override
    {
        env.set (sr, 1, 50);
        gainAtt = (float) std::exp (-1.0 / (0.001 * sr));
        gainRel = (float) std::exp (-1.0 / (p[1] * 0.001 * sr));
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float openAt = dbToGain (p[0]), closeAt = openAt * 0.5f; // 6 dB hysteresis stops chatter
        for (int i = 0; i < n; ++i)
        {
            const float e = env (in[0][i]);
            open = open ? e > closeAt : e > openAt;
            gain = open ? gainAtt * gain + (1 - gainAtt) : gainRel * gain;
            out[0][i] = in[0][i] * gain;
        }
        openOut.store (open, std::memory_order_relaxed);
    }
};

struct Compressor : Node // p: threshold dB, ratio, attack ms, release ms, makeup dB
{
    Compressor() : Node (1, 1) {}
    Envelope env;
    void retune() override { env.set (sr, p[2], p[3]); }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float threshold = p[0], slope = 1.0f - 1.0f / std::max (1.0f, (float) p[1]), makeup = p[4];
        for (int i = 0; i < n; ++i)
        {
            const float levelDb = Decibels::gainToDecibels (env (in[0][i]), -120.0f);
            const float reduction = std::max (0.0f, levelDb - threshold) * slope;
            out[0][i] = in[0][i] * dbToGain (makeup - reduction);
        }
    }
};

// Analog-style octaver: a flip-flop on each zero crossing makes the octave down; full-wave
// rectifying makes the octave up. Glitchy on chords, like the real thing.
struct Octave : Node // p: dry, sub, up
{
    Octave() : Node (1, 1) {}
    Biquad track, subLp, upHp;
    Envelope env;
    bool flip = false, above = false;

    void retune() override
    {
        track.set (Biquad::LowPass, sr, 700);
        subLp.set (Biquad::LowPass, sr, 900);
        upHp.set (Biquad::HighPass, sr, 80);
        env.set (sr, 2, 60);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        for (int i = 0; i < n; ++i)
        {
            const float x = in[0][i], t = track (x), level = env (x);
            if (! above && t > 0.002f) { above = true; flip = ! flip; }
            else if (above && t < -0.002f) above = false;
            const float sub = subLp ((flip ? 1.0f : -1.0f) * level);
            const float up = upHp (std::abs (x));
            out[0][i] = p[0] * x + p[1] * sub * 1.5f + p[2] * up * 1.5f;
        }
    }
};

struct Eq : Node // p: 100, 200, 400, 800, 1600, 3200, 6400 Hz bands (dB), level dB
{
    Eq() : Node (1, 1) {}
    std::array<Biquad, 7> bands;
    void retune() override
    {
        for (size_t b = 0; b < bands.size(); ++b)
            bands[b].set (Biquad::Peak, sr, 100.0 * std::pow (2.0, (double) b), 1.1, p[b]);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float level = dbToGain (p[7]);
        for (int i = 0; i < n; ++i)
        {
            float x = in[0][i];
            for (auto& b : bands) x = b (x);
            out[0][i] = x * level;
        }
    }
};

// Wah: a resonant lowpass swept 350 Hz (heel) to 2.2 kHz (toe) by the treadle.
struct Wah : Node // p: position 0..1, q
{
    Wah() : Node (1, 1) {}
    Biquad filter;
    SmoothedValue<float> freq;
    void prepare (int) override { freq.reset (sr, 0.03); freq.setCurrentAndTargetValue (hz()); }
    float hz() const { return 350.0f * std::pow (2200.0f / 350.0f, (float) p[0]); }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        freq.setTargetValue (hz());
        const float q = p[1], makeup = 1.0f / (1.0f + (q - 1.0f) * 0.08f);
        for (int i = 0; i < n; i += 16) // retune every 16 samples while the treadle moves
        {
            freq.skip (std::min (16, n - i) - 1);
            filter.set (Biquad::LowPass, sr, freq.getNextValue(), q);
            for (int j = i; j < std::min (n, i + 16); ++j)
                out[0][j] = filter (in[0][j]) * makeup;
        }
    }
};

struct Volume : Node // p: position 0..1
{
    Volume() : Node (1, 1) {}
    SmoothedValue<float> gain;
    void prepare (int) override { gain.reset (sr, 0.03); gain.setCurrentAndTargetValue (p[0] * p[0]); }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        gain.setTargetValue (p[0] * p[0]); // audio taper
        for (int i = 0; i < n; ++i)
            out[0][i] = in[0][i] * gain.getNextValue();
    }
};

// Chorus: a 12 ms delay wobbled by an LFO; left and right LFOs 90° apart for width.
struct Chorus : Node // p: rate Hz, depth, mix
{
    Chorus() : Node (1, 2) {}
    DelayLine line;
    Lfo lfo;
    void prepare (int) override { line.prepare ((int) (sr * 0.05)); }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float base = (float) (0.012 * sr), swing = (float) (p[1] * 0.004 * sr), mix = p[2];
        for (int i = 0; i < n; ++i)
        {
            const float x = in[0][i];
            line.push (x);
            const double ph = lfo.phase;
            const float l = line.read (base + swing * lfo.next (p[0], sr));
            const float r = line.read (base + swing * (float) std::sin ((ph + 0.25) * MathConstants<double>::twoPi));
            out[0][i] = (1 - mix) * x + mix * l;
            out[1][i] = (1 - mix) * x + mix * r;
        }
    }
};

struct Flanger : Node // p: rate Hz, depth, feedback, mix
{
    Flanger() : Node (1, 1) {}
    DelayLine line;
    Lfo lfo;
    float last = 0;
    void prepare (int) override { line.prepare ((int) (sr * 0.02)); }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float mix = p[3];
        for (int i = 0; i < n; ++i)
        {
            const float sweep = 0.5f + 0.5f * lfo.next (p[0], sr);
            const float d = (float) ((0.001 + p[1] * 0.004 * sweep) * sr);
            line.push (in[0][i] + p[2] * last);
            last = line.read (d);
            out[0][i] = (1 - mix) * in[0][i] + mix * last;
        }
    }
};

// Phaser: first-order allpass stages swept 200 Hz - 2 kHz, mixed 50/50 with the dry signal.
struct Phaser : Node // p: rate Hz, depth, feedback, stages (4/6/8)
{
    Phaser() : Node (1, 1) {}
    std::array<float, 8> x1 {}, y1 {};
    Lfo lfo;
    float last = 0;
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const int stages = 4 + 2 * jlimit (0, 2, (int) p[3]);
        for (int i = 0; i < n; ++i)
        {
            const float hz = 200.0f * std::pow (10.0f, p[1] * (0.5f + 0.5f * lfo.next (p[0], sr)));
            const float t = std::tan (MathConstants<float>::pi * std::min (hz, (float) sr * 0.45f) / (float) sr);
            const float a = (t - 1) / (t + 1);
            float s = in[0][i] + p[2] * last;
            for (size_t k = 0; k < (size_t) stages; ++k)
            {
                const float y = a * s + x1[k] - a * y1[k];
                x1[k] = s;
                y1[k] = y;
                s = y;
            }
            last = s;
            out[0][i] = 0.5f * (in[0][i] + s);
        }
    }
};

struct Tremolo : Node // p: rate Hz, depth, shape (sine/square)
{
    Tremolo() : Node (1, 1) {}
    Lfo lfo;
    float smooth = 0;
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float k = (float) std::exp (-1.0 / (0.002 * sr)); // rounds the square's edges: no clicks
        for (int i = 0; i < n; ++i)
        {
            float v = lfo.next (p[0], sr);
            if (p[2] > 0.5f) v = v >= 0 ? 1.0f : -1.0f;
            smooth = k * smooth + (1 - k) * v;
            out[0][i] = in[0][i] * (1.0f - p[1] * (0.5f + 0.5f * smooth));
        }
    }
};

// Delay: echoes added on top of the dry signal. Digital repeats stay clean; tape repeats wobble
// (wow and flutter), lose lows and highs and saturate; analog (bucket brigade) repeats get darker
// fast. Ping-pong bounces the repeats between the left and right outputs.
struct Delay : Node // p: model, time ms, feedback, tone 0..10, mix, pingpong
{
    Delay() : Node (1, 2) {}
    DelayLine left, right;
    Biquad toneL, toneR, hpL, hpR;
    Lfo wow, flutter;
    SmoothedValue<float> time;
    int model = 0;
    void prepare (int) override
    {
        left.prepare ((int) (sr * 2.1));
        right.prepare ((int) (sr * 2.1));
        time.reset (sr, 0.1);
        time.setCurrentAndTargetValue ((float) (p[1] * 0.001 * sr));
    }
    void retune() override
    {
        model = (int) p[0];
        const double t = p[3] / 10.0;
        const double hz = model == 0 ? 1000 * std::pow (12.0, t) : model == 1 ? 800 * std::pow (6.0, t) : 600 * std::pow (5.0, t);
        toneL.set (Biquad::LowPass, sr, hz);
        toneR.set (Biquad::LowPass, sr, hz);
        hpL.set (Biquad::HighPass, sr, model == 1 ? 150 : model == 2 ? 80 : 20);
        hpR.set (Biquad::HighPass, sr, model == 1 ? 150 : model == 2 ? 80 : 20);
    }
    float repeat (float v, Biquad& tone, Biquad& hp) const
    {
        v = hp (tone (v));
        return model == 1 ? std::tanh (v * 1.3f) / 1.3f : v;
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        time.setTargetValue ((float) (p[1] * 0.001 * sr));
        const float fb = p[2], mix = p[4];
        const bool pingPong = p[5] > 0.5f;
        for (int i = 0; i < n; ++i)
        {
            float d = time.getNextValue();
            if (model == 1) d *= 1.0f + 0.003f * wow.next (0.5f, sr) + 0.0006f * flutter.next (6.0f, sr);
            else if (model == 2) d *= 1.0f + 0.001f * wow.next (0.4f, sr);
            const float x = in[0][i], l = left.read (d), r = right.read (d);
            if (pingPong)
            {
                left.push (x + fb * repeat (r, toneR, hpR));
                right.push (fb * repeat (l, toneL, hpL));
            }
            else
            {
                left.push (x + fb * repeat (l, toneL, hpL));
                right.push (x + fb * repeat (r, toneR, hpR));
            }
            out[0][i] = x + mix * l;
            out[1][i] = x + mix * r;
        }
    }
};

// Reverb, added on top of the dry signal. Room, hall and plate use JUCE's stereo reverb with
// different sizes and damping (the plate bright and thin in the lows). Spring is its own thing:
// two delay lines with a chain of allpass filters in the loop, which smears each echo into the
// familiar drip.
struct Reverb : Node // p: model, decay s, predelay ms, tone 0..10, mix
{
    Reverb() : Node (2, 2) {}
    juce::Reverb verb;
    DelayLine preL, preR;
    Biquad wetHpL, wetHpR;
    struct Spring
    {
        DelayLine line;
        std::array<float, 8> x1 {}, y1 {};
        Biquad lp, hp;
        float last = 0;
        float process (float x, float feedback, float length)
        {
            float v = lp (x) + feedback * last;
            for (size_t k = 0; k < x1.size(); ++k) // dispersion: high frequencies arrive first
            {
                const float y = 0.65f * v + x1[k] - 0.65f * y1[k];
                x1[k] = v;
                y1[k] = y;
                v = y;
            }
            line.push (v);
            last = line.read (length);
            return hp (last);
        }
    } springL, springR;
    int model = 0;

    void prepare (int) override
    {
        verb.setSampleRate (sr);
        preL.prepare ((int) (sr * 0.25));
        preR.prepare ((int) (sr * 0.25));
        springL.line.prepare ((int) (sr * 0.1));
        springR.line.prepare ((int) (sr * 0.1));
    }
    void retune() override
    {
        model = (int) p[0];
        const float size = jlimit (0.0f, 1.0f, std::log (p[1] / 0.2f) / std::log (50.0f)), bright = p[3] / 10.0f;
        juce::Reverb::Parameters r;
        r.roomSize = model == 0 ? 0.2f + 0.4f * size : model == 1 ? 0.3f + 0.68f * size : 0.5f + 0.45f * size;
        r.damping = model == 2 ? 0.25f * (1 - bright) : 1.0f - bright * 0.9f;
        r.width = model == 0 ? 0.7f : 1.0f;
        r.wetLevel = 1.0f;
        r.dryLevel = 0.0f;
        verb.setParameters (r);
        wetHpL.set (Biquad::HighPass, sr, model == 2 ? 300 : 60);
        wetHpR.set (Biquad::HighPass, sr, model == 2 ? 300 : 60);
        for (auto* s : { &springL, &springR })
        {
            s->lp.set (Biquad::LowPass, sr, 2500 + 2500 * bright);
            s->hp.set (Biquad::HighPass, sr, 250);
        }
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float mix = p[4];
        if (model == 3)
        {
            const float fb = 0.4f + 0.5f * jlimit (0.0f, 1.0f, std::log (p[1] / 0.2f) / std::log (50.0f));
            for (int i = 0; i < n; ++i)
            {
                out[0][i] = in[0][i] + mix * springL.process (in[0][i], fb, (float) (0.035 * sr));
                out[1][i] = in[1][i] + mix * springR.process (in[1][i], fb, (float) (0.041 * sr));
            }
            return;
        }
        const float d = std::max (1.0f, (float) (p[2] * 0.001 * sr));
        for (int i = 0; i < n; ++i)
        {
            preL.push (in[0][i]);
            preR.push (in[1][i]);
            out[0][i] = preL.read (d);
            out[1][i] = preR.read (d);
        }
        verb.processStereo (out[0], out[1], n);
        for (int i = 0; i < n; ++i)
        {
            out[0][i] = in[0][i] + mix * wetHpL (out[0][i]);
            out[1][i] = in[1][i] + mix * wetHpR (out[1][i]);
        }
    }
};

// Looper: one 60 s loop. The main switch goes record → play → overdub → play…; Undo removes the
// last overdub session (restored a chunk per block, so it never stalls the audio thread).
struct Looper : Node // p: level
{
    Looper() : Node (1, 1) {}
    enum Mode { Empty, Recording, Playing, Overdubbing, Stopped };
    enum Command { None, Main, Stop, Undo, Clear };
    std::atomic<int> command { None };
    std::atomic<int> modeOut { Empty }, lengthOut { 0 }, positionOut { 0 }; // for the UI

    void prepare (int) override
    {
        buf.assign ((size_t) (sr * 60), 0.0f);
        prev.assign (buf.size(), 0.0f);
        mode = Empty;
        len = pos = written = restoreLeft = 0;
    }

    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        handle (command.exchange (None));
        restoreChunk (16384);
        const int max = (int) buf.size();
        for (int i = 0; i < n; ++i)
        {
            const float x = in[0][i];
            float loop = 0;
            if (mode == Recording)
            {
                buf[(size_t) pos] = x;
                if (++pos >= max) { len = max; pos = 0; mode = Playing; }
            }
            else if (mode == Playing || mode == Overdubbing)
            {
                loop = buf[(size_t) pos];
                if (mode == Overdubbing)
                {
                    if (written < len) { prev[(size_t) pos] = buf[(size_t) pos]; ++written; } // first pass saves the old layer
                    buf[(size_t) pos] += x;
                }
                pos = (pos + 1) % len;
            }
            out[0][i] = x + loop * p[0];
        }
        modeOut = mode;
        lengthOut = mode == Recording ? pos : len;
        positionOut = pos;
    }

private:
    void handle (int cmd)
    {
        switch (cmd)
        {
            case Main:
                if (mode == Empty) { pos = 0; mode = Recording; }
                else if (mode == Recording) { len = std::max (1, pos); pos = 0; mode = Playing; }
                else if (mode == Playing) { restoreChunk ((int) buf.size()); startPos = pos; written = 0; mode = Overdubbing; }
                else if (mode == Overdubbing) mode = Playing;
                else if (mode == Stopped) { pos = 0; mode = Playing; }
                break;
            case Stop:
                if (mode == Recording) len = std::max (1, pos);
                if (mode != Empty) { pos = 0; mode = Stopped; }
                break;
            case Undo:
                if (mode == Recording || written == 0) break;
                if (mode == Overdubbing) mode = Playing;
                restoreAt = startPos;
                restoreLeft = written;
                written = 0;
                break;
            case Clear:
                mode = Empty;
                len = pos = written = restoreLeft = 0;
                break;
            default: break;
        }
    }

    void restoreChunk (int maxSamples)
    {
        for (int k = std::min (restoreLeft, maxSamples); k > 0; --k, --restoreLeft)
        {
            buf[(size_t) restoreAt] = prev[(size_t) restoreAt];
            restoreAt = (restoreAt + 1) % len;
        }
    }

    std::vector<float> buf, prev;
    int mode = Empty, len = 0, pos = 0, startPos = 0, written = 0, restoreAt = 0, restoreLeft = 0;
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
    else if (type == "cab" || type == "cab/spk") n = std::make_shared<Cab>();
    else if (type == "cab/mix") n = std::make_shared<MicMix>();
    else if (type == "mic") n = std::make_shared<Mic>();
    else if (type == "tuner") n = std::make_shared<Tuner>();
    else if (type == "gate") n = std::make_shared<Gate>();
    else if (type == "compressor") n = std::make_shared<Compressor>();
    else if (type == "octave") n = std::make_shared<Octave>();
    else if (type == "eq") n = std::make_shared<Eq>();
    else if (type == "wah") n = std::make_shared<Wah>();
    else if (type == "volume") n = std::make_shared<Volume>();
    else if (type == "chorus") n = std::make_shared<Chorus>();
    else if (type == "flanger") n = std::make_shared<Flanger>();
    else if (type == "phaser") n = std::make_shared<Phaser>();
    else if (type == "tremolo") n = std::make_shared<Tremolo>();
    else if (type == "delay") n = std::make_shared<Delay>();
    else if (type == "reverb") n = std::make_shared<Reverb>();
    else if (type == "looper") n = std::make_shared<Looper>();
    else if (type == "pitch") n = std::make_shared<PitchShift>();
    else if (type == "acoustic") n = std::make_shared<Acoustic>();
    else n = std::make_shared<PassThrough> (1, 1);
    n->type = type;
    return n;
}

} // namespace rig
