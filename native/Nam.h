// Neural Amp Modeler captures (amps, pedals, full rigs) as rig nodes. NeuralAmpModelerCore runs the
// model; this file only loads it safely and sets levels.

#pragma once
#include "Devices.h"
#include "NAM/get_dsp.h"

namespace rig
{
// A capture loads on the message thread (configure) and reaches the audio thread through a
// try-lock, like the engine's graphs; the model it replaces is freed back on the message thread.
// Levels follow the NAM plugin: output normalised to -18 dB when the file says how loud it is.
//
// Captures are trained at one rate (48 kHz almost always). When the interface runs at another,
// the signal is converted to the capture's rate, played through it and converted back
// (windowed-sinc), so a capture sounds as made at 44.1, 88.2 or 96 kHz. Cost: about 1 ms.
struct Nam : Node // p: input dB, output dB
{
    Nam() : Node (1, 1) {}
    struct Model { std::shared_ptr<nam::DSP> dsp; double rate = 0; }; // rate: the capture's, 0 = the interface's
    SpinLock lock;
    Model live, pending, retired;
    bool swap = false;
    String loaded;
    int maxBlock = 512;
    std::atomic<float> normalise { 1.0f };
    std::atomic<bool> missing { false };
    String lastError; // message thread
    std::vector<float> scratch;
    SmoothedValue<float> inGain, outGain;
    // Rate conversion: input waiting at the interface rate, a block at the capture's rate, output
    // waiting at the capture's rate. Capacity is set in prepare(), so the audio thread never allocates.
    WindowedSincInterpolator up, down;
    std::vector<float> inQ, mid, midOut, outQ;
    static constexpr int PRIME = 48; // samples of the capture's rate kept in hand against jitter

    void prepare (int block) override
    {
        maxBlock = block;
        scratch.assign ((size_t) block, 0.0f);
        const size_t room = (size_t) block * 8 + 1024; // up to 192 kHz captures at any interface rate
        for (auto* q : { &inQ, &mid, &midOut, &outQ }) { q->clear(); q->reserve (room); }
        mid.resize (room);
        midOut.resize (room);
        loaded = "\x01"; // the rate may have changed: reload on the next configure
        inGain.reset (sr, 0.02);
        outGain.reset (sr, 0.02);
    }

    void configure() override
    {
        {
            const SpinLock::ScopedLockType l (lock);
            retired = {};
        }
        const auto it = files.find ("model");
        const String path = it != files.end() ? it->second : String();
        if (path == loaded) return;
        loaded = path;

        Model model;
        if (File (path).existsAsFile())
        {
            try
            {
                model.dsp = nam::get_dsp (std::filesystem::path (path.toStdString()));
                const double want = model.dsp->GetExpectedSampleRate();
                model.rate = ! model.dsp->SupportsArbitrarySampleRate() && want > 0 && std::abs (want - sr) > 1.0 ? want : 0.0;
                model.dsp->Reset (model.rate > 0 ? model.rate : sr, model.rate > 0 ? (int) std::ceil (maxBlock * model.rate / sr) + 16 : maxBlock);
            }
            catch (const std::exception& e) { DBG ("NAM load failed: " << e.what()); lastError = e.what(); model = {}; }
        }
        missing = path.isNotEmpty() && model.dsp == nullptr;
        normalise = model.dsp != nullptr && model.dsp->HasLoudness() ? dbToGain ((float) (-18.0 - model.dsp->GetLoudness())) : 1.0f;

        const SpinLock::ScopedLockType l (lock);
        pending = std::move (model);
        swap = true;
    }

    void render (const float* const* in, float* const* out, int n, IO&) override
    {
        if (const SpinLock::ScopedTryLockType l (lock); l.isLocked() && swap)
        {
            retired = std::move (live);
            live = std::move (pending);
            swap = false;
            up.reset(); down.reset();
            inQ.clear(); outQ.assign (PRIME, 0.0f);
        }
        inGain.setTargetValue (dbToGain (p[0]));
        outGain.setTargetValue (dbToGain (p[1]) * normalise.load());
        if (live.dsp == nullptr)
        {
            FloatVectorOperations::copy (out[0], in[0], n); // no capture yet: pass the signal on
            return;
        }
        for (int i = 0; i < n; ++i) scratch[(size_t) i] = in[0][i] * inGain.getNextValue();
        if (live.rate > 0) convert (n, out[0]);
        else
        {
            float* ip = scratch.data();
            float* op = out[0];
            live.dsp->process (&ip, &op, n);
        }
        for (int i = 0; i < n; ++i) out[0][i] *= outGain.getNextValue();
    }

    // Interface rate -> capture rate -> capture -> interface rate, through the queues.
    void convert (int n, float* out)
    {
        const double toModel = sr / live.rate, toHost = live.rate / sr; // input samples per output sample
        if (inQ.size() + (size_t) n > inQ.capacity()) inQ.clear(); // can't happen at sane rates; never allocate
        inQ.insert (inQ.end(), scratch.begin(), scratch.begin() + n);
        const int m = std::min ((int) mid.size(), (int) std::floor (((double) inQ.size() - 2.0) / toModel));
        if (m > 0)
        {
            const int used = up.process (toModel, inQ.data(), mid.data(), m);
            inQ.erase (inQ.begin(), inQ.begin() + used);
            float* ip = mid.data();
            float* op = midOut.data();
            live.dsp->process (&ip, &op, m);
            if (outQ.size() + (size_t) m > outQ.capacity()) outQ.clear();
            outQ.insert (outQ.end(), midOut.begin(), midOut.begin() + m);
        }
        if ((double) outQ.size() < std::ceil (n * toHost) + 2.0) { FloatVectorOperations::clear (out, n); return; } // still priming
        const int used = down.process (toHost, outQ.data(), out, n);
        outQ.erase (outQ.begin(), outQ.begin() + used);
    }
};

inline std::shared_ptr<Node> makeAnyNode (const String& type)
{
    if (type == "namAmp" || type == "namPedal" || type == "namRig")
    {
        auto n = std::make_shared<Nam>();
        n->type = type;
        return n;
    }
    return makeNode (type);
}
} // namespace rig
