# DSP accuracy and performance

Improve sound accuracy while preserving low-latency playback. Measure each change against the baseline before accepting it.

## 1. Establish an audio baseline

- [ ] Extend `native/check.cpp` and the offline renderer with repeatable DI, impulse, sweep, and distortion measurements. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Compare the same DI through Rigsmith and the official NAM plugin with matched models, gain, normalization, and sample rates. — NOT DONE: needs measurement against the official NAM plugin or hardware, listening tests, or a large DSP change; not started
- [ ] Measure frequency response, harmonics, aliasing, processing latency, and parallel-path cancellation. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Benchmark worst-case audio callback time and dropouts at 44.1/48/96 kHz and 64/128/256-sample buffers, including knob changes and scene switches. At 48 kHz, a 64-sample block has a 1.33 ms deadline. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass

## 2. Correct gain staging and NAM calibration

- [ ] Support NAM input-calibration metadata and interface calibration separately from output loudness normalization. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Measure levels before and after NAM, cabinet processing, and final output protection to locate unwanted distortion in clean captures. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Review cabinet normalization, fixed gain compensation, and the final soft clipper, which starts shaping above 0.7 amplitude (about -3.1 dBFS). — NOT DONE: reviewed the final soft clipper only: it is transparent below -3.1 dBFS, so it is not what distorts clean captures (the captures were; see the preset swap). Cab normalisation and fixed gains are unreviewed
- [ ] Add regression checks for calibrated clean captures and output headroom; document any preset-level changes. — NOT DONE: added only the output-protection check (softClip transparent below 0.7, never above 1.0). Calibrated-capture checks need NAM input-calibration support first

## 3. Compensate for processing latency

- [ ] Track each node's processing latency, including oversampling, NAM model/resampling, and convolution latency where applicable. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Align shorter parallel branches before summing and align dry/wet bypass paths. Preserve intentional effect and mic-distance delays. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Report the resulting processing latency to the plugin host and include it in standalone latency readouts. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Verify alignment with impulses, parallel cancellation, bypass transitions, and sample-rate changes. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass

## 4. Reduce audible DSP artifacts

- [ ] Measure power-amp aliasing and add oversampling where the measurements justify its CPU cost. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Smooth abrupt gain and filter changes; verify stability and click-free knob movement. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Validate NAM sample-rate conversion for frequency response, alias rejection, continuity, and queue underflow/overflow behavior. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass

## 5. Remove unnecessary processing

- [x] Apply parameters and trigger retuning/configuration only for nodes whose relevant values changed. — done: `Engine::applyParams` returns whether a knob or file changed; retune and `configure()` run only for changed or new nodes (native/Engine.h)
- [ ] Profile NAM queue copying; replace front erases with preallocated circular buffers if the cost is significant. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Audit callback work for allocations, blocking, destruction, and CPU spikes under representative rigs. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass
- [ ] Verify optimizations preserve rendered output within a defined numerical tolerance and improve measured callback time. — NOT DONE: larger DSP work needing a measurement harness first; not started this pass

## 6. Improve model fidelity

- [ ] Fit built-in amp and pedal models against measured hardware responses across input levels and control settings. — NOT DONE: needs measurement against the official NAM plugin or hardware, listening tests, or a large DSP change; not started
- [ ] Replace independent amp EQ approximations with measured or circuit-derived interacting tone stacks. — NOT DONE: needs measurement against the official NAM plugin or hardware, listening tests, or a large DSP change; not started
- [ ] Improve power-stage sag, bias, and speaker-load behavior against reference measurements. — NOT DONE: needs measurement against the official NAM plugin or hardware, listening tests, or a large DSP change; not started
- [ ] Evaluate measured cabinet/mic IRs against the generated responses; use assets with suitable redistribution rights. — NOT DONE: needs measurement against the official NAM plugin or hardware, listening tests, or a large DSP change; not started
- [ ] Validate improvements with level-matched listening comparisons and repeat the performance benchmarks. — NOT DONE: needs measurement against the official NAM plugin or hardware, listening tests, or a large DSP change; not started

# Product performance

Improve responsiveness without reducing sound quality. Prioritize live-readout isolation and separating layout changes from audio changes after measuring the baseline.

## 1. Establish a product baseline

- [ ] Profile the release app inside JUCE's webview with small, typical, and large rigs. — NOT DONE: needs the release app profiled in the webview (no screen or profiler access in this session)
- [ ] Measure frame time and input response during knob drags, gear movement, and playback. — NOT DONE: needs the release app profiled in the webview (no screen or profiler access in this session)
- [ ] Measure cold startup, preset/scene loading, worst-case audio callback time, and dropouts. — NOT DONE: needs the release app profiled in the webview (no screen or profiler access in this session)
- [ ] Measure total memory including webview processes; the current RAM display excludes them. — NOT DONE: needs the release app profiled in the webview (no screen or profiler access in this session)
- [ ] Set acceptance budgets from the baseline, targeting smooth 60 fps interaction, no long loading stalls, and zero audio deadline misses under the tested workload. — NOT DONE: needs the release app profiled in the webview (no screen or profiler access in this session)

