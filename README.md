# Rigsmith

A guitar rig simulator for macOS, as an app and as an AU/VST3 plugin. Place as many pedals, amps, cabs, mics, splitters and power supplies as you like, cable them in any order, and your guitar plays through it live, the way it would through the real thing. Load Neural Amp Modeler captures of real amps and pedals next to the modelled gear.

![Rigsmith icon](native/icon.png)

## What it does

- **Free routing.** Audio follows the cables, like a real rig. Amps have an effects loop (send/return), and splitters and joiners let you run parallel chains, for example two amps panned left and right.
- **Power matters.** A pedal with no power cable is silent. Press P, or click "Plug into power", to wire it to a free outlet.
- **Three views.**
  - **Board:** the stage, the pedalboard and the desk, drawn like real gear.
  - **Grid:** Quad Cortex-style tiles in signal order, with a panel that shows the whole rig or the selected block.
  - **Live:** a stage screen with big scene and footswitch targets, tuner, tap tempo and levels. Knobs are out of reach.
- **Gear:** 9 amps, 4 cabs, 3 mics and 30 pedals (dynamics, drive, fuzz, pitch, filter, modulation, delay, reverb, looper), each with its own fictional maker and look.
- **NAM captures.** NAM amp, full-rig and pedal blocks run [Neural Amp Modeler](https://github.com/sdatkinson/NeuralAmpModelerCore) captures (`.nam`, including the A2 format).
- **TONE3000 browser.** Search, download and use captures and IRs from [TONE3000](https://www.tone3000.com) inside the app, with each creator's name and license kept beside the file. Rigsmith ships no third-party captures: their licenses don't allow it, so presets that use them fetch them from TONE3000 on your request.
- **Scenes.** Up to eight per preset. Each remembers which blocks are on and any knob you mark per-scene (the small S), and switching is gapless.
- **Amps.** Clean, drive and lead channels with their own gain and EQ, bright/deep/fat switches, power tubes (EL34, 6L6, KT88, EL84), bias, sag and supply voltage.
- **Cab and mic studio.** Up to four mics per cab, dragged anywhere on the speaker, each with level, pan, distance, angle, time-align, polarity and solo, mixed to the cab's stereo outs. Or real IRs in two slots with a blend and low/high cut.
- **Presets:** 44 built-in presets (clean, acoustic, crunch, lead, metal, ambient, scenes, NAM captures, hybrids of captures and modelled gear), plus your own.
- **Tools:**
  - a standalone tuner
  - master and input mute
  - input and output meters
  - latency, CPU and RAM readouts
  - undo and redo
  - keyboard shortcuts
- **Files:** rigs export as encrypted `.rigsmith` files.

## Requirements

- macOS on Apple silicon or Intel, with the Xcode Command Line Tools (`xcode-select --install`).
- CMake 3.22 or newer.
- Node.js 22 or newer.
- An audio interface for your guitar, plus wired headphones or monitors. Bluetooth adds too much latency to play through.

## Build and run

```sh
npm install
npm run build                       # UI → dist/
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release   # first time only; fetches JUCE 8
cmake --build native/build -j8      # builds the app and the plugins; fetches NAM core and Eigen the first time
open native/build/Rig_artefacts/Release/Rigsmith.app
```

The build also installs the plugin to `~/Library/Audio/Plug-Ins/Components/Rigsmith.component` (AU) and `~/Library/Audio/Plug-Ins/VST3/Rigsmith.vst3`. In your DAW, put Rigsmith on a track that records your guitar input. The project saves the rig. The plugin passes Apple's `auval -v aufx Rgs2 Rgsm`.

### TONE3000

To browse and download captures in the app, create a free publishable key on tone3000.com (Settings, API), paste it in **Settings** (the sliders icon, or `,`), and sign in. Sign-in shows a short code to approve on tone3000.com. Downloads go to `~/Library/Application Support/Rig/Library`. You can also add your own `.nam` and `.wav` files under **Captures → Add files**.

On first launch, open **Audio settings** (the sliders icon, top right). Choose your interface, enable its guitar input, and set a buffer size of 64 or 128 samples. Then pick the input on the **DI box** and set its trim so the input meter peaks just below the clip light.

### Developing the UI

```sh
npm run dev -- --port 5173
RIG_DEV_URL=http://localhost:5173 open native/build/Rig_artefacts/Release/Rigsmith.app
```

With `RIG_DEV_URL` set, the app loads the Vite dev server, so UI changes hot-reload.

## Using it

- **Add gear:** click an item in the gear list on the left. You can also drag it onto the rig, or drop it onto a cable to put it in that cable.
- **Cable:** drag from one jack to another. A refused connection tells you why, for example "That would make a feedback loop".
- **Edit:**
  - Drag a knob up or down; double-click it to reset.
  - Click a pedal's footswitch to turn it on or off.
  - Double-click any device for a large view with every control, plus **Replace** and **Delete**.
- **Mics:** drag a mic onto a cab, then drag it across the cone. The centre is brighter and the edge darker. Scroll over the mic to move it closer or farther. Double-click the cab for the full mic studio.
- **Captures:** drag a capture from **Captures** onto the rig to make a NAM block (amp, full rig or pedal by its type), or onto a cable to insert it. Drag an IR onto a cab to load it.
- **Scenes:** **+ Add scenes** under the top bar snapshots what's playing. Switch with the scene buttons or ⇧1–⇧8; double-click one to rename it. Mark a knob per-scene with the **S** under it in a device's window.
- **Shortcuts:** press **?** for the full list. The main ones:

| Key | Action |
|---|---|
| ← → | Previous / next preset |
| V | Board / Grid |
| L | Live mode (there: 1–8 scenes, Q–O pedals, Esc to leave) |
| ⇧1–⇧8 | Scene A–H |
| , | Settings |
| T | Tuner |
| M / I | Mute output / mute guitar input |
| 1–9 | Stomp pedal 1–9 in signal order |
| B / P / Enter | Bypass, power, open the selected device |
| ⌫ | Delete the selected device or cable |
| \ | Show or hide the gear list |
| ⌘Z / ⇧⌘Z | Undo / redo |
| ⌘S / ⌘O / ⌘E | Save preset / open / export `.rigsmith` |

Your rig autosaves. Named presets and the autosave live in `~/Library/Application Support/Rig/Rigs`.

## Rig files

Export (⌘E) writes a `.rigsmith` file:
- **Encryption:** AES-256-CBC with an HMAC-SHA256 tag (`native/RigFile.h`).
- **Tampering:** a file that was changed or damaged outside the app is refused.
- **Older rigs:** `.json` files still import.
- **Limits:** the key is built into the app. That keeps rigs from being read or edited by other tools, but it is not protection against someone who takes the app apart.

## Checks and tools

```sh
npm test                                      # routing rules, presets, layout, replace/insert (vitest)
native/build/RigCheck_artefacts/Release/RigCheck   # audio engine checks: every device, every amp/cab, tuner, rig files
npm run render                                # every preset → renders/*.wav, with its tone balance
npm run render -- my-di.wav                   # your own dry guitar recording through every preset
npm run render -- Metal                       # only presets matching a name or category
```

`npm run render` needs the native build, since it drives `RigRender`. Without a DI file it plays a synthesised guitar: chords for clean, crunch and acoustic, a lead phrase for leads, and palm-muted chugs for metal.

## How it's built

- **UI:** React 19 and TypeScript, with React Flow, running in JUCE's web view.
  - `src/rig.ts` is the rig model: devices, cables, routing rules, undo, and `compile()`.
  - `src/layout.ts` places gear on the board and the grid.
  - `src/gear.tsx` draws the gear.
- **Engine:** C++ with JUCE 8.
  - `native/Engine.h` runs the compiled rig as a node graph. It builds each new graph off the audio thread and fades between graphs, so re-cabling never clicks.
  - `native/Devices.h` holds one sound model per device. Amps have oversampled gain stages, a tone stack and a power section with sag. Cabs and the acoustic body are generated impulse responses.

`PLAN.md` has the full design: decisions, routing rules, data model, device catalog and what's planned next.

## Notes

- **Names:** all brand names on the gear are fictional. Models are described by what they're inspired by ("UK Plexi", "US Rectified"), never by a real product name.
- **Tuning:** the tone was tuned by measurement. A real DI recording is the best way to judge and retune it (see `npm run render -- my-di.wav`).
- **Platform:** macOS only for now. The file encryption uses CommonCrypto.
- **Sample rate:** NAM captures are made at 48 kHz; run your interface at 48 kHz to hear them as made (Rigsmith warns otherwise).
- **Licenses inside:** NeuralAmpModelerCore (MIT), Eigen (MPL 2.0), JUCE 8 (AGPLv3 or commercial), React Flow (MIT), lucide (ISC), Geist (SIL OFL 1.1). Powered by TONE3000.
