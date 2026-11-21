// The canvas. Board view: a stage, a pedalboard and a desk, with every device snapped into place
// by layout.ts and drawn like real gear (gear.tsx). Grid view: Quad Cortex-style tiles in signal
// order, with a panel on the right. Gear comes from the list on the left: click it, drag it onto
// the rig, or drop it on a cable to put it in that cable. Double-click any device for a big view.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import {
  BaseEdge, Controls, getBezierPath, getSmoothStepPath, Handle, Position, ReactFlow, useReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { PanelLeftClose, PanelLeftOpen, Replace, Search, Trash2, X } from 'lucide-react';
import { ampKnob, def, isNam, itemParams, itemsOf, makerOf, variantOf, type DeviceType, type Item, type Jack, type JackKind } from './catalog';
import { CabStudio } from './CabStudio';
import { Captures, DND_FILE } from './Captures';
import { Picker } from './Picker';
import type { Entry } from './library';
import {
  AMP_SWITCHES, AmpChannel, CaptureSelect, colorOf, credit, deviceName, focusOnOpen, Gear, Knob, knobParams, LooperScreen, MicControls, ModelPlate, plateParams,
  readout, tapeName, Thumb, TunerScreen, useShot, type Edit, type Live,
} from './gear';
import { pedalboard } from './models';
import { spriteStyle, useSprite } from './render3d';
import { cones, dropHints, micPlacementAt, gearSize, isPedal, layoutBoard, layoutGrid, MIC_HEAD, TILE, type Layout, type Zone } from './layout';
import {
  addDevice, cableAt, canConnect, connect, disconnect, insertIntoCable, isPowered, moveDevice, placeMic, powerUp,
  removeDevice, replaceDevice, setFile, setParam, syncedKnob, toggle, type Device, type FileRef, type JackRef, type Rig, type XY,
} from './rig';

export type View = 'board' | 'grid';
export type Levels = { in: number; out: number; cpu: number; ram: number };
export type { Edit };
type Ctx = { rig: Rig; view: View; edit: Edit; inputs: string[]; live: Live; levels: Levels };
const RigCtx = createContext<Ctx & { dropCable?: string }>(null!);

export const GROUPS: [string, DeviceType[]][] = [
  ['Dynamics', ['tuner', 'gate', 'compressor']],
  ['Drive', ['boost', 'distortion', 'fuzz']],
  ['Pitch and body', ['octave', 'pitch', 'acoustic']],
  ['Filter', ['eq', 'wah', 'volume']],
  ['Modulation', ['chorus', 'flanger', 'phaser', 'tremolo']],
  ['Time', ['delay', 'reverb', 'looper']],
  ['Amp and cab', ['amp', 'cab', 'mic']],
  ['Neural captures', ['namAmp', 'namRig', 'namPedal']],
  ['Routing and power', ['splitter', 'joiner', 'power', 'input', 'output']],
];
const PEDAL_TYPES = GROUPS.slice(0, 6).flatMap(([, types]) => types);
const DND = 'application/x-rigsmith-gear';

// Cable look: an outer rubber jacket and a thin inner highlight, coloured by what the cable carries.
const CABLE: Record<JackKind | 'mic', { jacket: string; core: string; width: number }> = {
  audio: { jacket: '#0e0e10', core: '#5b5b62', width: 7 },
  power: { jacket: '#1a1210', core: '#a5532f', width: 5 },
  speaker: { jacket: '#151310', core: '#a08440', width: 9 },
  mic: { jacket: 'transparent', core: '#8a8a92', width: 2 },
};
const JACK: Record<JackKind, string> = { audio: '#9a9aa2', power: '#b8693f', speaker: '#b89a4f' };

const ref = (device: string | null, jack: string | null | undefined): JackRef => ({ device: device ?? '', jack: jack ?? '' });
const jackKind = (rig: Rig, r: JackRef) => def(rig.devices[r.device].type).jacks.find((j) => j.name === r.jack)!.kind;
const FIXED = new Set<DeviceType>(['input', 'output', 'power']); // their place on the board never changes
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const switchable = (d: Device) => !!def(d.type).footswitch || d.type === 'input';

// Pedals take signal in on the right and out on the left, like real ones. The grid flows left to right.
// On the board the amp's back panel (send, return, speaker) faces up, away from the player.
function side(j: Jack, view: View, type: DeviceType) {
  if (view === 'board' && type === 'amp' && j.name !== 'in') return Position.Top;
  if (view === 'board' && type === 'mic') return Position.Bottom;
  if (j.kind === 'power') return Position.Top;
  if (j.kind === 'speaker' && view === 'board') return j.dir === 'in' ? Position.Top : Position.Bottom;
  return (j.dir === 'in') === (view === 'board') ? Position.Right : Position.Left;
}

// Devices in signal order: the grid's rows top to bottom, each left to right.
function signalOrder(rig: Rig) {
  const pos = layoutGrid(rig);
  return Object.values(rig.devices).filter((d) => pos[d.id]).sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
}

