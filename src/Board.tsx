// The canvas. Board view: a stage, a pedalboard and a desk, with every device snapped into place
// by layout.ts and drawn like real gear (gear.tsx). Grid view: plain boxes you place freely.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  BaseEdge, Controls, getBezierPath, Handle, Position, ReactFlow, useReactFlow, Background,
  type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Plus } from 'lucide-react';
import { def, type DeviceType, type Jack, type JackKind } from './catalog';
import { Gear, Knob, MicControls, PEDALS, tapeName, type Edit, type Live } from './gear';
import { dropHints, gearSize, isPedal, layoutBoard, type Layout, type Zone } from './layout';
import {
  addDevice, cableAt, canConnect, connect, disconnect, isPowered, moveDevice, placeMic, removeDevice,
  setParam, toggle, type JackRef, type Rig, type XY,
} from './rig';

export type View = 'board' | 'grid';
export type { Edit };
type Ctx = { rig: Rig; view: View; edit: Edit; inputs: string[]; live: Live };
const RigCtx = createContext<Ctx>(null!);

export const GROUPS: [string, DeviceType[]][] = [
  ['Dynamics', ['tuner', 'gate', 'compressor']],
  ['Drive', ['boost', 'distortion', 'fuzz', 'octave']],
  ['Filter', ['eq', 'wah', 'volume']],
  ['Modulation', ['chorus', 'flanger', 'phaser', 'tremolo']],
  ['Time', ['delay', 'reverb', 'looper']],
  ['Amp and cab', ['amp', 'cab', 'mic']],
  ['Routing and power', ['splitter', 'joiner', 'power', 'input', 'output']],
];
const SWATCH: Partial<Record<DeviceType, string>> = { ...PEDALS, wah: '#1c1c1e', volume: '#1c1c1e', amp: '#c9a24e', cab: '#3a342a', mic: '#8d9098', splitter: '#b9babd', joiner: '#b9babd', power: '#26262a', input: '#b9babd', output: '#2b2c30' };

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

// Pedals take signal in on the right and out on the left, like real ones. The grid flows left to right.
// On the board the amp's back panel (send, return, speaker) faces up, away from the player.
function side(j: Jack, view: View, type: DeviceType) {
  if (view === 'board' && type === 'amp' && j.name !== 'in') return Position.Top;
  if (view === 'board' && type === 'mic') return Position.Bottom;
  if (j.kind === 'power') return Position.Top;
  if (j.kind === 'speaker') return j.dir === 'in' ? Position.Top : Position.Bottom;
  return (j.dir === 'in') === (view === 'board') ? Position.Right : Position.Left;
}

