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
export type Param = { name: string; min: number; max: number; def: number; options?: string[]; step?: number };
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
// BPM sync: a note length of the rig's tempo (Rig.tempo) sets a delay's time or a modulation's rate
// (rig.ts compile). 'free' leaves the knob in charge. Always the last param, so engine order is unchanged.
export const SYNC = [['free', 0], ['1/2', 2], ['dotted 1/4', 1.5], ['1/4', 1], ['dotted 1/8', 0.75], ['1/8', 0.5], ['1/8 triplet', 1 / 3], ['1/16', 0.25]] as const;
const sync = () => choice('sync', SYNC.map(([n]) => n));
const mix = (def = 0.5) => p('mix', 0, 1, def);

// Amp models, in the order native/Devices.h AMPS lists them. Named for what they're modelled on.
export const AMP_MODELS = ['US Clean', 'Tweed', 'UK Chime', 'UK Plexi', 'UK Lead', 'US Rectified', 'Modern High Gain', 'Boutique Lead', 'Jazz Clean'];

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
  gate: pedal('Noise Gate', 10, [p('threshold', -80, -10, -45), p('release', 10, 500, 80)]),
  compressor: pedal('Compressor', 10, [p('threshold', -60, 0, -20), p('ratio', 1, 20, 4), p('attack', 0.1, 100, 5), p('release', 10, 1000, 100), p('makeup', 0, 24, 0)]),
  boost: pedal('Boost', 10, [choice('model', ['clean', 'treble', 'mid']), p('gain', 0, 24, 6), knob('tone')]),
  distortion: pedal('Drive', 20, [choice('model', ['Overdrive', 'Distortion', 'Amp in a Box', 'Metal']), knob('drive'), knob('tone'), knob('level')]),
  fuzz: pedal('Fuzz', 10, [choice('model', ['Germanium', 'Sustainer']), knob('fuzz', 7), knob('tone'), knob('level')]),
  octave: pedal('Octave', 30, [p('dry', 0, 1, 1), p('sub', 0, 1, 0.5), p('up', 0, 1, 0)]),
  eq: pedal('EQ', 20, [...[100, 200, 400, 800, 1600, 3200, 6400].map((hz) => p(`${hz}Hz`, -12, 12, 0)), p('level', -12, 12, 0)]),
  wah: pedal('Wah', 10, [p('position', 0, 1, 0.5), p('q', 1, 10, 4)]),
  volume: { label: 'Volume', jacks: [IN, OUT], params: [p('position', 0, 1, 1)] },
  chorus: pedal('Chorus', 20, [p('rate', 0.1, 5, 0.8), p('depth', 0, 1, 0.5), mix(), sync()], [IN, ...STEREO_OUT, DC]),
  flanger: pedal('Flanger', 20, [p('rate', 0.05, 5, 0.3), p('depth', 0, 1, 0.6), p('feedback', 0, 0.95, 0.5), mix(), sync()]),
  phaser: pedal('Phaser', 15, [p('rate', 0.05, 5, 0.5), p('depth', 0, 1, 0.7), p('feedback', 0, 0.9, 0.3), choice('stages', ['4', '6', '8']), sync()]),
  tremolo: pedal('Tremolo', 10, [p('rate', 0.5, 15, 5), p('depth', 0, 1, 0.5), choice('shape', ['sine', 'square']), sync()]),
  delay: pedal('Delay', 100, [choice('model', ['Digital', 'Tape', 'Analog']), p('time', 20, 2000, 400), p('feedback', 0, 0.95, 0.35), knob('tone', 6), mix(0.35), choice('pingpong', ['off', 'on']), sync()], [IN, ...STEREO_OUT, DC]),
  reverb: pedal('Reverb', 150, [choice('model', ['Room', 'Hall', 'Plate', 'Spring'], 1), p('decay', 0.2, 10, 2.5), p('predelay', 0, 200, 20), knob('tone', 6), mix(0.3)],
    [jack('inL', 'in'), jack('inR', 'in', 'audio', 'inL'), ...STEREO_OUT, DC]),
  looper: pedal('Looper', 200, [p('level', 0, 1, 1)]),
  pitch: pedal('Pitch Shift', 100, [{ ...p('interval', -12, 12, 12), step: 1 }, p('detune', 0, 30, 6), mix(0.5)], [IN, ...STEREO_OUT, DC]),
  acoustic: pedal('Acoustic Sim', 80, [choice('body', ['dreadnought', 'jumbo', 'parlor', 'nylon']), mix(0.7), knob('top'), p('level', -12, 12, 0)]),

  // Amp: the drive channel keeps v1's gain and EQ knobs; clean and lead have their own (AMP_CHANNEL_KNOBS).
  // Order matters: native/Devices.h AmpParam reads them by position.
  amp: {
    label: 'Amp',
    jacks: [IN, jack('send', 'out'), jack('return', 'in', 'audio', 'send'), jack('speaker', 'out', 'speaker')],
    params: [
      choice('model', AMP_MODELS), knob('gain'), knob('bass'), knob('mid'), knob('treble'), knob('presence'), knob('master'),
      choice('channel', ['clean', 'drive', 'lead'], 1), choice('bright', ['off', 'on']), choice('deep', ['off', 'on']), choice('fat', ['off', 'on']),
      choice('tube', ['stock', 'EL34', '6L6', 'KT88', 'EL84']), knob('bias'), knob('sag'), p('voltage', 80, 110, 100),
      knob('cleanGain', 3), knob('cleanBass'), knob('cleanMid'), knob('cleanTreble'),
      knob('leadGain', 7), knob('leadBass'), knob('leadMid'), knob('leadTreble'),
    ],
    parts: [{ suffix: 'pre', ins: ['in'], outs: ['send'] }, { suffix: 'power', ins: ['return'], outs: ['speaker'] }],
  },
  // A cab: mics on it pick it up. Its L/R outputs are the mic mixer's stereo bus (MicMix in the engine).
  // Source IR plays the IR files in its slots (Device.files irA / irB) instead of the modelled speaker.
  cab: {
    label: 'Cab',
    jacks: [jack('in', 'in', 'speaker'), jack('outL', 'out'), jack('outR', 'out')],
    params: [
      choice('size', ['1x12', '2x12', '4x12'], 1), choice('speaker', ['warm 25W', 'aggressive 60W', 'chimey alnico', 'sparkly US']),
      choice('source', ['modelled', 'IR']), p('blend', 0, 1, 0.5), p('lowCut', 20, 300, 20), p('highCut', 3000, 20000, 20000),
    ],
    parts: [{ suffix: 'spk', ins: ['in'], outs: [] }, { suffix: 'mix', ins: [], outs: ['outL', 'outR'] }],
  },
  // A mic's controls are its mixer channel; position and distance live on Device.mic.
  mic: {
    label: 'Mic', jacks: [OUT],
    params: [
      choice('model', ['dynamic', 'ribbon', 'condenser']), p('level', -24, 12, 0), p('pan', -1, 1, 0),
      choice('phase', ['normal', 'flipped']), p('align', 0, 3, 0), p('angle', 0, 60, 0), choice('solo', ['off', 'on']),
    ],
  },

  // Neural Amp Modeler captures (Device.files.model). An amp capture drives a cab; a full-rig capture
  // already includes the cab and mic; a pedal capture sits on the board and needs power.
  namAmp: { label: 'NAM Amp', jacks: [IN, jack('speaker', 'out', 'speaker')], params: [p('input', -24, 24, 0), p('output', -24, 24, 0)] },
  namRig: { label: 'NAM Rig', jacks: [IN, OUT], params: [p('input', -24, 24, 0), p('output', -24, 24, 0)] },
  namPedal: pedal('NAM Pedal', 100, [p('input', -24, 24, 0), p('output', -24, 24, 0)]),
} satisfies Record<string, DeviceDef>;

