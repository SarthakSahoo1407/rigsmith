# Rigsmith

A guitar rig simulator for macOS, as an app and as an AU/VST3 plugin. Place as many pedals, amps, cabs, mics, splitters and power supplies as you like, cable them in any order, and your guitar plays through it live, the way it would through the real thing. Load Neural Amp Modeler captures of real amps and pedals next to the modelled gear.

![Rigsmith icon](native/icon.png)

## What it does

- **Free routing.** Audio follows the cables, like a real rig. Amps have an effects loop (send/return), and splitters and joiners let you run parallel chains, for example two amps panned left and right.
- **Power matters.** A pedal with no power cable is silent. Press P, or click "Plug into power", to wire it to a free outlet.
- **Three views.**
  - **Board:** the stage, a railed pedalboard and the desk, with every piece rendered in 3D and cables that hang with real plugs.
  - **Grid:** Quad Cortex-style blocks in signal order, each with a picture of its gear, and a panel that shows the whole rig or the selected block.
  - **Live:** your set on stage: the setlist on the left, the scene playing in big type, the next one, the rig's footswitches, tuner, tap tempo and levels. Knobs stay on the board.
- **Gear:** 9 amps, 4 cabs, 3 mics and 30 pedals (dynamics, drive, fuzz, pitch, filter, modulation, delay, reverb, looper), each with its own fictional maker and look.
- **NAM captures.** NAM amp, full-rig and pedal blocks run [Neural Amp Modeler](https://github.com/sdatkinson/NeuralAmpModelerCore) captures (`.nam`, including the A2 format).
- **TONE3000 browser.** Search, download and use captures and IRs from [TONE3000](https://www.tone3000.com) inside the app, with each creator's name and license kept beside the file. Rigsmith ships no third-party captures: their licenses don't allow it, so presets that use them fetch them from TONE3000 on your request.
- **Rendered gear.** Every pedal, amp, cab, speaker, mic, footswitch and knob is a 3D model (three.js) lit by a warm key light and rendered once to an image: you see each piece's sides, depth, chrome and tolex, while the knobs, switches and labels on top stay live. Cables hang with real plugs; the pedals sit on a railed board.
- **Live sets and scenes.** A set is a setlist of songs, each with scenes. A scene is any sound: a built-in preset, one of yours, or what's on the board now, changed however you like (other knobs, pedals on or off). Scenes from the same preset switch without a gap; one from another preset loads its rig. Seven example sets come with it (worship, rock covers, metal, blues, ambient, funk and country, acoustic), with made-up songs and their riffs, verses, choruses and solos.
- **Amps.** Clean, drive and lead channels with their own gain and EQ, bright/deep/fat switches, power tubes (EL34, 6L6, KT88, EL84), bias, sag and supply voltage.
- **Cab and mic studio.** Up to four mics per cab, dragged anywhere on the speaker, each with level, pan, distance, angle, time-align, polarity and solo, mixed to the cab's stereo outs. Or real IRs in two slots with a blend and low/high cut.
- **Tempo.** One BPM for the whole rig (type it, nudge it with ↑ ↓, or tap). Delays and chorus, flanger, phaser and tremolo can lock to a note length (1/2 to 1/16, dotted and triplet) instead of a free time or rate. Standalone only: a plugin doesn't read the host's tempo yet.
- **Assistant.** Press `/` (or the sparkle button) and type a change: "more reverb", "a bit less gain", "swap the delay for a tape echo", "add a delay after the reverb", "remove the chorus", "tempo 96". A language model on OpenRouter's free tier (key in Settings) turns it into a short list of edits that Rigsmith checks and applies as one undo step; anything it gets wrong is skipped and shown. Only your request and a list of the rig's blocks and knobs are sent.
- **Presets:** 44 built-in presets (clean, acoustic, crunch, lead, metal, ambient, live rigs, NAM captures, hybrids of captures and modelled gear), plus your own.
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
- **Live sets:** press **L**. Pick a set, or **+** for a new one. **Add a scene** takes a preset or what's on the board now. To make a scene its own sound, play it, change things on the board, come back and press **Save into the scene** (or **Save as a new scene**). The pencil edits names, songs and order. Changing an example set saves it as your own copy.
- **Shortcuts:** press **?** for the full list. The main ones:

| Key | Action |
|---|---|
| ← → | Previous / next preset |
| V | Board / Grid |
| L | Live mode (there: 1–9 pick a scene, space or ← → step through the set, Q–O pedals, Esc to leave) |
| , | Settings |
| T | Tuner |
| M / I | Mute output / mute guitar input |
| 1–9 | Stomp pedal 1–9 in signal order |
| B / P / Enter | Bypass, power, open the selected device |
| ⌫ | Delete the selected device or cable |
| \ | Show or hide the gear list |
| ⌘Z / ⇧⌘Z | Undo / redo |
| ⌘S / ⌘O / ⌘E | Save preset / open / export `.rigsmith` |

Your rig autosaves. Named presets, your live sets (`_sets.json`) and the autosave live in `~/Library/Application Support/Rig/Rigs`.

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
  - `src/gear.tsx` draws the gear's live controls; `src/models.ts` models each piece in three.js and `src/render3d.ts` renders the models to images (oblique camera, so a piece's face lines up with the controls on it).
  - `src/sets.ts` holds live sets; `src/Live.tsx` is Live mode.
- **Engine:** C++ with JUCE 8.
  - `native/Engine.h` runs the compiled rig as a node graph. It builds each new graph off the audio thread and fades between graphs, so re-cabling never clicks.
  - `native/Devices.h` holds one sound model per device. Amps have oversampled gain stages, a tone stack and a power section with sag. Cabs and the acoustic body are generated impulse responses.

`PLAN.md` has the full design: decisions, routing rules, data model, device catalog and what's planned next.

## Notes

- **Names:** all brand names on the gear are fictional. Models are described by what they're inspired by ("UK Plexi", "US Rectified"), never by a real product name.
- **Tuning:** the tone was tuned by measurement. A real DI recording is the best way to judge and retune it (see `npm run render -- my-di.wav`).
- **Platform:** macOS only for now. The file encryption uses CommonCrypto.
- **Sample rate:** NAM captures are made at 48 kHz; run your interface at 48 kHz to hear them as made (Rigsmith warns otherwise).
- **Licenses inside:** NeuralAmpModelerCore (MIT), Eigen (MPL 2.0), JUCE 8 (AGPLv3 or commercial), React Flow (MIT), three.js (MIT), lucide (ISC), Geist (SIL OFL 1.1). Powered by TONE3000.

`npm run dev`, then open `preview.html?preset=Shred%20lead&kind=pedals` (or `kind=amps`) to look at the gear in a plain browser, no app needed.

## Windows

Rigsmith builds for Windows 10 and 11 as an app and a VST3 plugin (no AU: that's Apple's format). The
UI runs in Microsoft Edge WebView2, which Windows 11 and current Windows 10 already include.

Build it with Visual Studio 2022 (the "Desktop development with C++" workload), CMake and Node 22:

```
npm ci
npm run build
cmake -S native -B native/build
cmake --build native/build --config Release
```

- The app is `native/build/Rig_artefacts/Release/Rigsmith.exe`, with its `ui` folder beside it: keep them together.
- The plugin is `native/build/RigPlugin_artefacts/Release/VST3/Rigsmith.vst3`. Copy the whole folder to `C:\Program Files\Common Files\VST3` (administrator rights needed).
- Rigs, captures and settings live in `%APPDATA%\Rigsmith`. `.rigsmith` files open on both systems.
- Audio uses WASAPI, which works with any interface but has more latency than a Mac. For low latency use your interface's ASIO driver: download Steinberg's ASIO SDK, and configure with `-DRIG_ASIO_SDK=<folder>` (the SDK's licence doesn't let us ship it).
- `.github/workflows/build.yml` builds both platforms and keeps the results as downloads.
