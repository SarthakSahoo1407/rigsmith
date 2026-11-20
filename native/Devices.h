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

// Tuner: mutes the signal while engaged. The UI asks detect() for the pitch.
struct Tuner : Node // p: reference A4 Hz
{
    Tuner() : Node (1, 1) {}
    static constexpr int size = 8192;
    std::array<std::atomic<float>, size> ring {};
    std::atomic<int> w { 0 };

    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        int wi = w.load (std::memory_order_relaxed);
        for (int i = 0; i < n; ++i)
        {
            ring[(size_t) wi].store (in[0][i], std::memory_order_relaxed);
            wi = (wi + 1) & (size - 1);
            out[0][i] = 0.0f;
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
        const float q = p[1], makeup = 1.5f / std::max (1.0f, q);
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

// Delay: echoes added on top of the dry signal; tone darkens each repeat. Ping-pong bounces
// the repeats between the left and right outputs.
struct Delay : Node // p: time ms, feedback, tone 0..10, mix, pingpong
{
    Delay() : Node (1, 2) {}
    DelayLine left, right;
    Biquad toneL, toneR;
    SmoothedValue<float> time;
    void prepare (int) override
    {
        left.prepare ((int) (sr * 2.1));
        right.prepare ((int) (sr * 2.1));
        time.reset (sr, 0.1);
        time.setCurrentAndTargetValue ((float) (p[0] * 0.001 * sr));
    }
    void retune() override
    {
        const double hz = 1000.0 * std::pow (12.0, p[2] / 10.0);
        toneL.set (Biquad::LowPass, sr, hz);
        toneR.set (Biquad::LowPass, sr, hz);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        time.setTargetValue ((float) (p[0] * 0.001 * sr));
        const float fb = p[1], mix = p[3];
        const bool pingPong = p[4] > 0.5f;
        for (int i = 0; i < n; ++i)
        {
            const float x = in[0][i], d = time.getNextValue();
            const float l = left.read (d), r = right.read (d);
            if (pingPong)
            {
                left.push (x + fb * toneR (r));
                right.push (fb * toneL (l));
            }
            else
            {
                left.push (x + fb * toneL (l));
                right.push (x + fb * toneR (r));
            }
            out[0][i] = x + mix * l;
            out[1][i] = x + mix * r;
        }
    }
};

// Reverb: pre-delay into JUCE's Freeverb-style stereo reverb, added on top of the dry signal.
struct Reverb : Node // p: decay s, predelay ms, tone 0..10, mix
{
    Reverb() : Node (2, 2) {}
    juce::Reverb verb;
    DelayLine preL, preR;
    void prepare (int) override
    {
        verb.setSampleRate (sr);
        preL.prepare ((int) (sr * 0.25));
        preR.prepare ((int) (sr * 0.25));
    }
    void retune() override
    {
        juce::Reverb::Parameters r;
        r.roomSize = jlimit (0.0f, 1.0f, 0.3f + 0.68f * std::log (p[0] / 0.2f) / std::log (50.0f));
        r.damping = 1.0f - p[2] / 10.0f * 0.9f;
        r.wetLevel = 1.0f;
        r.dryLevel = 0.0f;
        r.width = 1.0f;
        verb.setParameters (r);
    }
    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        const float d = std::max (1.0f, (float) (p[1] * 0.001 * sr));
        for (int i = 0; i < n; ++i)
        {
            preL.push (in[0][i]);
            preR.push (in[1][i]);
            out[0][i] = preL.read (d);
            out[1][i] = preR.read (d);
        }
        verb.processStereo (out[0], out[1], n);
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < n; ++i)
                out[c][i] = in[c][i] + p[3] * out[c][i];
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
    else if (type == "cab") n = std::make_shared<Cab>();
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
    else n = std::make_shared<PassThrough> (1, 1);
    n->type = type;
    return n;
}

} // namespace rig
