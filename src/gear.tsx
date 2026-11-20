// How each device looks on the Board, drawn like the real thing: powder-coated stompboxes, a tolex
// amp head with a brushed panel, cabs with grille cloth, mics on stands. Every device carries a
// strip of gaffer tape with its name, the way players label a real board. The Grid uses plain boxes.

import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode, WheelEvent } from 'react';
import { def, type DeviceType, type Param } from './catalog';
import { call } from './native';
import { isPowered, placeMic, setParam, toggle, type Device, type Rig } from './rig';

export type Edit = (change: (rig: Rig) => Rig, group?: string) => void;
// Live readouts from the engine, by device id: tuner pitch, looper state.
export type Live = Record<string, { hz?: number; mode?: string; length?: number; position?: number }>;
type Props = { d: Device; rig: Rig; edit: Edit; inputs: string[]; live: Live };

const fmt = (p: Param, v: number) => (p.options ? p.options[v] : String(Number(v.toFixed(p.max - p.min > 20 ? 0 : 2))));
const LABELS: Record<string, string> = { makeup: 'gain', predelay: 'pre', feedback: 'repeats', pingpong: 'ping-pong', reference: 'ref', threshold: 'thresh' };
const label = (name: string) => LABELS[name] ?? name;

// The name on the tape: "Delay", or "Delay 2" when there is more than one.
export function tapeName(rig: Rig, d: Device) {
  const many = Object.values(rig.devices).filter((x) => x.type === d.type).length > 1;
  return many ? `${def(d.type).label} ${d.id.split('-').pop()}` : def(d.type).label;
}

// Vertical drag sets a value; one drag is one undo step.
function dragger(value: number, min: number, max: number, onChange: (v: number, group?: string) => void, pixels = 150) {
  return (e: PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const group = `drag:${performance.now()}`;
    const move = (ev: globalThis.PointerEvent) => onChange(value + ((startY - ev.clientY) / pixels) * (max - min), group);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
}

function arrows(value: number, min: number, max: number, onChange: (v: number) => void) {
  return (e: KeyboardEvent) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (step) { e.preventDefault(); onChange(value + (step * (max - min)) / 50); }
  };
}

const sliderProps = (p: Param, value: number) => ({
  role: 'slider', tabIndex: 0, 'aria-label': p.name, 'aria-valuemin': p.min, 'aria-valuemax': p.max,
  'aria-valuenow': value, 'aria-valuetext': fmt(p, value), title: `${label(p.name)}: ${fmt(p, value)}`,
});

export type KnobStyle = 'small' | 'pedal' | 'amp';

// Rotary knob: drag up/down, arrow keys, double-click for default. Choices render as a selector switch.
export function Knob({ p, value, onChange, look = 'small' }: { p: Param; value: number; onChange: (v: number, group?: string) => void; look?: KnobStyle }) {
  if (p.options) return <Selector p={p} value={value} onChange={onChange} />;
  const angle = -150 + ((value - p.min) / (p.max - p.min)) * 300;
  return (
    <div className={`knob knob-${look} nodrag`} {...sliderProps(p, value)}
      onPointerDown={dragger(value, p.min, p.max, onChange)} onKeyDown={arrows(value, p.min, p.max, onChange)} onDoubleClick={() => onChange(p.def)}>
      <svg viewBox="-20 -20 40 40" aria-hidden>
        {look === 'amp' && Array.from({ length: 11 }, (_, i) => (
          <line key={i} y1="-18.5" y2={i % 5 === 0 ? -15.5 : -16.8} className="knob-tick" transform={`rotate(${-150 + i * 30})`} />
        ))}
        {look === 'amp' ? (
          <g transform={`rotate(${angle})`}>
            <circle r="11" className="knob-skirt" />
            <path d="M -4.2 6 L -2 -15 Q 0 -16.5 2 -15 L 4.2 6 Q 0 8 -4.2 6 Z" className="knob-head" />
            <line y1="-6" y2="-14" className="knob-mark" />
          </g>
        ) : (
          <>
            <circle r={look === 'pedal' ? 14 : 15} className="knob-skirt" />
            <circle r={look === 'pedal' ? 10.5 : 11} className="knob-cap" />
            <line y1={look === 'pedal' ? -4 : -3} y2={look === 'pedal' ? -13 : -14} className="knob-mark" transform={`rotate(${angle})`} />
          </>
        )}
      </svg>
      <span>{label(p.name)}</span>
    </div>
  );
}

// A row of labelled positions with a lit indicator on the chosen one, like a channel selector.
function Selector({ p, value, onChange }: { p: Param; value: number; onChange: (v: number) => void }) {
  return (
    <div className="selector nodrag" role="radiogroup" aria-label={p.name}>
      {p.options!.map((o, i) => (
        <button key={o} role="radio" aria-checked={i === value} className={i === value ? 'on' : ''} onClick={() => onChange(i)}>
          <span className="selector-led" />{o}
        </button>
      ))}
    </div>
  );
}