export type DeviceType = keyof typeof CATALOG;
export const def = (type: DeviceType): DeviceDef => CATALOG[type];

// Fictional makers. Every amp model and every cab (by speaker) has its own, like a real mixed rig.
export const AMP_MAKERS = ['Fairmont', 'Sutter', 'Wexford', 'Kingsway', 'Thornbury', 'Ironside', 'Vexor', 'Calloway', 'Moreau'];
export const CAB_MAKERS = ['Kingsway', 'Ironside', 'Wexford', 'Fairmont'];
const MAKERS: Partial<Record<DeviceType, string>> = {
  namAmp: 'NAM capture', namRig: 'NAM capture', namPedal: 'NAM capture',
  mic: 'Oriel', power: 'Voltline', input: 'Arcadia Audio', output: 'Arcadia Audio', splitter: 'Patchwell', joiner: 'Patchwell',
};
export const makerOf = (type: DeviceType, params: Record<string, number> = {}) =>
  type === 'amp' ? AMP_MAKERS[params.model ?? 0] ?? AMP_MAKERS[0]
    : type === 'cab' ? CAB_MAKERS[params.speaker ?? 0] ?? CAB_MAKERS[0]
      : MAKERS[type] ?? 'Kestrel';

// Gear that is several products in real life: each one is its own item in the gear list, with its
// own name and look. Which one it is stays a knob value (`param`), so the engine is unchanged.
export const VARIANTS: Partial<Record<DeviceType, { param: string; names: string[] }>> = {
  distortion: { param: 'model', names: ['Overdrive', 'Distortion', 'Amp in a Box', 'Metal Drive'] },
  fuzz: { param: 'model', names: ['Germanium Fuzz', 'Sustainer Fuzz'] },
  boost: { param: 'model', names: ['Clean Boost', 'Treble Booster', 'Mid Boost'] },
  delay: { param: 'model', names: ['Digital Delay', 'Tape Echo', 'Analog Delay'] },
  reverb: { param: 'model', names: ['Room Reverb', 'Hall Reverb', 'Plate Reverb', 'Spring Reverb'] },
  amp: { param: 'model', names: AMP_MODELS },
  cab: { param: 'speaker', names: ['Warm 25W cab', 'Aggressive 60W cab', 'Chimey alnico cab', 'Sparkly US cab'] },
};
export const variantOf = (type: DeviceType, params: Record<string, number>) => {
  const v = VARIANTS[type];
  return v ? params[v.param] ?? 0 : undefined;
};

