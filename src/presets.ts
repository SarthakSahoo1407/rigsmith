// Built-in rigs. Board placement is automatic (layout.ts); the builder only records signal order:
// pedals right to left on the board, amp stacks left to right on the stage. The Grid lays the
// same rig out left to right in signal order.

import { def, type DeviceType } from './catalog';
import {
  addDevice, addScene, applyScene, connect, emptyRig, linkParam, mainJack as jackOf, moveDevice, placeMic, removeScene, renameScene, selectScene,
  setFile, setParam, toggle, type FileRef, type Rig, type XY,
} from './rig';

const mainJack = (type: DeviceType, dir: 'in' | 'out') => jackOf(type, dir)!;

type Params = Record<string, number>;
type Size = '1x12' | '2x12' | '4x12';
type Speaker = 'warm 25W' | 'aggressive 60W' | 'chimey alnico' | 'sparkly US';
type Kit = {
  input: () => string;
  pedal: (type: DeviceType, params?: Params, opts?: { off?: boolean; loop?: boolean; capture?: Capture }) => string;
  capture: (type: 'namAmp' | 'namRig', capture: Capture, params?: Params) => string; // a NAM head on the stage
  amp: (params: Params) => string;
  cab: (size: Size, speaker?: Speaker) => string; // goes under the last amp added
  mic: (model: 'dynamic' | 'ribbon' | 'condenser', cab: string, position: number, distance: number) => string;
  output: (volume?: number) => string;
  typeOf: (id: string) => DeviceType;
  wire: (from: string, fromJack: string, to: string, toJack: string) => void;
  chain: (...ids: string[]) => void; // out → in along the list, using each device's main jacks
  loop: (amp: string, ...fx: string[]) => void; // amp send → effects → amp return
  toOutput: (from: string, output: string) => void; // stereo devices feed both sides
};


function build(steps: (kit: Kit) => void): Rig {
  let rig = emptyRig();
  let col = 0;
  let pedals = 0;
  let stacks = 0;
  const mics: Record<string, number> = {};

  const add = (type: DeviceType, board: XY, gridRow = 0, params: Params = {}) => {
    let id: string;
    [rig, id] = addDevice(rig, type, board);
    rig = moveDevice(rig, id, 'grid', { x: col++ * 230, y: gridRow * 260 });
    for (const [k, v] of Object.entries(params)) rig = setParam(rig, id, k, v);
    return id;
  };
  const choice = (type: DeviceType, name: string, option: string) => def(type).params.find((p) => p.name === name)!.options!.indexOf(option);

  const kit: Kit = {
    input: () => add('input', { x: 0, y: 0 }),
    pedal: (type, params = {}, opts = {}) => {
      const id = add(type, { x: -200 * pedals++ || 0, y: 0 }, opts.loop ? -1 : 0, params);
      if (opts.off) rig = { ...rig, devices: { ...rig.devices, [id]: { ...rig.devices[id], on: false } } };
      if (opts.capture) rig = setFile(rig, id, 'model', fileOf(opts.capture));
      return id;
    },
    capture: (type, capture, params = {}) => {
      const id = add(type, { x: 1000 * stacks++, y: 0 }, 0, params);
      rig = setFile(rig, id, 'model', fileOf(capture));
      return id;
    },
    amp: (params) => add('amp', { x: 1000 * stacks++, y: 0 }, 0, params),
    cab: (size, speaker = 'warm 25W') => add('cab', { x: 1000 * (stacks - 1), y: 0 }, 0, { size: choice('cab', 'size', size), speaker: choice('cab', 'speaker', speaker) }),
    mic: (model, cab, position, distance) => {
      const n = mics[cab] = (mics[cab] ?? -1) + 1;
      const id = add('mic', { x: n, y: 0 }, 1, { model: choice('mic', 'model', model), level: n ? -3 : 0 });
      rig = placeMic(rig, id, { cab, x: position, y: n % 2 ? 0.25 : 0.75, distance }); // a second mic on the same cone goes on the other side
      return id;
    },
    output: (volume) => add('output', { x: 0, y: 0 }, 0, volume === undefined ? {} : { volume }),
    typeOf: (id) => rig.devices[id].type,
    wire: (a, aj, b, bj) => { rig = connect(rig, { device: a, jack: aj }, { device: b, jack: bj }); },
    chain: (...ids) => {
      for (let i = 1; i < ids.length; i++) {
        const [a, b] = [rig.devices[ids[i - 1]], rig.devices[ids[i]]];
        kit.wire(a.id, mainJack(a.type, 'out'), b.id, mainJack(b.type, 'in'));
      }
    },
    toOutput: (from, output) => {
      const stereo = def(rig.devices[from].type).jacks.some((j) => j.name === 'outR');
      kit.wire(from, stereo ? 'outL' : 'out', output, 'L');
      if (stereo) kit.wire(from, 'outR', output, 'R');
    },
    loop: (amp, ...fx) => {
      const [first, last] = [rig.devices[fx[0]], rig.devices[fx[fx.length - 1]]];
      kit.wire(amp, 'send', first.id, mainJack(first.type, 'in'));
      kit.chain(...fx);
      kit.wire(last.id, mainJack(last.type, 'out'), amp, 'return');
    },
  };
  steps(kit);

  // Power every pedal that needs it from bricks under the board, 8 outlets each.
  const needy = Object.values(rig.devices).filter((d) => def(d.type).power);
  let brick = '';
  needy.forEach((d, i) => {
    if (i % 8 === 0) brick = add('power', { x: i, y: 0 }, 2);
    kit.wire(brick, String((i % 8) + 1), d.id, 'dc');
  });
  return rig;
}

