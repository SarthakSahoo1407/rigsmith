# Rigsmith — Guitar Rig Simulator Plan

A desktop guitar rig (macOS) you build like a real one: place any number of pedals, amps, cabs, mics and power supplies, run audio and power cables between jacks in any order, split and rejoin the signal, and play through it live from an audio interface.

## Decisions

| Topic | Decision |
|---|---|
| Platform | JUCE 8 desktop app (C++, CMake). The UI is Vite + React + TypeScript running in JUCE's web view. Switched from the browser after Chrome measured ~14 ms reported (more in reality) with the interface; native targets 3–6 ms. |
| Audio | JUCE `AudioDeviceManager` + a small node graph of our own (`native/Engine.h`). Built-in `juce_dsp` pieces first (IIR filters, WaveShaper, Convolution, Compressor, DelayLine, Oscillator); plain C++ processors where none exists (noise gate, octave, looper). |
| Guitar input | Audio interface, chosen in JUCE's Audio Settings dialog (device, sample rate, buffer size, enabled channels). No MIDI. |
| Monitoring | Wired headphones/monitors on the interface. Bluetooth is too slow for live playing. |
| Amp realism | Nine amp models (US Clean, Tweed, UK Chime, UK Plexi, UK Lead, US Rectified, Modern High Gain, Boutique Lead, Jazz Clean): 1–4 gain stages at 8x oversampling with interstage filtering, a voiced tone stack, and a power section with sag, depth and presence. Cabs have a size and a speaker type. Drives, fuzz, boost, delay and reverb have models too. Cabs and the acoustic simulator are generated minimum-phase impulse responses (`designIr`: a magnitude curve plus seeded cone/wood ripple), so they sound measured rather than EQ'd. Tuned against FFT octave-band balance (`RigRender`), level-matched; retune from a real DI clip when one is available. NAM captures later. |
| Branding | Fictional makers, never real ones. Each amp model has its own maker and look (Fairmont, Sutter, Wexford, Kingsway, Thornbury, Ironside, Vexor, Calloway, Moreau: tolex or tweed, grille cloth, nameplate, top or bottom panel, knob finish); each cab speaker type too (Kingsway, Ironside, Wexford, Fairmont). Pedals Kestrel, mics Oriel, power Voltline, interface and DI Arcadia Audio, routing Patchwell; the board is a Rigsmith Touring 32. Amps and cabs are separate items in the gear list, like the pedals. |
| Pedals | Each pedal has the enclosure it's modelled on (`layout.ts shapeOf`): compact with a hinged plate, MXR-style stomp, wide, round fuzz, TS-style rocker, hammertone; chrome, cream, black or chicken-head knobs and its own typeface. Pedals that are several pedals in real life (drive, fuzz, boost, delay, reverb) are separate items; the model stays a knob value. |
| Mics | A mic on a cab is drawn from behind on the cab's face, its head over a cone. Drag it across the cone to set position (centre bright, edge dark), scroll over it for distance. |
| Power | On/off only. Unpowered pedal = silent. Devices store volts/mA but nothing checks them yet. |
| UI | One rig, two views with a toggle. **Board**: a stage at soundcheck with auto zones (`src/layout.ts`): amp heads stacked on their cabs with mics in front on the stage, pedals in slots on a pedalboard (signal right to left, wrapping rows, power bricks on the rail), interface on a desk, guitar input beside the board. Drag reorders within a zone; nothing floats. **Grid**: free-form boxes. Built on React Flow (`@xyflow/react`). Graphite chrome, one amber accent, gaffer-tape name labels. |
| Grid | Quad Cortex-style: equal tiles laid out by signal flow (columns) and branches (rows), routed cables, power gear hidden. The right panel shows the rig overview (levels, warnings, power all, the signal path with on/off per block) or the selected tile's controls. |
| Stereo | Two mics on one cab blend to the centre through a joiner. Two amps on a splitter pan left and right, level-matched. |
| Stereo | Every cable is mono. Stereo gear has separate L/R jacks. A mono signal into only Output L plays on both sides. |
| Cables | Ideal (no tone loss). 5 ms fade on connect/disconnect, so no pops. |
| Footswitches | Click the plate, or keys 1–9 stomp pedals in signal order. |
| Keys | ←/→ presets, V view, T tuner, M mute output, I mute input, B bypass, P power, Enter open, ⌫ delete, \\ gear list, ⌘Z/⇧⌘Z, ⌘S, ⌘O/⌘E, ? list. |
| Gear list | Left sidebar, collapsible: thumbnails of the real gear. Click to add, drag onto the rig, or drop onto a cable to insert it there. Double-click any device for a large window with every control, Replace (same kind of gear) and Delete. |
| Tuner | A tuner pedal in the chain, plus a standalone tuner (top bar, T) that listens to the input directly and mutes the output while open: an arc from −50 to +50 cents with an orange needle, the note big, Hz and cents either side. |
| Mute | Master output mute (top bar, M) and an input mute on each DI box (I mutes all). |
| Meters | Input and output peak meters, clip light, latency, audio CPU and app RAM. |
| Wah / volume | On-screen treadle (drag or scroll wheel). |
| Undo | Cmd+Z / Shift+Cmd+Z over rig snapshots. A knob drag is one step. |
| Saving | Autosave and named presets as JSON files in `~/Library/Application Support/Rig`, written by the native side. Export/import uses encrypted `.rigsmith` files (`native/RigFile.h`: AES-256-CBC + HMAC-SHA256, app-held key; tampered files are refused); old `.json` rigs still import. Audio device settings saved the same way. |
| Build | `npm run build` (UI → `dist/`), then `cmake --build native/build` copies `dist/` into `Rigsmith.app`. Dev: `RIG_DEV_URL=http://localhost:5173` makes the app load the Vite dev server for hot reload. |

