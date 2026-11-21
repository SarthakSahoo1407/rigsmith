// DSP building blocks shared by every device: filters, oversampled shaper, delay line, LFO, and
// the Node base class each device implements.

#pragma once
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_dsp/juce_dsp.h>
#include "Platform.h"

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
    explicit Shaper (size_t factorLog2 = 2) : os (1, factorLog2, dsp::Oversampling<float>::filterHalfBandPolyphaseIIR, true, false) {}
    dsp::Oversampling<float> os;
    double rate (double sr) const { return sr * (double) os.getOversamplingFactor(); }
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
    std::array<std::atomic<float>, 32> p {}; // knob values, in catalog order (src/catalog.ts)
    std::map<String, String> files;          // message thread: slot ("model", "irA"...) → a library file's full path
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

    // Message thread, after knob values arrive: for work that may allocate, like loading an IR.
    virtual void configure() {}

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


// Ring buffer read back at a fractional delay. Sized once in prepare, never on the audio thread.
struct DelayLine
{
    std::vector<float> buf { 0.0f, 0.0f, 0.0f };
    int w = 0;

    void prepare (int size) { buf.assign ((size_t) std::max (4, size), 0.0f); w = 0; }
    void push (float x) { buf[(size_t) w] = x; w = (w + 1) % (int) buf.size(); }

    // The sample written `d` samples ago (d = 1 is the newest), linearly interpolated.
    float read (float d) const
    {
        const int size = (int) buf.size();
        d = jlimit (1.0f, (float) size - 2.0f, d);
        float r = (float) w - d;
        if (r < 0) r += (float) size;
        const int i0 = (int) r, i1 = (i0 + 1) % size;
        const float f = r - (float) i0;
        return buf[(size_t) i0] + f * (buf[(size_t) i1] - buf[(size_t) i0]);
    }
};

struct Lfo
{
    double phase = 0;
    // Sine at `hz`, `offset` turns of phase ahead (0.25 = 90°).
    float next (float hz, double sr, double offset = 0)
    {
        const float v = (float) std::sin ((phase + offset) * MathConstants<double>::twoPi);
        phase += hz / sr;
        phase -= std::floor (phase);
        return v;
    }
};

// One-pole envelope follower with separate attack and release times.
struct Envelope
{
    float att = 0, rel = 0, env = 0;
    void set (double sr, double attackMs, double releaseMs)
    {
        att = (float) std::exp (-1.0 / (std::max (0.01, attackMs) * 0.001 * sr));
        rel = (float) std::exp (-1.0 / (std::max (0.01, releaseMs) * 0.001 * sr));
    }
    float operator() (float x)
    {
        const float a = std::abs (x);
        env = a > env ? att * env + (1 - att) * a : rel * env + (1 - rel) * a;
        return env;
    }
};

// A minimum-phase impulse response whose magnitude follows `curve` ({Hz, dB} points, joined on a
// log-frequency axis), plus seeded ripple: narrow random peaks and notches above `rippleFrom` Hz, the
// fine detail (cone break-up, wood modes) that makes a measured response sound real and an EQ sound
// like an EQ. Minimum phase via the folded cepstrum, so the IR starts at once and adds no latency.
using Curve = std::vector<std::pair<float, float>>;
inline AudioBuffer<float> designIr (double sr, int length, const Curve& curve, float rippleDb = 0, float rippleFrom = 1000, int seed = 1)
{
    constexpr int order = 14, N = 1 << order;
    dsp::FFT fft (order);
    struct Bump { float hz, db, width; };
    std::vector<Bump> bumps;
    Random rng (seed);
    for (int i = 0; i < 24 && rippleDb > 0; ++i)
        bumps.push_back ({ rippleFrom * std::pow (12000.0f / rippleFrom, rng.nextFloat()), (rng.nextFloat() * 2 - 1) * rippleDb, 0.03f + 0.06f * rng.nextFloat() });
    auto dbAt = [&] (float hz) {
        hz = std::max (hz, 1.0f);
        float db = curve.front().second;
        for (size_t i = 1; i < curve.size(); ++i)
            if (hz >= curve[i - 1].first)
            {
                const float a = std::log (curve[i - 1].first), b = std::log (curve[i].first);
                db = hz >= curve[i].first ? curve[i].second
                                          : curve[i - 1].second + (std::log (hz) - a) / (b - a) * (curve[i].second - curve[i - 1].second);
            }
        for (const auto& k : bumps)
        {
            const float o = std::log2 (hz / k.hz) / k.width; // distance in bump widths (octaves)
            db += k.db * std::exp (-o * o);
        }
        return std::max (db, -90.0f);
    };

    std::vector<dsp::Complex<float>> a ((size_t) N), b ((size_t) N);
    for (int k = 0; k < N; ++k)
    {
        const int bin = k <= N / 2 ? k : N - k;
        a[(size_t) k] = { dbAt ((float) (bin * sr / N)) * 0.11512925f, 0.0f }; // dB to natural log
    }
    fft.perform (a.data(), b.data(), true); // real cepstrum
    for (int k = 1; k < N / 2; ++k) b[(size_t) k] *= 2.0f;
    for (int k = N / 2 + 1; k < N; ++k) b[(size_t) k] = 0.0f;
    fft.perform (b.data(), a.data(), false);
    for (auto& v : a) v = std::exp (v);
    fft.perform (a.data(), b.data(), true);

    length = std::min (length, N);
    AudioBuffer<float> ir (1, length);
    const int fade = length / 8;
    for (int i = 0; i < length; ++i)
        ir.setSample (0, i, b[(size_t) i].real() * (i > length - fade ? (float) (length - i) / (float) fade : 1.0f));
    return ir;
}

// Captures and IRs live in one folder, by kind: Library/nam/*.nam, Library/ir/*.wav.
// A library id is "<kind>/<file name>"; anything that tries to leave the folder resolves to nothing.
inline File libraryDir()
{
    auto d = platform::dataDir().getChildFile ("Library");
    d.getChildFile ("nam").createDirectory();
    d.getChildFile ("ir").createDirectory();
    return d;
}
inline File libraryFile (const String& id)
{
    const auto kind = id.upToFirstOccurrenceOf ("/", false, false), name = id.fromFirstOccurrenceOf ("/", false, false);
    if ((kind != "nam" && kind != "ir") || name.isEmpty()) return {};
    const auto f = libraryDir().getChildFile (kind).getChildFile (File::createLegalFileName (name));
    return f.isAChildOf (libraryDir()) ? f : File();
}

} // namespace rig
