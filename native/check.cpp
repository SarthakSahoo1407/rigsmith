// Offline check of the audio engine: feeds a sine through compiled rigs and asserts on the output.
// Build and run: cmake --build native/build --target RigCheck && native/build/RigCheck_artefacts/Release/RigCheck

#include "Engine.h"
#include "RigFile.h"
#include <cstdio>

using namespace juce;

static int failures = 0;
#define CHECK(cond) do { if (! (cond)) { std::printf ("FAIL line %d: %s\n", __LINE__, #cond); ++failures; } } while (0)

constexpr int N = 64;
constexpr double SR = 48000.0;

struct Rendered { float l, r, in, diff; bool finite; };

// Runs `blocks` blocks of a 440 Hz sine (amplitude 0.25) into input channel 0.
// Returns RMS of the last block's input and outputs, and how far L strays from the input.
static Rendered run (rig::Engine& e, int blocks = 40)
{
    static double phase = 0;
    std::vector<float> in (N), l (N), r (N);
    const float* ins[] = { in.data() };
    float* outs[] = { l.data(), r.data() };
    Rendered res {};
    for (int b = 0; b < blocks; ++b)
    {
        for (auto& x : in) { x = 0.25f * (float) std::sin (phase); phase += MathConstants<double>::twoPi * 440.0 / SR; }
        e.audioDeviceIOCallbackWithContext (ins, 1, outs, 2, N, {});
        e.collectGarbage();
    }
    double sl = 0, sr = 0, si = 0, d = 0;
    res.finite = true;
    for (int i = 0; i < N; ++i)
    {
        sl += l[(size_t) i] * l[(size_t) i];
        sr += r[(size_t) i] * r[(size_t) i];
        si += in[(size_t) i] * in[(size_t) i];
        d += std::abs (l[(size_t) i] - in[(size_t) i]);
        res.finite = res.finite && std::isfinite (l[(size_t) i]) && std::isfinite (r[(size_t) i]);
    }
    res.l = (float) std::sqrt (sl / N);
    res.r = (float) std::sqrt (sr / N);
    res.in = (float) std::sqrt (si / N);
    res.diff = (float) (d / N);
    return res;
}

static var rigJson (const char* text) { return JSON::parse (String (text)); }

static bool near (float a, float b, float tol = 0.005f) { return std::abs (a - b) < tol; }


// Renders one node directly over `in` (one vector per input jack) and returns its outputs.
static std::vector<std::vector<float>> renderNode (rig::Node& node, const std::vector<std::vector<float>>& in)
{
    const int len = (int) in[0].size();
    std::vector<std::vector<float>> out ((size_t) std::max (1, node.numOuts), std::vector<float> ((size_t) len));
    std::vector<float> mix ((size_t) N);
    rig::IO io;
    io.mixL = io.mixR = mix.data();
    for (int s = 0; s < len; s += N)
    {
        std::vector<const float*> ip;
        std::vector<float*> op;
        for (auto& v : in) ip.push_back (v.data() + s);
        for (auto& v : out) op.push_back (v.data() + s);
        node.process (ip.data(), op.data(), std::min (N, len - s), io);
    }
    return out;
}

static std::shared_ptr<rig::Node> make (const char* type, const std::vector<float>& params)
{
    auto node = rig::makeNode (type);
    size_t i = 0;
    for (float v : params) node->p[i++] = v;
    node->prepareNode (SR, N);
    node->configure();
    Thread::sleep (60); // convolution IRs load on a background thread
    return node;
}

static std::vector<float> sine (float hz, float amp, int len)
{
    std::vector<float> v ((size_t) len);
    for (int i = 0; i < len; ++i) v[(size_t) i] = amp * (float) std::sin (MathConstants<double>::twoPi * hz * i / SR);
    return v;
}

static float rms (const std::vector<float>& v, int from = 0)
{
    double s = 0;
    for (size_t i = (size_t) from; i < v.size(); ++i) s += v[i] * v[i];
    return (float) std::sqrt (s / double (v.size() - (size_t) from));
}