function Fader({ p, value, onChange, text }: { p: Param; value: number; onChange: (v: number, group?: string) => void; text: string }) {
  const frac = (value - p.min) / (p.max - p.min);
  return (
    <div className="fader nodrag" {...sliderProps(p, value)} onPointerDown={dragger(value, p.min, p.max, onChange, 60)}
      onKeyDown={arrows(value, p.min, p.max, onChange)} onDoubleClick={() => onChange(p.def)}>
      <div className="fader-slot"><div className="fader-cap" style={{ bottom: `calc(${frac * 100}% - 5px)` }} /></div>
      <span>{text}</span>
    </div>
  );
}

const knobs = ({ d, edit }: Props, look: KnobStyle, only?: (p: Param) => boolean) =>
  def(d.type).params.filter((p) => !only || only(p)).map((p) => (
    <Knob key={p.name} p={p} look={look} value={d.params[p.name]} onChange={(v, g) => edit((r) => setParam(r, d.id, p.name, v), g)} />
  ));

const Tape = ({ children, className = '' }: { children: ReactNode; className?: string }) => <div className={`tape ${className}`}>{children}</div>;
const Screws = () => <>{['tl', 'tr', 'bl', 'br'].map((c) => <span key={c} className={`screw ${c}`} />)}</>;

// Enclosure colours: powder coat, each picked so two pedals side by side never look alike.
const PEDALS: Partial<Record<DeviceType, string>> = {
  tuner: '#242427', gate: '#4a4f57', compressor: '#2b5d8f', boost: '#d9d0b4', distortion: '#d9661f', fuzz: '#8e9fb3',
  octave: '#54306f', eq: '#e3e1da', chorus: '#6fb3cc', flanger: '#5f3d8a', phaser: '#c4441c', tremolo: '#1d7468',
  delay: '#2f6b37', reverb: '#22314f', looper: '#7c2230',
};

const isLight = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
};

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

function TunerScreen({ d, live }: Props) {
  const hz = live[d.id]?.hz ?? 0;
  if (!d.on) return <div className="screen off">mute to tune</div>;
  if (!hz) return <div className="screen"><b>–</b><div className="cents" /></div>;
  const n = 12 * Math.log2(hz / d.params.reference) + 69;
  const cents = Math.round((n - Math.round(n)) * 100);
  return (
    <div className={`screen${Math.abs(cents) <= 3 ? ' in-tune' : ''}`} aria-live="polite">
      <b>{NOTES[((Math.round(n) % 12) + 12) % 12]}</b>
      <div className="cents"><i style={{ left: `${50 + cents}%` }} /></div>
      <small>{cents > 0 ? '+' : ''}{cents} cents</small>
    </div>
  );
}

function LooperScreen({ d, live }: Props) {
  const s = live[d.id] ?? {};
  const mode = s.mode ?? 'empty';
  const progress = s.length ? (s.position ?? 0) / s.length : 0;
  const cmd = (c: string) => call('looper', d.id, c);
  return (
    <>
      <div className={`screen loop-${mode}`} aria-live="polite">
        <b>{mode === 'empty' ? 'ready' : mode}</b>
        <small>{(s.length ?? 0).toFixed(1)} s</small>
        <div className="loop-bar"><i style={{ width: `${mode === 'recording' ? 100 : progress * 100}%` }} /></div>
      </div>
      <div className="mini-buttons">
        <button className="nodrag" onClick={() => cmd('stop')}>stop</button>
        <button className="nodrag" onClick={() => cmd('undo')}>undo</button>
        <button className="nodrag" onClick={() => cmd('clear')}>clear</button>
      </div>
    </>
  );
}

function Pedal(props: Props) {
  const { d, rig, edit } = props;
  const dd = def(d.type);
  const color = PEDALS[d.type] ?? '#444';
  const powered = isPowered(rig, d.id);
  const looper = d.type === 'looper';
  const mode = props.live[d.id]?.mode;
  const lit = looper ? powered && !!mode && mode !== 'empty' && mode !== 'stopped' : powered && d.on;
  const bands = dd.params.filter((p) => p.name.endsWith('Hz'));
  return (
    <div className={`pedal${isLight(color) ? ' light' : ''}`} style={{ '--body': color } as CSSProperties}>
      <Screws />
      {bands.length > 0 && (
        <div className="faders">
          {bands.map((p) => {
            const hz = parseInt(p.name);
            return <Fader key={p.name} p={p} text={hz >= 1000 ? `${hz / 1000}k` : String(hz)}
              value={d.params[p.name]} onChange={(v, g) => edit((r) => setParam(r, d.id, p.name, v), g)} />;
          })}
        </div>
      )}
      <div className="pedal-knobs">{knobs(props, 'pedal', (p) => !p.name.endsWith('Hz'))}</div>
      {d.type === 'tuner' && <TunerScreen {...props} />}
      {looper && <LooperScreen {...props} />}
      <div className="pedal-print">{dd.label}</div>
      <span className={`led${lit ? ' lit' : ''}${mode === 'recording' ? ' rec' : ''}`} />
      <button className="stomp nodrag" aria-label={looper ? 'Looper: record, play, overdub' : `${dd.label} footswitch`}
        aria-pressed={looper ? undefined : d.on}
        onClick={() => (looper ? call('looper', d.id, 'main') : edit((r) => toggle(r, d.id)))}>
        <span className="stomp-cap" />
      </button>
      <Tape>{tapeName(rig, d)}{!powered && <em> · no power</em>}</Tape>
    </div>
  );
}

