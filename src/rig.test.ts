import { describe, expect, it } from 'vitest';
import type { DeviceType } from './catalog';
import {
  addDevice, canConnect, commit, compile, connect, emptyRig, history, isPowered, parseRig,
  placeMic, redo, removeDevice, setParam, undo, type Rig,
} from './rig';

const at = { x: 0, y: 0 };
const j = (device: string, jack: string) => ({ device, jack });

function build(...types: DeviceType[]): [Rig, string[]] {
  let rig = emptyRig();
  const ids: string[] = [];
  for (const t of types) {
    let id: string;
    [rig, id] = addDevice(rig, t, at);
    ids.push(id);
  }
  return [rig, ids];
}

const wires = (rig: Rig) => compile(rig).wires.map((w) => `${w.from}:${w.out}>${w.to}:${w.in}`).sort();

describe('cables', () => {
  it('only matching jacks connect', () => {
    const [rig] = build('input', 'distortion', 'power', 'amp', 'cab');
    expect(canConnect(rig, j('input-1', 'out'), j('distortion-1', 'in'))).toBeNull();
    expect(canConnect(rig, j('distortion-1', 'in'), j('input-1', 'out'))).toBeNull(); // either end first
    expect(canConnect(rig, j('power-1', '1'), j('distortion-1', 'dc'))).toBeNull();
    expect(canConnect(rig, j('amp-1', 'speaker'), j('cab-1', 'in'))).toBeNull();
    expect(canConnect(rig, j('input-1', 'out'), j('distortion-1', 'dc'))).toMatch(/audio jack into a power/);
    expect(canConnect(rig, j('amp-1', 'speaker'), j('distortion-1', 'in'))).toMatch(/speaker/);
    expect(canConnect(rig, j('input-1', 'out'), j('cab-1', 'in'))).toMatch(/speaker/);
    expect(canConnect(rig, j('input-1', 'out'), j('distortion-1', 'out'))).toBe('Both jacks are outputs');
    expect(canConnect(rig, j('input-1', 'out'), j('nope', 'in'))).toBe('No such jack');
  });

  it('plugging into a used jack replaces the old cable', () => {
    let [rig] = build('input', 'boost', 'fuzz');
    rig = connect(rig, j('input-1', 'out'), j('boost-1', 'in'));
    rig = connect(rig, j('input-1', 'out'), j('fuzz-1', 'in'));
    expect(rig.cables.map((c) => c.id)).toEqual(['input-1.out>fuzz-1.in']);
  });

  it('refuses feedback loops but allows the amp effects loop and parallel paths', () => {
    let [rig] = build('boost', 'fuzz', 'amp', 'delay', 'splitter', 'joiner');
    rig = connect(rig, j('boost-1', 'out'), j('fuzz-1', 'in'));
    expect(canConnect(rig, j('fuzz-1', 'out'), j('boost-1', 'in'))).toBe('That would make a feedback loop');
    expect(canConnect(rig, j('boost-1', 'out'), j('boost-1', 'in'))).toBe('That would make a feedback loop');

    rig = connect(rig, j('amp-1', 'send'), j('delay-1', 'in'));
    expect(canConnect(rig, j('delay-1', 'outL'), j('amp-1', 'return'))).toBeNull();
    rig = connect(rig, j('delay-1', 'outL'), j('amp-1', 'return'));
    expect(canConnect(rig, j('amp-1', 'speaker'), j('amp-1', 'in'))).toMatch(/speaker/);

    rig = connect(rig, j('splitter-1', 'outA'), j('joiner-1', 'inA'));
    expect(canConnect(rig, j('splitter-1', 'outB'), j('joiner-1', 'inB'))).toBeNull();
    expect(canConnect(rig, j('joiner-1', 'out'), j('splitter-1', 'in'))).toBe('That would make a feedback loop');
  });

  it('sees loops through a mic on a cab', () => {
    let [rig] = build('amp', 'cab', 'mic');
    rig = connect(rig, j('amp-1', 'speaker'), j('cab-1', 'in'));
    rig = placeMic(rig, 'mic-1', { cab: 'cab-1', x: 0.5, y: 0.5, distance: 0 });
    expect(canConnect(rig, j('mic-1', 'out'), j('amp-1', 'in'))).toBe('That would make a feedback loop');
  });
});

