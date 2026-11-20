// Built-in rigs. Each is laid out in signal order: right to left on the Board (like a real
// pedalboard), left to right on the Grid.

import type { DeviceType } from './catalog';
import { addDevice, connect, emptyRig, moveDevice, placeMic, setParam, type Rig } from './rig';

type Steps = {
  add: (type: DeviceType, col: number, row: number, params?: Record<string, number>) => string;
  wire: (from: string, fromJack: string, to: string, toJack: string) => void;
  mic: (mic: string, cab: string, position: number, distance: number) => void;
  power: (...pedals: string[]) => void;
};

function build(steps: (s: Steps) => void): Rig {
  let rig = emptyRig();
  const add: Steps['add'] = (type, col, row, params = {}) => {
    let id: string;
    [rig, id] = addDevice(rig, type, { x: 0, y: 0 });
    rig = moveDevice(rig, id, 'board', { x: (6 - col) * 280, y: row * 230 });
    rig = moveDevice(rig, id, 'grid', { x: col * 280, y: row * 230 });
    for (const [k, v] of Object.entries(params)) rig = setParam(rig, id, k, v);
    return id;
  };
  const wire: Steps['wire'] = (a, aj, b, bj) => { rig = connect(rig, { device: a, jack: aj }, { device: b, jack: bj }); };
  const mic: Steps['mic'] = (m, cab, x, distance) => { rig = placeMic(rig, m, { cab, x, y: 0.5, distance }); };
  const power: Steps['power'] = (...pedals) => {
    const supply = add('power', 1, -1);
    pedals.forEach((p, i) => wire(supply, String(i + 1), p, 'dc'));
  };
  steps({ add, wire, mic, power });
  return rig;
}

const VOICING = { clean: 0, crunch: 1, highGain: 2 };
const SIZE = { '1x12': 0, '2x12': 1, '4x12': 2 };
const MIC = { dynamic: 0, ribbon: 1, condenser: 2 };

export const DEFAULT_PRESET = 'Clean amp';

export const PRESETS: Record<string, () => Rig> = {
  [DEFAULT_PRESET]: () => build(({ add, wire, mic }) => {
    const input = add('input', 0, 0);
    const amp = add('amp', 2, 0, { voicing: VOICING.clean, gain: 4, bass: 5, mid: 5, treble: 6, master: 5 });
    const cab = add('cab', 3, 0, { size: SIZE['2x12'] });
    const m = add('mic', 3, 1, { model: MIC.dynamic });
    const out = add('output', 5, 0);
    wire(input, 'out', amp, 'in');
    wire(amp, 'speaker', cab, 'in');
    mic(m, cab, 0.3, 0.1);
    wire(m, 'out', out, 'L');
  }),

  'Boosted crunch': () => build(({ add, wire, mic, power }) => {
    const input = add('input', 0, 0);
    const boost = add('boost', 1, 0, { gain: 9, treble: 2 });
    const amp = add('amp', 2, 0, { voicing: VOICING.crunch, gain: 6, bass: 5, mid: 6, treble: 6, master: 6 });
    const cab = add('cab', 3, 0, { size: SIZE['4x12'] });
    const m = add('mic', 3, 1, { model: MIC.dynamic });
    const out = add('output', 5, 0);
    power(boost);
    wire(input, 'out', boost, 'in');
    wire(boost, 'out', amp, 'in');
    wire(amp, 'speaker', cab, 'in');
    mic(m, cab, 0.4, 0.15);
    wire(m, 'out', out, 'L');
  }),

  // Two mics on one cab, panned hard left and right.
  'High gain, two mics': () => build(({ add, wire, mic, power }) => {
    const input = add('input', 0, 0);
    const drive = add('distortion', 1, 0, { drive: 1.5, tone: 6, level: 7 }); // used as a tight boost
    const amp = add('amp', 2, 0, { voicing: VOICING.highGain, gain: 7, bass: 6, mid: 4, treble: 6, master: 5 });
    const cab = add('cab', 3, 0, { size: SIZE['4x12'] });
    const dyn = add('mic', 4, 1, { model: MIC.dynamic });
    const ribbon = add('mic', 3, 1, { model: MIC.ribbon });
    const out = add('output', 5, 0);
    power(drive);
    wire(input, 'out', drive, 'in');
    wire(drive, 'out', amp, 'in');
    wire(amp, 'speaker', cab, 'in');
    mic(dyn, cab, 0.2, 0.05);
    mic(ribbon, cab, 0.6, 0.3);
    wire(dyn, 'out', out, 'L');
    wire(ribbon, 'out', out, 'R');
  }),

  'Fuzz into clean amp': () => build(({ add, wire, mic, power }) => {
    const input = add('input', 0, 0);
    const fuzz = add('fuzz', 1, 0, { fuzz: 8, tone: 6, level: 6 });
    const amp = add('amp', 2, 0, { voicing: VOICING.clean, gain: 5, bass: 6, mid: 5, treble: 5, master: 5 });
    const cab = add('cab', 3, 0, { size: SIZE['1x12'] });
    const m = add('mic', 3, 1, { model: MIC.condenser });
    const out = add('output', 5, 0);
    power(fuzz);
    wire(input, 'out', fuzz, 'in');
    wire(fuzz, 'out', amp, 'in');
    wire(amp, 'speaker', cab, 'in');
    mic(m, cab, 0.5, 0.25);
    wire(m, 'out', out, 'L');
  }),

  // A splitter feeds a dirty amp (left) and a clean amp (right) in parallel.
  'Dual amp stereo': () => build(({ add, wire, mic, power }) => {
    const input = add('input', 0, 0);
    const split = add('splitter', 1, 0);
    const drive = add('distortion', 2, -0.6, { drive: 6, tone: 5, level: 5 });
    const dirty = add('amp', 3, -0.6, { voicing: VOICING.crunch, gain: 6, master: 5 });
    const clean = add('amp', 3, 0.9, { voicing: VOICING.clean, gain: 4, master: 5 });
    const cabL = add('cab', 4, -0.6, { size: SIZE['4x12'] });
    const cabR = add('cab', 4, 0.9, { size: SIZE['2x12'] });
    const micL = add('mic', 5, -0.6, { model: MIC.dynamic });
    const micR = add('mic', 5, 0.9, { model: MIC.condenser });
    const out = add('output', 6, 0);
    power(drive);
    wire(input, 'out', split, 'in');
    wire(split, 'outA', drive, 'in');
    wire(drive, 'out', dirty, 'in');
    wire(split, 'outB', clean, 'in');
    wire(dirty, 'speaker', cabL, 'in');
    wire(clean, 'speaker', cabR, 'in');
    mic(micL, cabL, 0.3, 0.1);
    mic(micR, cabR, 0.4, 0.2);
    wire(micL, 'out', out, 'L');
    wire(micR, 'out', out, 'R');
  }),
};