static void checkDevices()
{
    const int second = (int) SR;

    { // Delay: one echo 100 ms after the dry impulse.
        auto d = make ("delay", { 0, 100, 0, 10, 1, 0 });
        std::vector<float> imp ((size_t) second / 5);
        imp[0] = 1;
        auto out = renderNode (*d, { imp });
        int at = 1;
        for (int i = 1; i < (int) out[0].size(); ++i) if (std::abs (out[0][(size_t) i]) > std::abs (out[0][(size_t) at])) at = i;
        CHECK (std::abs (at - second / 10) <= 1);
        CHECK (near (out[1][(size_t) at], out[0][(size_t) at], 1e-7f)); // plain delay: same echo on both sides
    }
    { // IR designer: a flat curve is a single click; -20 dB is a click a tenth as loud.
        auto flat = rig::designIr (SR, 1024, { { 100, 0 }, { 1000, 0 } });
        auto quiet = rig::designIr (SR, 1024, { { 100, -20 }, { 1000, -20 } });
        float tail = 0;
        for (int i = 1; i < 1024; ++i) tail += std::abs (flat.getSample (0, i));
        CHECK (near (flat.getSample (0, 0), 1.0f, 0.01f) && tail < 0.01f);
        CHECK (near (quiet.getSample (0, 0), 0.1f, 0.005f));
    }
    { // Cab: a 4x12 with aggressive speakers passes the upper mids and cuts the fizz above 6 kHz.
        auto level = [&] (float hz) {
            auto c = make ("cab", { 2, 1 });
            return Decibels::gainToDecibels (rms (renderNode (*c, { sine (hz, 0.1f, second / 2) })[0], second / 4));
        };
        const float mids = level (2500), fizz = level (8000);
        if (! (fizz < mids - 20)) std::printf ("  cab: 2.5k %.1f dB, 8k %.1f dB\n", mids, fizz);
        CHECK (fizz < mids - 20);
    }
    { // Gate: shuts out hiss below the threshold, passes playing above it.
        auto g = make ("gate", { -50, 50 });
        CHECK (rms (renderNode (*g, { sine (440, 0.0005f, second) })[0], second / 2) < 1e-5f);
        const auto loud = sine (440, 0.1f, second);
        CHECK (near (rms (renderNode (*g, { loud })[0], second / 2), rms (loud, second / 2), 0.002f));
    }
    { // Compressor: a hot signal 26 dB over the threshold comes out much quieter.
        auto c = make ("compressor", { -20, 10, 1, 50, 0 });
        const auto in = sine (220, 0.5f, second);
        CHECK (rms (renderNode (*c, { in })[0], second / 2) < rms (in, second / 2) * 0.25f);
    }
    { // Tuner: mutes while engaged and hears the pitch of A4 and low E.
        for (float hz : { 440.0f, 82.41f })
        {
            auto t = make ("tuner", { 440 });
            auto out = renderNode (*t, { sine (hz, 0.2f, second / 2) });
            CHECK (rms (out[0]) == 0.0f);
            const float heard = dynamic_cast<rig::Tuner&> (*t).detect();
            if (! near (heard, hz, hz * 0.003f)) std::printf ("  tuner heard %.2f for %.2f\n", heard, hz);
            CHECK (near (heard, hz, hz * 0.003f));
        }
    }
    { // Volume pedal: heel down is silent, toe down is unity.
        const auto in = sine (440, 0.2f, second / 4);
        CHECK (rms (renderNode (*make ("volume", { 0 }), { in })[0], second / 8) < 1e-6f);
        CHECK (near (rms (renderNode (*make ("volume", { 1 }), { in })[0], second / 8), rms (in, second / 8), 1e-4f));
    }
    { // Reverb: keeps ringing after the input stops.
        auto r = make ("reverb", { 1, 3, 20, 6, 0.5f });
        std::vector<float> burst ((size_t) second);
        for (int i = 0; i < 2000; ++i) burst[(size_t) i] = (float) std::sin (i * 0.05);
        auto out = renderNode (*r, { burst, burst });
        CHECK (rms (out[0], second / 2) > 1e-4f && rms (out[1], second / 2) > 1e-4f);
    }
    { // Looper: record, play back, overdub, undo the overdub.
        auto node = make ("looper", { 1 });
        auto& l = dynamic_cast<rig::Looper&> (*node);
        std::vector<float> ramp (1000), zeros (1000), ones (1000, 0.5f);
        for (int i = 0; i < 1000; ++i) ramp[(size_t) i] = (float) i / 1000.0f;
        l.command = rig::Looper::Main; renderNode (l, { ramp });            // record
        l.command = rig::Looper::Main; auto play = renderNode (l, { zeros }); // play
        CHECK (play[0] == ramp);
        l.command = rig::Looper::Main; renderNode (l, { ones });            // overdub one pass
        l.command = rig::Looper::Main; auto dub = renderNode (l, { zeros });
        CHECK (near (dub[0][500], ramp[500] + 0.5f, 1e-6f));
        l.command = rig::Looper::Undo; renderNode (l, { zeros });
        auto undone = renderNode (l, { zeros });
        CHECK (undone[0] == ramp);
    }
    { // Pitch shift +12: the added voice is an octave up (220 Hz in, about 440 Hz out).
        auto ps = make ("pitch", { 12, 0, 1 });
        const auto in = sine (220, 0.2f, second);
        auto out = renderNode (*ps, { in });
        int crossings = 0;
        for (int i = second / 2 + 1; i < second; ++i)
        {
            const float a = out[0][(size_t) i - 1] - in[(size_t) i - 1], b = out[0][(size_t) i] - in[(size_t) i];
            if ((a < 0) != (b < 0)) ++crossings;
        }
        const float hz = (float) crossings / 2.0f / 0.5f;
        if (! near (hz, 440, 25)) std::printf ("  pitch shift heard %.1f Hz\n", hz);
        CHECK (near (hz, 440, 25));
    }
    // Every model of every multi-model effect stays finite and audible.
    for (int m = 0; m < 4; ++m)
        for (auto [type, params] : std::vector<std::pair<const char*, std::vector<float>>> {
                 { "distortion", { (float) m, 6, 5, 6 } }, { "fuzz", { (float) (m % 2), 7, 5, 6 } }, { "boost", { (float) (m % 3), 12, 5 } },
                 { "delay", { (float) (m % 3), 300, 0.4f, 5, 0.5f, (float) (m % 2) } }, { "reverb", { (float) m, 2, 20, 6, 0.5f } },
                 { "acoustic", { (float) m, 0.7f, 5, 0 } } })
        {
            const auto in = sine (196, 0.2f, second / 2);
            auto out = renderNode (*make (type, params), { in, in });
            bool finite = true;
            for (auto& ch : out) for (float v : ch) finite = finite && std::isfinite (v);
            const float level = rms (out[0], second / 4);
            if (! (finite && level > 0.01f && level < 2.0f)) std::printf ("  %s model %d: rms %.3f\n", type, m, level);
            CHECK (finite && level > 0.01f && level < 2.0f);
        }
    // Everything else: a sane, non-silent signal for a plain sine.
    for (auto [type, params] : std::vector<std::pair<const char*, std::vector<float>>> {
             { "octave", { 1, 0.5f, 0.5f } }, { "eq", { 6, 0, -6, 0, 3, 0, 0, 0 } }, { "wah", { 0.5f, 4 } },
             { "chorus", { 0.8f, 0.5f, 0.5f } }, { "flanger", { 0.3f, 0.6f, 0.5f, 0.5f } },
             { "phaser", { 0.5f, 0.7f, 0.3f, 1 } }, { "tremolo", { 5, 0.5f, 1 } } })
    {
        auto out = renderNode (*make (type, params), { sine (330, 0.2f, second / 2) });
        bool finite = true;
        for (auto& ch : out) for (float v : ch) finite = finite && std::isfinite (v);
        if (! (finite && rms (out[0], second / 4) > 0.01f)) std::printf ("  %s misbehaved\n", type);
        CHECK (finite && rms (out[0], second / 4) > 0.01f);
    }
}