function toNodes(rig: Rig, view: View, prev: Node[], layout: Layout | null): Node[] {
  const old = new Map(prev.map((n) => [n.id, n]));
  if (view === 'grid') {
    const pos = layoutGrid(rig);
    return Object.values(rig.devices).filter((d) => pos[d.id]).map((d) => ({
      ...old.get(d.id), id: d.id, type: 'tile', data: {}, position: pos[d.id], draggable: false,
    }));
  }
  const zones: Node[] = (layout?.zones ?? []).map((z) => ({
    id: z.id, type: 'zone', position: { x: z.x, y: z.y }, data: z, zIndex: -1,
    draggable: false, selectable: false, deletable: false, focusable: false, connectable: false,
  }));
  const devices: Node[] = Object.values(rig.devices).map((d) => ({
    ...old.get(d.id), id: d.id, type: 'device', data: {},
    position: layout ? layout.pos[d.id] : d.pos[view],
    draggable: !(layout && FIXED.has(d.type)),
    // A head sits on its cab and a mic stands in front of it: draw them in that order.
    zIndex: d.type === 'mic' ? 2 : d.type === 'amp' || d.type === 'namAmp' || d.type === 'namRig' ? 1 : 0,
  }));
  return [...zones, ...devices];
}

function toEdges(rig: Rig, prev: Edge[], view: View): Edge[] {
  const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
  const shown = view === 'grid' ? rig.cables.filter((c) => jackKind(rig, c.from) !== 'power') : rig.cables;
  const cables: Edge[] = shown.map((c) => ({
    id: c.id, type: 'cable', source: c.from.device, sourceHandle: c.from.jack, target: c.to.device, targetHandle: c.to.jack,
    data: { kind: jackKind(rig, c.from) }, selected: selected.has(c.id),
  }));
  // On the board a mic stands on its cab's face, so the link only shows in the grid.
  const mics: Edge[] = view === 'board' ? [] : Object.values(rig.devices).flatMap((d) => d.mic ? [{
    id: `mic:${d.id}`, type: 'cable', source: d.mic.cab, sourceHandle: 'mic', target: d.id, targetHandle: 'mic',
    data: { kind: 'mic' }, selectable: false, deletable: false,
  }] : []);
  return [...cables, ...mics];
}

function CableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps) {
  const { view, dropCable } = useContext(RigCtx);
  const kind = (data?.kind ?? 'audio') as keyof typeof CABLE;
  const look = CABLE[kind];
  const hot = selected || dropCable === id;
  let path: string;
  if (view === 'board' && kind !== 'mic') {
    // Cables droop under their own weight: the longer the run, the deeper the sag.
    const sag = Math.min(120, Math.hypot(targetX - sourceX, targetY - sourceY) * 0.22);
    const low = Math.max(sourceY, targetY) + sag;
    const dx = targetX - sourceX;
    path = `M ${sourceX} ${sourceY} C ${sourceX + dx / 5} ${low}, ${targetX - dx / 5} ${low}, ${targetX} ${targetY}`;
  } else if (view === 'grid') {
    [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10, offset: 16 });
  } else {
    [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }
  if (view === 'grid') {
    return <BaseEdge id={id} path={path} interactionWidth={20} style={{
      stroke: hot ? 'var(--accent)' : kind === 'speaker' ? '#a08440' : '#6b6b73', strokeWidth: hot ? 3 : 2,
      strokeDasharray: kind === 'mic' ? '4 4' : undefined,
    }} />;
  }
  // Each end is a plug pushed into its jack, pointing along the cable.
  const ends = view === 'board' && kind !== 'mic' ? [
    [sourceX, sourceY, Math.atan2(Math.max(sourceY, targetY) + 40 - sourceY, (targetX - sourceX) / 5)],
    [targetX, targetY, Math.atan2(Math.max(sourceY, targetY) + 40 - targetY, -(targetX - sourceX) / 5)],
  ] : [];
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={22}
        style={{ stroke: look.jacket, strokeWidth: look.width, strokeLinecap: 'round', filter: 'drop-shadow(0 6px 4px rgba(0,0,0,.55))' }} />
      <path d={path} fill="none" pointerEvents="none" strokeLinecap="round" className="cable-sheen"
        style={{ strokeWidth: Math.max(1.5, look.width / 4), transform: `translate(0, ${-look.width / 4}px)` }} />
      <path d={path} fill="none" pointerEvents="none" strokeLinecap="round" className={hot ? 'cable-core selected' : 'cable-core'}
        style={{ stroke: hot ? 'var(--accent)' : look.core, strokeWidth: hot ? 3 : 1, strokeDasharray: kind === 'mic' ? '3 5' : undefined, opacity: hot ? 1 : 0.5 }} />
      {ends.map(([x, y, a], i) => (
        <g key={i} transform={`translate(${x} ${y}) rotate(${(a * 180) / Math.PI})`} pointerEvents="none" className="plug">
          <rect x={4} y={-look.width / 2 - 2} width={18} height={look.width + 4} rx={2} fill="url(#plug-metal)" />
          <rect x={20} y={-look.width / 2 - 1} width={14} height={look.width + 2} rx={3} fill="#121213" />
          <rect x={2} y={-look.width / 2 - 3} width={4} height={look.width + 6} rx={1} fill="#d9dadd" />
        </g>
      ))}
    </>
  );
}

function ZoneNode({ data }: NodeProps) {
  const z = data as Zone;
  const name = { stage: 'Stage', board: 'Rigsmith Touring 32', desk: 'Desk' }[z.kind];
  const board = useSprite(z.kind === 'board' ? `board:${z.w}x${z.h}` : null, () => pedalboard(z.w, z.h));
  return (
    <div className={`zone zone-${z.kind}${board ? ' shelled' : ''}`} style={{ width: z.w, height: z.h }}>
      {board && <img className="shell" src={board.url} alt="" draggable={false} style={spriteStyle(board)} />}
      <span className="zone-name">{name}</span>
    </div>
  );
}