## Routing rules

1. One cable per jack. Plugging into a used jack replaces the old cable.
2. Splitting and joining only through devices: **Splitter** (1 in, 2 out; chain for more) and **Joiner** (2 in, 1 out, level per input, phase-flip switch).
3. Only matching jacks connect: audio out → audio in, power outlet → power in, amp send → pedal in, pedal out → amp return, amp speaker out → cab in only.
4. No feedback loops. A cable that would create a cycle is refused.
5. A hidden, non-removable limiter sits on the final output.
6. **Amp effects loop is normalled like a real amp:** with nothing in Return, the signal passes through the amp internally. A cable in Return breaks the internal path and feeds the power amp. A cable in Send alone is just a copy (tap) of the preamp signal.
7. An amp with nothing on its speaker out is silent ("no load" warning).
8. **Mics are placed, not cabled.** Drag a mic onto a cab's speaker; position (center brighter, edge darker) and distance (closer = more bass, further = quieter + small delay) are two knobs on the placed mic. Dragging a mic off its cab detaches it. Several mics per cab are allowed. The mic's XLR output jack goes to the Output device. A cab without a mic is silent.
9. Any audio output may go straight to the Output (DI / amp-less path).
10. No limit on device count. The ceiling is CPU; an audio glitch shows a warning.

## Data model (`src/rig.ts`, pure TypeScript)

```ts
type JackRef = { device: string; jack: string };
type Cable = { id: string; from: JackRef; to: JackRef; kind: 'audio' | 'power' };
type Device = {
  id: string;
  type: DeviceType;              // key into the catalog
  params: Record<string, number>;
  on: boolean;                   // footswitch
  hotkey?: string;
  pos: { board: XY; grid: XY };
  mic?: { cab: string; x: number; y: number; distance: number }; // mic devices only
  ir?: string;                   // cab: user-loaded IR, stored as base64 in the rig file
};
type Rig = { version: 1; devices: Record<string, Device>; cables: Cable[] };
```

The TypeScript catalog defines each type's jacks (name, audio/power, in/out, side of the box), params (range, default) and power need (volts, mA). The C++ side defines each type's DSP only.

