// The cab and mic studio, inside a cab's device window: a close-up of one speaker where every mic
// on the cab can be dragged anywhere on the cone, a mixer strip per mic (model, level, pan,
// distance, angle, time-align, polarity, solo), and the cab's source: the modelled speaker, or
// real IRs in two slots with a blend and low/high cuts.

import { useRef, type PointerEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { def } from './catalog';
import { CaptureSelect, Knob, tapeName, type Edit } from './gear';
import { micOffset, micPlacementAt, micsOn } from './layout';
import { addDevice, placeMic, removeDevice, setParam, type Device, type Rig } from './rig';

const R = 120; // the speaker's radius in the close-up
// Rings of a speaker, centre out, as engineers name the spots.
const RINGS: [number, string][] = [[0.16, 'cap'], [0.3, 'cap edge'], [0.66, 'cone'], [1, 'edge']];
const param = (type: 'mic' | 'cab', name: string) => def(type).params.find((p) => p.name === name)!;

export function CabStudio({ d, rig, edit }: { d: Device; rig: Rig; edit: Edit }) {
  const mics = micsOn(rig, d.id);
  const svg = useRef<SVGSVGElement>(null);
  const ir = d.params.source === 1;

  // Dragging a mic dot sets where it points: distance from the centre and the direction.
  const drag = (mic: Device) => (e: PointerEvent<SVGGElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const group = `mic:${performance.now()}`;
    const move = (ev: globalThis.PointerEvent) => {
      const box = svg.current!.getBoundingClientRect();
      const scale = (2 * R + 40) / box.width;
      const at = micPlacementAt((ev.clientX - box.left) * scale - (R + 20), (ev.clientY - box.top) * scale - (R + 20), R);
      edit((r) => placeMic(r, mic.id, { ...r.devices[mic.id].mic!, x: at.x, y: at.y }), group);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const addMic = () => edit((r) => {
    const [next, id] = addDevice(r, 'mic', { x: 0, y: 0 });
    return placeMic(next, id, { cab: d.id, x: 0.3, y: mics.length % 2 ? 0.25 : 0.75, distance: 0.1 });
  });

  return (
    <div className="studio">
      <section className="studio-speaker" aria-label="Mic placement">
        <h3>Mic placement</h3>
        <svg ref={svg} viewBox={`${-R - 20} ${-R - 20} ${2 * R + 40} ${2 * R + 40}`} className="speaker-closeup">
          <defs>
            <radialGradient id="cone" r="50%">
              <stop offset="0" stopColor="#3a3835" /><stop offset=".16" stopColor="#1d1c1a" /><stop offset=".17" stopColor="#2c2a27" />
              <stop offset=".66" stopColor="#1f1e1c" /><stop offset=".9" stopColor="#151514" /><stop offset="1" stopColor="#0c0c0c" />
            </radialGradient>
          </defs>
          <circle r={R} fill="url(#cone)" stroke="#000" strokeWidth="2" />
          {RINGS.map(([f, name]) => (
            <g key={name}>
              <circle r={f * R} fill="none" className="ring" />
              <text x={0} y={-f * R + 12} className="ring-label">{name}</text>
            </g>
          ))}
          {mics.map((m, i) => {
            const o = micOffset(m.mic!.x, m.mic!.y, R);
            return (
              <g key={m.id} transform={`translate(${o.x} ${o.y})`} onPointerDown={drag(m)} className="mic-dot" role="slider" tabIndex={0}
                aria-label={`${tapeName(rig, m)} position`} aria-valuenow={Math.round(m.mic!.x * 100)} aria-valuetext={`${Math.round(m.mic!.x * 100)}% toward the edge`}>
                <circle r={13 - m.mic!.distance * 5} />
                <text y={4}>{i + 1}</text>
              </g>
            );
          })}
        </svg>
        <p className="hint">Drag a mic: the centre is brightest, the edge darkest. Each mic points at its own speaker on the cab.</p>
      </section>

      <section className="studio-mixer" aria-label="Mic mixer">
        <h3>Mics <span className="count">{mics.length} of 4</span></h3>
        {mics.map((m, i) => (
          <div key={m.id} className={`strip${m.params.solo ? ' soloed' : ''}`}>
            <div className="strip-head">
              <span className="strip-num">{i + 1}</span>
              <select value={m.params.model} aria-label={`${tapeName(rig, m)} model`} onChange={(e) => edit((r) => setParam(r, m.id, 'model', Number(e.target.value)))}>
                {param('mic', 'model').options!.map((o, k) => <option key={o} value={k}>{o}</option>)}
              </select>
              <button className={`toggle-key${m.params.phase ? ' on' : ''}`} aria-pressed={!!m.params.phase} title="Flip polarity" onClick={() => edit((r) => setParam(r, m.id, 'phase', m.params.phase ? 0 : 1))}>Ø</button>
              <button className={`toggle-key${m.params.solo ? ' on' : ''}`} aria-pressed={!!m.params.solo} title="Solo" onClick={() => edit((r) => setParam(r, m.id, 'solo', m.params.solo ? 0 : 1))}>S</button>
              <button className="icon small danger" aria-label={`Remove ${tapeName(rig, m)}`} onClick={() => edit((r) => removeDevice(r, m.id))}><Trash2 size={16} strokeWidth={1.5} /></button>
            </div>
            <div className="strip-knobs">
              {(['level', 'pan', 'angle', 'align'] as const).map((name) => (
                <Knob key={name} p={param('mic', name)} look="big" value={m.params[name]} onChange={(v, g) => edit((r) => setParam(r, m.id, name, v), g)} />
              ))}
              <Knob p={{ name: 'distance', min: 0, max: 1, def: 0.2 }} look="big" value={m.mic!.distance}
                onChange={(v, g) => edit((r) => placeMic(r, m.id, { ...r.devices[m.id].mic!, distance: v }), g)} />
            </div>
          </div>
        ))}
        {mics.length < 4 && <button className="text-button" onClick={addMic}><Plus size={16} strokeWidth={1.5} />Add a mic</button>}
        <p className="hint">The cab's L and R outputs carry this mix. A mic's own output still works for routing it alone.</p>
      </section>

      <section className="studio-source" aria-label="Cab source">
        <h3>Source</h3>
        <div className="segmented" role="radiogroup" aria-label="Source">
          {param('cab', 'source').options!.map((o, i) => (
            <button key={o} role="radio" aria-checked={d.params.source === i} aria-pressed={d.params.source === i} onClick={() => edit((r) => setParam(r, d.id, 'source', i))}>
              {i ? 'Real IRs' : 'Modelled speaker'}
            </button>
          ))}
        </div>
        {ir ? (
          <>
            <label className="field"><span>IR A</span><CaptureSelect d={d} edit={edit} slot="irA" kind="ir" label="IR A" /></label>
            <label className="field"><span>IR B</span><CaptureSelect d={d} edit={edit} slot="irB" kind="ir" label="IR B" /></label>
            <p className="hint">A real IR has its mic built in, so the mics above shape it a second time. Keep one mic, near the centre, close.</p>
          </>
        ) : (
          <>
            <label className="field"><span>speaker</span>
              <select value={d.params.speaker} onChange={(e) => edit((r) => setParam(r, d.id, 'speaker', Number(e.target.value)))}>
                {param('cab', 'speaker').options!.map((o, i) => <option key={o} value={i}>{o}</option>)}
              </select>
            </label>
            <label className="field"><span>size</span>
              <select value={d.params.size} onChange={(e) => edit((r) => setParam(r, d.id, 'size', Number(e.target.value)))}>
                {param('cab', 'size').options!.map((o, i) => <option key={o} value={i}>{o}</option>)}
              </select>
            </label>
          </>
        )}
        <div className="strip-knobs">
          {(ir ? ['blend', 'lowCut', 'highCut'] : ['lowCut', 'highCut']).map((name) => (
            <Knob key={name} p={param('cab', name)} look="big" value={d.params[name]} onChange={(v, g) => edit((r) => setParam(r, d.id, name, v), g)} />
          ))}
        </div>
      </section>
    </div>
  );
}
