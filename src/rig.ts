// The rig: what's on the board and how it's cabled. Pure functions, no audio.
// The UI edits a Rig; compile() turns it into the node/wire list the native engine runs.

import { CATALOG, def, type DeviceType, type JackKind } from './catalog';

export type XY = { x: number; y: number };
export type JackRef = { device: string; jack: string };
export type Cable = { id: string; from: JackRef; to: JackRef }; // from = output jack, to = input jack
// Where a mic sits on a cab's speaker: x, y in 0..1 across the speaker face, distance 0 (touching) .. 1 (far).
export type MicPlacement = { cab: string; x: number; y: number; distance: number };
export type Device = {
  id: string;
  type: DeviceType;
  params: Record<string, number>;
  on: boolean;
  hotkey?: string;
  pos: { board: XY; grid: XY };
  mic?: MicPlacement;
  ir?: string; // v1 field, unused
  files?: Record<string, FileRef>; // library files by slot: NAM devices "model", cabs "irA" / "irB"
};
// A capture or IR in the library (native Library.h). `id` is "<kind>/<file name>"; the rest is shown
// to the user. Files from TONE3000 keep their creator, license and links, and the tone to fetch
// them from again on another Mac.
export type FileRef = {
  id: string; name: string; kind?: 'nam' | 'ir'; source?: 'file' | 'tone3000';
  author?: string; authorUrl?: string; license?: string; toneId?: number | string; modelId?: number | string; toneUrl?: string; gear?: string;
};
// Scenes: up to eight snapshots inside one rig. Each remembers which blocks are on, plus the knobs
// that were made per-scene ("linked"); everything else is shared by all scenes.
export type Scene = { name: string; on: Record<string, boolean>; params: Record<string, Record<string, number>> };
export type Scenes = { active: number; list: Scene[] };
export type Rig = { version: 1; devices: Record<string, Device>; cables: Cable[]; scenes?: Scenes };
export const MAX_SCENES = 8;

// Knob values go as an array in catalog order; a placed mic adds its position and distance.
export type Compiled = {
  nodes: { id: string; type: string; params: number[]; on: boolean; files?: Record<string, string> }[];
  wires: { from: string; out: number; to: string; in: number }[];
};

export const emptyRig = (): Rig => ({ version: 1, devices: {}, cables: [] });

const same = (a: JackRef, b: JackRef) => a.device === b.device && a.jack === b.jack;
const key = (r: JackRef) => `${r.device}.${r.jack}`;
const jackOf = (rig: Rig, r: JackRef) => {
  const d = rig.devices[r.device];
  return d && def(d.type).jacks.find((j) => j.name === r.jack);
};
export const cableAt = (rig: Rig, r: JackRef) => rig.cables.find((c) => same(c.from, r) || same(c.to, r));
const unplug = (rig: Rig, ...refs: JackRef[]): Rig => ({
  ...rig,
  cables: rig.cables.filter((c) => !refs.some((r) => same(c.from, r) || same(c.to, r))),
});

export function addDevice(rig: Rig, type: DeviceType, at: XY): [Rig, string] {
  let n = 1;
  while (rig.devices[`${type}-${n}`]) n++;
  const id = `${type}-${n}`;
  const params = Object.fromEntries(def(type).params.map((p) => [p.name, p.def]));
  const on = !def(type).startsOff;
  return [{ ...rig, devices: { ...rig.devices, [id]: { id, type, params, on, pos: { board: at, grid: at } } } }, id];
}

export function removeDevice(rig: Rig, id: string): Rig {
  const devices: Record<string, Device> = {};
  for (const d of Object.values(rig.devices)) {
    if (d.id === id) continue;
    devices[d.id] = d.mic?.cab === id ? { ...d, mic: undefined } : d; // its mics fall off
  }
  const scenes = rig.scenes && { ...rig.scenes, list: rig.scenes.list.map((s) => {
    const { [id]: _on, ...on } = s.on;
    const { [id]: _params, ...params } = s.params;
    return { ...s, on, params };
  }) };
  return { ...rig, devices, cables: rig.cables.filter((c) => c.from.device !== id && c.to.device !== id), ...(scenes && { scenes }) };
}

const update = (rig: Rig, id: string, change: Partial<Device>): Rig => ({
  ...rig,
  devices: { ...rig.devices, [id]: { ...rig.devices[id], ...change } },
});