The UI owns the rig and compiles it before sending it to the engine: jack names become channel indices, unpowered devices are flagged, a mic placed on a cab becomes a cab → mic connection, and a cabled amp Return sets the amp's loop switch. The engine never sees jack names, power cables or positions:

```ts
type Compiled = {
  nodes: { id: string; type: DeviceType; params: Record<string, number>; on: boolean; powered: boolean }[];
  wires: { from: string; out: number; to: string; in: number }[];
};
```

Pure functions in `rig.ts`: `canConnect(rig, from, to)` (rules 1, 3 and 4; cycle check treats each device as every input → every output), `isPowered(rig, id)`, plus add/remove/move/connect/disconnect/setParam. These carry the unit tests.

## Audio engine (`native/Main.cpp`, split when it grows)

- `AudioDeviceManager` runs the interface. Settings come from JUCE's `AudioDeviceSelectorComponent` dialog.
- Bridge: JUCE web view native functions (`getState`, `set`, `openAudioSettings`, later `setRig`, `setParam`) and events pushed to the UI (`state`, `meter` at 30 Hz). `src/native.ts` is the JS side.
- `setRig(compiled)` reuses nodes by id, topologically sorts them, and hands the new graph to the audio thread, which swaps it in between blocks with a one-block fade out/in. A knob or footswitch change with the same nodes and wires only updates atomics, no rebuild. `native/check.cpp` (`RigCheck`) renders rigs offline and asserts on the output.
- Knob changes go through `SmoothedValue`, so no zipper noise. Audio-thread values are atomics; no locks or allocation on the audio thread.
- A footswitch crossfades between the effect and a dry bypass path. An unpowered device outputs silence.
- **Guitar Input** device: input channel (among the enabled ones), trim, level meter, clip LED. Trim is the calibration knob.
- **Output** device: L/R → master volume → limiter → interface outputs. The limiter is a zero-latency soft clipper (linear to 0.7, tanh above, never past ±1).
- Shows round-trip latency (JUCE's input + output latency, which include the buffer) and CPU load.

## Device catalog (v1, one model each, no brand names)

The "Built from" column was written in Web Audio terms; each maps to its `juce_dsp` twin (biquad → `dsp::IIR`, WaveShaper → `dsp::WaveShaper` with `dsp::Oversampling`, ConvolverNode → `dsp::Convolution`, DelayNode → `dsp::DelayLine`, LFO → `dsp::Oscillator`, DynamicsCompressorNode → `dsp::Compressor`, AnalyserNode → a FIFO read by the UI timer, AudioWorklet → plain C++ processor).

| Device | Jacks | Built from |
|---|---|---|
| Guitar Input | out | getUserMedia → ChannelSplitter → Gain (trim) |
| Output | in L, in R | ChannelMerger → master → soft-clip limiter → destination |
| Power Supply | 8 power outlets | no audio |
| Splitter | in → out A, out B | Gain fan-out |
| Joiner | in A, in B → out | 2× Gain (level, phase = −1) summed |
| Tuner | in → out | AnalyserNode + autocorrelation on main thread; mutes output when engaged |
| Noise Gate | in → out | AudioWorklet: envelope follower, threshold, hysteresis, release |
| Compressor | in → out | DynamicsCompressorNode + makeup Gain |
| Boost | in → out | Gain + treble biquad |
| Distortion | in → out | pre-EQ → Gain → WaveShaper (tanh, 4× oversample) → tone lowpass → level |
| Fuzz | in → out | Gain → asymmetric hard-clip WaveShaper (4×) → tone → level |
| Octave | in → out | AudioWorklet: −1 octave by zero-crossing flip-flop, +1 by full-wave rectify; dry/sub/up mix |
| EQ | in → out | 7 peaking biquads + level |
| Wah | in → out | peaking/bandpass biquad, frequency from treadle |
| Volume | in → out | Gain from treadle |
| Chorus | in → out L/R | DelayNode with LFO on delayTime, L/R LFOs 90° apart |
| Flanger | in → out | short DelayNode + LFO + internal feedback |
| Phaser | in → out | 4–8 allpass biquads, LFO on frequency, feedback |
| Tremolo | in → out | Gain with LFO on gain (sine/square) |
| Delay | in → out L/R | 2× DelayNode, feedback, tone lowpass, ping-pong switch |
| Reverb | in L/R → out L/R | ConvolverNode with a generated stereo noise-decay IR (rebuilt on decay change) |
| Looper | in → out | AudioWorklet buffer: record, play, overdub, undo last layer. Memory only. |
| Amp | in, send, return, speaker out; power from wall | highpass → preamp Gain → WaveShaper → tone stack (low shelf / peaking / high shelf) → [loop, rule 6] → power-amp WaveShaper → master. Voicings: clean / crunch / high-gain = param presets. |
| Cab 1x12 / 2x12 / 4x12 | in | biquads (low cut, low resonance, presence peak, high cut) per size, or a user `.wav` IR via ConvolverNode |
| Mic (dynamic / ribbon / condenser) | XLR out | placed on a cab: per-model EQ; position shifts lowpass; distance = Gain + DelayNode + low shelf |

No audio files ship in v1, so there is nothing to license.

## Files

```
src/rig.ts          data model, rules, compile(), pure functions
src/rig.test.ts     vitest: canConnect, cycles, power, normalled loop, compile, undo
src/catalog.ts      jacks, params, power per device type
src/native.ts       JUCE bridge (call / on)
src/App.tsx         React Flow canvas, Board/Grid toggle, toolbar, hotkeys, undo
src/layout.ts       Board zones and slot placement, drag-to-reorder hints
src/gear.tsx        Board look: stompboxes, treadles, amp head, cabs, mics, interface, power brick
src/app.css         all styles
native/CMakeLists.txt  fetches JUCE 8.0.15, builds Rig.app, bundles dist/
native/Main.cpp     app, window, bridge, settings, rig storage, meters, standalone tuner
native/RigFile.h    encrypted .rigsmith export format
native/icon.png     app icon, an amp combo (drawn in native/art/icon.svg)
native/Dsp.h        biquad, oversampled shaper, delay line, LFO, envelope, Node base
native/Devices.h    one sound model per device type
native/Engine.h     graph build, handover to the audio thread
native/check.cpp    offline engine check (RigCheck)
native/render.cpp   RigRender: a guitar part (synthesised or a DI .wav) through a compiled rig into a WAV, with tone balance
scripts/render-presets.mts  `npm run render [di.wav]`: every preset to renders/*.wav
src/presets.ts      built-in rigs
```

## Phases (each ends with something playable)

1. **Sound in, sound out.** JUCE app + React UI: Audio Settings dialog, input channel, trim, meter, clip LED, volume, limiter, latency and CPU readout. Check: you hear your guitar with no hum, no crackle and single-digit latency.
2. **Rig model.** `rig.ts` + tests for every routing rule, undo, autosave/presets/JSON (validate imported files; they are untrusted).
3. **Wiring UI.** React Flow Board view: place devices from a palette, drag audio and power cables jack to jack, refused connections show why. Grid view toggle.
4. **Core rig.** Engine sync + Power Supply, Splitter, Joiner, Boost, Distortion, Amp (with normalled loop), Cabs, Mics, Output. Check: two amps in parallel panned L/R, a pedal in the amp loop.
5. **Full catalog.** Done: every device has a sound model; realistic Board look; tuner readout and looper controls stream from the engine (`live` event, 10 Hz); 21 built-in presets in six categories (Clean, Acoustic, Crunch, Lead, Metal, Ambient).
6. **Play it.** Hotkeys, footswitch feel, glitch warning, a release build of `Rig.app`.

## Later (not in v1)

- NAM neural amp/pedal captures (native NAM C++ core inside the amp processor)
- VST/AU plugin build
- Voltage/mA checks for power, hum/ground-loop noise
- Cable tone loss and buffered/true-bypass behavior
- MIDI footswitches and expression pedals
- Intentional feedback loops
- Scenes (one switch changes many pedals)
- Windows build
- Looper WAV export, multi-track, tempo sync
- Bundled real cab/mic IR packs
