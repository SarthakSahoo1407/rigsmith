// The canvas: devices as boxes with jacks, cables between them. Board and Grid are two
// layouts of the same rig.

import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  Background, BaseEdge, Controls, getBezierPath, Handle, Position, ReactFlow, useReactFlow,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { def, type DeviceType, type Jack, type JackKind, type Param } from './catalog';
import {
  addDevice, cableAt, canConnect, connect, disconnect, isPowered, moveDevice, placeMic, removeDevice,
  setParam, toggle, type JackRef, type Rig,
} from './rig';

export type View = 'board' | 'grid';
export type Edit = (change: (rig: Rig) => Rig, group?: string) => void;
type Ctx = { rig: Rig; view: View; edit: Edit; inputs: string[] };
const RigCtx = createContext<Ctx>(null!);

export const GROUPS: [string, DeviceType[]][] = [
  ['Routing', ['input', 'output', 'power', 'splitter', 'joiner']],
  ['Dynamics', ['tuner', 'gate', 'compressor']],
  ['Drive', ['boost', 'distortion', 'fuzz', 'octave']],
  ['Filter', ['eq', 'wah', 'volume']],
  ['Modulation', ['chorus', 'flanger', 'phaser', 'tremolo']],
  ['Time', ['delay', 'reverb', 'looper']],
  ['Amp', ['amp', 'cab', 'mic']],
];
const CATEGORY = Object.fromEntries(GROUPS.flatMap(([g, types]) => types.map((t) => [t, g.toLowerCase()])));
// Devices with a sound model in native/Engine.h. The rest pass the signal through for now.
const MODELLED = new Set<DeviceType>(['input', 'output', 'power', 'splitter', 'joiner', 'boost', 'distortion', 'fuzz', 'amp', 'cab', 'mic']);
const CABLE: Record<JackKind | 'mic', string> = { audio: '#a3a3ad', power: '#f97316', speaker: '#facc15', mic: '#a78bfa' };

const ref = (device: string | null, jack: string | null | undefined): JackRef => ({ device: device ?? '', jack: jack ?? '' });
const jackKind = (rig: Rig, r: JackRef) => def(rig.devices[r.device].type).jacks.find((j) => j.name === r.jack)!.kind;

// Pedals take signal in on the right and out on the left, like real ones. The grid flows left to right.
function side(j: Jack, view: View) {
  if (j.kind === 'power') return Position.Top;
  if (j.kind === 'speaker') return j.dir === 'in' ? Position.Top : Position.Bottom;
  return (j.dir === 'in') === (view === 'board') ? Position.Right : Position.Left;
}

function toNodes(rig: Rig, view: View, prev: Node[]): Node[] {
  const old = new Map(prev.map((n) => [n.id, n]));
  return Object.values(rig.devices).map((d) => ({ ...old.get(d.id), id: d.id, type: 'device', position: d.pos[view], data: {} }));
}

function toEdges(rig: Rig, prev: Edge[]): Edge[] {
  const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
  const cables: Edge[] = rig.cables.map((c) => ({
    id: c.id, type: 'cable', source: c.from.device, sourceHandle: c.from.jack, target: c.to.device, targetHandle: c.to.jack,
    data: { kind: jackKind(rig, c.from) }, selected: selected.has(c.id),
  }));
  const mics: Edge[] = Object.values(rig.devices).flatMap((d) => d.mic ? [{
    id: `mic:${d.id}`, type: 'cable', source: d.mic.cab, sourceHandle: 'mic', target: d.id, targetHandle: 'mic',
    data: { kind: 'mic' }, selectable: false, deletable: false,
  }] : []);
  return [...cables, ...mics];
}

function CableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps) {
  const { view } = useContext(RigCtx);
  const kind = (data?.kind ?? 'audio') as keyof typeof CABLE;
  let path: string;
  if (view === 'board') {
    // Cables droop under their own weight: the longer the cable, the deeper the sag.
    const sag = Math.min(140, Math.hypot(targetX - sourceX, targetY - sourceY) * 0.3);
    const low = Math.max(sourceY, targetY) + sag;
    const dx = targetX - sourceX;
    path = `M ${sourceX} ${sourceY} C ${sourceX + dx / 4} ${low}, ${targetX - dx / 4} ${low}, ${targetX} ${targetY}`;
  } else {
    [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }
  return (
    <BaseEdge id={id} path={path} style={{
      stroke: CABLE[kind], strokeWidth: (kind === 'speaker' ? 5 : 3) + (selected ? 2 : 0),
      strokeDasharray: kind === 'mic' ? '4 4' : undefined, opacity: selected ? 1 : 0.85,
    }} />
  );
}

const fmt = (p: Param, v: number) => (p.options ? p.options[v] : String(Number(v.toFixed(p.max - p.min > 20 ? 0 : 2))));

// Rotary knob: drag up/down, arrow keys, double-click for default.
function Knob({ p, value, onChange }: { p: Param; value: number; onChange: (v: number, group?: string) => void }) {
  if (p.options) {
    return (
      <label className="knob nodrag">
        <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
          {p.options.map((o, i) => <option key={o} value={i}>{o}</option>)}
        </select>
        <span>{p.name}</span>
      </label>
    );
  }
  const range = p.max - p.min;
  const angle = -135 + ((value - p.min) / range) * 270;
  const down = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = value;
    const group = `knob:${performance.now()}`; // one drag = one undo step
    const move = (ev: globalThis.PointerEvent) => onChange(start + ((startY - ev.clientY) / 150) * range, group);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const key = (e: KeyboardEvent) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (step) { e.preventDefault(); onChange(value + (step * range) / 50); }
  };
  return (
    <div className="knob nodrag" role="slider" tabIndex={0} aria-label={p.name} aria-valuemin={p.min} aria-valuemax={p.max}
      aria-valuenow={value} title={`${p.name}: ${fmt(p, value)}`} onPointerDown={down} onKeyDown={key} onDoubleClick={() => onChange(p.def)}>
      <svg viewBox="-16 -16 32 32" aria-hidden>
        <circle r="13" className="knob-body" />
        <line y2="-11" className="knob-mark" transform={`rotate(${angle})`} />
      </svg>
      <span>{p.name}</span>
    </div>
  );
}

const MIC_KNOBS: Param[] = [
  { name: 'position', min: 0, max: 1, def: 0.5 }, // 0 = center of the speaker, 1 = edge
  { name: 'distance', min: 0, max: 1, def: 0.2 },
];

function DeviceNode({ id }: NodeProps) {
  const { rig, view, edit, inputs } = useContext(RigCtx);
  const d = rig.devices[id];
  if (!d) return null;
  const dd = def(d.type);
  const powered = isPowered(rig, id);
  const bySide = new Map<Position, Jack[]>();
  for (const j of dd.jacks) bySide.set(side(j, view), [...(bySide.get(side(j, view)) ?? []), j]);

  // Room for every jack: 24px per jack along each side.
  const count = (...ps: Position[]) => Math.max(0, ...ps.map((p) => bySide.get(p)?.length ?? 0)) + 1;
  const size = { minHeight: count(Position.Left, Position.Right) * 24, minWidth: count(Position.Top, Position.Bottom) * 24 };

  return (
    <div className={`device ${view} cat-${CATEGORY[d.type]}${d.on && powered ? '' : ' off'}`} style={size}>
      {[...bySide].flatMap(([pos, jacks]) => jacks.map((j, i) => {
        const along = `${((i + 1) / (jacks.length + 1)) * 100}%`;
        return (
          <Handle key={j.name} id={j.name} type={j.dir === 'out' ? 'source' : 'target'} position={pos}
            style={{ background: CABLE[j.kind], ...(pos === Position.Top || pos === Position.Bottom ? { left: along } : { top: along }) }}
            title={`${j.name}: ${j.kind} ${j.dir === 'in' ? 'input' : 'output'}`}>
            {j.name !== 'in' && j.name !== 'out' ? <span>{j.name}</span> : null}
          </Handle>
        );
      }))}
      {d.type === 'cab' && <Handle id="mic" type="source" position={Position.Bottom} isConnectable={false} className="hidden-handle" />}
      {d.type === 'mic' && <Handle id="mic" type="target" position={Position.Top} isConnectable={false} className="hidden-handle" />}

      <div className="device-head">{dd.label} <small>{id}</small></div>
      {dd.params.length > 0 && (
        <div className="knobs">
          {dd.params.map((p) => {
            // The input channel is a pick from the interface's enabled inputs, not a knob.
            const param = d.type === 'input' && p.name === 'channel' ? { ...p, options: inputs.length ? inputs : ['Input 1'] } : p;
            return <Knob key={p.name} p={param} value={d.params[p.name]} onChange={(v, g) => edit((r) => setParam(r, id, p.name, v), g)} />;
          })}
        </div>
      )}
      {d.type === 'mic' && (d.mic ? (
        <div className="knobs">
          {MIC_KNOBS.map((p) => (
            <Knob key={p.name} p={p} value={p.name === 'position' ? d.mic!.x : d.mic!.distance}
              onChange={(v, g) => edit((r) => placeMic(r, id, { ...d.mic!, [p.name === 'position' ? 'x' : 'distance']: v }), g)} />
          ))}
        </div>
      ) : <div className="hint">Drag onto a cab</div>)}
      {dd.power && !powered && <div className="warn">No power</div>}
      {!MODELLED.has(d.type) && <div className="hint">No sound model yet: passes signal through</div>}
      {d.type === 'amp' && !cableAt(rig, { device: id, jack: 'speaker' }) && <div className="warn">No load: connect a cab</div>}
      {dd.footswitch && (
        <button className="footswitch nodrag" onClick={() => edit((r) => toggle(r, id))} aria-pressed={d.on}>
          <span className={`led-dot${d.on && powered ? ' lit' : ''}`} /> {d.on ? 'On' : 'Bypassed'}
        </button>
      )}
    </div>
  );
}

