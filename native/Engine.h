// Audio engine: runs the rig the UI compiles (src/rig.ts compile()) as a graph of nodes.
//
// Threads: setRig()/prepare()/collectGarbage() run on the message thread; the device callback on
// the audio thread. A new graph is built off the audio thread and handed over through `pending`;
// the audio thread swaps it in between blocks with a one-block fade, and the old graph is freed
// back on the message thread. No locks are waited on and nothing is allocated on the audio thread.

#pragma once
#include "Devices.h"
#include "Nam.h"

namespace rig
{
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
    std::atomic<float> peak { 0.0f };    // input level, read and reset by the UI meter
    std::atomic<float> outPeak { 0.0f }; // output level before the safety clipper, same
    std::atomic<bool> muted { false };   // master mute: the rig keeps running, nothing reaches the speakers
    // Standalone tuner: hears an interface input directly, whatever the rig, and mutes the output while open.
    std::atomic<bool> tuning { false };
    std::atomic<bool> tunerMutes { true }; // false: tune while still hearing the rig
    std::atomic<int> tunerChannel { 0 };
    Tuner tuner;

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
        tuner.prepareNode (sr, maxBlock);
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
        if (tuning && tunerChannel < numIn && in[tunerChannel] != nullptr)
            tuner.feed (in[tunerChannel], n);
        master.setTargetValue (muted || (tuning && tunerMutes) ? 0.0f : masterTarget.load());
        float top = 0.0f;
        for (int i = 0; i < n; ++i)
        {
            float g = master.getNextValue();
            if (incoming != nullptr) g *= 1.0f - float (i) / float (n);
            if (fadeIn) g *= float (i) / float (n);
            const float l = io.mixL[i] * g, r = io.mixR[i] * g;
            top = std::max (top, std::max (std::abs (l), std::abs (r)));
            if (numOut > 0 && out[0] != nullptr) out[0][i] = softClip (l);
            if (numOut > 1 && out[1] != nullptr) out[1][i] = softClip (r);
        }
        for (float prev = outPeak; top > prev && ! outPeak.compare_exchange_weak (prev, top);) {}
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

    // Writes the node's knobs, switch and files. True only when a knob or file really changed, so
    // retuning and configure() run for the nodes you touched, not for every node on every knob turn.
    static bool applyParams (Node& node, const var& n)
    {
        bool changed = false;
        if (const auto* ps = n["params"].getArray())
            for (int i = 0; i < std::min (ps->size(), (int) node.p.size()); ++i)
            {
                const auto v = (float) (double) ps->getReference (i);
                if (node.p[(size_t) i].load() != v) { node.p[(size_t) i] = v; changed = true; }
            }
        node.on = (bool) n["on"];
        std::map<String, String> files;
        if (auto* f = n["files"].getDynamicObject())
            for (const auto& slot : f->getProperties())
                if (const auto file = libraryFile (slot.value.toString()); file != File())
                    files[slot.name.toString()] = file.getFullPathName();
        if (files != node.files) { node.files = std::move (files); changed = true; }
        if (changed) node.version++;
        return changed;
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
            auto node = ! fresh && it != byId.end() && it->second->type == type ? it->second : makeAnyNode (type);
            const bool changed = applyParams (*node, n);
            const bool isNew = node != (it != byId.end() ? it->second : nullptr) || fresh;
            if (isNew) node->prepareNode (sr, maxBlock);
            if (isNew || changed) node->configure();
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
