// The text assistant's operations: "more reverb", "swap the delay for a tape echo", "add a delay after the reverb".
// A language model (OpenRouter, via native/Llm.h) turns the sentence into a short list of operations;
// this file describes the rig to it, checks every operation, and applies them with the rig functions
// the UI already uses. The model only ever picks from the operations below: it cannot touch files, the
// network or anything outside the rig, and a bad operation is skipped and reported, never guessed at.

import { AMP_CHANNEL_KNOBS, ampKnob, CATALOG, def, itemParams, itemsOf, type DeviceType, type Item, type Param } from './catalog';
import { layoutGrid } from './layout';
import { call } from './native';
import { insertAfter, removeAndBridge, replaceDevice, setParam, setTempo, tempoOf, toggle, type Device, type Rig } from './rig';

export type Op =
  | { op: 'set'; target: string; param: string; value: number | string }
  | { op: 'nudge'; target: string; param: string; by: number }
  | { op: 'toggle'; target: string; on?: boolean }
  | { op: 'replace'; target: string; with: string }
  | { op: 'remove'; target: string }
  | { op: 'add'; item: string; after?: string }
  | { op: 'tempo'; bpm: number };
export type Plan = { ops: Op[]; say?: string; ask?: string };
export type Result = { rig: Rig; done: string[]; failed: string[] };

const MAX_OPS = 12;
// What can be added or swapped in: the pedals, amps and cabs of the gear list.
const ADDABLE: DeviceType[] = ['tuner', 'gate', 'compressor', 'boost', 'distortion', 'fuzz', 'octave', 'pitch', 'acoustic', 'eq', 'wah', 'volume',
  'chorus', 'flanger', 'phaser', 'tremolo', 'delay', 'reverb', 'looper', 'amp', 'cab'];
const items = () => ADDABLE.flatMap(itemsOf);

const nameOf = (d: Device) => items().find((i) => i.type === d.type && (i.variant === undefined || i.variant === d.params[itemVariantParam(i.type)]))?.name ?? def(d.type).label;
const itemVariantParam = (t: DeviceType) => (t === 'amp' || t === 'distortion' || t === 'fuzz' || t === 'boost' || t === 'delay' || t === 'reverb' ? 'model' : t === 'cab' ? 'speaker' : '');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();

// An amp's gain, bass, mid and treble are per channel; the model sees them by their plain names.
const knobName = (d: Device, name: string) => (d.type === 'amp' && AMP_CHANNEL_KNOBS.includes(name) ? ampKnob(name, d.params.channel) : name);
const AMP_SHOWN = ['model', 'channel', 'gain', 'bass', 'mid', 'treble', 'presence', 'master'];
const shownParams = (d: Device): Param[] => def(d.type).params.filter((p) => d.type !== 'amp' || AMP_SHOWN.includes(p.name));
const numeral = (n: number) => String(Number(n.toFixed(2)));

// The rig as the model sees it: tempo, then every block in signal order with its knobs and ranges.
export function describeRig(rig: Rig): string {
  const pos = layoutGrid(rig);
  const rows = Object.values(rig.devices).filter((d) => pos[d.id] && d.type !== 'power')
    .sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
  const lines = rows.map((d) => {
    const knobs = shownParams(d).map((p) => {
      const v = d.params[knobName(d, p.name)];
      return p.options ? `${p.name}=${p.options[v]} {${p.options.join('|')}}` : `${p.name}=${numeral(v)} [${p.min}..${p.max}]`;
    });
    const file = d.files?.model ? ` capture="${d.files.model.name}"` : '';
    return `- id=${d.id} name="${nameOf(d)}" type=${d.type} ${d.on ? 'on' : 'off'}${file}${knobs.length ? ' | ' + knobs.join(', ') : ''}`;
  });
  return `Tempo: ${tempoOf(rig)} BPM\nSignal path, first to last:\n${lines.join('\n')}`;
}