// Jack handles for a device, placed along each side.
function Jacks({ d, view }: { d: Device; view: View }) {
  const bySide = new Map<Position, Jack[]>();
  for (const j of def(d.type).jacks) {
    if (view === 'grid' && j.kind === 'power') continue; // power is handled for you in the grid
    bySide.set(side(j, view, d.type), [...(bySide.get(side(j, view, d.type)) ?? []), j]);
  }
  return (
    <>
      {[...bySide].flatMap(([pos, jacks]) => jacks.map((j, i) => {
        const along = `${((i + 1) / (jacks.length + 1)) * 100}%`;
        return (
          <Handle key={j.name} id={j.name} type={j.dir === 'out' ? 'source' : 'target'} position={pos}
            style={{ ...({ '--ring': JACK[j.kind] } as CSSProperties), ...(pos === Position.Top || pos === Position.Bottom ? { left: along } : { top: along }) }}
            title={`${j.name}: ${j.kind} ${j.dir === 'in' ? 'input' : 'output'}`}>
            {j.name !== 'in' && j.name !== 'out' ? <span>{j.name}</span> : null}
          </Handle>
        );
      }))}
      {d.type === 'cab' && <Handle id="mic" type="source" position={view === 'grid' ? Position.Right : Position.Bottom} isConnectable={false} className="hidden-handle" />}
      {d.type === 'mic' && <Handle id="mic" type="target" position={view === 'grid' ? Position.Left : Position.Top} isConnectable={false} className="hidden-handle" />}
    </>
  );
}

function DeviceNode({ id, selected }: NodeProps) {
  const ctx = useContext(RigCtx);
  const d = ctx.rig.devices[id];
  if (!d) return null;
  return (
    <div className={`device board${selected ? ' selected' : ''}`} style={{ width: gearSize(d).w, height: gearSize(d).h }}>
      <Jacks d={d} view="board" />
      <Gear d={d} rig={ctx.rig} edit={ctx.edit} inputs={ctx.inputs} live={ctx.live} />
    </div>
  );
}

// A tile's second line: what this device is set to, never just its name again.
function tileDetail(rig: Rig, d: Device, inputs: string[]) {
  const pick = (name: string) => def(d.type).params.find((p) => p.name === name)!.options![d.params[name]];
  switch (d.type) {
    case 'amp': return `${pick('model')} · gain ${d.params.gain.toFixed(1)}`;
    case 'cab': return `${pick('size')} · ${pick('speaker')}`;
    case 'mic': return d.mic ? `${pick('model')} on ${tapeName(rig, rig.devices[d.mic.cab])}` : pick('model');
    case 'input': return d.on ? inputs[d.params.channel] ?? `input ${d.params.channel + 1}` : 'muted';
    case 'output': return `volume ${Math.round(d.params.volume * 100)}%`;
    case 'tuner': return d.on ? 'muting while tuning' : 'bypassed';
    case 'splitter': return 'A and B';
    case 'joiner': return 'A + B';
    case 'power': return '9V · 8 outlets';
    case 'namAmp': case 'namRig': case 'namPedal': return d.files?.model?.name ?? 'no capture chosen';
    default: {
      if (!d.on) return 'bypassed';
      const shown = knobParams(d.type).filter((p) => !p.options && !p.name.endsWith('Hz')).slice(0, 2);
      return shown.map((p) => `${p.name} ${readout(p, d.params[p.name])}`).join(' · ') || 'on';
    }
  }
}

function TileShot({ d }: { d: Device }) {
  const shot = useShot(d.type, d.params);
  return <div className="tile-shot">{shot && <img src={shot.url} alt="" draggable={false} />}</div>;
}

// Grid tile: colour bar, name, setting, and a light that's lit when the device is on and powered.
function Tile({ id, selected }: NodeProps) {
  const { rig, inputs } = useContext(RigCtx);
  const d = rig.devices[id];
  if (!d) return null;
  const powered = isPowered(rig, id);
  const lit = powered && d.on;
  return (
    <div className={`tile${lit ? '' : ' dim'}${selected ? ' selected' : ''}`} style={{ width: TILE.w, height: TILE.h, '--swatch': colorOf(d.type, d.params) } as CSSProperties}>
      <Jacks d={d} view="grid" />
      <span className={`tile-led${lit ? ' lit' : ''}`} />
      <TileShot d={d} />
      <span className="tile-name">{tapeName(rig, d)}</span>
      <span className="tile-model">{tileDetail(rig, d, inputs)}</span>
      {!powered && <span className="tile-badge">no power</span>}
      {d.type === 'amp' && !cableAt(rig, { device: id, jack: 'speaker' }) && <span className="tile-badge">no cab</span>}
      {d.type === 'mic' && !d.mic && <span className="tile-badge">not on a cab</span>}
    </div>
  );
}

// A knob of the device, set by name, with an optional label.
function ParamKnob({ d, name, label }: { d: Device; name: string; label?: string }) {
  const { edit } = useContext(RigCtx);
  const p = def(d.type).params.find((x) => x.name === name)!;
  return <Knob p={{ ...p, name: label ?? name }} look="big" value={d.params[name]} onChange={(v, g) => edit((r) => setParam(r, d.id, name, v), g)} />;
}

