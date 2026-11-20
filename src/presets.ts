// Built-in rigs. Board placement is automatic (layout.ts); the builder only records signal order:
// pedals right to left on the board, amp stacks left to right on the stage. The Grid lays the
// same rig out left to right in signal order.

import { def, type DeviceType } from './catalog';
import { addDevice, connect, emptyRig, moveDevice, placeMic, setParam, type Rig, type XY } from './rig';

type Params = Record<string, number>;
type Kit = {
  input: () => string;
  pedal: (type: DeviceType, params?: Params, opts?: { off?: boolean; loop?: boolean }) => string;
  amp: (params: Params) => string;
  cab: (size: '1x12' | '2x12' | '4x12') => string; // goes under the last amp added
  mic: (model: 'dynamic' | 'ribbon' | 'condenser', cab: string, position: number, distance: number) => string;
  output: () => string;
  wire: (from: string, fromJack: string, to: string, toJack: string) => void;
  chain: (...ids: string[]) => void; // out → in along the list, using each device's main jacks
  loop: (amp: string, ...fx: string[]) => void; // amp send → effects → amp return
};

const OUT_JACK: Partial<Record<DeviceType, string>> = { amp: 'speaker', chorus: 'outL', delay: 'outL', reverb: 'outL', splitter: 'outA' };
const IN_JACK: Partial<Record<DeviceType, string>> = { reverb: 'inL', joiner: 'inA', output: 'L' };

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
      return id;
    },
    amp: (params) => add('amp', { x: 1000 * stacks++, y: 0 }, 0, params),
    cab: (size) => add('cab', { x: 1000 * (stacks - 1), y: 0 }, 0, { size: choice('cab', 'size', size) }),
    mic: (model, cab, position, distance) => {
      const n = mics[cab] = (mics[cab] ?? -1) + 1;
      const id = add('mic', { x: n, y: 0 }, 1, { model: choice('mic', 'model', model) });
      rig = placeMic(rig, id, { cab, x: position, y: 0.5, distance });
      return id;
    },
    output: () => add('output', { x: 0, y: 0 }),
    wire: (a, aj, b, bj) => { rig = connect(rig, { device: a, jack: aj }, { device: b, jack: bj }); },
    chain: (...ids) => {
      for (let i = 1; i < ids.length; i++) {
        const [a, b] = [rig.devices[ids[i - 1]], rig.devices[ids[i]]];
        kit.wire(a.id, OUT_JACK[a.type] ?? 'out', b.id, IN_JACK[b.type] ?? 'in');
      }
    },
    loop: (amp, ...fx) => {
      const [first, last] = [rig.devices[fx[0]], rig.devices[fx[fx.length - 1]]];
      kit.wire(amp, 'send', first.id, IN_JACK[first.type] ?? 'in');
      kit.chain(...fx);
      kit.wire(last.id, OUT_JACK[last.type] ?? 'out', amp, 'return');
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

// Common shapes: guitar → pedals → amp → cab → mic(s) → interface, effects optionally in the amp loop.
type Shape = {
  pedals?: [DeviceType, Params?, { off?: boolean }?][];
  amp?: Params;
  loop?: [DeviceType, Params?][];
  cab?: '1x12' | '2x12' | '4x12';
  mics?: ['dynamic' | 'ribbon' | 'condenser', number, number][]; // model, position, distance; two mics pan L and R
};
const rigOf = ({ pedals = [], amp, loop = [], cab = '2x12', mics = [['dynamic', 0.3, 0.1]] }: Shape) => () => build((k) => {
  const i = k.input();
  const t = k.pedal('tuner');
  const chain = [i, t, ...pedals.map(([type, params, opts]) => k.pedal(type, params, opts))];
  const fx = loop.map(([type, params]) => k.pedal(type, params, { loop: true }));
  const o = k.output();
  if (!amp) { k.chain(...chain, o); return; }
  const a = k.amp(amp), c = k.cab(cab);
  k.chain(...chain, a, c);
  if (fx.length) k.loop(a, ...fx);
  const ms = mics.map(([model, x, d]) => k.mic(model, c, x, d));
  if (ms.length === 1) k.wire(ms[0], 'out', o, 'L');
  else { k.wire(ms[0], 'out', o, 'L'); k.wire(ms[1], 'out', o, 'R'); }
});

const CLEAN = 0, CRUNCH = 1, HIGH = 2;
const comp = (threshold: number, ratio: number, makeup: number, attack = 10, release = 120) => ({ threshold, ratio, attack, release, makeup });
const verb = (decay: number, mix: number, tone = 6, predelay = 15) => ({ decay, predelay, tone, mix });
const echo = (time: number, feedback: number, mix: number, tone = 5, pingpong = 0) => ({ time, feedback, tone, mix, pingpong });

export const PRESETS: Record<string, Preset> = {
  // Clean
  [DEFAULT_PRESET]: { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-24, 3, 4)]],
    amp: { voicing: CLEAN, gain: 4, bass: 5, mid: 5, treble: 6, master: 5 },
    loop: [['reverb', verb(2, 0.25)]],
  }) },
  'Glassy chorus clean': { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-26, 4, 6, 5)], ['chorus', { rate: 0.7, depth: 0.45, mix: 0.45 }]],
    amp: { voicing: CLEAN, gain: 3, bass: 4, mid: 5, treble: 7, master: 5 },
    loop: [['reverb', verb(2.4, 0.3, 7)]], cab: '1x12', mics: [['condenser', 0.35, 0.2]],
  }) },
  'Jazz clean': { category: 'Clean', build: rigOf({
    amp: { voicing: CLEAN, gain: 3, bass: 6, mid: 6, treble: 3, master: 5 },
    loop: [['reverb', verb(1.4, 0.18, 4)]], cab: '1x12', mics: [['ribbon', 0.5, 0.35]],
  }) },
  'Country slapback': { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-30, 6, 8, 2, 90)]],
    amp: { voicing: CLEAN, gain: 4, bass: 4, mid: 6, treble: 8, master: 6 },
    loop: [['delay', echo(110, 0.1, 0.35, 7)]], cab: '2x12', mics: [['dynamic', 0.2, 0.05]],
  }) },
  'Funk clean': { category: 'Clean', build: rigOf({
    pedals: [['compressor', comp(-30, 6, 9, 3, 80)], ['wah', { position: 0.6, q: 6 }], ['phaser', { rate: 0.4, depth: 0.6, feedback: 0.3, stages: 0 }]],
    amp: { voicing: CLEAN, gain: 3, bass: 4, mid: 5, treble: 7, master: 5 }, cab: '1x12', mics: [['condenser', 0.4, 0.2]],
  }) },
  'Surf': { category: 'Clean', build: rigOf({
    pedals: [['tremolo', { rate: 6, depth: 0.5, shape: 0 }]],
    amp: { voicing: CLEAN, gain: 5, bass: 4, mid: 5, treble: 7, master: 6 },
    loop: [['reverb', verb(3.5, 0.55, 7, 5)]],
  }) },

  // Acoustic: no amp. A piezo-style DI chain straight to the interface: compression, an EQ that
  // scoops the boxy mids and lifts the air, a touch of width and a room.
  'Acoustic DI': { category: 'Acoustic', build: rigOf({
    pedals: [
      ['compressor', comp(-28, 3, 5, 15, 150)],
      ['eq', { '100Hz': -4, '200Hz': 1, '400Hz': -5, '800Hz': -2, '1600Hz': 1, '3200Hz': 4, '6400Hz': 5, level: 0 }],
      ['chorus', { rate: 0.3, depth: 0.15, mix: 0.2 }],
      ['reverb', verb(1.8, 0.3, 7, 20)],
    ],
  }) },
  'Acoustic 12-string': { category: 'Acoustic', build: rigOf({
    pedals: [
      ['compressor', comp(-28, 3, 5, 15, 150)],
      ['octave', { dry: 1, sub: 0, up: 0.35 }],
      ['eq', { '100Hz': -5, '200Hz': 0, '400Hz': -5, '800Hz': -1, '1600Hz': 2, '3200Hz': 4, '6400Hz': 6, level: 0 }],
      ['chorus', { rate: 0.6, depth: 0.25, mix: 0.35 }],
      ['reverb', verb(2.2, 0.3, 7, 20)],
    ],
  }) },

  // Crunch and rock
  'Blues crunch': { category: 'Crunch', build: rigOf({
    pedals: [['compressor', comp(-22, 2.5, 3, 15, 150)], ['distortion', { drive: 3, tone: 6, level: 7 }]],
    amp: { voicing: CRUNCH, gain: 4, bass: 5, mid: 6, treble: 6, master: 6 },
    loop: [['delay', echo(320, 0.2, 0.2)], ['reverb', verb(1.6, 0.2, 5, 10)]], mics: [['ribbon', 0.5, 0.3]],
  }) },
  'Classic rock': { category: 'Crunch', build: rigOf({
    pedals: [['wah', { position: 0.5, q: 5 }, { off: true }], ['distortion', { drive: 6, tone: 5, level: 6 }]],
    amp: { voicing: CRUNCH, gain: 6, bass: 6, mid: 6, treble: 6, master: 6 },
    loop: [['delay', echo(380, 0.25, 0.25)]], cab: '4x12',
  }) },

  // Lead
  'Singing lead': { category: 'Lead', build: rigOf({
    pedals: [['compressor', comp(-20, 3, 3, 20, 200)], ['distortion', { drive: 4, tone: 6, level: 7 }]],
    amp: { voicing: HIGH, gain: 6, bass: 5, mid: 7, treble: 6, master: 6 },
    loop: [['delay', echo(420, 0.35, 0.3, 5, 1)], ['reverb', verb(2.5, 0.25)]], cab: '4x12',
  }) },
  'Blues lead': { category: 'Lead', build: rigOf({
    pedals: [['distortion', { drive: 5, tone: 6, level: 7 }]],
    amp: { voicing: CRUNCH, gain: 6, bass: 5, mid: 7, treble: 6, master: 7 },
    loop: [['delay', echo(350, 0.2, 0.22)], ['reverb', verb(1.8, 0.2, 5, 10)]], mics: [['ribbon', 0.4, 0.2]],
  }) },
  'Shred lead': { category: 'Lead', build: rigOf({
    pedals: [['gate', { threshold: -55, release: 60 }], ['distortion', { drive: 1, tone: 7, level: 8 }]],
    amp: { voicing: HIGH, gain: 8, bass: 5, mid: 6, treble: 7, master: 5 },
    loop: [['delay', echo(380, 0.3, 0.25, 5, 1)]], cab: '4x12', mics: [['dynamic', 0.2, 0.05], ['ribbon', 0.6, 0.3]],
  }) },
  'Octave fuzz lead': { category: 'Lead', build: rigOf({
    pedals: [['octave', { dry: 1, sub: 0, up: 0.7 }], ['fuzz', { fuzz: 8, tone: 6, level: 6 }]],
    amp: { voicing: CLEAN, gain: 5, bass: 5, mid: 6, treble: 5, master: 7 },
    loop: [['delay', echo(300, 0.3, 0.3, 6)]], cab: '4x12',
  }) },

  // Metal: a gate kills hiss before the amp, a drive with no gain tightens the low end, two mics pan L/R.
  'Modern metal': { category: 'Metal', build: rigOf({
    pedals: [['gate', { threshold: -55, release: 60 }], ['distortion', { drive: 0, tone: 7, level: 8 }]],
    amp: { voicing: HIGH, gain: 7, bass: 6, mid: 4, treble: 6, master: 5 },
    loop: [['eq', { '100Hz': 2, '400Hz': -3, '800Hz': -1, '1600Hz': 1, '3200Hz': 2 }]],
    cab: '4x12', mics: [['dynamic', 0.2, 0.05], ['ribbon', 0.6, 0.3]],
  }) },
  'Djent': { category: 'Metal', build: rigOf({
    pedals: [['gate', { threshold: -50, release: 40 }], ['distortion', { drive: 0, tone: 8, level: 9 }]],
    amp: { voicing: HIGH, gain: 6, bass: 5, mid: 7, treble: 7, master: 5 },
    loop: [['eq', { '100Hz': -2, '200Hz': -3, '800Hz': 3, '1600Hz': 3, '6400Hz': -2 }]],
    cab: '4x12', mics: [['dynamic', 0.15, 0.03], ['dynamic', 0.45, 0.1]],
  }) },
  'Thrash': { category: 'Metal', build: rigOf({
    pedals: [['gate', { threshold: -52, release: 50 }], ['distortion', { drive: 2, tone: 7, level: 7 }]],
    amp: { voicing: HIGH, gain: 8, bass: 7, mid: 3, treble: 7, master: 6 },
    cab: '4x12', mics: [['dynamic', 0.25, 0.05]],
  }) },
  'Doom': { category: 'Metal', build: rigOf({
    pedals: [['octave', { dry: 1, sub: 0.5, up: 0 }], ['fuzz', { fuzz: 9, tone: 4, level: 7 }]],
    amp: { voicing: CRUNCH, gain: 8, bass: 8, mid: 5, treble: 4, master: 8 },
    loop: [['reverb', verb(3, 0.2, 4)]], cab: '4x12', mics: [['ribbon', 0.4, 0.2]],
  }) },

  // Ambient and utility
  // Volume-pedal swells into chorus; the stereo ping-pong delay and long reverb sit after the mic,
  // studio style, so they stay stereo all the way to the interface.
  'Ambient swells': { category: 'Ambient', build: () => build((k) => {
    const i = k.input(), t = k.pedal('tuner');
    const v = k.pedal('volume', { position: 0.9 });
    const ch = k.pedal('chorus', { rate: 0.5, depth: 0.5, mix: 0.4 });
    const dl = k.pedal('delay', echo(450, 0.5, 0.45, 5, 1));
    const rv = k.pedal('reverb', verb(6, 0.7, 5, 40));
    const a = k.amp({ voicing: CLEAN, gain: 4, bass: 5, mid: 5, treble: 6, master: 5 });
    const cab = k.cab('2x12'), m = k.mic('condenser', cab, 0.4, 0.25);
    const o = k.output();
    k.chain(i, t, v, ch, a, cab);
    k.chain(m, dl);
    k.wire(dl, 'outL', rv, 'inL');
    k.wire(dl, 'outR', rv, 'inR');
    k.wire(rv, 'outL', o, 'L');
    k.wire(rv, 'outR', o, 'R');
  }) },
  // A splitter feeds a driven crunch amp (left) and a clean amp (right) in parallel.
  'Dual amp stereo': { category: 'Ambient', build: () => build((k) => {
    const i = k.input(), t = k.pedal('tuner'), sp = k.pedal('splitter');
    const d = k.pedal('distortion', { drive: 6, tone: 5, level: 5 });
    const dirty = k.amp({ voicing: CRUNCH, gain: 6, master: 5 }), cabL = k.cab('4x12');
    const clean = k.amp({ voicing: CLEAN, gain: 4, master: 5 }), cabR = k.cab('2x12');
    const micL = k.mic('dynamic', cabL, 0.3, 0.1), micR = k.mic('condenser', cabR, 0.4, 0.2), o = k.output();
    k.chain(i, t, sp);
    k.wire(sp, 'outA', d, 'in');
    k.chain(d, dirty, cabL);
    k.wire(sp, 'outB', clean, 'in');
    k.chain(clean, cabR);
    k.wire(micL, 'out', o, 'L');
    k.wire(micR, 'out', o, 'R');
  }) },
  // The looper sits after the mic, so loops capture the finished tone.
  'Looper jam': { category: 'Ambient', build: () => build((k) => {
    const i = k.input(), t = k.pedal('tuner');
    const d = k.pedal('distortion', { drive: 4, tone: 6, level: 6 });
    const lp = k.pedal('looper', { level: 1 });
    const a = k.amp({ voicing: CRUNCH, gain: 5, bass: 5, mid: 6, treble: 6, master: 6 });
    const cab = k.cab('2x12'), m = k.mic('dynamic', cab, 0.3, 0.1), o = k.output();
    k.chain(i, t, d, a, cab);
    k.chain(m, lp, o);
  }) },
};