export function moveDevice(rig: Rig, id: string, view: 'board' | 'grid', at: XY): Rig {
  const was = rig.devices[id].pos[view];
  return was.x === at.x && was.y === at.y ? rig : update(rig, id, { pos: { ...rig.devices[id].pos, [view]: at } });
}

// With scenes, a footswitch belongs to the active scene; without, to the device.
export function toggle(rig: Rig, id: string): Rig {
  const sc = rig.scenes;
  if (!sc || !sceneSwitched(rig.devices[id])) return update(rig, id, { on: !rig.devices[id].on });
  const scene = sc.list[sc.active];
  return withScene(rig, { ...scene, on: { ...scene.on, [id]: !(scene.on[id] ?? rig.devices[id].on) } });
}

const clampParam = (rig: Rig, id: string, name: string, value: number) => {
  const p = def(rig.devices[id].type).params.find((x) => x.name === name);
  if (!p || !Number.isFinite(value)) return undefined;
  const step = p.options ? 1 : p.step;
  return Math.min(p.max, Math.max(p.min, step ? Math.round(value / step) * step : value));
};

// A knob linked to scenes changes only in the active scene; any other knob changes for all.
export function setParam(rig: Rig, id: string, name: string, value: number): Rig {
  const v = clampParam(rig, id, name, value);
  if (v === undefined) return rig;
  if (isLinked(rig, id, name)) {
    const scene = rig.scenes!.list[rig.scenes!.active];
    return withScene(rig, { ...scene, params: { ...scene.params, [id]: { ...scene.params[id], [name]: v } } });
  }
  return update(rig, id, { params: { ...rig.devices[id].params, [name]: v } });
}

// ---- Scenes ----
const sceneSwitched = (d: Device) => !!def(d.type).footswitch;
const withScene = (rig: Rig, scene: Scene): Rig => ({
  ...rig, scenes: { ...rig.scenes!, list: rig.scenes!.list.map((s, i) => (i === rig.scenes!.active ? scene : s)) },
});
export const isLinked = (rig: Rig, id: string, name: string) => !!rig.scenes?.list.some((s) => s.params[id]?.[name] !== undefined);

// The rig as the active scene plays it: its footswitches and linked knobs over the shared settings.
export function applyScene(rig: Rig): Rig {
  const sc = rig.scenes;
  if (!sc) return rig;
  const scene = sc.list[sc.active];
  const devices: Record<string, Device> = {};
  for (const d of Object.values(rig.devices)) {
    const on = sceneSwitched(d) ? scene.on[d.id] ?? d.on : d.on;
    const params = scene.params[d.id] ? { ...d.params, ...scene.params[d.id] } : d.params;
    devices[d.id] = on === d.on && params === d.params ? d : { ...d, on, params };
  }
  return { ...rig, devices };
}

// The current sound as a scene: every footswitch's state and every linked knob's value.
function snapshot(rig: Rig, name: string): Scene {
  const now = applyScene(rig);
  const on: Record<string, boolean> = {};
  const params: Record<string, Record<string, number>> = {};
  for (const d of Object.values(now.devices)) if (sceneSwitched(d)) on[d.id] = d.on;
  for (const s of rig.scenes?.list ?? [])
    for (const [id, ps] of Object.entries(s.params))
      for (const k of Object.keys(ps)) if (now.devices[id]) (params[id] ??= {})[k] = now.devices[id].params[k];
  return { name, on, params };
}

// Adds a scene copied from what's playing now and switches to it. The first call turns scenes on.
export function addScene(rig: Rig, name?: string): Rig {
  const list = rig.scenes?.list ?? [];
  if (list.length >= MAX_SCENES) throw new Error(`A rig has at most ${MAX_SCENES} scenes`);
  const base = list.length ? list : [snapshot(rig, 'Scene A')];
  const scene = snapshot(rig, name ?? `Scene ${String.fromCharCode(65 + base.length)}`);
  return { ...rig, scenes: { active: base.length, list: [...base, scene] } };
}

export function selectScene(rig: Rig, index: number): Rig {
  if (!rig.scenes || index < 0 || index >= rig.scenes.list.length || index === rig.scenes.active) return rig;
  return { ...rig, scenes: { ...rig.scenes, active: index } };
}