// The controls of one device, large: used by the grid panel and the device window.
function DeviceControls({ d }: { d: Device }) {
  const { rig, edit, inputs, live } = useContext(RigCtx);
  const dd = def(d.type);
  const powered = isPowered(rig, d.id);
  const cabs = Object.values(rig.devices).filter((x) => x.type === 'cab');
  const props = { d, rig, edit, inputs, live };
  const amp = d.type === 'amp';
  const generic = knobParams(d.type).filter((p) => !(d.type === 'input' && p.name === 'channel') && !(amp) && !syncedKnob(d, p.name));
  return (
    <>
      {plateParams(d.type).map((p) => (
        <label key={p.name} className="field"><span>{p.name}</span><ModelPlate d={d} edit={edit} name={p.name} /></label>
      ))}
      {isNam(d.type) && (
        <label className="field"><span>capture</span><CaptureSelect d={d} edit={edit} slot="model" kind="nam" label="Capture" />
          {d.files?.model && <span className="credit">{credit(d.files.model) || 'Your file'}</span>}
          {live[d.id]?.missing && <span className="inline-error">The capture file isn't on this Mac</span>}
          {live[d.id]?.wrongRate && <span className="inline-error">This capture was made at 48 kHz: set your interface to 48 kHz</span>}
        </label>
      )}
      {d.type === 'input' && (
        <label className="field"><span>interface input</span>
          <select value={d.params.channel} onChange={(e) => edit((r) => setParam(r, d.id, 'channel', Number(e.target.value)))}>
            {(inputs.length ? inputs : ['Input 1']).map((o, i) => <option key={o} value={i}>{o}</option>)}
          </select>
        </label>
      )}
      {d.type === 'mic' && (
        <label className="field"><span>on cab</span>
          <select value={d.mic?.cab ?? ''} onChange={(e) => edit((r) => placeMic(r, d.id, e.target.value
            ? { cab: e.target.value, x: d.mic?.x ?? 0.5, y: 0.75, distance: d.mic?.distance ?? 0.2 } : undefined))}>
            <option value="">none</option>
            {cabs.map((c) => <option key={c.id} value={c.id}>{tapeName(rig, c)}</option>)}
          </select>
        </label>
      )}
      {amp && (
        <>
          <div className="control-group"><h4>Channel</h4><div className="row"><AmpChannel d={d} edit={edit} /></div></div>
          <div className="control-group"><h4>Front panel</h4>
            <div className="inspector-knobs">
              {['gain', 'bass', 'mid', 'treble', 'presence', 'master'].map((n) => <ParamKnob key={n} d={d} name={ampKnob(n, d.params.channel)} label={n} />)}
            </div>
            <div className="row switches">
              {AMP_SWITCHES.map((n) => (
                <button key={n} className={`mini-toggle${d.params[n] ? ' up' : ''}`} aria-pressed={!!d.params[n]} onClick={() => edit((r) => setParam(r, d.id, n, d.params[n] ? 0 : 1))}><i />{n}</button>
              ))}
            </div>
          </div>
          <div className="control-group"><h4>Power amp</h4>
            <label className="field"><span>power tubes</span>
              <select value={d.params.tube} onChange={(e) => edit((r) => setParam(r, d.id, 'tube', Number(e.target.value)))}>
                {dd.params.find((p) => p.name === 'tube')!.options!.map((o, i) => <option key={o} value={i}>{i ? o : 'stock for this model'}</option>)}
              </select>
            </label>
            <div className="inspector-knobs">{['bias', 'sag', 'voltage'].map((n) => <ParamKnob key={n} d={d} name={n} />)}</div>
            <p className="hint">Cold bias: raspy, sputtery. Hot: fatter, squashed. Lower voltage breaks up sooner and quieter.</p>
          </div>
        </>
      )}
      {(generic.length > 0 || d.type === 'mic') && (
        <div className="inspector-knobs">
          {generic.map((p) => p.options && p.name !== 'stages'
            ? <Knob key={p.name} p={p} look="big" value={d.params[p.name]} onChange={(v) => edit((r) => setParam(r, d.id, p.name, v))} />
            : <ParamKnob key={p.name} d={d} name={p.name} />)}
          {d.type === 'mic' && <MicControls d={d} edit={edit} look="big" />}
        </div>
      )}
      {d.type === 'tuner' && <TunerScreen {...props} />}
      {d.type === 'looper' && <LooperScreen {...props} />}
      {switchable(d) && d.type !== 'looper' && (
        <button className="bypass" aria-pressed={d.on} onClick={() => edit((r) => toggle(r, d.id))}>
          <span className={`led${(d.type === 'input' ? !d.on : d.on && powered) ? ' lit' : ''}`} />
          {d.type === 'input' ? (d.on ? 'Mute input' : 'Muted') : d.on ? 'On' : 'Bypassed'}<kbd>B</kbd>
        </button>
      )}
      {dd.power && !powered && (
        <div className="notice">No power. <button onClick={() => edit((r) => powerUp(r, d.id))}>Plug into power <kbd>P</kbd></button></div>
      )}
      {(amp || d.type === 'namAmp') && !cableAt(rig, { device: d.id, jack: 'speaker' }) && <div className="notice">No load: cable a cab to the speaker jack</div>}
    </>
  );
}

// What a device can be swapped for: any pedal for a pedal, any amp for an amp, any cab for a cab.
function replacements(d: Device): Item[] {
  if (d.type === 'amp' || d.type === 'cab') return itemsOf(d.type);
  if (d.type === 'namPedal') return [...PEDAL_TYPES, 'namPedal' as DeviceType].flatMap(itemsOf);
  return PEDAL_TYPES.includes(d.type) ? [...PEDAL_TYPES, 'namPedal' as DeviceType].flatMap(itemsOf) : [];
}
const sameItem = (d: Device, i: Item) => i.type === d.type && (i.variant === undefined || i.variant === variantOf(d.type, d.params));

function Head({ d, onClose }: { d: Device; onClose: () => void }) {
  const { rig } = useContext(RigCtx);
  return (
    <header className="inspector-head">
      <span className="swatch" style={{ background: colorOf(d.type, d.params) }} />
      <div className="inspector-title">
        <h2>{tapeName(rig, d)}</h2>
        <span>{makerOf(d.type, d.params)} · {def(d.type).label}</span>
      </div>
      <button className="icon" aria-label="Close" title="Close (Esc)" onClick={onClose}><X size={16} strokeWidth={1.5} /></button>
    </header>
  );
}

// What a device can be swapped for, searchable and grouped like the gear list. Cables and the pedalboard
// it sits on are kept (rig.ts replaceDevice).
function ReplaceSelect({ d, onReplaced }: { d: Device; onReplaced: (id: string) => void }) {
  const { edit } = useContext(RigCtx);
  const options = replacements(d);
  if (!options.length) return null;
  const group = (t: DeviceType) => GROUPS.find(([, types]) => types.includes(t))?.[0] ?? 'Other';
  const key = (i: Item) => `${i.type}:${i.variant ?? ''}`;
  const current = options.find((i) => sameItem(d, i));
  return (
    <label className="field"><span><Replace size={14} strokeWidth={1.5} /> replace with</span>
      <Picker label="Replace with" value={current && key(current)} placeholder={deviceName(d)}
        options={options.map((i) => ({ value: key(i), label: i.name, group: group(i.type), hint: makerOf(i.type, itemParams(i)) }))}
        onChange={(v) => {
          const item = options.find((i) => key(i) === v);
          if (!item || (current && key(current) === v)) return;
          let next = d.id;
          edit((r) => {
            const [rig, nid] = replaceDevice(r, d.id, item.type, itemParams(item));
            next = nid;
            return rig;
          });
          onReplaced(next);
        }} />
    </label>
  );
}

// Double-click: the device, big, with every control, plus Replace and Delete.
function DeviceWindow({ id, onClose, onReplaced }: { id: string; onClose: () => void; onReplaced: (id: string) => void }) {
  const ctx = useContext(RigCtx);
  const d = ctx.rig.devices[id];
  if (!d) return null;
  const size = gearSize(d);
  const k = Math.min(1.9, 540 / size.w, 600 / size.h); // fill the preview, leaving room for the rendered sides
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" tabIndex={-1} ref={focusOnOpen} aria-label={tapeName(ctx.rig, d)}>
        <Head d={d} onClose={onClose} />
        <div className="modal-body">
          {d.type === 'cab' ? <CabStudio d={d} rig={ctx.rig} edit={ctx.edit} /> : (
            <div className="modal-stage">
              <div style={{ width: size.w * k, height: size.h * k }}>
                <div className="device board" style={{ width: size.w, height: size.h, transform: `scale(${k})`, transformOrigin: '0 0' }}>
                  <Gear d={d} rig={ctx.rig} edit={ctx.edit} inputs={ctx.inputs} live={ctx.live} />
                </div>
              </div>
            </div>
          )}
          <div className="modal-side">
            {d.type !== 'cab' && <DeviceControls d={d} />}
            <ReplaceSelect d={d} onReplaced={onReplaced} />
            <button className="remove" onClick={() => { ctx.edit((r) => removeDevice(r, id)); onClose(); }}>
              <Trash2 size={16} strokeWidth={1.5} />Delete <kbd>⌫</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  const level = Math.max(0, Math.min(1, (20 * Math.log10(value || 1e-6) + 60) / 60));
  return (
    <div className="ov-meter">
      <span>{label}</span>
      <div className="meter" role="meter" aria-label={`${label} level`} aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ transform: `scaleX(${level})` }} className={value >= 0.99 ? 'hot' : ''} />
      </div>
    </div>
  );
}