export type Preset = { category: string; build: () => Rig };
export const DEFAULT_PRESET = 'Clean amp';

// Captures on TONE3000 these presets use. Rigsmith never ships the files: loading a preset offers to
// download them through the TONE3000 API, on the user's request, with the creator's name and license.
// Titles are the creators' own.
type Capture = { toneId: number; name: string; gear: string; author: string; url: string; license?: string };
const T3K = {
  deluxe: { toneId: 104188, name: "Fender '62 Deluxe Amp - Bright Ch - 2026", gear: 'amp', author: 'outmodedelectronics', license: 't3k', url: 'https://www.tone3000.com/tones/fender-62-deluxe-amp-bright-ch-2026-104188' },
  badlander: { toneId: 82361, name: 'Mesa Badlander 50 - Crunch - Mesa 4x12 Load - Amp Head', gear: 'amp', author: 'outmodedelectronics', license: 't3k', url: 'https://www.tone3000.com/tones/mesa-badlander-50-crunch-mesa-4x12-load-amp-head-82361' },
  dualRec: { toneId: 26226, name: 'Mesa Dual Rectifer Multiwatt', gear: 'amp', author: 'StudioAmpCaptures', license: 't3k', url: 'https://www.tone3000.com/tones/mesa-dual-rectifer-multiwatt-26226' },
  dualRecRig: { toneId: 26225, name: 'Mesa Dual Rectifier Multiwatt Celestion V30', gear: 'amp-cab', author: 'StudioAmpCaptures', license: 't3k', url: 'https://www.tone3000.com/tones/mesa-dual-rectifier-multiwatt-celestion-v30-26225' },
  deluxeRig: { toneId: 104183, name: "Fender '62 Deluxe - Bright Ch - SM57/M201 - 2026", gear: 'amp-cab', author: 'outmodedelectronics', url: 'https://www.tone3000.com/tones/fender-62-deluxe-bright-ch-sm57m201-2026-104183' },
  ts9: { toneId: 36827, name: 'Ibanez TS9 Tube Screamer', gear: 'pedal', author: 'StudioAmpCaptures', license: 't3k', url: 'https://www.tone3000.com/tones/ibanez-ts9-tube-screamer-36827' },
  mastotron: { toneId: 94478, name: 'ZVex Mastotron Fuzz', gear: 'pedal', author: 'outmodedelectronics', url: 'https://www.tone3000.com/tones/zvex-mastotron-fuzz-94478' },
  blade: { toneId: 36832, name: 'Fortin Blade Whitechapel Boost', gear: 'pedal', author: 'StudioAmpCaptures', url: 'https://www.tone3000.com/tones/fortin-blade-whitechapel-boost-36832' },
} satisfies Record<string, Capture>;
// Until it's downloaded, a capture's library id is a placeholder; library.ts resolve() finds the real
// file by its tone.
const fileOf = (c: Capture): FileRef => ({
  id: `nam/t3k-${c.toneId}.nam`, name: c.name, kind: 'nam', source: 'tone3000', toneId: c.toneId, author: c.author, license: c.license, toneUrl: c.url, gear: c.gear,
});