describe('power', () => {
  it('pedals need a power cable; passive and wall gear do not', () => {
    let [rig] = build('distortion', 'power', 'amp', 'volume');
    expect(isPowered(rig, 'distortion-1')).toBe(false);
    expect(isPowered(rig, 'amp-1')).toBe(true);
    expect(isPowered(rig, 'volume-1')).toBe(true);
    rig = connect(rig, j('power-1', '3'), j('distortion-1', 'dc'));
    expect(isPowered(rig, 'distortion-1')).toBe(true);
  });
});

describe('compile', () => {
  it('drops unpowered pedals, so the chain goes silent after them', () => {
    let [rig] = build('input', 'distortion', 'output', 'power');
    rig = connect(rig, j('input-1', 'out'), j('distortion-1', 'in'));
    rig = connect(rig, j('distortion-1', 'out'), j('output-1', 'L'));
    expect(compile(rig).nodes.map((n) => n.id).sort()).toEqual(['input-1', 'output-1']);
    expect(wires(rig)).toEqual([]);

    rig = connect(rig, j('power-1', '1'), j('distortion-1', 'dc'));
    expect(wires(rig)).toEqual(['distortion-1:0>output-1:0', 'distortion-1:0>output-1:1', 'input-1:0>distortion-1:0']);
  });

  it('normals Output R to whatever feeds L, until R is plugged', () => {
    let [rig] = build('input', 'output', 'boost', 'power');
    rig = connect(rig, j('input-1', 'out'), j('output-1', 'L'));
    expect(wires(rig)).toEqual(['input-1:0>output-1:0', 'input-1:0>output-1:1']);
    rig = connect(rig, j('power-1', '1'), j('boost-1', 'dc'));
    rig = connect(rig, j('boost-1', 'out'), j('output-1', 'R'));
    expect(wires(rig)).toEqual(['boost-1:0>output-1:1', 'input-1:0>output-1:0']);
  });

  it('runs the amp as preamp + power amp, linked until Return is plugged', () => {
    let [rig] = build('input', 'amp', 'cab', 'mic', 'output', 'delay', 'power');
    rig = connect(rig, j('input-1', 'out'), j('amp-1', 'in'));
    rig = connect(rig, j('amp-1', 'speaker'), j('cab-1', 'in'));
    rig = placeMic(rig, 'mic-1', { cab: 'cab-1', x: 0.3, y: 0.5, distance: 0.1 });
    rig = connect(rig, j('mic-1', 'out'), j('output-1', 'L'));
    expect(compile(rig).nodes.map((n) => `${n.id}=${n.type}`)).toContain('amp-1/pre=amp/pre');
    expect(compile(rig).nodes.find((n) => n.id === 'mic-1')!.params).toEqual([0, 0.3, 0.1]);
    expect(wires(rig)).toEqual([
      'amp-1/power:0>cab-1:0', 'amp-1/pre:0>amp-1/power:0', 'cab-1:0>mic-1:0',
      'input-1:0>amp-1/pre:0', 'mic-1:0>output-1:0', 'mic-1:0>output-1:1',
    ]);

    rig = connect(rig, j('power-1', '1'), j('delay-1', 'dc'));
    rig = connect(rig, j('amp-1', 'send'), j('delay-1', 'in'));
    rig = connect(rig, j('delay-1', 'outR'), j('amp-1', 'return'));
    const w = wires(rig);
    expect(w).not.toContain('amp-1/pre:0>amp-1/power:0');
    expect(w).toContain('amp-1/pre:0>delay-1:0');
    expect(w).toContain('delay-1:1>amp-1/power:0');
  });

  it('a cab without a mic, or an amp without a cab, goes nowhere', () => {
    let [rig] = build('input', 'amp', 'cab');
    rig = connect(rig, j('input-1', 'out'), j('amp-1', 'in'));
    rig = connect(rig, j('amp-1', 'speaker'), j('cab-1', 'in'));
    expect(wires(rig).filter((w) => w.startsWith('cab-1'))).toEqual([]);
  });
});