// Grid panel with nothing selected: the whole rig at a glance, in signal order.
function Overview({ onPick }: { onPick: (id: string) => void }) {
  const { rig, edit, inputs, levels } = useContext(RigCtx);
  const pos = layoutGrid(rig);
  const rows = signalOrder(rig).filter((d) => d.type !== 'power');
  const unpowered = rows.filter((d) => !isPowered(rig, d.id));
  const noCab = rows.filter((d) => d.type === 'amp' && !cableAt(rig, { device: d.id, jack: 'speaker' }));
  const loose = rows.filter((d) => d.type === 'mic' && !d.mic);
  return (
    <aside className="inspector overview" aria-label="Rig overview">
      <header className="inspector-head"><div className="inspector-title"><h2>Rig overview</h2><span>{rows.length} blocks · click one to edit</span></div></header>
      <div className="ov-levels">
        <Meter label="In" value={levels.in} />
        <Meter label="Out" value={levels.out} />
        <span className="readout">CPU {Math.round(levels.cpu * 100)}% · RAM {Math.round(levels.ram)} MB</span>
      </div>
      {unpowered.length > 0 && (
        <div className="notice">{unpowered.length} {unpowered.length === 1 ? 'pedal has' : 'pedals have'} no power
          <button onClick={() => edit((r) => unpowered.reduce((acc, d) => powerUp(acc, d.id), r))}>Power all</button></div>
      )}
      {noCab.map((d) => <div key={d.id} className="notice">{tapeName(rig, d)} has no cab</div>)}
      {loose.map((d) => <div key={d.id} className="notice">{tapeName(rig, d)} is not on a cab</div>)}
      <ol className="path">
        {rows.map((d, i) => (
          <li key={d.id} className={i > 0 && pos[d.id].y !== pos[rows[i - 1].id].y ? 'new-row' : ''}>
            <button className="path-row" onClick={() => onPick(d.id)}>
              <span className="swatch" style={{ background: colorOf(d.type, d.params) }} />
              <span className="path-name">{tapeName(rig, d)}</span>
              <span className="path-detail">{tileDetail(rig, d, inputs)}</span>
            </button>
            {switchable(d) && (
              <button className={`path-switch${d.on ? ' on' : ''}`} aria-pressed={d.on} aria-label={`${tapeName(rig, d)} ${d.type === 'input' ? 'unmuted' : 'on'}`}
                onClick={() => edit((r) => toggle(r, d.id))}>{d.type === 'input' ? (d.on ? 'live' : 'muted') : d.on ? 'on' : 'off'}</button>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}

// The selected tile's controls, on the right of the grid.
function Inspector({ d, onClose }: { d: Device; onClose: () => void }) {
  const { rig, edit } = useContext(RigCtx);
  return (
    <aside className="inspector" aria-label={`${tapeName(rig, d)} controls`}>
      <Head d={d} onClose={onClose} />
      <DeviceControls d={d} />
      <button className="remove" onClick={() => { edit((r) => removeDevice(r, d.id)); onClose(); }}><Trash2 size={16} strokeWidth={1.5} />Remove</button>
    </aside>
  );
}

// The gear list: every piece drawn small, grouped like a shop wall. Click to add, or drag it in.
function Locker({ collapsed, onCollapse, onAdd, onSettings }: { collapsed: boolean; onCollapse: (c: boolean) => void; onAdd: (item: Item) => void; onSettings: () => void }) {
  const [tab, setTab] = useState<'gear' | 'captures'>('gear');
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  if (collapsed) {
    return (
      <nav className="locker collapsed" aria-label="Gear">
        <button className="icon" title="Show gear (\)" aria-label="Show gear" onClick={() => onCollapse(false)}><PanelLeftOpen size={16} strokeWidth={1.5} /></button>
      </nav>
    );
  }
  return (
    <nav className="locker" aria-label="Gear">
      <header className="locker-head">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === 'gear'} aria-pressed={tab === 'gear'} onClick={() => setTab('gear')}>Gear</button>
          <button role="tab" aria-selected={tab === 'captures'} aria-pressed={tab === 'captures'} onClick={() => setTab('captures')}>Captures</button>
        </div>
        <button className="icon" title="Hide (\)" aria-label="Hide the gear list" onClick={() => onCollapse(true)}><PanelLeftClose size={16} strokeWidth={1.5} /></button>
      </header>
      {tab === 'captures' ? <Captures onSettings={onSettings} /> : (
        <>
          <label className="search locker-search"><Search size={14} strokeWidth={1.5} aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search gear" aria-label="Search gear" /></label>
          <span className="locker-hint">Click to add, or drag onto the rig or a cable</span>
        </>
      )}
      {tab === 'gear' && GROUPS.map(([group, types]) => [group, types.flatMap(itemsOf).filter((i) => !q || `${i.name} ${group} ${makerOf(i.type, itemParams(i))}`.toLowerCase().includes(q))] as const)
        .filter(([, items]) => items.length).map(([group, items]) => (
        <section key={group}>
          <h3>{group}</h3>
          <div className="locker-grid">
            {items.map((item) => (
              <button key={`${item.type}:${item.variant}`} className="locker-item" draggable title={`${makerOf(item.type, itemParams(item))} ${item.name}`}
                onDragStart={(e) => { e.dataTransfer.setData(DND, JSON.stringify(item)); e.dataTransfer.effectAllowed = 'copy'; }}
                onClick={() => onAdd(item)}>
                <Thumb item={item} />
                <span className="locker-name">{item.name}</span>
                {(item.type === 'amp' || item.type === 'cab') && <span className="locker-maker">{makerOf(item.type, itemParams(item))}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
      {tab === 'gear' && q && !GROUPS.some(([g, types]) => types.flatMap(itemsOf).some((i) => `${i.name} ${g} ${makerOf(i.type, itemParams(i))}`.toLowerCase().includes(q))) && <p className="hint locker-none">No gear matches.</p>}
    </nav>
  );
}

const nodeTypes = { device: DeviceNode, zone: ZoneNode, tile: Tile };
const edgeTypes = { cable: CableEdge };

// Where new gear lands on the board: pedals at the end of the chain, stage gear at the end of the stage.
function boardHint(rig: Rig, type: DeviceType): XY {
  const all = Object.values(rig.devices);
  if (isPedal({ type } as Parameters<typeof isPedal>[0])) {
    const pedals = all.filter(isPedal);
    const lastRow = Math.max(0, ...pedals.map((p) => p.pos.board.y));
    return { x: Math.min(0, ...pedals.map((p) => p.pos.board.x)) - 400, y: lastRow };
  }
  return { x: Math.max(0, ...all.map((d) => d.pos.board.x)) + 4000, y: 0 };
}

const typing = (e: KeyboardEvent) => e.target instanceof Element && e.target.closest('input, select, textarea');

export function Board({ rig, view, edit, flash, inputs, live, levels, onSettings }: Ctx & { flash: (msg: string) => void; onSettings: () => void }) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selected, setSelected] = useState<string>();
  const [opened, setOpened] = useState<string>();
  const [dropCable, setDropCable] = useState<string>();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('locker') === 'closed'; } catch { return false; } });
  const layout = useMemo(() => (view === 'board' ? layoutBoard(rig) : null), [rig, view]);
  useEffect(() => setNodes((prev) => toNodes(rig, view, prev, layout)), [rig, view, layout]);
  useEffect(() => setEdges((prev) => toEdges(rig, prev, view)), [rig, view]);
  useEffect(() => { try { localStorage.setItem('locker', collapsed ? 'closed' : 'open'); } catch { /* private window */ } }, [collapsed]);
  const inspected = view === 'grid' && selected ? rig.devices[selected] : undefined;

  // Refit when the view, the panels or the amount of gear changes.
  const count = Object.keys(rig.devices).length;
  useEffect(() => {
    const t = setTimeout(() => flow.fitView({ padding: 0.06, duration: 250 }), 80);
    return () => clearTimeout(t);
  }, [view, count, collapsed]);

  // Adds gear. Dropped on the board it takes that slot; dropped on a cable it goes into the cable.
  const add = (item: Item, at?: XY, cable?: string, file?: FileRef) => {
    let added = '';
    edit((r) => {
      let [next, id] = addDevice(r, item.type, boardHint(r, item.type));
      added = id;
      for (const [k, v] of Object.entries(itemParams(item))) next = setParam(next, id, k, v);
      if (file) next = setFile(next, id, 'model', file);
      if (at && view === 'board' && isPedal(next.devices[id])) {
        const hints = dropHints(next, layoutBoard(next), id, { x: at.x - gearSize(next.devices[id]).w / 2, y: at.y });
        for (const [hid, hint] of Object.entries(hints)) next = moveDevice(next, hid, 'board', hint);
      }
      if (cable) {
        try { next = insertIntoCable(next, cable, id); } catch (e) { flash(`${message(e)}; added it unplugged`); }
      }
      return next;
    });
    if (!added) return;
    setSelected(added);
    if (def(item.type).power) flash(`${item.name} added. Press P to plug it into power`);
  };

  const cableAtPoint = (x: number, y: number) => {
    for (const el of document.elementsFromPoint(x, y)) {
      const id = el.closest('.react-flow__edge')?.getAttribute('data-id');
      const c = id && rig.cables.find((k) => k.id === id);
      if (c && jackKind(rig, c.from) !== 'power') return c.id;
    }
  };
  // A capture dropped on the rig becomes a NAM amp, full rig or pedal (by what TONE3000 or the file
  // says it is); an IR dropped on a cab loads into its first free slot and switches it to IRs.
  const dropFile = (entry: Entry, at: XY, cable?: string, x?: number, y?: number) => {
    const ref: FileRef = { id: entry.id, name: entry.name, kind: entry.kind, source: entry.source, author: entry.author, authorUrl: entry.authorUrl,
      license: entry.license, toneId: entry.toneId, modelId: entry.modelId, toneUrl: entry.toneUrl, gear: entry.gear };
    if (entry.kind === 'ir') {
      const hit = x !== undefined && y !== undefined
        ? document.elementsFromPoint(x, y).map((el) => el.closest('.react-flow__node')?.getAttribute('data-id')).find((id) => id && rig.devices[id]?.type === 'cab')
        : undefined;
      const cab = hit ?? Object.values(rig.devices).find((d) => d.type === 'cab')?.id;
      if (!cab) { flash('Drop an IR onto a cab'); return; }
      const slot = !rig.devices[cab].files?.irA || rig.devices[cab].params.source !== 1 ? 'irA' : 'irB';
      edit((r) => setParam(setFile(r, cab, slot, ref), cab, 'source', 1));
      flash(`${entry.name} loaded into ${tapeName(rig, rig.devices[cab])}, slot ${slot === 'irA' ? 'A' : 'B'}`);
      return;
    }
    const type: DeviceType = entry.gear === 'amp' ? 'namAmp' : entry.gear === 'amp-cab' || entry.gear === 'full-rig' ? 'namRig' : 'namPedal';
    add({ type, name: entry.name }, at, cable, ref);
  };

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DND_FILE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropCable(cableAtPoint(e.clientX, e.clientY)); return; }
    if (!e.dataTransfer.types.includes(DND)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropCable(cableAtPoint(e.clientX, e.clientY));
  };
  const onDrop = (e: DragEvent) => {
    const file = e.dataTransfer.getData(DND_FILE);
    if (file) {
      e.preventDefault();
      setDropCable(undefined);
      dropFile(JSON.parse(file) as Entry, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), cableAtPoint(e.clientX, e.clientY), e.clientX, e.clientY);
      return;
    }
    const raw = e.dataTransfer.getData(DND);
    setDropCable(undefined);
    if (!raw) return;
    e.preventDefault();
    add(JSON.parse(raw) as Item, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), cableAtPoint(e.clientX, e.clientY));
  };

  // Keys that act on the selection or the board. App.tsx handles the global ones.
  const keys = useRef<(e: KeyboardEvent) => void>(undefined);
  keys.current = (e: KeyboardEvent) => {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const d = selected ? rig.devices[selected] : undefined;
    if (e.key === 'Escape') { if (opened) setOpened(undefined); else setSelected(undefined); return; }
    if (e.key === '\\') { setCollapsed((c) => !c); return; }
    if (e.key === 'Enter' && d) { setOpened(d.id); return; }
    if (e.key.toLowerCase() === 'b' && d && switchable(d)) { edit((r) => toggle(r, d.id)); return; }
    if (e.key.toLowerCase() === 'p' && d) {
      if (!def(d.type).power) flash(`${deviceName(d)} needs no power`);
      else edit((r) => powerUp(r, d.id));
      return;
    }
    // 1-9: stomp the nth pedal in signal order, like a footswitch controller.
    if (/^[1-9]$/.test(e.key)) {
      const pedal = signalOrder(rig).filter((x) => def(x.type).footswitch && x.type !== 'looper')[Number(e.key) - 1];
      if (pedal) edit((r) => toggle(r, pedal.id));
    }
  };
  useEffect(() => {
    const fn = (e: KeyboardEvent) => keys.current?.(e);
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, []);

  const onConnectEnd: OnConnectEnd = (_, state) => {
    if (state.isValid !== false || !state.toHandle) return;
    const why = canConnect(rig, ref(state.fromHandle.nodeId, state.fromHandle.id), ref(state.toHandle.nodeId, state.toHandle.id));
    if (why) flash(why);
  };

  const onDragStop = (node: Node, dragged: Node[]) => {
    edit((r) => {
      const d = r.devices[node.id];
      if (!d) return r;
      if (d.type === 'mic') {
        // A mic dropped on a cab points at the nearest cone: how far from its centre sets the position
        // (centre = bright, edge = dark), the side it's on is kept. Dropped anywhere else, it comes loose.
        const head = { x: node.position.x + MIC_HEAD.x, y: node.position.y + MIC_HEAD.y };
        const cab = flow.getIntersectingNodes(node).map((n) => r.devices[n.id]).find((x) => x?.type === 'cab');
        if (!cab) return placeMic(r, d.id, undefined);
        let at = { x: d.mic?.x ?? 0.3, y: d.mic?.y ?? 0.75 };
        if (view === 'board' && layout) {
          const origin = layout.pos[cab.id];
          const c = cones(cab.params.size).reduce((best, k) =>
            Math.hypot(origin.x + k.x - head.x, origin.y + k.y - head.y) < Math.hypot(origin.x + best.x - head.x, origin.y + best.y - head.y) ? k : best);
          at = micPlacementAt(head.x - (origin.x + c.x), head.y - (origin.y + c.y), c.r * 0.85);
        }
        r = placeMic(r, d.id, { cab: cab.id, ...at, distance: d.mic?.distance ?? 0.2 });
        return view === 'grid' ? moveDevice(r, d.id, 'grid', node.position) : r;
      }
      if (view === 'grid') {
        for (const n of dragged) if (r.devices[n.id]) r = moveDevice(r, n.id, 'grid', n.position);
        return r;
      }
      for (const [id, hint] of Object.entries(dropHints(r, layout!, d.id, node.position))) r = moveDevice(r, id, 'board', hint);
      return r;
    });
    // On the board everything snaps back into its slot, even when the order didn't change.
    if (view === 'board') setNodes((ns) => toNodes(rig, view, ns, layout));
  };

  return (
    <RigCtx.Provider value={{ rig, view, edit, inputs, live, levels, dropCable }}>
      <div className={`workspace${collapsed ? ' locker-closed' : ''}${view === 'grid' ? ' with-panel' : ''}`}>
        <Locker collapsed={collapsed} onCollapse={setCollapsed} onAdd={(item) => add(item)} onSettings={onSettings} />
        <div ref={wrapper} className={`canvas canvas-${view}${dropCable ? ' dropping' : ''}`} onDragOver={onDragOver} onDrop={onDrop}
          onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as globalThis.Node) && setDropCable(undefined)}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView minZoom={0.15} maxZoom={2}
            proOptions={{ hideAttribution: true }} zoomOnDoubleClick={false}
            onNodesChange={(changes) => {
              for (const c of changes.getByType('remove')) changes.remove(c); // deletes go through onDelete
              setNodes((ns) => changes.applyTo(ns));
            }}
            onEdgesChange={(changes) => {
              for (const c of changes.getByType('remove')) changes.remove(c);
              setEdges((es) => changes.applyTo(es));
            }}
            isValidConnection={(c: Edge | Connection) =>
              canConnect(rig, ref(c.source, c.sourceHandle), ref(c.target, c.targetHandle)) === null}
            onConnect={(c) => edit((r) => connect(r, ref(c.source, c.sourceHandle), ref(c.target, c.targetHandle)))}
            onConnectEnd={onConnectEnd}
            onNodeDragStop={(_, node, dragged) => onDragStop(node, dragged)}
            onNodeClick={(_, node) => rig.devices[node.id] && setSelected(node.id)}
            onNodeDoubleClick={(_, node) => rig.devices[node.id] && setOpened(node.id)}
            onPaneClick={() => setSelected(undefined)}
            onDelete={({ nodes: ns, edges: es }) => edit((r) => {
              for (const e of es) r = disconnect(r, e.id);
              for (const n of ns) if (r.devices[n.id]) r = removeDevice(r, n.id);
              return r;
            })}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {view === 'grid' && (inspected
          ? <Inspector d={inspected} onClose={() => setSelected(undefined)} />
          : <Overview onPick={setSelected} />)}
        {opened && rig.devices[opened] && <DeviceWindow id={opened} onClose={() => setOpened(undefined)} onReplaced={(id) => { setOpened(id); setSelected(id); }} />}
      </div>
    </RigCtx.Provider>
  );
}