// A device's name: the product it is ("Tape Echo", "UK Plexi"), or its catalog label.
export const nameOf = (type: DeviceType, params: Record<string, number>) => {
  const v = VARIANTS[type];
  return v?.names[params[v.param] ?? 0] ?? CATALOG[type].label;
};

// Everything you can add, as it appears in the gear list. `variant` is the value of the variant knob.
export type Item = { type: DeviceType; variant?: number; name: string };
export const itemsOf = (type: DeviceType): Item[] =>
  VARIANTS[type]?.names.map((name, variant) => ({ type, variant, name })) ?? [{ type, name: CATALOG[type].label }];
export const itemParams = (i: Item): Record<string, number> => (i.variant === undefined ? {} : { [VARIANTS[i.type]!.param]: i.variant });

// The amp knobs that belong to a channel: the drive channel uses the plain names.
export const AMP_CHANNEL_KNOBS = ['gain', 'bass', 'mid', 'treble'];
export const ampKnob = (name: string, channel: number) =>
  !AMP_CHANNEL_KNOBS.includes(name) || channel === 1 ? name : `${channel === 0 ? 'clean' : 'lead'}${name[0].toUpperCase()}${name.slice(1)}`;
export const isNam = (type: DeviceType) => type === 'namAmp' || type === 'namRig' || type === 'namPedal';