// Wah and volume: a rocking treadle. Drag it, or scroll over it.
function Treadle(props: Props) {
  const { d, rig, edit } = props;
  const pos = d.params.position;
  const p = def(d.type).params.find((x) => x.name === 'position')!;
  const set = (v: number, g?: string) => edit((r) => setParam(r, d.id, 'position', v), g);
  const powered = isPowered(rig, d.id);
  return (
    <div className="treadle">
      <div className="rocker nodrag nowheel" {...sliderProps(p, pos)} onPointerDown={dragger(pos, 0, 1, set, 120)}
        onKeyDown={arrows(pos, 0, 1, set)} onWheel={(e: WheelEvent) => set(pos - e.deltaY * 0.002, `wheel:${d.id}`)}
        style={{ transform: `perspective(320px) rotateX(${(pos - 0.5) * 22}deg)` }}>
        <span>{d.type === 'wah' ? (pos > 0.5 ? 'toe' : 'heel') : `${Math.round(pos * 100)}%`}</span>
      </div>
      <div className="treadle-base">
        {knobs(props, 'pedal', (x) => x.name !== 'position')}
        {d.type === 'wah' && (
          <button className="toe-switch nodrag" aria-pressed={d.on} aria-label="Wah on/off" onClick={() => edit((r) => toggle(r, d.id))}>
            <span className={`led${d.on && powered ? ' lit' : ''}`} />
          </button>
        )}
      </div>
      <Tape>{tapeName(rig, d)}{!powered && <em> · no power</em>}</Tape>
    </div>
  );
}

function Amp(props: Props) {
  const { rig, d, edit } = props;
  const loaded = rig.cables.some((c) => c.from.device === d.id && c.from.jack === 'speaker');
  const voicing = def('amp').params[0];
  return (
    <div className="amp">
      <span className="corner tl" /><span className="corner tr" />
      <div className="amp-panel">
        <span className="badge">RIG</span>
        <Selector p={voicing} value={d.params.voicing} onChange={(v) => edit((r) => setParam(r, d.id, 'voicing', v))} />
        <div className="amp-knobs">{knobs(props, 'amp', (p) => p.name !== 'voicing')}</div>
        <div className="amp-power">
          <span className="toggle" title="Power" /><span className="toggle" title="Standby" />
          <span className="jewel" title="On" />
        </div>
      </div>
      <div className="amp-grille">{!loaded && <span className="warn">no load: cable a cab</span>}</div>
      <Tape className="on-top">{tapeName(rig, d)}</Tape>
    </div>
  );
}

function Cab(props: Props) {
  const { d, rig, edit } = props;
  const size = d.params.size;
  const mics = Object.values(rig.devices).filter((m) => m.mic?.cab === d.id);
  const sizes = def('cab').params[0].options!;
  return (
    <div className={`cab cab-${size}`}>
      <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
      <div className="cab-grille">
        {Array.from({ length: [1, 2, 4][size] }, (_, i) => (
          <div key={i} className="speaker">
            {i === 0 && mics.map((m) => (
              <span key={m.id} className="mic-spot" title={`${tapeName(rig, m)}: ${Math.round(m.mic!.x * 100)}% toward the edge`}
                style={{ left: `${50 + m.mic!.x * 42}%`, width: 16 - m.mic!.distance * 8, height: 16 - m.mic!.distance * 8 }} />
            ))}
          </div>
        ))}
      </div>
      <div className="cab-foot">
        <span className="badge">RIG</span>
        <div className="size-pick nodrag" role="radiogroup" aria-label="Cab size">
          {sizes.map((s, i) => (
            <button key={s} role="radio" aria-checked={i === size} className={i === size ? 'on' : ''} onClick={() => edit((r) => setParam(r, d.id, 'size', i))}>{s}</button>
          ))}
        </div>
      </div>
      <Tape className="on-top">{tapeName(rig, d)}</Tape>
    </div>
  );
}

