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

const WIDE = new Set<DeviceType>(['eq', 'compressor', 'delay', 'reverb', 'looper']);
const STAGE_GEAR = new Set<DeviceType>(['amp', 'cab', 'mic']);
const DESK_GEAR = new Set<DeviceType>(['input', 'output', 'power']);

export const ROW_H = 336; // pedal slot height including the gap to the next row
const ROW_W = 1180; // usable board width
const PAD = 32;
const SLOT_GAP = 20;

export function gearSize(d: Device): Size {
  switch (d.type) {
    case 'amp': return { w: 520, h: 196 };
    case 'cab': return [{ w: 300, h: 292 }, { w: 440, h: 292 }, { w: 520, h: 440 }][d.params.size] ?? { w: 440, h: 292 };
    case 'mic': return { w: 104, h: 236 };
    case 'input': return { w: 148, h: 184 };
    case 'output': return { w: 224, h: 184 };
    case 'power': return { w: 336, h: 60 };
    case 'splitter': return { w: 112, h: 140 };
    case 'joiner': return { w: 156, h: 176 };
    case 'wah': case 'volume': return { w: 124, h: 296 };
    default: return { w: WIDE.has(d.type) ? 180 : 140, h: 296 };
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
    const cab = stack.find((d) => d.type === 'cab');
    const mics = cab ? devices.filter((m) => m.type === 'mic' && m.mic?.cab === cab.id).sort(byX) : [];
    if (mics.length) {
      const m = gearSize(mics[0]);
      const span = mics.length * m.w + (mics.length - 1) * 16;
      mics.forEach((mic, i) => { pos[mic.id] = { x: x + (w - span) / 2 + i * (m.w + 16), y: y + 32 }; placedMics.add(mic.id); });
      y += 32 + m.h;
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
  devices.filter((d) => d.type === 'input').sort(byX).forEach((d, i) => { pos[d.id] = { x: boardRight + 56, y: boardTop + 40 + i * 216 }; });

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