// Common shape: guitar → tuner → pedals → amp (or a NAM amp capture) → cab → mic(s) → interface,
// effects optionally in the amp's loop. A NAM full-rig capture goes straight to the interface, as
// does a rig with no amp. Two mics on one cab go through the cab's mic mixer, both centred.
type Mic = ['dynamic' | 'ribbon' | 'condenser', number, number]; // model, position, distance
type Shape = {
  pedals?: [DeviceType, Params?, { off?: boolean; capture?: Capture }?][];
  amp?: Params;
  capture?: Capture; // a NAM amp in place of the modelled amp, or a full rig (gear amp-cab) in place of amp, cab and mics
  loop?: [DeviceType, Params?][];
  cab?: [Size, Speaker];
  mics?: Mic[];
  level?: number; // interface volume, to even out preset loudness
};
const rigOf = ({ pedals = [], amp, capture, loop = [], cab = ['2x12', 'warm 25W'], mics = [['dynamic', 0.3, 0.1]], level }: Shape) => () => build((k) => {
  const i = k.input();
  const t = k.pedal('tuner');
  const chain = [i, t, ...pedals.map(([type, params, opts]) => k.pedal(type, params, opts))];
  const fx = loop.map(([type, params]) => k.pedal(type, params, { loop: true }));
  const o = k.output(level);
  if (capture?.gear === 'amp-cab') chain.push(k.capture('namRig', capture));
  if (!amp && capture?.gear !== 'amp') {
    k.chain(...chain);
    k.toOutput(chain[chain.length - 1], o);
    return;
  }
  const a = capture ? k.capture('namAmp', capture) : k.amp(amp!), c = k.cab(...cab);
  k.chain(...chain, a, c);
  if (fx.length && !capture) k.loop(a, ...fx);
  const ms = mics.map(([model, x, d]) => k.mic(model, c, x, d));
  if (!ms[1]) return k.wire(ms[0], 'out', o, 'L');
  k.wire(c, 'outL', o, 'L');
  k.wire(c, 'outR', o, 'R');
});

// Two amps on a splitter, one per side of the stereo field: left amp → interface L, right → R.
type Side = { amp: Params; cab: [Size, Speaker]; mic: Mic; pedals?: [DeviceType, Params?][]; loop?: [DeviceType, Params?][] };
const dualOf = ({ pedals = [], left, right, level }: { pedals?: Shape['pedals']; left: Side; right: Side; level?: number }) => () => build((k) => {
  const i = k.input(), t = k.pedal('tuner');
  const pre = pedals.map(([type, params, opts]) => k.pedal(type, params, opts));
  const sp = k.pedal('splitter');
  k.chain(i, t, ...pre, sp);
  const o = k.output(level);
  for (const [jack, side, out] of [['outA', left, 'L'], ['outB', right, 'R']] as const) {
    const fx = (side.pedals ?? []).map(([type, params]) => k.pedal(type, params));
    const a = k.amp(side.amp), c = k.cab(...side.cab);
    const first = fx[0] ?? a;
    k.wire(sp, jack, first, mainJack(k.typeOf(first), 'in'));
    k.chain(...fx, a, c);
    const loop = (side.loop ?? []).map(([type, params]) => k.pedal(type, params, { loop: true }));
    if (loop.length) k.loop(a, ...loop);
    k.wire(k.mic(side.mic[0], c, side.mic[1], side.mic[2]), 'out', o, out);
  }
});

// Amp models (src/catalog.ts AMP_MODELS) and effect models by name.
const AMP = { usClean: 0, tweed: 1, chime: 2, plexi: 3, ukLead: 4, rectified: 5, modern: 6, boutique: 7, jazz: 8 };
const amp = (model: keyof typeof AMP, gain: number, bass = 5, mid = 5, treble = 5, presence = 5, master = 5) =>
  ({ model: AMP[model], gain, bass, mid, treble, presence, master });
const OD = 0, DIST = 1, AIAB = 2, METAL = 3; // drive models
const comp = (threshold: number, ratio: number, makeup: number, attack = 10, release = 120) => ({ threshold, ratio, attack, release, makeup });
const REVERB = { room: 0, hall: 1, plate: 2, spring: 3 };
const verb = (model: keyof typeof REVERB, decay: number, mix: number, tone = 6, predelay = 15) => ({ model: REVERB[model], decay, predelay, tone, mix });
const DELAY = { digital: 0, tape: 1, analog: 2 };
const echo = (model: keyof typeof DELAY, time: number, feedback: number, mix: number, tone = 5, pingpong = 0) => ({ model: DELAY[model], time, feedback, tone, mix, pingpong });
const drive = (model: number, d: number, tone: number, level: number) => ({ model, drive: d, tone, level });
const boostPedal = (d: number) => ['distortion', drive(OD, d, 6, 8)] as [DeviceType, Params]; // overdrive as a tight boost before high gain
const gate = (threshold: number, release = 60): [DeviceType, Params] => ['gate', { threshold, release }];

