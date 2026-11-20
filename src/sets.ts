// Live sets: what Live mode plays. A set is a list of scenes, grouped by song; each scene is a whole
// rig, taken from any preset (built-in, yours, or whatever is on the board) and changed as you like.
// Scenes made from the same preset keep the same blocks and cables, so the engine only changes knobs
// and footswitches between them: no gap. A scene from another preset loads that rig.

import { compile, parseRig, type Rig } from './rig';

export type SetScene = { name: string; song: string; from: string; rig: Rig }; // from: the preset key it came from ('b:…', 'u:…' or '')
export type LiveSet = { name: string; scenes: SetScene[] };

export const MAX_SET_SCENES = 64;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

// Your sets as saved (a JSON map of name to set), checked like any rig file. Broken scenes are dropped.
export function parseSets(json: string | null): Record<string, LiveSet> {
  const out: Record<string, LiveSet> = {};
  let raw: any;
  try { raw = JSON.parse(json ?? '{}'); } catch { return out; }
  for (const [name, set] of Object.entries<any>(raw && typeof raw === 'object' ? raw : {})) {
    const scenes: SetScene[] = [];
    for (const s of Array.isArray(set?.scenes) ? set.scenes.slice(0, MAX_SET_SCENES) : []) {
      try {
        scenes.push({ name: text(s.name, 32) || 'Scene', song: text(s.song, 40), from: text(s.from, 120), rig: parseRig(JSON.stringify(s.rig)) });
      } catch { /* skip a scene whose rig doesn't parse */ }
    }
    out[name.slice(0, 60)] = { name: name.slice(0, 60), scenes };
  }
  return out;
}

// ---- Editing (each returns a new set) ----
export function addToSet(set: LiveSet, scene: SetScene, at = set.scenes.length): LiveSet {
  if (set.scenes.length >= MAX_SET_SCENES) throw new Error(`A set holds at most ${MAX_SET_SCENES} scenes`);
  return { ...set, scenes: [...set.scenes.slice(0, at), scene, ...set.scenes.slice(at)] };
}
export const removeFromSet = (set: LiveSet, i: number): LiveSet => ({ ...set, scenes: set.scenes.filter((_, k) => k !== i) });
export const changeScene = (set: LiveSet, i: number, change: Partial<SetScene>): LiveSet =>
  ({ ...set, scenes: set.scenes.map((s, k) => (k === i ? { ...s, ...change } : s)) });
export function moveInSet(set: LiveSet, i: number, dir: -1 | 1): LiveSet {
  const j = i + dir;
  if (j < 0 || j >= set.scenes.length) return set;
  const scenes = [...set.scenes];
  [scenes[i], scenes[j]] = [scenes[j], scenes[i]];
  return { ...set, scenes };
}

// The songs of a set in order, each with its scenes and their index in the set.
export function songsOf(set: LiveSet) {
  const songs: { song: string; scenes: { scene: SetScene; index: number }[] }[] = [];
  set.scenes.forEach((scene, index) => {
    const last = songs[songs.length - 1];
    if (last && last.song === scene.song) last.scenes.push({ scene, index });
    else songs.push({ song: scene.song, scenes: [{ scene, index }] });
  });
  return songs;
}

// Two rigs sound the same when the engine would get the same blocks, settings and cables (where
// devices sit and which copy of a capture file doesn't matter). Same shape: same blocks and cables,
// so switching between them only changes knobs and footswitches, without a gap.
export function sameSound(a: Rig, b: Rig) {
  if (a === b) return true;
  const strip = (r: Rig) => { const c = compile(r); return JSON.stringify([c.nodes.map(({ files: _, ...n }) => n), c.wires]); };
  return strip(a) === strip(b);
}
export function sameShape(a: Rig, b: Rig) {
  const shape = (r: Rig) => { const c = compile(r); return JSON.stringify([c.nodes.map((n) => [n.id, n.type]), c.wires]); };
  return shape(a) === shape(b);
}
