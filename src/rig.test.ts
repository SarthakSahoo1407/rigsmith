import { describe, expect, it } from 'vitest';
import type { DeviceType } from './catalog';
import {
  addDevice, addScene, canConnect, commit, compile, connect, emptyRig, history, insertIntoCable, isPowered, linkParam, parseRig,
  placeMic, powerUp, redo, removeDevice, removeScene, replaceDevice, selectScene, setFile, setParam, toggle, undo, type Rig,
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
  it('powerUp uses a free outlet, then adds a supply when all are taken', () => {
    let [rig, ids] = build('power', ...Array(9).fill('boost') as DeviceType[]);
    for (const id of ids.slice(1)) rig = powerUp(rig, id);
    expect(ids.slice(1).every((id) => isPowered(rig, id))).toBe(true);
    expect(Object.keys(rig.devices).filter((d) => d.startsWith('power'))).toEqual(['power-1', 'power-2']);
    expect(powerUp(rig, 'boost-1')).toBe(rig);
  });

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
    // mic: model, level, pan, phase, align, angle, solo, then position and distance
    expect(compile(rig).nodes.find((n) => n.id === 'mic-1')!.params).toEqual([0, 0, 0, 0, 0, 0, 0, 0.3, 0.1]);
    expect(wires(rig)).toEqual([
      'amp-1/power:0>cab-1/spk:0', 'amp-1/pre:0>amp-1/power:0', 'cab-1/spk:0>mic-1:0',
      'input-1:0>amp-1/pre:0', 'mic-1:0>cab-1/mix:0', 'mic-1:0>output-1:0', 'mic-1:0>output-1:1',
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

describe('cab mic mixer', () => {
  it('sums the cab mics to its L/R outs with pan, and solo silences the rest', () => {
    let [rig] = build('amp', 'cab', 'mic', 'mic', 'output');
    rig = connect(rig, j('amp-1', 'speaker'), j('cab-1', 'in'));
    rig = placeMic(rig, 'mic-1', { cab: 'cab-1', x: 0.3, y: 0.75, distance: 0.1 });
    rig = placeMic(rig, 'mic-2', { cab: 'cab-1', x: 0.5, y: 0.25, distance: 0.2 });
    rig = connect(rig, j('cab-1', 'outL'), j('output-1', 'L'));
    rig = connect(rig, j('cab-1', 'outR'), j('output-1', 'R'));
    rig = setParam(rig, 'mic-1', 'pan', -1);
    const mix = () => compile(rig).nodes.find((n) => n.id === 'cab-1/mix')!.params;
    expect(mix()).toEqual([1, -1, 1, 0, 0, 0, 0, 0]);
    expect(wires(rig)).toEqual(expect.arrayContaining(['mic-1:0>cab-1/mix:0', 'mic-2:0>cab-1/mix:1', 'cab-1/mix:0>output-1:0', 'cab-1/mix:1>output-1:1']));
    rig = setParam(rig, 'mic-2', 'solo', 1);
    expect(mix()).toEqual([0, -1, 1, 0, 0, 0, 0, 0]);
  });

  it('refuses a loop through the mic mixer', () => {
    let [rig] = build('amp', 'cab', 'mic');
    rig = connect(rig, j('amp-1', 'speaker'), j('cab-1', 'in'));
    rig = placeMic(rig, 'mic-1', { cab: 'cab-1', x: 0.3, y: 0.75, distance: 0.1 });
    expect(canConnect(rig, j('cab-1', 'outL'), j('amp-1', 'in'))).toMatch(/loop/);
  });
});

describe('scenes', () => {
  const rigWithScenes = () => {
    let [rig] = build('input', 'distortion', 'delay', 'output', 'power');
    rig = connect(rig, j('input-1', 'out'), j('distortion-1', 'in'));
    rig = connect(rig, j('distortion-1', 'out'), j('delay-1', 'in'));
    rig = connect(rig, j('delay-1', 'outL'), j('output-1', 'L'));
    rig = powerUp(powerUp(rig, 'distortion-1'), 'delay-1');
    rig = toggle(rig, 'distortion-1'); // off in the base
    return addScene(rig, 'Lead'); // scene A = current (drive off), scene B "Lead" active
  };
  const node = (rig: Rig, id: string) => compile(rig).nodes.find((n) => n.id === id)!;

  it('each scene keeps its own footswitches', () => {
    let rig = rigWithScenes();
    expect(rig.scenes!.list.map((s) => s.name)).toEqual(['Scene A', 'Lead']);
    rig = toggle(rig, 'distortion-1'); // drive on in Lead only
    expect(node(rig, 'distortion-1').on).toBe(true);
    rig = selectScene(rig, 0);
    expect(node(rig, 'distortion-1').on).toBe(false);
    expect(compile(rig).wires).toEqual(compile(selectScene(rig, 1)).wires); // switching scenes never re-cables
  });

  it('a linked knob is per scene, the rest are shared', () => {
    let rig = linkParam(rigWithScenes(), 'delay-1', 'mix', true);
    rig = setParam(rig, 'delay-1', 'mix', 0.6); // Lead
    rig = setParam(rig, 'delay-1', 'time', 500); // shared
    rig = selectScene(rig, 0);
    expect(node(rig, 'delay-1').params[4]).toBe(0.35); // mix in scene A unchanged
    expect(node(rig, 'delay-1').params[1]).toBe(500);
    expect(node(selectScene(rig, 1), 'delay-1').params[4]).toBe(0.6);
    rig = linkParam(rig, 'delay-1', 'mix', false); // shared again at scene A's value
    expect(node(selectScene(rig, 1), 'delay-1').params[4]).toBe(0.35);
  });

  it('round-trips through a rig file and drops scenes with the last one', () => {
    let rig = linkParam(rigWithScenes(), 'delay-1', 'mix', true);
    rig = setParam(toggle(rig, 'distortion-1'), 'delay-1', 'mix', 0.7);
    const back = parseRig(JSON.stringify(rig));
    expect(back.scenes).toEqual(rig.scenes);
    expect(compile(back)).toEqual(compile(rig));
    const one = removeScene(rig, 0);
    expect(one.scenes!.list.map((s) => s.name)).toEqual(['Lead']);
    const none = removeScene(one, 0);
    expect(none.scenes).toBeUndefined();
    expect(compile(none)).toEqual(compile(rig)); // keeps what the last scene played
  });

  it('removing a device removes it from every scene', () => {
    const rig = removeDevice(rigWithScenes(), 'distortion-1');
    expect(rig.scenes!.list.every((s) => !('distortion-1' in s.on))).toBe(true);
  });
});

describe('scene presets', async () => {
  const { PRESETS } = await import('./presets');
  it.each(Object.entries(PRESETS).filter(([, p]) => p.category === 'Scenes').map(([n]) => n))('%s: every scene plays something different', (name) => {
    const rig = PRESETS[name].build();
    expect(rig.scenes!.list.length).toBeGreaterThanOrEqual(3);
    const sounds = rig.scenes!.list.map((_, i) => JSON.stringify(compile(selectScene(rig, i)).nodes));
    expect(new Set(sounds).size).toBe(sounds.length);
    const wires = rig.scenes!.list.map((_, i) => JSON.stringify(compile(selectScene(rig, i)).wires));
    expect(new Set(wires).size).toBe(1); // scenes never re-cable, so switching is gapless
  });
});

describe('mic placement on the cone', async () => {
  const { micOffset, micPlacementAt } = await import('./layout');
  it('turns a drag point into a placement and back', () => {
    for (const [x, y] of [[0, 0.5], [0.4, 0.75], [1, 0.25], [0.7, 0.1]]) {
      const o = micOffset(x, y, 100);
      const back = micPlacementAt(o.x, o.y, 100);
      expect(back.x).toBeCloseTo(x);
      if (x > 0) expect(micOffset(back.x, back.y, 100).x).toBeCloseTo(o.x);
    }
    expect(micPlacementAt(300, 0, 100).x).toBe(1); // off the edge stays at the edge
  });
});

describe('library files', () => {
  it('compile passes library ids; rig files keep credits and refuse paths that leave the library', () => {
    let [rig] = build('namAmp');
    rig = setFile(rig, 'namAmp-1', 'model', { id: 'nam/Plexi.nam', name: 'Plexi', author: 'someone', license: 'cc-by', toneId: 42, source: 'tone3000' });
    expect(compile(rig).nodes[0].files).toEqual({ model: 'nam/Plexi.nam' });
    expect(parseRig(JSON.stringify(rig)).devices['namAmp-1'].files!.model).toMatchObject({ author: 'someone', license: 'cc-by', toneId: 42 });
    const evil = JSON.parse(JSON.stringify(rig));
    evil.devices['namAmp-1'].files.model.id = 'nam/../../secrets';
    expect(parseRig(JSON.stringify(evil)).devices['namAmp-1'].files).toBeUndefined();
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

  it('drops a pedal into a cable, and refuses gear that cannot go there', () => {
    let [rig] = build('input', 'output', 'distortion', 'amp');
    rig = connect(rig, j('input-1', 'out'), j('output-1', 'L'));
    rig = insertIntoCable(rig, rig.cables[0].id, 'distortion-1');
    expect(rig.cables.map((c) => c.id).sort()).toEqual(['distortion-1.out>output-1.L', 'input-1.out>distortion-1.in']);
    expect(() => insertIntoCable(rig, rig.cables[0].id, 'amp-1')).toThrow(); // its main output is a speaker jack
  });

  it('replaces a device in place, moving its cables to the matching jacks', () => {
    let [rig] = build('input', 'delay', 'reverb', 'power');
    rig = connect(rig, j('input-1', 'out'), j('delay-1', 'in'));
    rig = connect(rig, j('delay-1', 'outL'), j('reverb-1', 'inL'));
    rig = connect(rig, j('delay-1', 'outR'), j('reverb-1', 'inR'));
    rig = connect(rig, j('power-1', '1'), j('delay-1', 'dc'));
    let id: string;
    [rig, id] = replaceDevice(rig, 'delay-1', 'distortion', { model: 3 });
    expect(rig.devices['delay-1']).toBeUndefined();
    expect(rig.devices[id].params.model).toBe(3);
    // mono pedal: in and the left output move over, the right output has nowhere to go
    expect(rig.cables.map((c) => c.id).sort()).toEqual([`${id}.out>reverb-1.inL`, `input-1.out>${id}.in`, `power-1.1>${id}.dc`]);
    // same type: only the model changes, the id stays
    expect(replaceDevice(rig, id, 'distortion', { model: 0 })[1]).toBe(id);
  });

  it('clamps params and rounds choices', () => {
    let [rig] = build('amp');
    rig = setParam(rig, 'amp-1', 'gain', 99);
    rig = setParam(rig, 'amp-1', 'model', 1.6);
    rig = setParam(rig, 'amp-1', 'nope', 1);
    expect(rig.devices['amp-1'].params).toMatchObject({ gain: 10, model: 2 });
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
    const rig = parseRig(JSON.stringify({ version: 1, cables: [], devices: { b: { id: 'b', type: 'boost', params: { gain: 1e9, tone: 'x', model: 7 } } } }));
    expect(rig.devices.b.params).toEqual({ model: 2, gain: 24, tone: 5 });
  });
});

describe('built-in presets', async () => {
  const { PRESETS } = await import('./presets');
  it.each(Object.keys(PRESETS))('%s builds, round-trips and reaches the output', (name) => {
    const rig = PRESETS[name].build();
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

describe('board layout', async () => {
  const { PRESETS } = await import('./presets');
  const { layoutBoard, gearSize } = await import('./layout');
  it.each(Object.keys(PRESETS))('%s: every device placed, nothing overlaps', (name) => {
    const rig = PRESETS[name].build();
    const { pos } = layoutBoard(rig);
    const boxes = Object.values(rig.devices).map((d) => ({ id: d.id, ...pos[d.id], ...gearSize(d) }));
    for (const b of boxes) expect(Number.isFinite(b.x) && Number.isFinite(b.y), b.id).toBe(true);
    for (const a of boxes)
      for (const b of boxes)
        if (a.id < b.id && rig.devices[a.id].mic?.cab !== b.id && rig.devices[b.id].mic?.cab !== a.id) { // a mic stands on its cab's face
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
        }
  });

  it('keeps signal order right to left on the board', async () => {
    const rig = PRESETS['Shred lead'].build();
    const { pos } = layoutBoard(rig);
    expect(pos['tuner-1'].x).toBeGreaterThan(pos['gate-1'].x);
    expect(pos['gate-1'].x).toBeGreaterThan(pos['distortion-1'].x);
  });

  it('a dropped pedal takes the slot it was dropped on', async () => {
    const { dropHints } = await import('./layout');
    const { moveDevice } = await import('./rig');
    let rig = PRESETS['Shred lead'].build();
    const layout = layoutBoard(rig);
    // Drop the tuner just left of the distortion.
    const at = { x: layout.pos['distortion-1'].x - 60, y: layout.pos['distortion-1'].y };
    for (const [id, hint] of Object.entries(dropHints(rig, layout, 'tuner-1', at))) rig = moveDevice(rig, id, 'board', hint);
    const after = layoutBoard(rig).pos;
    expect(after['tuner-1'].x).toBeLessThan(after['distortion-1'].x);
    expect(after['gate-1'].x).toBeGreaterThan(after['distortion-1'].x);
  });
});

describe('grid layout', async () => {
  const { PRESETS } = await import('./presets');
  const { layoutGrid } = await import('./layout');
  it.each(Object.keys(PRESETS))('%s: signal flows left to right, no two tiles share a cell', (name) => {
    const rig = PRESETS[name].build();
    const pos = layoutGrid(rig);
    const cells = Object.values(pos).map((p) => `${p.x}:${p.y}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(Object.keys(pos).some((id) => id.startsWith('power'))).toBe(false);
    for (const c of rig.cables) {
      if (!pos[c.from.device] || !pos[c.to.device] || c.to.jack === 'return') continue;
      expect(pos[c.to.device].x, `${c.id}`).toBeGreaterThan(pos[c.from.device].x);
    }
  });

  it('a splitter opens a second row', () => {
    const pos = layoutGrid(PRESETS['Dual amp stereo'].build());
    expect(pos['amp-1'].y).not.toBe(pos['amp-2'].y);
  });
});