const BASE: Record<string, Preset> = {
  // Clean
  [DEFAULT_PRESET]: { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-24, 3, 4)]],
    amp: amp('usClean', 4, 5, 5, 6), loop: [['reverb', verb('spring', 2, 0.3)]],
    cab: ['2x12', 'sparkly US'],
  }) },
  'Glassy chorus clean': { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-26, 4, 6, 5)], ['chorus', { rate: 0.7, depth: 0.45, mix: 0.45 }]],
    amp: amp('jazz', 5, 4, 5, 7, 6), loop: [['reverb', verb('plate', 2.4, 0.3, 7)]],
    cab: ['2x12', 'sparkly US'], mics: [['condenser', 0.35, 0.2]],
  }) },
  'Jazz clean': { category: 'Clean', build: rigOf({
    amp: amp('jazz', 4, 6, 6, 3, 3), loop: [['reverb', verb('room', 1.2, 0.18, 4)]],
    cab: ['1x12', 'warm 25W'], mics: [['ribbon', 0.5, 0.35]],
  }) },
  'Chime jangle': { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-24, 3, 4)]],
    amp: amp('chime', 4, 4, 5, 7, 6), loop: [['reverb', verb('plate', 1.8, 0.25, 7)]],
    cab: ['2x12', 'chimey alnico'],
  }) },
  'Electric 12-string': { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-26, 4, 5, 5)], ['pitch', { interval: 12, detune: 6, mix: 0.5 }]],
    amp: amp('chime', 3, 4, 5, 7, 6), loop: [['reverb', verb('plate', 2, 0.25, 7)]],
    cab: ['2x12', 'chimey alnico'], mics: [['condenser', 0.3, 0.2]],
  }) },
  'Country slapback': { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-30, 6, 8, 2, 90)]],
    amp: amp('usClean', 5, 4, 6, 7, 7, 6), loop: [['delay', echo('tape', 110, 0.08, 0.35, 6)]],
    cab: ['1x12', 'sparkly US'], mics: [['dynamic', 0.2, 0.05]],
  }) },
  'Funk clean': { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-30, 6, 9, 3, 80)], ['wah', { position: 0.6, q: 6 }, { off: true }], ['phaser', { rate: 0.4, depth: 0.6, feedback: 0.3, stages: 0 }]],
    amp: amp('usClean', 4, 4, 6, 7, 6, 7), cab: ['1x12', 'sparkly US'], mics: [['condenser', 0.4, 0.2]],
  }) },
  'Surf': { category: 'Clean', build: rigOf({
    pedals: [['tremolo', { rate: 6, depth: 0.5, shape: 0 }]],
    amp: amp('usClean', 5, 4, 5, 7, 6, 6), loop: [['reverb', verb('spring', 4, 0.6, 7, 5)]],
    cab: ['2x12', 'sparkly US'],
  }) },

  // Acoustic: no amp. The acoustic sim turns the pickup into a guitar body, straight to the interface.
  'Acoustic dreadnought': { category: 'Acoustic', build: rigOf({
    pedals: [['compressor', comp(-26, 3, 4, 15, 150)], ['acoustic', { body: 0, mix: 0.75, top: 5, level: 5 }], ['reverb', verb('room', 1.4, 0.22, 6, 10)]],
  }) },
  'Acoustic nylon': { category: 'Acoustic', build: rigOf({
    pedals: [['compressor', comp(-24, 2.5, 3, 20, 180)], ['acoustic', { body: 3, mix: 0.8, top: 3, level: 5 }], ['reverb', verb('hall', 2.2, 0.25, 4, 20)]],
  }) },
  // Octave strings first, then the body, so both sets of strings ring through the same guitar.
  'Acoustic 12-string': { category: 'Acoustic', build: rigOf({
    pedals: [
      ['compressor', comp(-26, 3, 4, 15, 150)],
      ['pitch', { interval: 12, detune: 5, mix: 0.55 }],
      ['acoustic', { body: 1, mix: 0.7, top: 6, level: 5 }],
      ['reverb', verb('plate', 1.8, 0.25, 7, 15)],
    ],
  }) },

  // Crunch
  'Blues crunch': { category: 'Crunch', build: rigOf({
    amp: amp('tweed', 7, 6, 6, 5, 5, 6), loop: [['reverb', verb('spring', 1.6, 0.2, 5)]],
    cab: ['2x12', 'warm 25W'], mics: [['ribbon', 0.4, 0.25]],
  }) },
  'Classic rock': { category: 'Crunch', build: rigOf({
    pedals: [['wah', { position: 0.5, q: 5 }, { off: true }]],
    amp: amp('plexi', 8, 6, 6, 6, 5, 7), loop: [['delay', echo('analog', 380, 0.25, 0.22)]],
    cab: ['4x12', 'warm 25W'],
  }) },
  'Indie crunch': { category: 'Crunch', build: rigOf({
    pedals: [['boost', { model: 1, gain: 9, tone: 4 }]],
    amp: amp('chime', 7, 4, 6, 6, 6), loop: [['reverb', verb('plate', 1.6, 0.2, 6)]],
    cab: ['2x12', 'chimey alnico'],
  }) },

  'Clean and crunch': { category: 'Crunch', build: dualOf({
    pedals: [['compressor', comp(-24, 3, 3)]],
    left: { amp: amp('usClean', 4, 5, 5, 6, 5, 6.5), cab: ['2x12', 'sparkly US'], mic: ['condenser', 0.35, 0.2] },
    right: { amp: amp('plexi', 7, 6, 6, 6, 5, 6), cab: ['4x12', 'warm 25W'], mic: ['dynamic', 0.3, 0.1] },
  }) },

  // Lead
  'Singing lead': { category: 'Lead', build: rigOf({
    pedals: [['compressor', comp(-20, 3, 3, 20, 200)]],
    amp: amp('boutique', 7, 5, 6, 5, 5, 6),
    loop: [['delay', echo('tape', 420, 0.35, 0.3)], ['reverb', verb('hall', 2.5, 0.2)]],
    cab: ['2x12', 'warm 25W'], mics: [['dynamic', 0.3, 0.1], ['ribbon', 0.5, 0.3]],
  }) },
  'Blues lead': { category: 'Lead', build: rigOf({
    pedals: [['distortion', drive(OD, 5, 6, 6)]],
    amp: amp('tweed', 8, 5, 6, 5, 5, 6),
    loop: [['delay', echo('analog', 350, 0.2, 0.2)], ['reverb', verb('spring', 1.8, 0.2, 5)]],
    cab: ['1x12', 'warm 25W'], mics: [['ribbon', 0.4, 0.2]],
  }) },
  'Rock lead': { category: 'Lead', build: rigOf({
    pedals: [boostPedal(1)],
    amp: amp('ukLead', 6, 5, 7, 6, 6, 6),
    loop: [['delay', echo('digital', 380, 0.3, 0.22, 6)], ['reverb', verb('hall', 2, 0.15)]],
    cab: ['4x12', 'warm 25W'],
  }) },
  'Shred lead': { category: 'Lead', build: rigOf({
    pedals: [gate(-50, 80), boostPedal(0)],
    amp: amp('modern', 6, 5, 6, 6, 6, 5),
    loop: [['delay', echo('digital', 380, 0.3, 0.2, 6)]],
    cab: ['4x12', 'aggressive 60W'], mics: [['dynamic', 0.25, 0.05], ['ribbon', 0.5, 0.3]],
  }) },
  // Two lead amps with their own delays, set to different times so the repeats bounce side to side.
  'Stereo lead': { category: 'Lead', build: dualOf({
    pedals: [boostPedal(2)],
    left: { amp: amp('boutique', 7, 5, 6, 5, 5, 6), cab: ['2x12', 'warm 25W'], mic: ['dynamic', 0.3, 0.1], loop: [['delay', echo('tape', 380, 0.3, 0.25)]] },
    right: { amp: amp('ukLead', 6, 5, 7, 6, 5, 6), cab: ['4x12', 'warm 25W'], mic: ['dynamic', 0.3, 0.1], loop: [['delay', echo('digital', 510, 0.3, 0.25, 6)]] },
  }) },
  'Octave fuzz lead': { category: 'Lead', build: rigOf({
    pedals: [['octave', { dry: 1, sub: 0, up: 0.6 }], ['fuzz', { model: 0, fuzz: 7, tone: 6, level: 6 }]],
    amp: amp('plexi', 4, 5, 6, 5, 5, 7), loop: [['delay', echo('analog', 300, 0.3, 0.25)]],
    cab: ['4x12', 'warm 25W'],
  }) },

  // Metal: a gate before the amp kills hiss, an overdrive with no gain tightens the low end.
  'Modern metal': { category: 'Metal', build: rigOf({
    pedals: [gate(-45), boostPedal(0)],
    amp: amp('modern', 6, 5, 5, 5, 5, 5),
    loop: [['eq', { '100Hz': 1, '400Hz': -2, '3200Hz': 1 }]],
    cab: ['4x12', 'aggressive 60W'], mics: [['dynamic', 0.2, 0.05], ['dynamic', 0.5, 0.15]],
  }) },
  'Rectified chug': { category: 'Metal', build: rigOf({
    pedals: [gate(-45), boostPedal(0)],
    amp: amp('rectified', 6, 5, 6, 5, 5, 5),
    cab: ['4x12', 'aggressive 60W'], mics: [['dynamic', 0.25, 0.05], ['condenser', 0.4, 0.3]],
  }) },
  'Djent': { category: 'Metal', build: rigOf({
    pedals: [gate(-45, 40), ['distortion', drive(OD, 0, 6, 9)]],
    amp: amp('modern', 5, 5, 7, 6, 7, 5),
    loop: [['eq', { '100Hz': -2, '200Hz': -2, '800Hz': 2, '1600Hz': 2 }]],
    cab: ['4x12', 'aggressive 60W'], mics: [['dynamic', 0.15, 0.03], ['dynamic', 0.45, 0.1]],
  }) },
  'Thrash': { category: 'Metal', build: rigOf({
    pedals: [gate(-45, 50), boostPedal(1)],
    amp: amp('ukLead', 8, 6, 4, 6, 5, 6),
    cab: ['4x12', 'aggressive 60W'], mics: [['dynamic', 0.25, 0.05]],
  }) },
  'Doom': { category: 'Metal', build: rigOf({
    pedals: [['fuzz', { model: 1, fuzz: 6, tone: 7, level: 4 }]],
    amp: amp('rectified', 4, 5, 6, 6, 5, 5), loop: [['reverb', verb('room', 2, 0.15, 4)]],
    cab: ['4x12', 'warm 25W'], mics: [['ribbon', 0.4, 0.2]],
  }) },

  // Two rectified/modern stacks, one per side: the double-tracked wall of a metal record.
  'Twin stack metal': { category: 'Metal', build: dualOf({
    pedals: [gate(-45), boostPedal(0)],
    left: { amp: amp('rectified', 6, 5, 6, 5, 5, 5), cab: ['4x12', 'aggressive 60W'], mic: ['dynamic', 0.25, 0.05] },
    right: { amp: amp('modern', 6, 5, 5, 5, 5, 5), cab: ['4x12', 'aggressive 60W'], mic: ['dynamic', 0.3, 0.05] },
  }) },

  // Ambient and utility
  // Volume-pedal swells into chorus; the stereo tape delay and long hall sit after the mic,
  // studio style, so they stay stereo all the way to the interface.
  'Ambient swells': { category: 'Ambient', build: () => build((k) => {
    const i = k.input(), t = k.pedal('tuner');
    const v = k.pedal('volume', { position: 0.9 });
    const ch = k.pedal('chorus', { rate: 0.5, depth: 0.5, mix: 0.4 });
    const dl = k.pedal('delay', echo('tape', 450, 0.5, 0.45, 5, 1));
    const rv = k.pedal('reverb', verb('hall', 6, 0.7, 5, 40));
    const a = k.amp(amp('usClean', 4, 5, 5, 6));
    const cab = k.cab('2x12', 'sparkly US'), m = k.mic('condenser', cab, 0.4, 0.25);
    const o = k.output();
    k.chain(i, t, v, ch, a, cab);
    k.chain(m, dl);
    k.wire(dl, 'outL', rv, 'inL');
    k.wire(dl, 'outR', rv, 'inR');
    k.wire(rv, 'outL', o, 'L');
    k.wire(rv, 'outR', o, 'R');
  }) },
  // Two amps on a splitter, panned apart: a driven Plexi left, a US clean right.
  'Dual amp stereo': { category: 'Ambient', build: dualOf({
    left: { pedals: [['distortion', drive(OD, 3, 6, 7)]], amp: amp('plexi', 6), cab: ['4x12', 'warm 25W'], mic: ['dynamic', 0.3, 0.1] },
    right: { amp: amp('usClean', 4, 5, 5, 6, 5, 5.3), cab: ['2x12', 'sparkly US'], mic: ['condenser', 0.4, 0.2] },
  }) },
  // The looper sits after the mic, so loops capture the finished tone.
  'Looper jam': { category: 'Ambient', build: () => build((k) => {
    const i = k.input(), t = k.pedal('tuner');
    const d = k.pedal('distortion', drive(OD, 4, 6, 6));
    const lp = k.pedal('looper', { level: 1 });
    const a = k.amp(amp('plexi', 5, 5, 6, 6));
    const cab = k.cab('2x12'), m = k.mic('dynamic', cab, 0.3, 0.1), o = k.output();
    k.chain(i, t, d, a, cab);
    k.chain(m, lp, o);
  }) },
};

