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
struct Nam : Node // p: input dB, output dB
{
    Nam() : Node (1, 1) {}
    SpinLock lock;
    std::shared_ptr<nam::DSP> live, pending, retired;
    bool swap = false;
    String loaded;
    int maxBlock = 512;
    std::atomic<float> normalise { 1.0f };
    std::atomic<bool> missing { false }, wrongRate { false };
    String lastError; // message thread
    std::vector<float> scratch;
    SmoothedValue<float> inGain, outGain;

    void prepare (int block) override
    {
        maxBlock = block;
        scratch.assign ((size_t) block, 0.0f);
        loaded = "\x01"; // the rate may have changed: reload on the next configure
        inGain.reset (sr, 0.02);
        outGain.reset (sr, 0.02);
    }

    void configure() override
    {
        {
            const SpinLock::ScopedLockType l (lock);
            retired = nullptr;
        }
        const auto it = files.find ("model");
        const String path = it != files.end() ? it->second : String();
        if (path == loaded) return;
        loaded = path;

        std::shared_ptr<nam::DSP> model;
        if (File (path).existsAsFile())
        {
            try
            {
                model = nam::get_dsp (std::filesystem::path (path.toStdString()));
                model->Reset (sr, maxBlock);
            }
            catch (const std::exception& e) { DBG ("NAM load failed: " << e.what()); lastError = e.what(); model = nullptr; }
        }
        missing = path.isNotEmpty() && model == nullptr;
        // ponytail: a model trained at 48 kHz played at another rate shifts slightly; the UI warns. Resample if people need it.
        wrongRate = model != nullptr && ! model->SupportsArbitrarySampleRate() && model->GetExpectedSampleRate() > 0
                    && std::abs (model->GetExpectedSampleRate() - sr) > 1.0;
        normalise = model != nullptr && model->HasLoudness() ? dbToGain ((float) (-18.0 - model->GetLoudness())) : 1.0f;

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
        }
        inGain.setTargetValue (dbToGain (p[0]));
        outGain.setTargetValue (dbToGain (p[1]) * normalise.load());
        if (live == nullptr)
        {
            FloatVectorOperations::copy (out[0], in[0], n); // no capture yet: pass the signal on
            return;
        }
        for (int i = 0; i < n; ++i) scratch[(size_t) i] = in[0][i] * inGain.getNextValue();
        float* ip = scratch.data();
        float* op = out[0];
        live->process (&ip, &op, n);
        for (int i = 0; i < n; ++i) out[0][i] *= outGain.getNextValue();
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