const MIC_KNOBS: Param[] = [
  { name: 'position', min: 0, max: 1, def: 0.5 }, // 0 = center of the speaker, 1 = edge
  { name: 'distance', min: 0, max: 1, def: 0.2 },
];

export function MicControls({ d, edit, look = 'small' }: Pick<Props, 'd' | 'edit'> & { look?: KnobStyle }) {
  if (!d.mic) return <div className="hint">drag onto a cab</div>;
  return (
    <div className="knobs">
      {MIC_KNOBS.map((p) => (
        <Knob key={p.name} p={p} look={look} value={p.name === 'position' ? d.mic!.x : d.mic!.distance}
          onChange={(v, g) => edit((r) => placeMic(r, d.id, { ...d.mic!, [p.name === 'position' ? 'x' : 'distance']: v }), g)} />
      ))}
    </div>
  );
}

function Mic(props: Props) {
  const { d, rig, edit } = props;
  const model = d.params.model;
  const models = def('mic').params[0].options!;
  return (
    <div className="mic">
      <svg viewBox="0 0 60 90" aria-hidden className="mic-art">
        <line x1="30" y1="40" x2="30" y2="86" className="stand" />
        <path d="M 14 88 L 30 82 L 46 88" className="stand" />
        {model === 0 && <g transform="rotate(-20 30 40)"><rect x="25" y="2" width="10" height="16" rx="4" className="mic-grille" /><path d="M 25.5 18 L 27 44 L 33 44 L 34.5 18 Z" className="mic-body" /></g>}
        {model === 1 && <g><rect x="18" y="2" width="24" height="30" rx="11" className="mic-grille" /><rect x="26" y="32" width="8" height="12" className="mic-body" /></g>}
        {model === 2 && <g><rect x="21" y="2" width="18" height="26" rx="9" className="mic-grille" /><rect x="22" y="27" width="16" height="17" rx="3" className="mic-body" /></g>}
      </svg>
      <select className="mic-model nodrag" value={model} aria-label="Mic model" onChange={(e) => edit((r) => setParam(r, d.id, 'model', Number(e.target.value)))}>
        {models.map((m, i) => <option key={m} value={i}>{m}</option>)}
      </select>
      <MicControls d={d} edit={edit} look="pedal" />
      <Tape>{tapeName(rig, d)}</Tape>
    </div>
  );
}

function DiBox(props: Props) {
  const { d, edit, inputs, rig } = props;
  const channel = { ...def('input').params[0], options: inputs.length ? inputs : ['Input 1'] };
  return (
    <div className="steelbox">
      <Screws />
      <div className="jack-art" aria-hidden />
      <select className="nodrag" value={d.params.channel} aria-label="Interface input" onChange={(e) => edit((r) => setParam(r, d.id, 'channel', Number(e.target.value)))}>
        {channel.options.map((o, i) => <option key={o} value={i}>{o}</option>)}
      </select>
      {knobs(props, 'pedal', (p) => p.name === 'trim')}
      <Tape>{tapeName(rig, d) === 'Guitar Input' ? 'Guitar' : tapeName(rig, d)}</Tape>
    </div>
  );
}

function Interface(props: Props) {
  const vol = props.d.params.volume;
  return (
    <div className="interface">
      <div className="interface-top"><span className="badge">RIG I/O</span><span className="dim-text">monitor</span></div>
      <div className="interface-body">
        <div className="combo-jacks" aria-hidden><span /><span /></div>
        <div className="monitor-knob" style={{ '--v': vol } as CSSProperties}>{knobs(props, 'amp')}</div>
      </div>
      <Tape>{tapeName(props.rig, props.d) === 'Output' ? 'Interface' : tapeName(props.rig, props.d)}</Tape>
    </div>
  );
}

function Brick({ d, rig }: Props) {
  return (
    <div className="brick">
      <span className="brick-led" />
      <span>9V DC · 8 isolated outputs</span>
      <Tape className="side">{tapeName(rig, d)}</Tape>
    </div>
  );
}

function SteelBox(props: Props) {
  return (
    <div className="steelbox small">
      <Screws />
      {def(props.d.type).params.length > 0 && <div className="pedal-knobs">{knobs(props, 'pedal')}</div>}
      <Tape>{tapeName(props.rig, props.d)}</Tape>
    </div>
  );
}

export function Gear(props: Props) {
  switch (props.d.type) {
    case 'amp': return <Amp {...props} />;
    case 'cab': return <Cab {...props} />;
    case 'mic': return <Mic {...props} />;
    case 'input': return <DiBox {...props} />;
    case 'output': return <Interface {...props} />;
    case 'power': return <Brick {...props} />;
    case 'splitter': case 'joiner': return <SteelBox {...props} />;
    case 'wah': case 'volume': return <Treadle {...props} />;
    default: return <Pedal {...props} />;
  }
}

export { PEDALS };