export const renameScene = (rig: Rig, index: number, name: string): Rig =>
  !rig.scenes ? rig : { ...rig, scenes: { ...rig.scenes, list: rig.scenes.list.map((s, i) => (i === index ? { ...s, name: name.slice(0, 24) } : s)) } };

// Removing the last scene turns scenes off, keeping what that scene played.
export function removeScene(rig: Rig, index: number): Rig {
  const sc = rig.scenes;
  if (!sc) return rig;
  if (sc.list.length === 1) { const { scenes: _, ...rest } = applyScene(rig); return rest; }
  const list = sc.list.filter((_, i) => i !== index);
  return { ...rig, scenes: { list, active: Math.min(index <= sc.active ? Math.max(0, sc.active - 1) : sc.active, list.length - 1) } };
}

// Makes a knob per-scene (every scene starts at its current value), or shared again (all scenes
// take the active scene's value).
export function linkParam(rig: Rig, id: string, name: string, linked: boolean): Rig {
  if (!rig.scenes) rig = addScene(rig);
  const value = applyScene(rig).devices[id].params[name];
  const list = rig.scenes!.list.map((s) => {
    const own = { ...s.params[id] };
    if (linked) own[name] ??= value; else delete own[name];
    return { ...s, params: { ...s.params, [id]: own } };
  });
  const next = { ...rig, scenes: { ...rig.scenes!, list } };
  return linked ? next : update(next, id, { params: { ...rig.devices[id].params, [name]: value } });
}

export const setFile = (rig: Rig, id: string, slot: string, file: FileRef | undefined): Rig => {
  const files = { ...rig.devices[id].files };
  if (file) files[slot] = file; else delete files[slot];
  return update(rig, id, { files });
};

export function placeMic(rig: Rig, micId: string, at?: MicPlacement): Rig {
  if (rig.devices[micId]?.type !== 'mic') throw new Error('Only mics can be placed on a cab');
  if (at && rig.devices[at.cab]?.type !== 'cab') throw new Error('Mics go on cabs');
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const mic = at && { cab: at.cab, x: clamp(at.x), y: clamp(at.y), distance: clamp(at.distance) };
  const was = rig.devices[micId].mic;
  if (mic === was || (mic && was && JSON.stringify(mic) === JSON.stringify(was))) return rig; // no change, no undo step
  return update(rig, micId, { mic });
}

// Plugs a device into the first free outlet, adding a power supply when every outlet is taken.
export function powerUp(rig: Rig, id: string): Rig {
  if (!def(rig.devices[id].type).power || isPowered(rig, id)) return rig;
  for (const supply of Object.values(rig.devices).filter((d) => d.type === 'power'))
    for (const j of def('power').jacks)
      if (!cableAt(rig, { device: supply.id, jack: j.name })) return connect(rig, { device: supply.id, jack: j.name }, { device: id, jack: 'dc' });
  const [next, supply] = addDevice(rig, 'power', { x: 0, y: 0 });
  return connect(next, { device: supply, jack: '1' }, { device: id, jack: 'dc' });
}

export const isPowered = (rig: Rig, id: string) =>
  !def(rig.devices[id].type).power || !!cableAt(rig, { device: id, jack: 'dc' });

// Jacks the signal reaches next from `r`, inside the device or along a cable.
function next(rig: Rig, r: JackRef): JackRef[] {
  const d = rig.devices[r.device];
  const dd = def(d.type);
  const at = (jack: string) => ({ device: d.id, jack });
  const found: JackRef[] = [];
  for (const j of dd.jacks) if (j.normal === r.jack && !cableAt(rig, at(j.name))) found.push(at(j.name));

  if (jackOf(rig, r)!.dir === 'out') {
    for (const c of rig.cables) if (same(c.from, r)) found.push(c.to);
    if (d.mic) found.push({ device: d.mic.cab, jack: 'outL' }, { device: d.mic.cab, jack: 'outR' }); // through the cab's mic mixer
  } else {
    const part = dd.parts?.find((p) => p.ins.includes(r.jack));
    const outs = part ? part.outs : dd.jacks.filter((j) => j.dir === 'out' && j.kind !== 'power').map((j) => j.name);
    found.push(...outs.map(at));
    if (d.type === 'cab') for (const m of Object.values(rig.devices)) if (m.mic?.cab === d.id) found.push({ device: m.id, jack: 'out' });
  }
  return found;
}

