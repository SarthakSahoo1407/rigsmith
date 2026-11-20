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
  ir?: string; // cab: user-loaded IR, base64 .wav
};
export type Rig = { version: 1; devices: Record<string, Device>; cables: Cable[] };

// Knob values go as an array in catalog order; a placed mic adds its position and distance.
export type Compiled = {
  nodes: { id: string; type: string; params: number[]; on: boolean }[];
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
  return [{ ...rig, devices: { ...rig.devices, [id]: { id, type, params, on: true, pos: { board: at, grid: at } } } }, id];
}

export function removeDevice(rig: Rig, id: string): Rig {
  const devices: Record<string, Device> = {};
  for (const d of Object.values(rig.devices)) {
    if (d.id === id) continue;
    devices[d.id] = d.mic?.cab === id ? { ...d, mic: undefined } : d; // its mics fall off
  }
  return { ...rig, devices, cables: rig.cables.filter((c) => c.from.device !== id && c.to.device !== id) };
}

const update = (rig: Rig, id: string, change: Partial<Device>): Rig => ({
  ...rig,
  devices: { ...rig.devices, [id]: { ...rig.devices[id], ...change } },
});

export function moveDevice(rig: Rig, id: string, view: 'board' | 'grid', at: XY): Rig {
  const was = rig.devices[id].pos[view];
  return was.x === at.x && was.y === at.y ? rig : update(rig, id, { pos: { ...rig.devices[id].pos, [view]: at } });
}

export const toggle = (rig: Rig, id: string) => update(rig, id, { on: !rig.devices[id].on });

export function setParam(rig: Rig, id: string, name: string, value: number): Rig {
  const p = def(rig.devices[id].type).params.find((x) => x.name === name);
  if (!p || !Number.isFinite(value)) return rig;
  const v = Math.min(p.max, Math.max(p.min, p.options ? Math.round(value) : value));
  return update(rig, id, { params: { ...rig.devices[id].params, [name]: v } });
}

export function placeMic(rig: Rig, micId: string, at?: MicPlacement): Rig {
  if (rig.devices[micId]?.type !== 'mic') throw new Error('Only mics can be placed on a cab');
  if (at && rig.devices[at.cab]?.type !== 'cab') throw new Error('Mics go on cabs');
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const mic = at && { cab: at.cab, x: clamp(at.x), y: clamp(at.y), distance: clamp(at.distance) };
  const was = rig.devices[micId].mic;
  if (mic === was || (mic && was && JSON.stringify(mic) === JSON.stringify(was))) return rig; // no change, no undo step
  return update(rig, micId, { mic });
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

// A jack's place in the engine: which node, and which channel among that node's inputs or outputs.
function endpoint(d: Device, jack: string) {
  const dd = def(d.type);
  const part = dd.parts?.find((p) => p.ins.includes(jack) || p.outs.includes(jack));
  if (part) return { node: `${d.id}/${part.suffix}`, index: (part.ins.includes(jack) ? part.ins : part.outs).indexOf(jack) };
  const dir = dd.jacks.find((j) => j.name === jack)!.dir;
  return { node: d.id, index: dd.jacks.filter((j) => j.dir === dir && j.kind !== 'power').findIndex((j) => j.name === jack) };
}

export function compile(rig: Rig): Compiled {
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
    if (d.mic) params.push(d.mic.x, d.mic.distance);
    const base = { params, on: d.on };
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
    if (d.mic && isLive.has(d.mic.cab)) wire({ node: d.mic.cab, index: 0 }, { node: d.id, index: 0 });
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
      ir: type === 'cab' && typeof d.ir === 'string' ? d.ir : undefined,
    };
    for (const p of def(type).params) rig = setParam(rig, id, p.name, num(d.params?.[p.name], p.def));
    if (d.mic) mics.push([id, { cab: String(d.mic.cab), x: num(d.mic.x), y: num(d.mic.y), distance: num(d.mic.distance) }]);
  }
  for (const [id, at] of mics) rig = placeMic(rig, id, at);
  for (const c of raw.cables) {
    const ref = (r: any): JackRef => ({ device: String(r?.device), jack: String(r?.jack) });
    rig = connect(rig, ref(c?.from), ref(c?.to));
  }
  return rig;
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
