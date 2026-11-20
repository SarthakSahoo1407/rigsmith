// Board view placement. Nothing floats: every device lives in a zone and the layout snaps it into place.
//   Stage     amp heads stacked on the cab they drive, mics on stands in front of their cab
//   Board     pedals in slots, signal flowing right to left, wrapping to a second row; power bricks on the rail
//   Desk      the audio interface, left of the stage; the guitar input, right of the board
//
// A device's stored board position is only an ordering hint. Pedals keep theirs relative to the
// board's top-right corner (row by y, slot by x); stage gear orders left to right by x.

import type { DeviceType } from './catalog';
import type { Device, Rig, XY } from './rig';

export type Size = { w: number; h: number };
export type Zone = { id: string; kind: 'stage' | 'board' | 'desk'; x: number; y: number; w: number; h: number };
export type Layout = { pos: Record<string, XY>; zones: Zone[]; board: { right: number; top: number } };

const STAGE_GEAR = new Set<DeviceType>(['amp', 'cab', 'mic']);
const DESK_GEAR = new Set<DeviceType>(['input', 'output', 'power']);

export const ROW_H = 352; // pedal slot height including the gap to the next row
const ROW_W = 1180; // usable board width
const PAD = 32;
const SLOT_GAP = 20;

// Pedal enclosures, by what they're modelled on: a compact with a hinged plate, an MXR-style stomp,
// a wide two-row box, a round fuzz, a TS-style rocker, a hammertone booster.
export type Shape = 'compact' | 'stomp' | 'wide' | 'round' | 'screamer' | 'hammered';
const SHAPES: Partial<Record<DeviceType, Shape | Shape[]>> = {
  tuner: 'compact', eq: 'compact', boost: ['stomp', 'hammered', 'stomp'], distortion: ['screamer', 'compact', 'wide', 'compact'],
  fuzz: ['round', 'wide'], chorus: 'wide', delay: ['compact', 'wide', 'stomp'], reverb: ['compact', 'wide', 'stomp', 'wide'],
};
export const shapeOf = (type: DeviceType, params: Record<string, number> = {}): Shape => {
  const s = SHAPES[type];
  return (Array.isArray(s) ? s[params.model ?? 0] : s) ?? 'stomp';
};
const SHAPE_SIZE: Record<Shape, Size> = {
  compact: { w: 140, h: 304 }, stomp: { w: 152, h: 284 }, wide: { w: 236, h: 264 },
  round: { w: 208, h: 248 }, screamer: { w: 140, h: 296 }, hammered: { w: 140, h: 284 },
};

// Cab sizes and where the speakers sit behind the grille (relative to the cab's corner).
const CAB_SIZE: Size[] = [{ w: 320, h: 340 }, { w: 460, h: 340 }, { w: 520, h: 500 }];
export const CAB_FOOT = 72;
export function cones(size: number) {
  const box = CAB_SIZE[size] ?? CAB_SIZE[1];
  const gw = box.w - 44, gh = box.h - 22 - CAB_FOOT;
  const cols = size === 0 ? 1 : 2, rows = size === 2 ? 2 : 1;
  const r = Math.min(gw / cols, gh / rows) / 2 - 14;
  return Array.from({ length: cols * rows }, (_, i) => ({
    x: 22 + (gw / cols) * ((i % cols) + 0.5), y: 22 + (gh / rows) * (Math.floor(i / cols) + 0.5), r,
  }));
}
// The mics on a cab, in the order they take the cones.
export const micsOn = (rig: Rig, cab: string) => Object.values(rig.devices).filter((m) => m.mic?.cab === cab)
  .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
// A mic on a cab is drawn from behind, its head over a cone; this is where the head sits in the mic's box.
export const MIC_HEAD = { x: 40, y: 27.5 }; // the drawing is 64x172, shown at 1.25x
// Where a mic's head sits on its cab: its cone, moved from the centre toward the edge by `position`,
// on the side its `y` says (below 0.5 = left).
export function micSpot(rig: Rig, mic: Device) {
  const cab = rig.devices[mic.mic!.cab];
  const k = micsOn(rig, cab.id).findIndex((m) => m.id === mic.id);
  const all = cones(cab.params.size);
  const c = all[k % all.length];
  return { x: c.x + (mic.mic!.y < 0.5 ? -1 : 1) * mic.mic!.x * c.r * 0.85, y: c.y };
}

export function gearSize(d: Device): Size {
  switch (d.type) {
    case 'amp': return { w: 540, h: 228 };
    case 'cab': return CAB_SIZE[d.params.size] ?? CAB_SIZE[1];
    case 'mic': return d.mic ? { w: 80, h: 215 } : { w: 120, h: 272 };
    case 'input': return { w: 148, h: 248 };
    case 'output': return { w: 224, h: 184 };
    case 'power': return { w: 336, h: 60 };
    case 'splitter': return { w: 112, h: 140 };
    case 'joiner': return { w: 156, h: 176 };
    case 'wah': case 'volume': return { w: 124, h: 312 };
    default: {
      const s = SHAPE_SIZE[shapeOf(d.type, d.params)];
      return d.type === 'eq' ? { ...s, w: 190 } : d.type === 'compressor' && s === SHAPE_SIZE.stomp ? { ...s, w: 172 } : s;
    }
  }
}