function reaches(rig: Rig, start: JackRef, target: JackRef) {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const r = stack.pop()!;
    if (same(r, target)) return true;
    if (seen.has(key(r))) continue;
    seen.add(key(r));
    stack.push(...next(rig, r));
  }
  return false;
}

const KIND: Record<JackKind, string> = { audio: 'an audio', speaker: 'a speaker', power: 'a power' };

// Why a cable between a and b isn't allowed, or null if it is. Either end may be the output.
// An occupied jack is fine: connect() replaces the old cable.
export function canConnect(rig: Rig, a: JackRef, b: JackRef): string | null {
  const ja = jackOf(rig, a);
  const jb = jackOf(rig, b);
  if (!ja || !jb) return 'No such jack';
  if (ja.dir === jb.dir) return ja.dir === 'in' ? 'Both jacks are inputs' : 'Both jacks are outputs';
  if (ja.kind !== jb.kind) return `Can't plug ${KIND[ja.kind]} jack into ${KIND[jb.kind]} jack`;
  const [from, to] = ja.dir === 'out' ? [a, b] : [b, a];
  if (ja.kind !== 'power' && reaches(unplug(rig, from, to), to, from)) return 'That would make a feedback loop';
  return null;
}

export function connect(rig: Rig, a: JackRef, b: JackRef): Rig {
  const err = canConnect(rig, a, b);
  if (err) throw new Error(err);
  const [from, to] = jackOf(rig, a)!.dir === 'out' ? [a, b] : [b, a];
  const rest = unplug(rig, from, to);
  return { ...rest, cables: [...rest.cables, { id: `${key(from)}>${key(to)}`, from, to }] };
}

export const disconnect = (rig: Rig, cableId: string): Rig => ({ ...rig, cables: rig.cables.filter((c) => c.id !== cableId) });

// A device's main jacks: the amp's speaker out, otherwise the first audio output or input.
export const mainJack = (type: DeviceType, dir: 'in' | 'out') =>
  type === 'amp' && dir === 'out' ? 'speaker' : def(type).jacks.find((j) => j.dir === dir && j.kind !== 'power')?.name;

// Puts a device into a cable: the cable's source now feeds the device, and the device feeds where
// the cable went. Throws (and changes nothing) when the device can't sit there.
export function insertIntoCable(rig: Rig, cableId: string, id: string): Rig {
  const c = rig.cables.find((x) => x.id === cableId);
  if (!c) return rig;
  const type = rig.devices[id].type;
  const [inJack, outJack] = [mainJack(type, 'in'), mainJack(type, 'out')];
  if (!inJack || !outJack) throw new Error(`A ${def(type).label} can't go in a cable`);
  const r = connect(disconnect(rig, cableId), c.from, { device: id, jack: inJack });
  return connect(r, { device: id, jack: outJack }, c.to);
}

// Swaps a device for another one in the same place: same position and on/off, cables moved to the
// matching jacks (a stereo output's right side is dropped going into a mono pedal). Same type: only
// the given knobs change. Returns the rig and the new device's id.
export function replaceDevice(rig: Rig, id: string, type: DeviceType, params: Record<string, number> = {}): [Rig, string] {
  const old = rig.devices[id];
  const set = (r: Rig, target: string) => Object.entries(params).reduce((acc, [k, v]) => setParam(acc, target, k, v), r);
  if (old.type === type) return [set(rig, id), id];

  let [next, nid] = addDevice(rig, type, old.pos.board);
  next = set(update(next, nid, { pos: old.pos, on: old.on }), nid);
  const moved = rig.cables.filter((c) => c.from.device === id || c.to.device === id);
  next = removeDevice(next, id);
  const mapJack = (jack: string) => {
    const j = def(old.type).jacks.find((x) => x.name === jack)!;
    if (def(type).jacks.some((x) => x.name === jack && x.dir === j.dir && x.kind === j.kind)) return jack;
    return j.kind !== 'power' && jack === mainJack(old.type, j.dir) ? mainJack(type, j.dir) : undefined;
  };
  for (const c of moved) {
    const jack = mapJack(c.from.device === id ? c.from.jack : c.to.jack);
    if (!jack) continue;
    const swap = (r: JackRef) => (r.device === id ? { device: nid, jack } : r);
    try { next = connect(next, swap(c.from), swap(c.to)); } catch { /* doesn't fit the new gear: left unplugged */ }
  }
  return [next, nid];
}