describe('editing', () => {
  it('removing a device removes its cables and drops its mics', () => {
    let [rig] = build('amp', 'cab', 'mic');
    rig = connect(rig, j('amp-1', 'speaker'), j('cab-1', 'in'));
    rig = placeMic(rig, 'mic-1', { cab: 'cab-1', x: 2, y: -1, distance: 0.5 });
    expect(rig.devices['mic-1'].mic).toEqual({ cab: 'cab-1', x: 1, y: 0, distance: 0.5 });
    rig = removeDevice(rig, 'cab-1');
    expect(rig.cables).toEqual([]);
    expect(rig.devices['mic-1'].mic).toBeUndefined();
  });

  it('clamps params and rounds choices', () => {
    let [rig] = build('amp');
    rig = setParam(rig, 'amp-1', 'gain', 99);
    rig = setParam(rig, 'amp-1', 'voicing', 1.6);
    rig = setParam(rig, 'amp-1', 'nope', 1);
    expect(rig.devices['amp-1'].params).toMatchObject({ gain: 10, voicing: 2 });
    expect(rig.devices['amp-1'].params).not.toHaveProperty('nope');
  });

  it('undo/redo, with a knob drag as one step', () => {
    let [rig] = build('boost');
    let h = history(rig);
    h = commit(h, setParam(h.present, 'boost-1', 'gain', 10), 'drag-1');
    h = commit(h, setParam(h.present, 'boost-1', 'gain', 12), 'drag-1');
    h = commit(h, setParam(h.present, 'boost-1', 'gain', 20));
    h = undo(h);
    expect(h.present.devices['boost-1'].params.gain).toBe(12);
    h = undo(h);
    expect(h.present.devices['boost-1'].params.gain).toBe(6);
    expect(undo(h)).toBe(h);
    h = redo(redo(h));
    expect(h.present.devices['boost-1'].params.gain).toBe(20);
  });
});

describe('rig files', () => {
  it('round-trips', () => {
    let [rig] = build('input', 'amp', 'cab', 'mic', 'output');
    rig = connect(rig, j('input-1', 'out'), j('amp-1', 'in'));
    rig = connect(rig, j('amp-1', 'speaker'), j('cab-1', 'in'));
    rig = placeMic(rig, 'mic-1', { cab: 'cab-1', x: 0.5, y: 0.5, distance: 0.2 });
    rig = connect(rig, j('mic-1', 'out'), j('output-1', 'L'));
    expect(parseRig(JSON.stringify(rig))).toEqual(rig);
  });

  it('rejects junk and rule-breaking files', () => {
    expect(() => parseRig('nope')).toThrow('Not a JSON file');
    expect(() => parseRig('{"version":2}')).toThrow('Not a rig file');
    const file = (devices: object, cables: object[] = []) => JSON.stringify({ version: 1, devices, cables });
    expect(() => parseRig(file({ x: { id: 'x', type: 'toString' } }))).toThrow('Unknown device type');
    expect(() => parseRig(file({ 'a b': { id: 'a b', type: 'boost' } }))).toThrow('Bad device id');
    const loop = file(
      { a: { id: 'a', type: 'volume' }, b: { id: 'b', type: 'volume' } },
      [{ from: j('a', 'out'), to: j('b', 'in') }, { from: j('b', 'out'), to: j('a', 'in') }],
    );
    expect(() => parseRig(loop)).toThrow('feedback loop');
  });

  it('fills missing params with defaults and clamps bad ones', () => {
    const rig = parseRig(JSON.stringify({ version: 1, cables: [], devices: { b: { id: 'b', type: 'boost', params: { gain: 1e9, treble: 'x' } } } }));
    expect(rig.devices.b.params).toEqual({ gain: 24, treble: 0 });
  });
});

describe('built-in presets', async () => {
  const { PRESETS } = await import('./presets');
  it.each(Object.keys(PRESETS))('%s builds, round-trips and reaches the output', (name) => {
    const rig = PRESETS[name]();
    expect(parseRig(JSON.stringify(rig))).toEqual(rig);
    const { wires } = compile(rig);
    const reached = new Set(['input-1']);
    for (let grew = true; grew;) {
      grew = false;
      for (const w of wires) if (reached.has(w.from) && !reached.has(w.to)) { reached.add(w.to); grew = true; }
    }
    expect(reached).toContain('output-1');
  });
});