const SYSTEM = `You edit a guitar rig for a player. Turn their request into operations. Reply with ONLY one JSON object, no other text:
{"ops":[...],"say":"one short sentence of what you did"}
If the request is unclear or needs a choice, reply {"ops":[],"ask":"one short question"}.

Operations (target is an id from the rig below):
{"op":"set","target":"delay-1","param":"mix","value":0.4}      value in the knob's range; for a choice knob use its option text
{"op":"nudge","target":"reverb-1","param":"mix","by":0.2}     by is a fraction of the knob's range, -1..1: "a bit more" 0.1, "more" 0.2, "much more" 0.4, less is negative
{"op":"toggle","target":"fuzz-1","on":false}                 turn a pedal or amp on or off
{"op":"replace","target":"delay-1","with":"Tape Echo"}       swap for another item from the gear list
{"op":"remove","target":"chorus-1"}
{"op":"add","item":"Analog Delay","after":"reverb-1"}         after is an id; leave it out to add at the end of the pedals
{"op":"tempo","bpm":96}

Rules: use only ids, knob names and item names that appear below. Prefer the knob that matches the word: "volume" or "louder" is the Output's volume or the amp's master, "gain" is the amp's gain or a drive pedal's drive, "reverb" and "delay" are their mix. Do several operations when the request asks for several. Never invent ids.`;

export const gearList = () => items().map((i) => i.name).join(', ');

export function buildMessages(rig: Rig, request: string) {
  return [
    { role: 'system', content: `${SYSTEM}\n\nGear list (names for add and replace): ${gearList()}` },
    { role: 'user', content: `Rig:\n${describeRig(rig)}\n\nRequest: ${request.slice(0, 400)}` },
  ];
}

// The first JSON object in the reply, however the model wrapped it; only known operations survive.
export function parsePlan(text: string): Plan {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  let raw: any;
  try { raw = JSON.parse(text.slice(a, b + 1)); } catch { throw new Error('The assistant’s reply wasn’t understandable. Try rewording'); }
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 80) : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const ops: Op[] = [];
  for (const o of Array.isArray(raw?.ops) ? raw.ops.slice(0, MAX_OPS) : []) {
    const t = str(o?.target);
    switch (o?.op) {
      case 'set': { const v = typeof o.value === 'string' && num(o.value) === undefined ? str(o.value) : num(o.value); if (t && str(o.param) && v !== undefined) ops.push({ op: 'set', target: t, param: o.param, value: v }); break; }
      case 'nudge': { const by = num(o.by); if (t && str(o.param) && by !== undefined) ops.push({ op: 'nudge', target: t, param: o.param, by: Math.max(-1, Math.min(1, by)) }); break; }
      case 'toggle': if (t) ops.push({ op: 'toggle', target: t, on: typeof o.on === 'boolean' ? o.on : undefined }); break;
      case 'replace': if (t && str(o.with)) ops.push({ op: 'replace', target: t, with: o.with }); break;
      case 'remove': if (t) ops.push({ op: 'remove', target: t }); break;
      case 'add': if (str(o.item)) ops.push({ op: 'add', item: o.item, after: str(o.after) }); break;
      case 'tempo': { const bpm = num(o.bpm); if (bpm !== undefined) ops.push({ op: 'tempo', bpm }); break; }
    }
  }
  return { ops, say: str(raw?.say)?.slice(0, 160) ?? undefined, ask: str(raw?.ask)?.slice(0, 200) };
}

// ---- Applying ----
function findDevice(rig: Rig, ref: string): Device {
  if (rig.devices[ref]) return rig.devices[ref];
  const want = norm(ref);
  const all = Object.values(rig.devices).filter((d) => d.type !== 'power');
  const hits = all.filter((d) => norm(nameOf(d)) === want || d.type === want || norm(def(d.type).label) === want);
  const loose = hits.length ? hits : all.filter((d) => norm(nameOf(d)).includes(want) || (want.length > 2 && want.includes(norm(def(d.type).label))));
  if (loose.length === 1) return loose[0];
  if (!loose.length) throw new Error(`there's no "${ref}" in the rig`);
  throw new Error(`which "${ref}"? ${loose.map((d) => `${nameOf(d)} (${d.id})`).join(', ')}`);
}
function findItem(name: string): Item {
  const want = norm(name), all = items();
  const hit = all.find((i) => norm(i.name) === want) ?? all.find((i) => norm(i.name).includes(want) || want.includes(norm(i.name)))
    ?? all.find((i) => norm(CATALOG[i.type].label) === want);
  if (!hit) throw new Error(`I don't have "${name}" in the gear list`);
  return hit;
}
function findParam(d: Device, name: string): { p: Param; key: string } {
  const want = norm(name);
  const p = def(d.type).params.find((x) => norm(x.name) === want) ?? def(d.type).params.find((x) => norm(x.name).startsWith(want));
  if (!p) throw new Error(`${nameOf(d)} has no "${name}" knob`);
  return { p, key: knobName(d, p.name) };
}
const clamp = (p: Param, v: number) => { const c = Math.max(p.min, Math.min(p.max, v)); return p.options || p.step ? Math.round(c) : c; };