export const isPedal = (d: Device) => !STAGE_GEAR.has(d.type) && !DESK_GEAR.has(d.type);
export const zoneOf = (d: Device): Zone['kind'] => (STAGE_GEAR.has(d.type) ? 'stage' : isPedal(d) || d.type === 'power' ? 'board' : 'desk');

const rowOf = (d: Device) => Math.max(0, Math.round(d.pos.board.y / ROW_H));

export function layoutBoard(rig: Rig): Layout {
  const devices = Object.values(rig.devices);
  const pos: Record<string, XY> = {};
  const byX = (a: Device, b: Device) => a.pos.board.x - b.pos.board.x || a.id.localeCompare(b.id);

  // Stage: one stack per amp (head on its cab), then cabs without an amp, left to right.
  const cabOf = (amp: Device) => {
    const c = rig.cables.find((x) => x.from.device === amp.id && x.from.jack === 'speaker');
    return c ? rig.devices[c.to.device] : undefined;
  };
  const stacked = new Set<string>();
  const stacks: Device[][] = [];
  for (const amp of devices.filter((d) => d.type === 'amp')) {
    const cab = cabOf(amp);
    if (cab && !stacked.has(cab.id)) { stacks.push([amp, cab]); stacked.add(cab.id); } else stacks.push([amp]);
  }
  for (const cab of devices.filter((d) => d.type === 'cab' && !stacked.has(d.id))) stacks.push([cab]);
  stacks.sort((a, b) => byX(a[0], b[0]));

  let x = 0;
  let stageH = 0;
  const placedMics = new Set<string>();
  for (const stack of stacks) {
    const w = Math.max(...stack.map((d) => gearSize(d).w));
    let y = 0;
    for (const d of stack) {
      const s = gearSize(d);
      pos[d.id] = { x: x + (w - s.w) / 2, y };
      y += s.h;
    }
    // Mics stand in front of their cab, heads over the cones, like a real session.
    const cab = stack.find((d) => d.type === 'cab');
    if (cab) for (const mic of micsOn(rig, cab.id)) {
      const spot = micSpot(rig, mic);
      pos[mic.id] = { x: pos[cab.id].x + spot.x - MIC_HEAD.x, y: pos[cab.id].y + spot.y - MIC_HEAD.y };
      placedMics.add(mic.id);
      y = Math.max(y, pos[mic.id].y + gearSize(mic).h);
    }
    stageH = Math.max(stageH, y);
    x += w + 64;
  }
  for (const mic of devices.filter((d) => d.type === 'mic' && !placedMics.has(d.id)).sort(byX)) {
    pos[mic.id] = { x, y: 0 }; // a mic not on a cab waits at the end of the stage
    x += gearSize(mic).w + 24;
    stageH = Math.max(stageH, gearSize(mic).h);
  }
  const stageW = Math.max(x - 64, 640);

  // Pedalboard: slots fill right to left, a row at a time; a pedal can ask for a later row.
  // The board is as wide as its fullest row (up to ROW_W), so it never looks half empty.
  const pedals = devices.filter(isPedal).sort((a, b) => rowOf(a) - rowOf(b) || b.pos.board.x - a.pos.board.x || a.id.localeCompare(b.id));
  const widest = pedals.reduce((sum, p) => sum + gearSize(p).w + SLOT_GAP, -SLOT_GAP);
  const boardW = Math.max(560, Math.min(ROW_W, widest)) + 2 * PAD;
  const boardLeft = stageW / 2 - boardW / 2;
  const boardRight = boardLeft + boardW;
  const outputs = devices.filter((d) => d.type === 'output').length;
  const deskBottom = outputs ? 40 + outputs * 216 : 0;
  const boardTop = Math.max(stageH, deskBottom) + 160; // below the stage and the desk
  let row = 0;
  let cursor = boardRight - PAD;
  for (const p of pedals) {
    const s = gearSize(p);
    if (rowOf(p) > row) { row = rowOf(p); cursor = boardRight - PAD; }
    if (cursor - s.w < boardLeft + PAD - 0.5 && cursor < boardRight - PAD) { row++; cursor = boardRight - PAD; }
    pos[p.id] = { x: cursor - s.w, y: boardTop + PAD + row * ROW_H };
    cursor -= s.w + SLOT_GAP;
  }
  const rows = pedals.length ? row + 1 : 1;
  const railY = boardTop + PAD + rows * ROW_H - 12;
  const bricks = devices.filter((d) => d.type === 'power').sort(byX);
  bricks.forEach((b, i) => { pos[b.id] = { x: boardLeft + PAD + i * (gearSize(b).w + 24), y: railY }; });
  const boardH = railY + 60 + PAD - boardTop;

  // Desk: interface left of the stage, guitar input right of the board.
  devices.filter((d) => d.type === 'output').sort(byX).forEach((d, i) => { pos[d.id] = { x: -360, y: 40 + i * 216 }; });
  devices.filter((d) => d.type === 'input').sort(byX).forEach((d, i) => { pos[d.id] = { x: boardRight + 56, y: boardTop + 40 + i * 280 }; });

  const zones: Zone[] = [{ id: 'zone:board', kind: 'board', x: boardLeft, y: boardTop, w: boardW, h: boardH }];
  if (stageH) zones.push({ id: 'zone:stage', kind: 'stage', x: -48, y: -48, w: stageW + 96, h: stageH + 96 });
  if (outputs) zones.push({ id: 'zone:desk', kind: 'desk', x: -392, y: 8, w: 288, h: outputs * 216 + 48 });
  return { pos, zones, board: { right: boardRight, top: boardTop } };
}

