// Offline check of the audio engine: feeds a sine through compiled rigs and asserts on the output.
// Build and run: cmake --build native/build --target RigCheck && native/build/RigCheck_artefacts/Release/RigCheck

#include "Engine.h"
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

int main()
{
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
    const char* dist = R"({"nodes":[{"id":"i","type":"input","params":[0,0],"on":true},{"id":"d","type":"distortion","params":[%d,5,5],"on":%s},
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

    // Full amp chain renders something sane in every voicing and cab size.
    for (int voicing = 0; voicing < 3; ++voicing)
        for (int size = 0; size < 3; ++size)
        {
            std::snprintf (buf, sizeof buf, R"({"nodes":[{"id":"i","type":"input","params":[0,0],"on":true},
                {"id":"a/pre","type":"amp/pre","params":[%d,7,5,5,5,5],"on":true},{"id":"a/power","type":"amp/power","params":[%d,7,5,5,5,5],"on":true},
                {"id":"c","type":"cab","params":[%d],"on":true},{"id":"m","type":"mic","params":[0,0.3,0.2],"on":true},
                {"id":"o","type":"output","params":[1],"on":true}],
                "wires":[{"from":"i","out":0,"to":"a/pre","in":0},{"from":"a/pre","out":0,"to":"a/power","in":0},
                         {"from":"a/power","out":0,"to":"c","in":0},{"from":"c","out":0,"to":"m","in":0},{"from":"m","out":0,"to":"o","in":0}]})",
                voicing, voicing, size);
            e.setRig (rigJson (buf));
            r = run (e, 200);
            CHECK (r.finite && r.l > 0.01f && r.l < 1.0f);
        }

    std::printf (failures == 0 ? "engine check: all passed\n" : "engine check: %d failed\n", failures);
    return failures == 0 ? 0 : 1;
}