// Applies a plan to a rig. Every operation that checks out is applied; the rest are listed in `failed`.
export function applyPlan(start: Rig, plan: Plan): Result {
  let rig = start;
  const done: string[] = [], failed: string[] = [];
  for (const o of plan.ops) {
    try {
      switch (o.op) {
        case 'set': case 'nudge': {
          const d = findDevice(rig, o.target), { p, key } = findParam(d, o.param);
          let v: number;
          if (o.op === 'nudge') v = d.params[key] + o.by * (p.max - p.min);
          else if (typeof o.value === 'string') {
            const i = p.options?.findIndex((x) => norm(x) === norm(o.value as string)) ?? -1;
            if (i < 0) throw new Error(`${p.name} has no "${o.value}" (${p.options?.join(', ') ?? 'a number'})`);
            v = i;
          } else v = o.value;
          v = clamp(p, v);
          if (v === d.params[key]) { done.push(`${nameOf(d)} ${p.name} is already ${p.options ? p.options[v] : numeral(v)}`); break; }
          rig = setParam(rig, d.id, key, v);
          done.push(`${nameOf(d)} ${p.name} ${p.options ? p.options[v] : `${numeral(d.params[key])} → ${numeral(v)}`}`);
          break;
        }
        case 'toggle': {
          const d = findDevice(rig, o.target);
          if (!def(d.type).footswitch && d.type !== 'amp' && d.type !== 'namAmp' && d.type !== 'namRig') throw new Error(`${nameOf(d)} has no on/off`);
          if (o.on === undefined || o.on !== d.on) rig = toggle(rig, d.id);
          done.push(`${nameOf(d)} ${rig.devices[d.id].on ? 'on' : 'off'}`);
          break;
        }
        case 'replace': {
          const d = findDevice(rig, o.target), item = findItem(o.with);
          const [next] = replaceDevice(rig, d.id, item.type, itemParams(item));
          rig = next;
          done.push(`${nameOf(d)} → ${item.name}`);
          break;
        }
        case 'remove': {
          const d = findDevice(rig, o.target);
          if (['input', 'output'].includes(d.type)) throw new Error(`I won't remove the ${def(d.type).label}`);
          rig = removeAndBridge(rig, d.id);
          done.push(`removed ${nameOf(d)}`);
          break;
        }
        case 'add': {
          const item = findItem(o.item);
          const after = o.after ? findDevice(rig, o.after) : lastPedal(rig);
          if (!after) throw new Error('there is nothing to add it after');
          const [next, id] = insertAfter(rig, after.id, item.type, itemParams(item));
          rig = next;
          done.push(`added ${item.name} after ${nameOf(after)}${rig.devices[id].on ? '' : ' (off)'}`);
          break;
        }
        case 'tempo': rig = setTempo(rig, o.bpm); done.push(`tempo ${tempoOf(rig)} BPM`); break;
      }
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { rig, done, failed };
}

// "Add a delay" with no place given: after the last pedal before the amp, else after the input.
function lastPedal(rig: Rig): Device | undefined {
  const pos = layoutGrid(rig);
  const chain = Object.values(rig.devices).filter((d) => pos[d.id] && ADDABLE.includes(d.type) && d.type !== 'amp' && d.type !== 'cab' && !!def(d.type).footswitch)
    .sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
  return chain[chain.length - 1] ?? Object.values(rig.devices).find((d) => d.type === 'input');
}

// ---- Asking ----
export type Reply = { plan: Plan } | { error: string };
export async function ask(rig: Rig, request: string): Promise<Reply> {
  const r = await call<{ text: string } | { error: string }>('llmChat', { messages: buildMessages(rig, request) });
  if ('error' in r) return { error: r.error };
  try { return { plan: parsePlan(r.text) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
