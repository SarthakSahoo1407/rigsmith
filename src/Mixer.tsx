// The mixer: one channel strip per block of the rig, in signal order, like a DAW's console. Each strip
// has the block's on/off, its level fader(s) and, for a mic, pan, polarity and solo. The interface
// (output) is the master strip at the right, with the input and output meters.
// Faders are the same knobs as on the gear: moving one here moves it on the board.

import { useRef } from 'react';
import { def, makerOf, type DeviceType } from './catalog';
import { readout, tapeName, useShot, type Edit } from './gear';
import { layoutGrid } from './layout';
import { isPowered, setParam, toggle, type Device, type Rig } from './rig';

// The level controls of each kind of block (catalog param names). Blocks without one (a gate, a
// tuner) still get a strip with its switch.
export const FADERS: Partial<Record<DeviceType, string[]>> = {
  input: ['trim'], compressor: ['makeup'], boost: ['gain'], distortion: ['level'], fuzz: ['level'], eq: ['level'],
  octave: ['dry', 'sub', 'up'], chorus: ['mix'], flanger: ['mix'], delay: ['mix'], reverb: ['mix'], pitch: ['mix'], acoustic: ['level'],
  looper: ['level'], volume: ['position'], wah: ['position'], amp: ['master'], namAmp: ['output'], namRig: ['output'], namPedal: ['output'],
  joiner: ['levelA', 'levelB'], mic: ['level'], output: ['volume'],
};
const SKIP = new Set<DeviceType>(['power', 'splitter', 'cab']);
const level = (peak: number) => Math.max(0, Math.min(1, (20 * Math.log10(peak || 1e-6) + 60) / 60));

function Fader({ d, name, edit, who }: { d: Device; name: string; edit: Edit; who: string }) {
  const p = def(d.type).params.find((x) => x.name === name)!;
  const group = useRef('');
  const step = (p.max - p.min) / 200;
  return (
    <label className="mx-fader">
      <input type="range" min={p.min} max={p.max} step={step} value={d.params[name]} aria-label={`${who} ${name}`}
        onPointerDown={() => { group.current = `mix:${performance.now()}`; }}
        onChange={(e) => edit((r) => setParam(r, d.id, name, Number(e.target.value)), group.current || undefined)}
        onDoubleClick={() => edit((r) => setParam(r, d.id, name, p.def))} title="Double-click to reset" />
      <output>{readout(p, d.params[name])}</output>
      <span>{name}</span>
    </label>
  );
}

function Strip({ d, rig, edit, owner }: { d: Device; rig: Rig; edit: Edit; owner?: string }) {
  const shot = useShot(d.type, d.params);
  const dd = def(d.type);
  const powered = isPowered(rig, d.id);
  const input = d.type === 'input';
  const on = input ? d.on : d.on && powered;
  const faders = FADERS[d.type] ?? [];
  const mic = d.type === 'mic';
  const soloed = Object.values(rig.devices).some((m) => m.type === 'mic' && m.params.solo === 1);
  const set = (name: string, v: number) => edit((r) => setParam(r, d.id, name, v));
  return (
    <section className={`mx-strip${on ? '' : ' off'}${d.type === 'output' ? ' master' : ''}`} aria-label={tapeName(rig, d)}>
      <div className="mx-shot">{shot && <img src={shot.url} alt="" draggable={false} />}</div>
      <header><b title={tapeName(rig, d)}>{tapeName(rig, d)}</b><small>{owner ? `on ${owner}` : makerOf(d.type, d.params)}</small></header>
      {mic && (
        <div className="mx-pan">
          <input type="range" min={-1} max={1} step={0.02} value={d.params.pan} aria-label="Pan" onChange={(e) => set('pan', Number(e.target.value))}
            onDoubleClick={() => set('pan', 0)} />
          <small>{d.params.pan === 0 ? 'C' : `${d.params.pan < 0 ? 'L' : 'R'} ${Math.round(Math.abs(d.params.pan) * 100)}`}</small>
        </div>
      )}
      <div className="mx-faders">{faders.map((n) => <Fader key={n} d={d} name={n} edit={edit} who={tapeName(rig, d)} />)}</div>
      {mic && (
        <div className="mx-keys">
          <button className={`toggle-key${d.params.solo === 1 ? ' on' : ''}`} aria-pressed={d.params.solo === 1} title="Solo this mic" onClick={() => set('solo', d.params.solo === 1 ? 0 : 1)}>S</button>
          <button className={`toggle-key${d.params.phase === 1 ? ' on' : ''}`} aria-pressed={d.params.phase === 1} title="Flip polarity" onClick={() => set('phase', d.params.phase === 1 ? 0 : 1)}>Ø</button>
        </div>
      )}
      {mic && soloed && d.params.solo !== 1 && <small className="mx-note">muted by solo</small>}
      {dd.footswitch || input ? (
        <button className={`mx-switch${on ? ' on' : ''}`} aria-pressed={d.on} onClick={() => edit((r) => toggle(r, d.id))}>
          <i className="lamp" />{input ? (d.on ? 'live' : 'muted') : d.on ? 'on' : 'off'}
        </button>
      ) : <span className="mx-switch static">{d.type === 'output' ? 'master' : ''}</span>}
      {!powered && <small className="mx-note">no power</small>}
    </section>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="mx-meter" role="meter" aria-label={`${label} level`} aria-valuenow={Math.round(level(value) * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ transform: `scaleY(${level(value)})` }} className={value >= 0.99 ? 'hot' : ''} /><span>{label}</span>
    </div>
  );
}

export function Mixer({ rig, edit, levels }: { rig: Rig; edit: Edit; levels: { in: number; out: number } }) {
  const pos = layoutGrid(rig);
  const order = Object.values(rig.devices).filter((d) => pos[d.id] && !SKIP.has(d.type) && d.type !== 'output')
    .sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
  const outputs = Object.values(rig.devices).filter((d) => d.type === 'output');
  const name = (id?: string) => (id && rig.devices[id] ? tapeName(rig, rig.devices[id]) : undefined);
  return (
    <div className="mixer" aria-label="Mixer">
      <div className="mx-scroll">
        {order.map((d) => <Strip key={d.id} d={d} rig={rig} edit={edit} owner={name(d.mic?.cab)} />)}
        {!order.length && <div className="empty"><p>Nothing to mix</p><span>Add gear on the board, then come back.</span></div>}
      </div>
      <div className="mx-master">
        <div className="mx-meters"><Meter label="In" value={levels.in} /><Meter label="Out" value={levels.out} /></div>
        {outputs.map((d) => <Strip key={d.id} d={d} rig={rig} edit={edit} />)}
      </div>
    </div>
  );
}
