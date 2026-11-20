// Renders a guitar part through a compiled rig and writes a WAV, for auditioning presets without
// playing, and prints the tone balance in octave bands so presets can be compared by numbers.
//
//   RigRender <compiled-rig.json> <out.wav> [chug|chords|lead|<di.wav>]
//
// The compiled rig is what src/rig.ts compile() produces (scripts/compile-presets.mjs writes one per
// preset). Without a DI file the guitar is synthesised: plucked strings through a pickup.

#include "Engine.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <cstdio>

using namespace juce;

constexpr double SR = 48000.0;
constexpr int BLOCK = 64;

// A plucked string (Karplus-Strong). The pick excitation is lowpassed (a pick is not white noise),
// and a palm mute damps the loop much harder.
static void pluck (std::vector<float>& out, double start, double hz, double length, bool muted, float amp, Random& rng)
{
    const int at = (int) (start * SR), len = (int) (length * SR), period = std::max (2, (int) std::round (SR / hz));
    std::vector<float> loop ((size_t) period);
    rig::Biquad pick;
    pick.set (rig::Biquad::LowPass, SR, muted ? 1000 : 2500, 0.7);
    for (int k = 0; k < 3; ++k) for (auto& v : loop) v = pick (k == 2 ? rng.nextFloat() * 2 - 1 : 0) + (k < 2 ? 0 : 0); // settle the filter
    for (auto& v : loop) v = pick (rng.nextFloat() * 2 - 1) * 2.0f;
    const float decay = muted ? 0.992f : 0.9993f, bright = muted ? 0.15f : 0.45f;
    for (int i = 0; i < len && at + i < (int) out.size(); ++i)
    {
        const size_t k = (size_t) (i % period);
        const float v = (loop[k] * (1 - bright) + loop[(k + 1) % (size_t) period] * bright) * decay;
        loop[k] = v;
        const float fade = i > len - 400 ? (float) (len - i) / 400.0f : 1.0f;
        out[(size_t) (at + i)] += amp * v * fade;
    }
}

static std::vector<float> synthGuitar (const String& part)
{
    const double beat = 0.5; // 120 bpm
    std::vector<float> di ((size_t) (SR * 10));
    Random rng (7);
    auto chord = [&] (double t, std::initializer_list<double> hz, double len, bool muted, double strum = 0.012, float amp = 0.18f) {
        int i = 0;
        for (double f : hz) pluck (di, t + strum * i++, f, len, muted, amp, rng);
    };
    const double E2 = 82.41, A2 = 110.0, B2 = 123.47, D3 = 146.83, E3 = 164.81, G2 = 98.0, D2 = 73.42;
    if (part == "chug")
    {
        for (int bar = 0; bar < 4; ++bar)
        {
            const double t0 = bar * 4 * beat;
            for (int k = 0; k < 6; ++k) chord (t0 + k * beat / 2, { E2, B2, E3 }, beat / 2, true, 0.004);
            const double root = bar % 2 ? G2 : A2;
            chord (t0 + 3 * beat, { root, root * 1.5, root * 2 }, beat, false, 0.006);
        }
        chord (16 * beat, { D2, A2, D3 }, 3.5, false, 0.008);
    }
    else if (part == "chords")
    {
        const std::vector<std::vector<double>> shapes = {
            { 82.41, 123.47, 164.81, 207.65, 246.94, 329.63 },   // E
            { 110.0, 164.81, 220.0, 277.18, 329.63 },            // A
            { 146.83, 220.0, 293.66, 369.99 },                   // D
            { 98.0, 123.47, 146.83, 196.0, 246.94, 392.0 },      // G
        };
        for (int bar = 0; bar < 4; ++bar)
            for (int k = 0; k < 2; ++k)
            {
                const auto& s = shapes[(size_t) bar];
                for (size_t i = 0; i < s.size(); ++i) pluck (di, bar * 4 * beat + k * 2 * beat + 0.012 * (double) i, s[i], 2 * beat + 0.3, false, 0.14f, rng);
            }
        chord (16 * beat, { 82.41, 123.47, 164.81, 207.65, 246.94, 329.63 }, 3.5, false, 0.03, 0.14f);
    }
    else // lead: a minor-pentatonic phrase ending on a held note
    {
        const double notes[] = { 329.63, 392.0, 440.0, 493.88, 587.33, 659.26, 587.33, 493.88, 440.0, 392.0, 440.0 };
        double t = 0;
        for (size_t i = 0; i < std::size (notes); ++i)
        {
            const double len = i + 1 == std::size (notes) ? 3.5 : beat / 2;
            pluck (di, t, notes[i], len + 0.05, false, 0.3f, rng);
            t += i + 1 == std::size (notes) ? 0 : beat / 2;
        }
    }
    // Humbucker: a resonant peak around 2.5 kHz, then the cable's treble loss.
    rig::Biquad peak, cable;
    peak.set (rig::Biquad::Peak, SR, 2500, 1.5, 4);
    cable.set (rig::Biquad::LowPass, SR, 4500, 0.7);
    float top = 0;
    for (auto& v : di) { v = cable (peak (v)); top = std::max (top, std::abs (v)); }
    for (auto& v : di) v *= 0.5f / top; // a hot humbucker peaks around -6 dBFS
    return di;
}