function toNodes(rig: Rig, view: View, prev: Node[], layout: Layout | null): Node[] {
  const old = new Map(prev.map((n) => [n.id, n]));
  const zones: Node[] = (layout?.zones ?? []).map((z) => ({
    id: z.id, type: 'zone', position: { x: z.x, y: z.y }, data: z, zIndex: -1,
    draggable: false, selectable: false, deletable: false, focusable: false, connectable: false,
  }));
  const devices: Node[] = Object.values(rig.devices).map((d) => ({
    ...old.get(d.id), id: d.id, type: 'device', data: {},
    position: layout ? layout.pos[d.id] : d.pos[view],
    draggable: !(layout && FIXED.has(d.type)),
  }));
  return [...zones, ...devices];
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
  const look = CABLE[kind];
  let path: string;
  if (view === 'board' && kind !== 'mic') {
    // Cables droop under their own weight: the longer the run, the deeper the sag.
    const sag = Math.min(120, Math.hypot(targetX - sourceX, targetY - sourceY) * 0.22);
    const low = Math.max(sourceY, targetY) + sag;
    const dx = targetX - sourceX;
    path = `M ${sourceX} ${sourceY} C ${sourceX + dx / 5} ${low}, ${targetX - dx / 5} ${low}, ${targetX} ${targetY}`;
  } else {
    [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={18}
        style={{ stroke: look.jacket, strokeWidth: look.width, strokeLinecap: 'round' }} />
      <path d={path} fill="none" pointerEvents="none" strokeLinecap="round" className={selected ? 'cable-core selected' : 'cable-core'}
        style={{ stroke: selected ? 'var(--accent)' : look.core, strokeWidth: selected ? 2.5 : 1.5, strokeDasharray: kind === 'mic' ? '3 5' : undefined }} />
    </>
  );
}

function ZoneNode({ data }: NodeProps) {
  const z = data as Zone;
  const name = { stage: 'Stage', board: 'Pedalboard', desk: 'Desk' }[z.kind];
  return <div className={`zone zone-${z.kind}`} style={{ width: z.w, height: z.h }}><span className="zone-name">{name}</span></div>;
}

function DeviceNode({ id }: NodeProps) {
  const ctx = useContext(RigCtx);
  const { rig, view, edit, inputs } = ctx;
  const d = rig.devices[id];
  if (!d) return null;
  const dd = def(d.type);
  const powered = isPowered(rig, id);
  const bySide = new Map<Position, Jack[]>();
  for (const j of dd.jacks) bySide.set(side(j, view, d.type), [...(bySide.get(side(j, view, d.type)) ?? []), j]);

  // Board gear has a fixed size; grid boxes leave 24px of edge per jack.
  const count = (...ps: Position[]) => Math.max(0, ...ps.map((p) => bySide.get(p)?.length ?? 0)) + 1;
  const size: CSSProperties = view === 'board'
    ? { width: gearSize(d).w, height: gearSize(d).h }
    : { minHeight: count(Position.Left, Position.Right) * 24, minWidth: count(Position.Top, Position.Bottom) * 24 };

  return (
    <div className={`device ${view}${d.on && powered ? '' : ' off'}`} style={size}>
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
      {d.type === 'cab' && <Handle id="mic" type="source" position={Position.Bottom} isConnectable={false} className="hidden-handle" />}
      {d.type === 'mic' && <Handle id="mic" type="target" position={Position.Top} isConnectable={false} className="hidden-handle" />}

      {view === 'board' ? <Gear d={d} rig={rig} edit={edit} inputs={inputs} live={ctx.live} /> : (
        <>
          <div className="device-head"><span className="swatch" style={{ background: SWATCH[d.type] }} />{tapeName(rig, d)}</div>
          {dd.params.length > 0 && (
            <div className="knobs">
              {dd.params.map((p) => {
                // The input channel is a pick from the interface's enabled inputs, not a knob.
                const param = d.type === 'input' && p.name === 'channel' ? { ...p, options: inputs.length ? inputs : ['Input 1'] } : p;
                return <Knob key={p.name} p={param} value={d.params[p.name]} onChange={(v, g) => edit((r) => setParam(r, id, p.name, v), g)} />;
              })}
            </div>
          )}
          {d.type === 'mic' && <MicControls d={d} edit={edit} />}
          {dd.power && !powered && <div className="warn">No power</div>}
          {d.type === 'amp' && !cableAt(rig, { device: id, jack: 'speaker' }) && <div className="warn">No load: cable a cab</div>}
          {dd.footswitch && d.type !== 'looper' && (
            <button className="footswitch nodrag" onClick={() => edit((r) => toggle(r, id))} aria-pressed={d.on}>
              <span className={`led${d.on && powered ? ' lit' : ''}`} /> {d.on ? 'On' : 'Bypassed'}
            </button>
          )}
          {d.type === 'looper' && <div className="hint">Looper controls are on the Board</div>}
        </>
      )}
    </div>
  );
}

const nodeTypes = { device: DeviceNode, zone: ZoneNode };
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

export function Board({ rig, view, edit, flash, inputs, live }: Ctx & { flash: (msg: string) => void }) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const layout = useMemo(() => (view === 'board' ? layoutBoard(rig) : null), [rig, view]);
  useEffect(() => setNodes((prev) => toNodes(rig, view, prev, layout)), [rig, view, layout]);
  useEffect(() => setEdges((prev) => toEdges(rig, prev)), [rig]);

  // Refit when the view or the amount of gear changes.
  const count = Object.keys(rig.devices).length;
  useEffect(() => {
    const t = setTimeout(() => flow.fitView({ padding: 0.06, duration: 250 }), 50);
    return () => clearTimeout(t);
  }, [view, count]);

  const add = (type: DeviceType) => {
    const box = wrapper.current!.getBoundingClientRect();
    const center = flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 3 });
    edit((r) => {
      const [next, id] = addDevice(r, type, boardHint(r, type));
      return moveDevice(next, id, 'grid', center);
    });
  };

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
        // A mic dropped on a cab stands in front of it; dropped anywhere else, it comes loose.
        const cab = flow.getIntersectingNodes(node).find((n) => r.devices[n.id]?.type === 'cab');
        r = placeMic(r, d.id, cab && { cab: cab.id, x: d.mic?.x ?? 0.5, y: 0.5, distance: d.mic?.distance ?? 0.2 });
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
    <RigCtx.Provider value={{ rig, view, edit, inputs, live }}>
      <div className="workspace">
        <nav className="locker" aria-label="Add gear">
          {GROUPS.map(([group, types]) => (
            <section key={group}>
              <h3>{group}</h3>
              {types.map((t) => (
                <button key={t} className="locker-item" onClick={() => add(t)}>
                  <span className="swatch" style={{ background: SWATCH[t] }} />
                  <span>{def(t).label}</span>
                  <Plus size={16} strokeWidth={1.5} aria-hidden className="locker-add" />
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div ref={wrapper} className={`canvas canvas-${view}`}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView minZoom={0.15} maxZoom={2}
            proOptions={{ hideAttribution: true }}
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
            onDelete={({ nodes: ns, edges: es }) => edit((r) => {
              for (const e of es) r = disconnect(r, e.id);
              for (const n of ns) if (r.devices[n.id]) r = removeDevice(r, n.id);
              return r;
            })}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            {view === 'grid' && <Background gap={24} />}
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </RigCtx.Provider>
  );
}