const nodeTypes = { device: DeviceNode };
const edgeTypes = { cable: CableEdge };

export function Board({ rig, view, edit, flash, inputs }: Ctx & { flash: (msg: string) => void }) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  useEffect(() => setNodes((prev) => toNodes(rig, view, prev)), [rig, view]);
  useEffect(() => setEdges((prev) => toEdges(rig, prev)), [rig]);

  const add = (type: DeviceType) => {
    const box = wrapper.current!.getBoundingClientRect();
    const n = Object.keys(rig.devices).length;
    const at = flow.screenToFlowPosition({ x: box.left + box.width / 2 + (n % 5) * 24, y: box.top + box.height / 3 + (n % 5) * 24 });
    edit((r) => addDevice(r, type, at)[0]);
  };

  const onConnectEnd: OnConnectEnd = (_, state) => {
    if (state.isValid !== false || !state.toHandle) return;
    const why = canConnect(rig, ref(state.fromHandle.nodeId, state.fromHandle.id), ref(state.toHandle.nodeId, state.toHandle.id));
    if (why) flash(why);
  };

  return (
    <RigCtx.Provider value={{ rig, view, edit, inputs }}>
      <div className="workspace">
        <nav className="palette" aria-label="Add gear">
          {GROUPS.map(([group, types]) => (
            <div key={group}>
              <h3>{group}</h3>
              {types.map((t) => <button key={t} onClick={() => add(t)}>{def(t).label}</button>)}
            </div>
          ))}
        </nav>
        <div ref={wrapper} className="canvas">
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView minZoom={0.2}
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
            onNodeDragStop={(_, node, dragged) => edit((r) => {
              for (const n of dragged) r = moveDevice(r, n.id, view, n.position);
              const d = r.devices[node.id];
              if (d.type !== 'mic') return r;
              // A mic dropped on a cab sits on its speaker; dragged off, it comes loose.
              const cab = flow.getIntersectingNodes(node).find((n) => r.devices[n.id]?.type === 'cab');
              return placeMic(r, d.id, cab && { cab: cab.id, x: d.mic?.x ?? 0.5, y: 0.5, distance: d.mic?.distance ?? 0.2 });
            })}
            onDelete={({ nodes: ns, edges: es }) => edit((r) => {
              for (const e of es) r = disconnect(r, e.id);
              for (const n of ns) r = removeDevice(r, n.id);
              return r;
            })}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </RigCtx.Provider>
  );
}