int main()
{
    checkDevices();

    { // Biquads: lowpass passes DC, highpass blocks it.
        rig::Biquad lp, hp;
        lp.set (rig::Biquad::LowPass, SR, 1000);
        hp.set (rig::Biquad::HighPass, SR, 1000);
        float a = 0, b = 0;
        for (int i = 0; i < 4000; ++i) { a = lp (1.0f); b = hp (1.0f); }
        CHECK (near (a, 1.0f, 1e-3f));
        CHECK (near (b, 0.0f, 1e-3f));
    }

    rig::Engine e;
    e.masterTarget = 1.0f;
    e.prepare (SR, N);

    // Guitar straight to the output: L and R (R normalled to L, as compile() emits it).
    e.setRig (rigJson (R"({"nodes":[{"id":"i","type":"input","params":[0,0],"on":true},{"id":"o","type":"output","params":[1],"on":true}],
        "wires":[{"from":"i","out":0,"to":"o","in":0},{"from":"i","out":0,"to":"o","in":1}]})"));
    auto r = run (e);
    CHECK (near (r.l, r.in) && near (r.r, r.in));
    CHECK (r.diff < 1e-3f);

    // Nothing cabled: silence.
    e.setRig (rigJson (R"({"nodes":[{"id":"i","type":"input","params":[0,0],"on":true},{"id":"o","type":"output","params":[1],"on":true}],"wires":[]})"));
    r = run (e);
    CHECK (r.l == 0.0f && r.r == 0.0f);

    // Splitter into joiner: equal levels double the signal; flipping B's phase cancels it.
    const char* parallel = R"({"nodes":[{"id":"i","type":"input","params":[0,0],"on":true},{"id":"s","type":"splitter","params":[],"on":true},
        {"id":"j","type":"joiner","params":[1,1,%d],"on":true},{"id":"o","type":"output","params":[1],"on":true}],
        "wires":[{"from":"i","out":0,"to":"s","in":0},{"from":"s","out":0,"to":"j","in":0},{"from":"s","out":1,"to":"j","in":1},
                 {"from":"j","out":0,"to":"o","in":0}]})";
    char buf[1024];
    std::snprintf (buf, sizeof buf, parallel, 0);
    e.setRig (rigJson (buf));
    r = run (e);
    CHECK (near (r.l, 2 * r.in));
    CHECK (r.r == 0.0f); // nothing in R
    std::snprintf (buf, sizeof buf, parallel, 1);
    e.setRig (rigJson (buf));
    CHECK (run (e).l < 1e-4f);

    // Distortion: engaged changes the sound; bypassed passes it untouched. A knob turn keeps the same node.
    const char* dist = R"({"nodes":[{"id":"i","type":"input","params":[0,0],"on":true},{"id":"d","type":"distortion","params":[0,%d,5,5],"on":%s},
        {"id":"o","type":"output","params":[1],"on":true}],
        "wires":[{"from":"i","out":0,"to":"d","in":0},{"from":"d","out":0,"to":"o","in":0}]})";
    std::snprintf (buf, sizeof buf, dist, 8, "true");
    e.setRig (rigJson (buf));
    r = run (e);
    CHECK (r.finite && r.l > 0.01f && r.diff > 0.02f);
    const auto* node = e.nodes().at ("d").get();
    std::snprintf (buf, sizeof buf, dist, 8, "false");
    e.setRig (rigJson (buf));
    CHECK (e.nodes().at ("d").get() == node);
    r = run (e);
    CHECK (r.diff < 1e-3f);

    // Standalone tuner: hears the 440 Hz input with no tuner in the rig, and mutes the output.
    e.tuning = true;
    r = run (e, 200);
    CHECK (near (e.tuner.detect(), 440.0f, 2.0f) && r.l < 1e-4f);
    e.tuning = false;

    // Full amp chain renders something sane in every amp model, cab size and speaker.
    for (int voicing = 0; voicing < (int) std::size (rig::AMPS); ++voicing)
        for (int size = 0; size < 3; ++size)
        {
            std::snprintf (buf, sizeof buf, R"({"nodes":[{"id":"i","type":"input","params":[0,0],"on":true},
                {"id":"a/pre","type":"amp/pre","params":[%d,7,5,5,5,5,5],"on":true},{"id":"a/power","type":"amp/power","params":[%d,7,5,5,5,5,5],"on":true},
                {"id":"c","type":"cab","params":[%d,%d],"on":true},{"id":"m","type":"mic","params":[0,0.3,0.2],"on":true},
                {"id":"o","type":"output","params":[1],"on":true}],
                "wires":[{"from":"i","out":0,"to":"a/pre","in":0},{"from":"a/pre","out":0,"to":"a/power","in":0},
                         {"from":"a/power","out":0,"to":"c","in":0},{"from":"c","out":0,"to":"m","in":0},{"from":"m","out":0,"to":"o","in":0}]})",
                voicing, voicing, size, (voicing + size) % 4);
            e.setRig (rigJson (buf));
            Thread::sleep (60);
            r = run (e, 200);
            if (! (r.finite && r.l > 0.01f && r.l < 1.0f)) std::printf ("  amp model %d, cab %d: rms %.3f\n", voicing, size, r.l);
            CHECK (r.finite && r.l > 0.01f && r.l < 1.0f);
        }

    { // Rig files: round trip, and a flipped byte or a plain JSON file is refused.
        const String json = R"({"version":1,"devices":{},"cables":[],"name":"Ångström ✓"})";
        auto sealed = rigfile::seal (json);
        CHECK (rigfile::isRigFile (sealed) && rigfile::open (sealed) == json);
        CHECK (sealed.toString().indexOf ("devices") < 0); // nothing readable inside
        static_cast<char*> (sealed.getData())[40] ^= 1;
        CHECK (! rigfile::open (sealed).has_value());
        CHECK (! rigfile::open (MemoryBlock (json.toRawUTF8(), json.getNumBytesAsUTF8())).has_value());
    }

    std::printf (failures == 0 ? "engine check: all passed\n" : "engine check: %d failed\n", failures);
    return failures == 0 ? 0 : 1;
}
