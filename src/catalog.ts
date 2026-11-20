// Every device type: jacks, knobs and power need. DSP lives in native/ (C++).

export type JackKind = 'audio' | 'speaker' | 'power';
export type Jack = {
  name: string;
  dir: 'in' | 'out';
  kind: JackKind;
  // Normalled input: when nothing is plugged in, it gets the signal of this other jack —
  // an input (shares that input's source) or one of the device's own outputs (internal link).
  normal?: string;
};
export type Param = { name: string; min: number; max: number; def: number; options?: string[] };
// A device the engine runs as several nodes, so it can sit on both sides of a loop (amp send/return).
export type Part = { suffix: string; ins: string[]; outs: string[] };
export type DeviceDef = {
  label: string;
  jacks: Jack[];
  params: Param[];
  power?: { volts: number; mA: number }; // undefined = passive or wall-powered
  footswitch?: boolean;
  startsOff?: boolean; // placed bypassed (a tuner mutes while on)
  parts?: Part[];
};

const jack = (name: string, dir: Jack['dir'], kind: JackKind = 'audio', normal?: string): Jack => ({ name, dir, kind, normal });
const p = (name: string, min: number, max: number, def: number): Param => ({ name, min, max, def });
const choice = (name: string, options: string[], def = 0): Param => ({ name, min: 0, max: options.length - 1, def, options });

const IN = jack('in', 'in');
const OUT = jack('out', 'out');
const DC = jack('dc', 'in', 'power');
const STEREO_OUT = [jack('outL', 'out'), jack('outR', 'out')];

const pedal = (label: string, mA: number, params: Param[], jacks = [IN, OUT, DC]): DeviceDef => ({
  label, jacks, params, power: { volts: 9, mA }, footswitch: true,
});
const knob = (name: string, def = 5) => p(name, 0, 10, def);
const mix = (def = 0.5) => p('mix', 0, 1, def);

export const CATALOG = {
  input: { label: 'Guitar Input', jacks: [OUT], params: [p('channel', 0, 63, 0), p('trim', -24, 24, 0)] },
  output: { label: 'Output', jacks: [jack('L', 'in'), jack('R', 'in', 'audio', 'L')], params: [p('volume', 0, 1, 0.5)] },
  power: { label: 'Power Supply', jacks: Array.from({ length: 8 }, (_, i) => jack(String(i + 1), 'out', 'power')), params: [] },
  splitter: { label: 'Splitter', jacks: [IN, jack('outA', 'out'), jack('outB', 'out')], params: [] },
  joiner: {
    label: 'Joiner',
    jacks: [jack('inA', 'in'), jack('inB', 'in'), OUT],
    params: [p('levelA', 0, 1, 1), p('levelB', 0, 1, 1), choice('phaseB', ['normal', 'flipped'])],
  },

  tuner: { ...pedal('Tuner', 50, [p('reference', 430, 450, 440)]), startsOff: true },
  gate: pedal('Noise Gate', 10, [p('threshold', -80, 0, -50), p('release', 10, 500, 100)]),
  compressor: pedal('Compressor', 10, [p('threshold', -60, 0, -20), p('ratio', 1, 20, 4), p('attack', 0.1, 100, 5), p('release', 10, 1000, 100), p('makeup', 0, 24, 0)]),
  boost: pedal('Boost', 10, [p('gain', 0, 24, 6), p('treble', -12, 12, 0)]),
  distortion: pedal('Distortion', 20, [knob('drive'), knob('tone'), knob('level')]),
  fuzz: pedal('Fuzz', 10, [knob('fuzz', 7), knob('tone'), knob('level')]),
  octave: pedal('Octave', 30, [p('dry', 0, 1, 1), p('sub', 0, 1, 0.5), p('up', 0, 1, 0)]),
  eq: pedal('EQ', 20, [...[100, 200, 400, 800, 1600, 3200, 6400].map((hz) => p(`${hz}Hz`, -12, 12, 0)), p('level', -12, 12, 0)]),
  wah: pedal('Wah', 10, [p('position', 0, 1, 0.5), p('q', 1, 10, 4)]),
  volume: { label: 'Volume', jacks: [IN, OUT], params: [p('position', 0, 1, 1)] },
  chorus: pedal('Chorus', 20, [p('rate', 0.1, 5, 0.8), p('depth', 0, 1, 0.5), mix()], [IN, ...STEREO_OUT, DC]),
  flanger: pedal('Flanger', 20, [p('rate', 0.05, 5, 0.3), p('depth', 0, 1, 0.6), p('feedback', 0, 0.95, 0.5), mix()]),
  phaser: pedal('Phaser', 15, [p('rate', 0.05, 5, 0.5), p('depth', 0, 1, 0.7), p('feedback', 0, 0.9, 0.3), choice('stages', ['4', '6', '8'])]),
  tremolo: pedal('Tremolo', 10, [p('rate', 0.5, 15, 5), p('depth', 0, 1, 0.5), choice('shape', ['sine', 'square'])]),
  delay: pedal('Delay', 100, [p('time', 20, 2000, 400), p('feedback', 0, 0.95, 0.35), knob('tone', 6), mix(0.35), choice('pingpong', ['off', 'on'])], [IN, ...STEREO_OUT, DC]),
  reverb: pedal('Reverb', 150, [p('decay', 0.2, 10, 2.5), p('predelay', 0, 200, 20), knob('tone', 6), mix(0.3)],
    [jack('inL', 'in'), jack('inR', 'in', 'audio', 'inL'), ...STEREO_OUT, DC]),
  looper: pedal('Looper', 200, [p('level', 0, 1, 1)]),

  amp: {
    label: 'Amp',
    jacks: [IN, jack('send', 'out'), jack('return', 'in', 'audio', 'send'), jack('speaker', 'out', 'speaker')],
    params: [choice('voicing', ['clean', 'crunch', 'high-gain']), knob('gain'), knob('bass'), knob('mid'), knob('treble'), knob('master')],
    parts: [{ suffix: 'pre', ins: ['in'], outs: ['send'] }, { suffix: 'power', ins: ['return'], outs: ['speaker'] }],
  },
  // A cab has no output jack: mics placed on it pick it up (engine node output 0).
  cab: { label: 'Cab', jacks: [jack('in', 'in', 'speaker')], params: [choice('size', ['1x12', '2x12', '4x12'], 1)] },
  mic: { label: 'Mic', jacks: [OUT], params: [choice('model', ['dynamic', 'ribbon', 'condenser'])] },
} satisfies Record<string, DeviceDef>;

export type DeviceType = keyof typeof CATALOG;
export const def = (type: DeviceType): DeviceDef => CATALOG[type];