// ---- Scenes ----
// Builds the scenes of a preset in order: each starts from the one before, `links` are the knobs
// that differ per scene, and each step sets footswitches and knobs for its scene.
type Step = Record<string, Record<string, number | boolean>>;
function withScenes(rig: Rig, links: [string, string][], scenes: [string, Step][]): Rig {
  let r = removeScene(addScene(rig), 1); // scenes on, just scene A
  for (const [id, name] of links) r = linkParam(r, id, name, true);
  scenes.forEach(([name, step], i) => {
    r = i ? addScene(r, name) : renameScene(r, 0, name);
    for (const [id, { on, ...params }] of Object.entries(step)) {
      if (typeof on === 'boolean' && applyScene(r).devices[id].on !== on) r = toggle(r, id);
      for (const [k, v] of Object.entries(params)) r = setParam(r, id, k, Number(v));
    }
  });
  return selectScene(r, 0);
}
const scened = (shape: Shape, links: [string, string][], scenes: [string, Step][]) => () => withScenes(rigOf(shape)(), links, scenes);

const SCENES: Record<string, Preset> = {
  // A clean chime amp for verses, a drive for choruses, a lead channel with more delay.
  'Worship set': { category: 'Scenes', build: scened({
    pedals: [['compressor', comp(-26, 3, 4)], ['distortion', drive(OD, 4, 6, 7), { off: true }]],
    amp: amp('chime', 4, 4, 5, 7, 6), loop: [['delay', echo('tape', 430, 0.35, 0.2)], ['reverb', verb('hall', 3.5, 0.3, 6, 30)]],
    cab: ['2x12', 'chimey alnico'],
  }, [['delay-1', 'mix'], ['reverb-1', 'mix'], ['amp-1', 'channel'], ['amp-1', 'master']], [
    ['Verse', { 'distortion-1': { on: false }, 'delay-1': { mix: 0.18 }, 'reverb-1': { mix: 0.25 } }],
    ['Chorus', { 'distortion-1': { on: true }, 'delay-1': { mix: 0.25 } }],
    ['Lead', { 'amp-1': { channel: 2, master: 5.5 }, 'delay-1': { mix: 0.35 }, 'reverb-1': { mix: 0.3 } }],
    ['Pad', { 'distortion-1': { on: false }, 'amp-1': { channel: 1, master: 5 }, 'delay-1': { mix: 0.45 }, 'reverb-1': { mix: 0.6 } }],
  ]) },
  // One head, three channels: rhythm, crunch and a boosted lead with delay.
  'Rock band': { category: 'Scenes', build: scened({
    pedals: [boostPedal(2)], amp: amp('plexi', 7, 6, 6, 6, 5, 6), loop: [['delay', echo('analog', 380, 0.3, 0.25)]],
    cab: ['4x12', 'warm 25W'],
  }, [['amp-1', 'channel'], ['amp-1', 'master']], [
    ['Clean', { 'distortion-1': { on: false }, 'delay-1': { on: false }, 'amp-1': { channel: 0, master: 6 } }],
    ['Rhythm', { 'amp-1': { channel: 1 } }],
    ['Crunch', { 'distortion-1': { on: true } }],
    ['Lead', { 'amp-1': { channel: 2, master: 6.5 }, 'delay-1': { on: true } }],
  ]) },
  'Metal set': { category: 'Scenes', build: scened({
    pedals: [gate(-45), boostPedal(0), ['chorus', { rate: 0.6, depth: 0.4, mix: 0.4 }, { off: true }]],
    amp: amp('modern', 6, 5, 5, 5, 5, 5), loop: [['delay', echo('digital', 420, 0.3, 0.2, 6)]],
    cab: ['4x12', 'aggressive 60W'], mics: [['dynamic', 0.2, 0.05], ['dynamic', 0.5, 0.15]],
  }, [['amp-1', 'channel'], ['gate-1', 'threshold']], [
    ['Clean', { 'amp-1': { channel: 0 }, 'distortion-1': { on: false }, 'chorus-1': { on: true }, 'delay-1': { on: true } }],
    ['Rhythm', { 'amp-1': { channel: 1 }, 'distortion-1': { on: true }, 'chorus-1': { on: false }, 'delay-1': { on: false } }],
    ['Breakdown', { 'gate-1': { threshold: -38 } }],
    ['Lead', { 'amp-1': { channel: 2 }, 'gate-1': { threshold: -48 }, 'delay-1': { on: true } }],
  ]) },
  'Ambient layers': { category: 'Scenes', build: scened({
    pedals: [['volume', { position: 0.9 }], ['chorus', { rate: 0.5, depth: 0.5, mix: 0.35 }]],
    amp: amp('usClean', 4, 5, 5, 6), loop: [['delay', echo('tape', 520, 0.45, 0.3, 5, 1)], ['reverb', verb('hall', 5, 0.4, 5, 40)]],
    cab: ['2x12', 'sparkly US'], mics: [['condenser', 0.4, 0.25]],
  }, [['delay-1', 'mix'], ['delay-1', 'feedback'], ['reverb-1', 'mix'], ['reverb-1', 'decay']], [
    ['Dry', { 'chorus-1': { on: false }, 'delay-1': { mix: 0.1, feedback: 0.2 }, 'reverb-1': { mix: 0.15, decay: 1.5 } }],
    ['Wash', { 'chorus-1': { on: true }, 'delay-1': { mix: 0.3, feedback: 0.45 }, 'reverb-1': { mix: 0.45, decay: 5 } }],
    ['Huge', { 'delay-1': { mix: 0.45, feedback: 0.6 }, 'reverb-1': { mix: 0.7, decay: 9 } }],
  ]) },
};