## 2. Isolate live readouts

- [ ] Give meters, tuner, and looper independent subscriptions so their updates do not rerender static gear and the workspace. — NOT DONE: feature-sized work, not started this pass
- [ ] Separate frequently changing levels/live state from the board's rig context. — NOT DONE: feature-sized work, not started this pass
- [ ] Sample CPU and RAM less frequently while preserving responsive meters and tuner updates. — NOT DONE: feature-sized work, not started this pass

## 3. Separate layout edits from audio edits

- [x] Recalculate layout only when placement or relevant gear properties change, rather than on every knob change. — done: Board.tsx keys the layout on a placement string, so knob turns and pedal switching skip it
- [ ] Preserve unchanged node and edge references; stabilize React Flow callbacks where profiling shows unnecessary updates. — NOT DONE: layout is stabilised, but node and edge arrays are still rebuilt on every rig change; needs profiling in the real webview
- [ ] Avoid compiling and sending audio rigs for purely visual placement changes; preserve undo and autosave behavior. — NOT DONE: setRig still runs on every rig change; the engine now skips retuning for unchanged nodes, but a purely visual move still recompiles
- [ ] Verify knob changes, cab/mic placement, routing, and gear replacement still update every affected visual and audio property. — NOT DONE: needs the release app profiled in the webview (no screen or profiler access in this session)

## 4. Reduce graphics startup work

- [ ] Pre-render common gear sprites for release builds, retaining on-demand generation for uncommon variants and the existing cache. — NOT DONE: feature-sized work, not started this pass
- [ ] Subscribe to individual cached sprites so completing one sprite does not invalidate every sprite subscriber. — NOT DONE: feature-sized work, not started this pass
- [ ] Profile synchronous PNG encoding and sprite-generation frame time; bound background rendering work to preserve interaction responsiveness. — NOT DONE: needs the release app profiled in the webview (no screen or profiler access in this session)

## 5. Reduce native update and loading work

- [ ] Complete the changed-node parameter/configuration work in DSP section 5; rebuild routing only when its structure changes. — NOT DONE: native half done (changed-node apply and configure); routing rebuild already happens only when structure changes (`structureOf`); library caching is a separate item
- [ ] Cache library metadata with file-change invalidation to avoid repeated disk reads and full NAM parsing during listings. — NOT DONE: feature-sized work, not started this pass
- [ ] Load NAM models on a worker and safely hand completed models to the engine; handle cancellation, failures, and stale load results. — NOT DONE: feature-sized work, not started this pass
- [ ] Repeat startup, interaction, loading, memory, and audio benchmarks after changes to confirm gains without sound-quality regressions. — NOT DONE: needs the release app profiled in the webview (no screen or profiler access in this session)

# Product features and content

## 1. Guided audio setup and diagnostics

- [ ] Add a guided setup flow for interface selection, input channel, signal detection, gain calibration, and output selection. — NOT DONE: feature-sized work, not started this pass
- [ ] Add a "Why no sound?" diagnostic that identifies where the signal stops: device/input, mute, pedal power, routing, cab/mic, or output. — NOT DONE: feature-sized work, not started this pass
- [ ] Offer actionable fixes using existing audio settings and routing/power controls. — NOT DONE: feature-sized work, not started this pass

## 2. MIDI foot-controller support

- [ ] Support MIDI input in the standalone app and plugin, with MIDI Learn for CC and Program Change mappings. — NOT DONE: feature-sized work, not started this pass
- [ ] Map controllers to scene/preset changes, pedal switches, tap tempo, tuner, mute, and expression-controlled parameters. — NOT DONE: feature-sized work, not started this pass
- [ ] Save controller mappings and support device selection and reconnection. — NOT DONE: feature-sized work, not started this pass

## 3. Preset search and favorites

- [x] Search built-in and saved presets/rigs by name and category. — done: `src/PresetPicker.tsx`
- [x] Add persistent favorites and a favorites-only view for quick access. — done: stars and a favourites filter, kept in localStorage (per Mac, not in the rig files)

## 4. Expand gear, patches, and rigs

- [ ] Add more FX pedals with distinct, useful sounds and controls. — NOT DONE: feature-sized work, not started this pass
- [ ] Add more amp models with distinct clean, crunch, lead, and high-gain voicings. — NOT DONE: feature-sized work, not started this pass
- [ ] Expand other necessary gear where it fills a routing or tonal gap, including cabinets, microphones, and utility blocks. — NOT DONE: feature-sized work, not started this pass
- [ ] Add more ready-to-play patches and complete rigs across genres, gain levels, and playing styles, including examples for the new gear. — NOT DONE: feature-sized work, not started this pass
- [ ] Validate new gear and rigs for routing, output levels, sound quality, and CPU cost; clearly identify any required external captures or IRs. — NOT DONE: feature-sized work, not started this pass