int main (int argc, char** argv)
{
    if (argc < 3) { std::printf ("usage: RigRender <compiled-rig.json> <out.wav> [chug|chords|lead|<di.wav>]\n"); return 2; }
    const auto rigFile = File::getCurrentWorkingDirectory().getChildFile (argv[1]);
    const auto outFile = File::getCurrentWorkingDirectory().getChildFile (argv[2]);
    const String part = argc > 3 ? argv[3] : "chords";

    std::vector<float> di;
    if (part.endsWithIgnoreCase (".wav"))
    {
        AudioFormatManager formats;
        formats.registerBasicFormats();
        std::unique_ptr<AudioFormatReader> reader (formats.createReaderFor (File::getCurrentWorkingDirectory().getChildFile (part)));
        if (reader == nullptr) { std::printf ("can't read %s\n", part.toRawUTF8()); return 1; }
        AudioBuffer<float> buf (1, (int) reader->lengthInSamples);
        reader->read (&buf, 0, buf.getNumSamples(), 0, true, false);
        di.assign (buf.getReadPointer (0), buf.getReadPointer (0) + buf.getNumSamples());
    }
    else di = synthGuitar (part);

    const auto compiled = JSON::parse (rigFile);
    if (! compiled.isObject()) { std::printf ("can't parse %s\n", argv[1]); return 1; }

    rig::Engine engine;
    engine.masterTarget = 1.0f;
    engine.setRig (compiled);
    engine.prepare (SR, BLOCK);
    Thread::sleep (200); // convolution IRs load on a background thread

    const int len = (int) di.size();
    AudioBuffer<float> out (2, len);
    out.clear();
    for (int s = 0; s + BLOCK <= len; s += BLOCK)
    {
        const float* ins[] = { di.data() + s };
        float* outs[] = { out.getWritePointer (0, s), out.getWritePointer (1, s) };
        engine.audioDeviceIOCallbackWithContext (ins, 1, outs, 2, BLOCK, {});
        engine.collectGarbage();
    }

    // Tone balance: energy per octave band relative to the loudest band, from an averaged FFT
    // (filters leak too much to measure a cab's steep top end).
    std::vector<double> bands = { 63, 125, 250, 500, 1000, 2000, 4000, 8000 };
    std::printf ("%-28s", outFile.getFileNameWithoutExtension().toRawUTF8());
    constexpr int order = 13, size = 1 << order;
    dsp::FFT fft (order);
    dsp::WindowingFunction<float> hann (size, dsp::WindowingFunction<float>::hann);
    std::vector<double> energy (bands.size());
    std::vector<float> frame (2 * size);
    for (int at = 0; at + size <= len; at += size / 2)
    {
        for (int i = 0; i < size; ++i) frame[(size_t) i] = 0.5f * (out.getSample (0, at + i) + out.getSample (1, at + i));
        hann.multiplyWithWindowingTable (frame.data(), size);
        fft.performFrequencyOnlyForwardTransform (frame.data());
        for (int k = 1; k < size / 2; ++k)
        {
            const double hz = k * SR / size;
            for (size_t b = 0; b < bands.size(); ++b)
                if (hz >= bands[b] / 1.414 && hz < bands[b] * 1.414) energy[b] += frame[(size_t) k] * frame[(size_t) k];
        }
    }
    const double top = *std::max_element (energy.begin(), energy.end());
    for (size_t b = 0; b < bands.size(); ++b) std::printf (" %5.0f", 10 * std::log10 (energy[b] / top + 1e-12));
    // Peak before the output clipper: above 1.0 the rig is clipping. L/R rms shows stereo balance.
    std::printf ("  peak %.2f  rms L %.3f R %.3f\n", engine.outPeak.load(), out.getRMSLevel (0, 0, len), out.getRMSLevel (1, 0, len));

    outFile.deleteFile();
    WavAudioFormat wav;
    std::unique_ptr<OutputStream> stream = std::make_unique<FileOutputStream> (outFile);
    auto writer = wav.createWriterFor (stream, AudioFormatWriterOptions{}.withSampleRate (SR).withNumChannels (2).withBitsPerSample (24));
    if (writer == nullptr) { std::printf ("can't write %s\n", argv[2]); return 1; }
    writer->writeFromAudioSampleBuffer (out, 0, len);
    return 0;
}