// Where a dropped device should go: rewrite every zone-mate's hint to where it sits now, then put
// the dropped one at the drop point, so the next layout reflows around it.
export function dropHints(rig: Rig, layout: Layout, id: string, dropped: XY): Record<string, XY> {
  const d = rig.devices[id];
  const hints: Record<string, XY> = {};
  const center = (dev: Device, p: XY): XY => ({ x: p.x + gearSize(dev).w / 2, y: p.y });
  if (isPedal(d)) {
    for (const p of Object.values(rig.devices).filter(isPedal)) {
      const c = center(p, p.id === id ? dropped : layout.pos[p.id]);
      hints[p.id] = { x: c.x - layout.board.right, y: c.y - layout.board.top - PAD };
    }
  } else if (d.type === 'amp' || d.type === 'cab') {
    for (const s of Object.values(rig.devices).filter((x) => x.type === 'amp' || x.type === 'cab')) {
      hints[s.id] = { x: center(s, s.id === id ? dropped : layout.pos[s.id]).x, y: 0 };
    }
    // An amp and the cab under it move together.
    const partner = rig.cables.find((c) => (c.from.device === id && c.from.jack === 'speaker') || (c.to.device === id && rig.devices[c.from.device]?.type === 'amp'));
    if (partner) hints[partner.from.device === id ? partner.to.device : partner.from.device] = { ...hints[id] };
  }
  return hints;
}

// ---- Grid view: Quad Cortex-style rows and columns of equal tiles ----
// Column = how many devices the signal has passed through (longest path); a device sits on its
// first parent's row when that cell is free, so a split opens a new row. Power gear is hidden.
// Cables into an amp's Return are loop returns: they don't push the amp to a later column.

export const TILE = { w: 168, h: 92, colGap: 64, rowGap: 32 };

export function layoutGrid(rig: Rig): Record<string, XY> {
  const shown = Object.values(rig.devices).filter((d) => d.type !== 'power');
  const ids = new Set(shown.map((d) => d.id));
  const edges: [string, string][] = [];
  for (const c of rig.cables) {
    if (!ids.has(c.from.device) || !ids.has(c.to.device) || c.from.device === c.to.device) continue;
    if (rig.devices[c.to.device].type === 'amp' && c.to.jack === 'return') continue;
    edges.push([c.from.device, c.to.device]);
  }
  for (const d of shown) if (d.mic && ids.has(d.mic.cab)) edges.push([d.mic.cab, d.id]);

  // Longest-path columns (Kahn's order). Devices nothing reaches start at column 0.
  const indeg = new Map(shown.map((d) => [d.id, 0]));
  for (const [, b] of edges) indeg.set(b, indeg.get(b)! + 1);
  const col = new Map(shown.map((d) => [d.id, 0]));
  const order: string[] = [];
  const queue = shown.filter((d) => indeg.get(d.id) === 0).sort((a, b) => (a.type === 'input' ? -1 : b.type === 'input' ? 1 : 0)).map((d) => d.id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const [a, b] of edges) if (a === id) {
      col.set(b, Math.max(col.get(b)!, col.get(a)! + 1));
      indeg.set(b, indeg.get(b)! - 1);
      if (indeg.get(b) === 0) queue.push(b);
    }
  }
  for (const d of shown) if (!order.includes(d.id)) order.push(d.id); // only if a loop slipped through

  // Rows: follow the first parent; on a clash take the next free row. Unconnected gear goes last.
  const connected = new Set(edges.flat());
  const row = new Map<string, number>();
  const taken = new Set<string>();
  const place = (id: string, want: number) => {
    let r = want;
    while (taken.has(`${col.get(id)}:${r}`)) r++;
    row.set(id, r);
    taken.add(`${col.get(id)}:${r}`);
  };
  for (const id of order.filter((i) => connected.has(i))) {
    const parent = edges.find(([, b]) => b === id)?.[0];
    place(id, parent !== undefined && row.has(parent) ? row.get(parent)! : 0);
  }
  const spare = Math.max(-1, ...row.values()) + 1;
  order.filter((i) => !connected.has(i)).forEach((id, i) => { col.set(id, i); place(id, spare); });

  return Object.fromEntries(shown.map((d) => [d.id, {
    x: col.get(d.id)! * (TILE.w + TILE.colGap),
    y: row.get(d.id)! * (TILE.h + TILE.rowGap),
  }]));
}