// A jack's place in the engine: which node, and which channel among that node's inputs or outputs.
function endpoint(d: Device, jack: string) {
  const dd = def(d.type);
  const part = dd.parts?.find((p) => p.ins.includes(jack) || p.outs.includes(jack));
  if (part) return { node: `${d.id}/${part.suffix}`, index: (part.ins.includes(jack) ? part.ins : part.outs).indexOf(jack) };
  const dir = dd.jacks.find((j) => j.name === jack)!.dir;
  return { node: d.id, index: dd.jacks.filter((j) => j.dir === dir && j.kind !== 'power').findIndex((j) => j.name === jack) };
}

export function compile(rig: Rig): Compiled {
  rig = applyScene(rig);
  // Unpowered pedals and power supplies drop out of the audio path entirely.
  const live = Object.values(rig.devices).filter(
    (d) => isPowered(rig, d.id) && def(d.type).jacks.some((j) => j.kind !== 'power'),
  );
  const isLive = new Set(live.map((d) => d.id));
  const out: Compiled = { nodes: [], wires: [] };
  const wire = (a: { node: string; index: number }, b: { node: string; index: number }) =>
    out.wires.push({ from: a.node, out: a.index, to: b.node, in: b.index });

  for (const d of live) {
    const params = def(d.type).params.map((p) => d.params[p.name]);
    if (d.type === 'mic') params.push(d.mic?.x ?? 0, d.mic?.distance ?? 0);
    const files = d.files && Object.fromEntries(Object.entries(d.files).map(([slot, f]) => [slot, f.id]));
    const base = { params, on: d.on, ...(files && { files }) };
    const parts = def(d.type).parts;
    if (parts) for (const p of parts) out.nodes.push({ id: `${d.id}/${p.suffix}`, type: `${d.type}/${p.suffix}`, ...base });
    else out.nodes.push({ id: d.id, type: d.type, ...base });

    for (const j of def(d.type).jacks) {
      if (!j.normal || cableAt(rig, { device: d.id, jack: j.name })) continue; // a plugged jack breaks the normal
      const target = def(d.type).jacks.find((x) => x.name === j.normal)!;
      if (target.dir === 'out') {
        wire(endpoint(d, j.normal), endpoint(d, j.name)); // internal link, e.g. amp send → return
      } else {
        const src = cableAt(rig, { device: d.id, jack: j.normal });
        if (src && isLive.has(src.from.device)) wire(endpoint(rig.devices[src.from.device], src.from.jack), endpoint(d, j.name));
      }
    }
    if (d.mic && isLive.has(d.mic.cab)) wire({ node: `${d.mic.cab}/spk`, index: 0 }, { node: d.id, index: 0 });
  }

  // Each cab's mic mixer: up to four mics, in the order they take the cones, panned to its L/R outs.
  // A soloed mic silences the others on the bus.
  for (const n of out.nodes.filter((x) => x.type === 'cab/mix')) {
    const cab = n.id.slice(0, -'/mix'.length);
    const mics = live.filter((m) => m.mic?.cab === cab).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).slice(0, 4);
    const solo = mics.some((m) => m.params.solo === 1);
    n.params = [0, 1, 2, 3].flatMap((k) => (mics[k] ? [solo && mics[k].params.solo !== 1 ? 0 : 1, mics[k].params.pan] : [0, 0]));
    mics.forEach((m, k) => wire({ node: m.id, index: 0 }, { node: n.id, index: k }));
  }

  for (const c of rig.cables) {
    if (jackOf(rig, c.from)!.kind === 'power' || !isLive.has(c.from.device) || !isLive.has(c.to.device)) continue;
    wire(endpoint(rig.devices[c.from.device], c.from.jack), endpoint(rig.devices[c.to.device], c.to.jack));
  }
  return out;
}