// ---- NAM captures (fetched from TONE3000 on first load) and hybrids of captures and modelled gear ----
const NAM: Record<string, Preset> = {
  'NAM clean combo': { category: 'NAM captures', build: rigOf({
    pedals: [['compressor', comp(-26, 3, 4)]], capture: T3K.deluxe, cab: ['1x12', 'sparkly US'], mics: [['dynamic', 0.3, 0.1]],
  }) },
  'NAM crunch head': { category: 'NAM captures', build: rigOf({
    capture: T3K.badlander, cab: ['4x12', 'aggressive 60W'], mics: [['dynamic', 0.25, 0.05], ['ribbon', 0.5, 0.3]],
  }) },
  'NAM rectified metal': { category: 'NAM captures', build: rigOf({
    pedals: [gate(-45), ['namPedal', {}, { capture: T3K.ts9 }]], capture: T3K.dualRec, cab: ['4x12', 'aggressive 60W'],
    mics: [['dynamic', 0.2, 0.05], ['dynamic', 0.5, 0.15]],
  }) },
  'NAM rectified full rig': { category: 'NAM captures', build: rigOf({ pedals: [gate(-45), ['namPedal', {}, { capture: T3K.ts9 }]], capture: T3K.dualRecRig }) },
  'NAM clean full rig': { category: 'NAM captures', build: rigOf({ pedals: [['compressor', comp(-26, 3, 4)], ['reverb', verb('plate', 2, 0.25, 6)]], capture: T3K.deluxeRig }) },
  'NAM fuzz into clean combo': { category: 'NAM captures', build: rigOf({
    pedals: [['namPedal', {}, { capture: T3K.mastotron }]], capture: T3K.deluxe, cab: ['1x12', 'sparkly US'],
  }) },
  // Hybrids: captured pedals into modelled amps, a captured amp into the modelled cab and mic studio.
  'Hybrid: captured TS into UK Lead': { category: 'Hybrid', build: rigOf({
    pedals: [gate(-48), ['namPedal', {}, { capture: T3K.ts9 }]], amp: amp('ukLead', 6, 5, 7, 6, 5, 6),
    loop: [['delay', echo('digital', 380, 0.3, 0.2, 6)]], cab: ['4x12', 'warm 25W'],
  }) },
  'Hybrid: captured boost into Modern': { category: 'Hybrid', build: rigOf({
    pedals: [gate(-45), ['namPedal', {}, { capture: T3K.blade }]], amp: amp('modern', 5, 5, 5, 5, 5, 5),
    cab: ['4x12', 'aggressive 60W'], mics: [['dynamic', 0.2, 0.05], ['ribbon', 0.5, 0.3]],
  }) },
  'Hybrid: captured rectifier, studio cab': { category: 'Hybrid', build: rigOf({
    pedals: [gate(-45), boostPedal(0)], capture: T3K.dualRec, cab: ['4x12', 'aggressive 60W'],
    mics: [['dynamic', 0.15, 0.03], ['condenser', 0.45, 0.4]],
  }) },
  // Two amps on a splitter: the captured clean combo left, a modelled Plexi right.
  'Hybrid: capture + Plexi stereo': { category: 'Hybrid', build: () => build((k) => {
    const i = k.input(), t = k.pedal('tuner'), sp = k.pedal('splitter'), o = k.output();
    k.chain(i, t, sp);
    const left = k.capture('namAmp', T3K.deluxe), cabL = k.cab('1x12', 'sparkly US');
    k.wire(sp, 'outA', left, 'in');
    k.chain(left, cabL);
    const right = k.amp(amp('plexi', 6, 6, 6, 6, 5, 6)), cabR = k.cab('4x12', 'warm 25W');
    k.wire(sp, 'outB', right, 'in');
    k.chain(right, cabR);
    k.wire(k.mic('dynamic', cabL, 0.3, 0.1), 'out', o, 'L');
    k.wire(k.mic('dynamic', cabR, 0.3, 0.1), 'out', o, 'R');
  }) },
};

export const PRESETS: Record<string, Preset> = { ...BASE, ...SCENES, ...NAM };