// Rig files come from anywhere: rebuild them through the same rules as the UI.
export function parseRig(text: string): Rig {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error('Not a JSON file'); }
  if (raw?.version !== 1 || typeof raw.devices !== 'object' || raw.devices === null || !Array.isArray(raw.cables)) {
    throw new Error('Not a rig file');
  }
  const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const xy = (v: any): XY => ({ x: num(v?.x), y: num(v?.y) });

  let rig = emptyRig();
  const mics: [string, MicPlacement][] = [];
  for (const [id, d] of Object.entries<any>(raw.devices)) {
    if (!/^[\w-]{1,64}$/.test(id) || d?.id !== id) throw new Error(`Bad device id: ${id.slice(0, 64)}`);
    if (typeof d.type !== 'string' || !Object.hasOwn(CATALOG, d.type)) throw new Error(`Unknown device type in ${id}`);
    const type = d.type as DeviceType;
    rig.devices[id] = {
      id, type, params: {}, on: d.on !== false, pos: { board: xy(d.pos?.board), grid: xy(d.pos?.grid) },
      hotkey: typeof d.hotkey === 'string' && d.hotkey.length <= 16 ? d.hotkey : undefined,
    };
    const files = parseFiles(d.files);
    if (files) rig.devices[id].files = files;
    for (const p of def(type).params) rig = setParam(rig, id, p.name, num(d.params?.[p.name], p.def));
    if (d.mic) mics.push([id, { cab: String(d.mic.cab), x: num(d.mic.x), y: num(d.mic.y), distance: num(d.mic.distance) }]);
  }
  for (const [id, at] of mics) rig = placeMic(rig, id, at);
  for (const c of raw.cables) {
    const ref = (r: any): JackRef => ({ device: String(r?.device), jack: String(r?.jack) });
    rig = connect(rig, ref(c?.from), ref(c?.to));
  }
  if (Array.isArray(raw.scenes?.list) && raw.scenes.list.length) {
    const list: Scene[] = raw.scenes.list.slice(0, MAX_SCENES).map((s: any, i: number) => {
      const on: Record<string, boolean> = {};
      const params: Record<string, Record<string, number>> = {};
      for (const [id, v] of Object.entries<any>(s?.on ?? {})) if (rig.devices[id] && typeof v === 'boolean') on[id] = v;
      for (const [id, ps] of Object.entries<any>(s?.params ?? {})) {
        if (!rig.devices[id] || typeof ps !== 'object' || ps === null) continue;
        for (const [k, v] of Object.entries(ps)) {
          const c = clampParam(rig, id, k, num(v, NaN));
          if (c !== undefined) (params[id] ??= {})[k] = c;
        }
      }
      return { name: typeof s?.name === 'string' ? s.name.slice(0, 24) : `Scene ${String.fromCharCode(65 + i)}`, on, params };
    });
    rig = { ...rig, scenes: { list, active: Math.min(list.length - 1, Math.max(0, Math.trunc(num(raw.scenes.active)))) } };
  }
  return rig;
}

// Library references from a file: ids must look like "nam/x.nam" or "ir/x.wav"; the native side
// also refuses anything that leaves the library folder.
function parseFiles(raw: any): Record<string, FileRef> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: Record<string, FileRef> = {};
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : undefined);
  for (const [slot, f] of Object.entries<any>(raw)) {
    if (!['model', 'irA', 'irB'].includes(slot) || typeof f?.id !== 'string' || !/^(nam|ir)\/[^/\\]+$/.test(f.id)) continue;
    out[slot] = {
      id: f.id, name: str(f.name) ?? f.id, kind: f.kind === 'ir' ? 'ir' : f.kind === 'nam' ? 'nam' : undefined,
      source: f.source === 'tone3000' ? 'tone3000' : f.source === 'file' ? 'file' : undefined,
      author: str(f.author), authorUrl: str(f.authorUrl), license: str(f.license), toneUrl: str(f.toneUrl), gear: str(f.gear),
      toneId: typeof f.toneId === 'number' || typeof f.toneId === 'string' ? f.toneId : undefined,
      modelId: typeof f.modelId === 'number' || typeof f.modelId === 'string' ? f.modelId : undefined,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

// Undo/redo. Commits sharing a `group` (e.g. one knob drag) collapse into one step.
export type History = { past: Rig[]; present: Rig; future: Rig[]; group?: string };
export const history = (rig: Rig): History => ({ past: [], present: rig, future: [] });

export function commit(h: History, rig: Rig, group?: string): History {
  if (group && group === h.group) return { ...h, present: rig, future: [] };
  return { past: [...h.past, h.present].slice(-200), present: rig, future: [], group };
}
export const undo = (h: History): History =>
  h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h;
export const redo = (h: History): History =>
  h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h;
