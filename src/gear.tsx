// How each device looks on the Board, drawn like the real thing: glossy compact stompboxes with a
// hinged pedal plate, tolex amp heads, cabs with grille cloth, mics on boom stands. Every piece
// carries its maker's name, the way a real rig mixes brands (catalog.ts MAKER). A strip of gaffer
// tape marks duplicates and gear that has no power.

import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, ReactNode, WheelEvent } from 'react';
import { def, MAKER, nameOf, VARIANTS, type DeviceType, type Item, type Param } from './catalog';
import { call } from './native';
import { isPowered, placeMic, setParam, toggle, type Device, type Rig } from './rig';

export type Edit = (change: (rig: Rig) => Rig, group?: string) => void;
// Live readouts from the engine, by device id: tuner pitch, looper state, gate open/closed.
export type Live = Record<string, { hz?: number; mode?: string; length?: number; position?: number; open?: boolean }>;
type Props = { d: Device; rig: Rig; edit: Edit; inputs: string[]; live: Live };

const fmt = (p: Param, v: number) => (p.options ? p.options[v] : String(Number(v.toFixed(p.max - p.min > 20 ? 0 : 2))));
const LABELS: Record<string, string> = { makeup: 'gain', predelay: 'pre', feedback: 'repeats', pingpong: 'ping-pong', reference: 'ref', threshold: 'thresh' };
const label = (name: string) => LABELS[name] ?? name;
const UNITS: Record<string, string> = { time: ' ms', predelay: ' ms', release: ' ms', attack: ' ms', decay: ' s', threshold: ' dB', makeup: ' dB', detune: ' ct', interval: ' st', trim: ' dB', reference: ' Hz' };
export const readout = (p: Param, v: number) => fmt(p, v) + (p.options ? '' : (UNITS[p.name] ?? ''));

export const deviceName = (d: Device) => nameOf(d.type, d.params);

// The name on the tape: "Tape Echo", or "Tape Echo 2" when the rig has more than one.
export function tapeName(rig: Rig, d: Device) {
  const name = deviceName(d);
  const same = Object.values(rig.devices).filter((x) => deviceName(x) === name).map((x) => x.id)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return same.length > 1 ? `${name} ${same.indexOf(d.id) + 1}` : name;
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
    if (step) { e.preventDefault(); e.stopPropagation(); onChange(value + (step * (max - min)) / 50); }
  };
}

const sliderProps = (p: Param, value: number) => ({
  role: 'slider', tabIndex: 0, 'aria-label': p.name, 'aria-valuemin': p.min, 'aria-valuemax': p.max,
  'aria-valuenow': value, 'aria-valuetext': readout(p, value), title: `${label(p.name)}: ${readout(p, value)}`,
});
// Double-click resets a control; it must not also open the device window.
const reset = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };

export type KnobStyle = 'small' | 'pedal' | 'amp' | 'big';

// Rotary knob: drag up/down, arrow keys, double-click for default. Choices render as a selector switch.
export function Knob({ p, value, onChange, look = 'small' }: { p: Param; value: number; onChange: (v: number, group?: string) => void; look?: KnobStyle }) {
  if (p.options) return <Selector p={p} value={value} onChange={onChange} />;
  const angle = -150 + ((value - p.min) / (p.max - p.min)) * 300;
  return (
    <div className={`knob knob-${look} nodrag`} {...sliderProps(p, value)}
      onPointerDown={dragger(value, p.min, p.max, onChange)} onKeyDown={arrows(value, p.min, p.max, onChange)} onDoubleClick={reset(() => onChange(p.def))}>
      <svg viewBox="-20 -20 40 40" aria-hidden>
        {(look === 'amp' || look === 'big') && Array.from({ length: 11 }, (_, i) => (
          <line key={i} y1="-19.5" y2={i % 5 === 0 ? -16.5 : -17.8} className="knob-tick" transform={`rotate(${-150 + i * 30})`} />
        ))}
        {look === 'amp' ? (
          <g transform={`rotate(${angle})`}>
            <circle r="11" className="knob-skirt" />
            <path d="M -4.2 6 L -2 -15 Q 0 -16.5 2 -15 L 4.2 6 Q 0 8 -4.2 6 Z" className="knob-head" />
            <line y1="-6" y2="-14" className="knob-mark" />
          </g>
        ) : (
          <>
            <circle r={look === 'small' ? 15 : 14} className="knob-skirt" />
            <circle r={look === 'small' ? 11 : 10} className="knob-cap" />
            <line y1="-3.5" y2={look === 'small' ? -14 : -13} className="knob-mark" transform={`rotate(${angle})`} />
          </>
        )}
      </svg>
      <span>{label(p.name)}</span>
      {look === 'big' && <output>{readout(p, value)}</output>}
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
      onKeyDown={arrows(value, p.min, p.max, onChange)} onDoubleClick={reset(() => onChange(p.def))}>
      <div className="fader-slot"><div className="fader-cap" style={{ bottom: `calc(${frac * 100}% - 5px)` }} /></div>
      <span>{text}</span>
    </div>
  );
}

// Model pickers are nameplates, not knobs. A pedal whose models are separate pedals has none.
const PLATES = new Set(['model', 'body', 'speaker']);
export const plateParams = (type: DeviceType) => def(type).params.filter((p) => PLATES.has(p.name) && !(p.name === 'model' && VARIANTS[type]));
export const knobParams = (type: DeviceType) => def(type).params.filter((p) => !PLATES.has(p.name));

export function ModelPlate({ d, edit, name }: Pick<Props, 'd' | 'edit'> & { name: string }) {
  const p = def(d.type).params.find((x) => x.name === name)!;
  return (
    <select className="plate-select nodrag" aria-label={`${def(d.type).label} ${name}`} value={d.params[name]}
      onChange={(e) => edit((r) => setParam(r, d.id, name, Number(e.target.value)))}>
      {p.options!.map((o, i) => <option key={o} value={i}>{o}</option>)}
    </select>
  );
}

const knobs = ({ d, edit }: Props, look: KnobStyle, only?: (p: Param) => boolean) =>
  knobParams(d.type).filter((p) => !only || only(p)).map((p) => (
    <Knob key={p.name} p={p} look={look} value={d.params[p.name]} onChange={(v, g) => edit((r) => setParam(r, d.id, p.name, v), g)} />
  ));

const Tape = ({ children, className = '' }: { children: ReactNode; className?: string }) => <div className={`tape ${className}`}>{children}</div>;
const Screws = () => <>{['tl', 'tr', 'bl', 'br'].map((c) => <span key={c} className={`screw ${c}`} />)}</>;
// Tape only where a player would put it: to tell two identical pieces apart, or to flag no power.
function TapeIf({ rig, d, className }: { rig: Rig; d: Device; className?: string }) {
  const name = tapeName(rig, d);
  const powered = isPowered(rig, d.id);
  if (name === deviceName(d) && powered) return null;
  return <Tape className={className}>{name}{!powered && <em> · no power</em>}</Tape>;
}

// Enclosure colours: powder coat, each picked so two pedals side by side never look alike.
const PEDALS: Partial<Record<DeviceType, string>> = {
  tuner: '#242427', gate: '#4a4f57', compressor: '#2b5d8f', boost: '#d9d0b4', distortion: '#d9661f', fuzz: '#8e9fb3',
  octave: '#54306f', eq: '#e3e1da', chorus: '#6fb3cc', flanger: '#5f3d8a', phaser: '#c4441c', tremolo: '#1d7468',
  delay: '#2f6b37', reverb: '#22314f', looper: '#7c2230', pitch: '#2f5d8c', acoustic: '#8a5a32',
  wah: '#1c1c1e', volume: '#1c1c1e', amp: '#c9a24e', cab: '#3a342a', mic: '#8d9098', splitter: '#b9babd', joiner: '#b9babd',
  power: '#26262a', input: '#b9babd', output: '#2b2c30',
};
// Pedals that are several pedals in real life, one enclosure colour per model (catalog VARIANTS order).
const MODEL_COLORS: Partial<Record<DeviceType, string[]>> = {
  distortion: ['#3c8a4a', '#e07a1f', '#c9b48a', '#1f1f22'],
  fuzz: ['#8e9fb3', '#b23a2e'],
  boost: ['#d9d0b4', '#b5482a', '#2e6b8f'],
  delay: ['#e2e3e5', '#7a5a3a', '#3d4a7a'],
  reverb: ['#22314f', '#5b6e8f', '#c9c4b8', '#5b4a3a'],
};
export const colorOf = (type: DeviceType, params: Record<string, number> = {}) =>
  MODEL_COLORS[type]?.[params.model ?? 0] ?? PEDALS[type] ?? '#444';

const isLight = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
};

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function TunerScreen({ d, live }: Props) {
  const hz = live[d.id]?.hz ?? 0;
  if (!d.on) return <div className="screen off">stomp to tune</div>;
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

export function LooperScreen({ d, live }: Props) {
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

// Compact stompbox: controls up top with the check light, a big hinged pedal plate you stomp
// (the whole plate is the switch), and the maker's label along the bottom.
function Pedal(props: Props) {
  const { d, rig, edit } = props;
  const color = colorOf(d.type, d.params);
  const plates = plateParams(d.type);
  const powered = isPowered(rig, d.id);
  const looper = d.type === 'looper';
  const mode = props.live[d.id]?.mode;
  const lit = looper ? powered && !!mode && mode !== 'empty' && mode !== 'stopped' : powered && d.on;
  const bands = knobParams(d.type).filter((p) => p.name.endsWith('Hz'));
  const gateOpen = d.type === 'gate' && lit && props.live[d.id]?.open;
  return (
    <div className={`pedal${isLight(color) ? ' light' : ''}`} style={{ '--body': color } as CSSProperties}>
      <div className="pedal-face">
        <div className="pedal-lights">
          <span className={`led${lit ? ' lit' : ''}${mode === 'recording' ? ' rec' : ''}`} title={lit ? 'On' : 'Off'} />
          {d.type === 'gate' && <span className={`led green${gateOpen ? ' lit' : ''}`} title={gateOpen ? 'Gate open: you are playing' : 'Gate closed: muting noise'} />}
        </div>
        {bands.length > 0 && (
          <div className="faders">
            {bands.map((p) => {
              const hz = parseInt(p.name);
              return <Fader key={p.name} p={p} text={hz >= 1000 ? `${hz / 1000}k` : String(hz)}
                value={d.params[p.name]} onChange={(v, g) => edit((r) => setParam(r, d.id, p.name, v), g)} />;
            })}
          </div>
        )}
        {plates.map((p) => <ModelPlate key={p.name} d={d} edit={edit} name={p.name} />)}
        <div className="pedal-knobs">{knobs(props, 'pedal', (p) => !p.name.endsWith('Hz'))}</div>
        {d.type === 'tuner' && <TunerScreen {...props} />}
        {looper && <LooperScreen {...props} />}
      </div>
      <button className="pedal-plate nodrag" aria-label={looper ? 'Looper: record, play, overdub' : `${deviceName(d)} footswitch`}
        aria-pressed={looper ? undefined : d.on}
        onClick={() => (looper ? call('looper', d.id, 'main') : edit((r) => toggle(r, d.id)))}>
        <span className="plate-pad" />
      </button>
      <div className="pedal-label"><b>{MAKER[d.type]}</b><span>{deviceName(d)}</span></div>
      <TapeIf rig={rig} d={d} />
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
      <div className="treadle-maker">{MAKER[d.type]} · {deviceName(d)}</div>
      <TapeIf rig={rig} d={d} />
    </div>
  );
}

function Amp(props: Props) {
  const { rig, d, edit } = props;
  const loaded = rig.cables.some((c) => c.from.device === d.id && c.from.jack === 'speaker');
  return (
    <div className={`amp amp-m${d.params.model}`}>
      <span className="corner tl" /><span className="corner tr" />
      <div className="amp-panel">
        <div className="amp-id"><ModelPlate d={d} edit={edit} name="model" /></div>
        <div className="amp-knobs">{knobs(props, 'amp')}</div>
        <div className="amp-power">
          <span className="toggle" title="Power" /><span className="toggle" title="Standby" />
          <span className="jewel" title="On" />
        </div>
      </div>
      <div className="amp-grille">
        <span className="logo">{MAKER.amp}</span>
        {!loaded && <span className="warn">no load: cable a cab</span>}
      </div>
      <TapeIf rig={rig} d={d} className="on-top" />
    </div>
  );
}

function Cab(props: Props) {
  const { d, rig, edit } = props;
  const size = d.params.size;
  const cones = [1, 2, 4][size];
  const mics = Object.values(rig.devices).filter((m) => m.mic?.cab === d.id).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const sizes = def('cab').params[0].options!;
  return (
    <div className={`cab cab-${size} spk-${d.params.speaker}`}>
      <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
      <div className="cab-grille">
        <span className="logo">{MAKER.cab}</span>
        {Array.from({ length: cones }, (_, i) => (
          <div key={i} className="speaker">
            {/* Each mic gets its own cone, the way a stereo pair is set up on a real cab. */}
            {mics.filter((_, k) => k % cones === i).map((m) => (
              <span key={m.id} className="mic-spot" title={`${tapeName(rig, m)}: ${Math.round(m.mic!.x * 100)}% toward the edge, ${Math.round(m.mic!.distance * 30)} cm back`}
                style={{ left: `${50 + m.mic!.x * 42}%`, width: 18 - m.mic!.distance * 8, height: 18 - m.mic!.distance * 8 }} />
            ))}
          </div>
        ))}
      </div>
      <div className="cab-foot">
        <ModelPlate d={d} edit={edit} name="speaker" />
        <div className="size-pick nodrag" role="radiogroup" aria-label="Cab size">
          {sizes.map((s, i) => (
            <button key={s} role="radio" aria-checked={i === size} className={i === size ? 'on' : ''} onClick={() => edit((r) => setParam(r, d.id, 'size', i))}>{s}</button>
          ))}
        </div>
      </div>
      <TapeIf rig={rig} d={d} className="on-top" />
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

// The three mics, drawn as the classics they're modelled on: a slim dynamic with a tapered grille,
// a ribbon with its slotted bronze body, a large-diaphragm condenser with a mesh head.
export function MicArt({ model }: { model: number }) {
  return (
    <svg viewBox="0 0 80 120" aria-hidden className="mic-art">
      <defs>
        <linearGradient id={`mg${model}`} x1="0" x2="1">
          <stop offset="0" stopColor={['#2a2b2f', '#5a4326', '#9ea1a6'][model]} />
          <stop offset=".45" stopColor={['#5a5c63', '#b8935a', '#f1f2f4'][model]} />
          <stop offset="1" stopColor={['#1b1c1f', '#4a361d', '#8a8d92'][model]} />
        </linearGradient>
        <pattern id={`mesh${model}`} width="3" height="3" patternUnits="userSpaceOnUse">
          <rect width="3" height="3" fill={model === 1 ? '#2b2116' : '#b9bbbf'} />
          <circle cx="1.5" cy="1.5" r=".9" fill={model === 1 ? '#7a5a30' : '#6e7075'} />
        </pattern>
      </defs>
      <path d="M 18 116 L 40 104 L 62 116 M 40 104 L 40 116" className="stand" />
      <line x1="40" y1="104" x2="40" y2="62" className="stand" />
      <circle cx="40" cy="62" r="3" className="stand-joint" />
      <line x1="40" y1="62" x2="40" y2="52" className="stand" />
      {model === 0 && (
        <g>
          <path d="M 35 52 L 34 26 L 46 26 L 45 52 Z" fill={`url(#mg${model})`} />
          <path d="M 34 26 L 33 12 Q 40 4 47 12 L 46 26 Z" fill={`url(#mesh${model})`} stroke="#3a3b3f" />
          <rect x="34" y="25" width="12" height="2" fill="#c9cbcf" />
        </g>
      )}
      {model === 1 && (
        <g>
          <rect x="37" y="42" width="6" height="12" fill="#2a2016" />
          <rect x="27" y="6" width="26" height="38" rx="12" fill={`url(#mg${model})`} />
          <rect x="31" y="11" width="18" height="28" rx="8" fill={`url(#mesh${model})`} />
          {[16, 22, 28, 34].map((y) => <line key={y} x1="31" x2="49" y1={y} y2={y} stroke="#2a2016" strokeWidth="1.4" />)}
        </g>
      )}
      {model === 2 && (
        <g>
          <rect x="31" y="30" width="18" height="24" rx="3" fill={`url(#mg${model})`} />
          <rect x="29" y="4" width="22" height="28" rx="11" fill={`url(#mesh${model})`} stroke="#8a8d92" />
          <circle cx="40" cy="38" r="2" fill="#d9a441" />
        </g>
      )}
    </svg>
  );
}

function Mic(props: Props) {
  const { d, rig, edit } = props;
  const model = d.params.model;
  const models = def('mic').params[0].options!;
  const cab = d.mic && rig.devices[d.mic.cab];
  return (
    <div className="mic">
      <MicArt model={model} />
      <span className="mic-maker">{MAKER.mic}</span>
      <select className="mic-model nodrag" value={model} aria-label="Mic model" onChange={(e) => edit((r) => setParam(r, d.id, 'model', Number(e.target.value)))}>
        {models.map((m, i) => <option key={m} value={i}>{m}</option>)}
      </select>
      <MicControls d={d} edit={edit} look="pedal" />
      <span className="mic-where">{cab ? `on ${tapeName(rig, cab)}` : 'not on a cab'}</span>
      <TapeIf rig={rig} d={d} />
    </div>
  );
}

function DiBox(props: Props) {
  const { d, edit, inputs, rig } = props;
  const channel = { ...def('input').params[0], options: inputs.length ? inputs : ['Input 1'] };
  return (
    <div className="steelbox">
      <Screws />
      <span className="steel-maker">{MAKER.input} DI</span>
      <div className="jack-art" aria-hidden />
      <select className="nodrag" value={d.params.channel} aria-label="Interface input" onChange={(e) => edit((r) => setParam(r, d.id, 'channel', Number(e.target.value)))}>
        {channel.options.map((o, i) => <option key={o} value={i}>{o}</option>)}
      </select>
      {knobs(props, 'pedal', (p) => p.name === 'trim')}
      <button className={`mute-switch nodrag${d.on ? '' : ' muted'}`} aria-pressed={!d.on} onClick={() => edit((r) => toggle(r, d.id))}>
        <span className={`led${d.on ? '' : ' lit'}`} />mute
      </button>
      <TapeIf rig={rig} d={d} />
    </div>
  );
}

function Interface(props: Props) {
  const vol = props.d.params.volume;
  return (
    <div className="interface">
      <div className="interface-top"><span className="badge">{MAKER.output}</span><span className="dim-text">monitor</span></div>
      <div className="interface-body">
        <div className="combo-jacks" aria-hidden><span /><span /></div>
        <div className="monitor-knob" style={{ '--v': vol } as CSSProperties}>{knobs(props, 'amp')}</div>
      </div>
      <TapeIf rig={props.rig} d={props.d} />
    </div>
  );
}

function Brick({ d, rig }: Props) {
  return (
    <div className="brick">
      <span className="brick-led" />
      <span className="brick-maker">{MAKER.power}</span>
      <span>9V DC · 8 isolated outputs</span>
      <TapeIf rig={rig} d={d} className="side" />
    </div>
  );
}

function SteelBox(props: Props) {
  return (
    <div className="steelbox small">
      <Screws />
      <span className="steel-maker">{MAKER[props.d.type]}</span>
      <span className="steel-name">{deviceName(props.d)}</span>
      {knobParams(props.d.type).length > 0 && <div className="pedal-knobs">{knobs(props, 'pedal')}</div>}
      <TapeIf rig={props.rig} d={props.d} />
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

// The gear list's picture of an item: a small drawing of the real thing, not a name.
export function Thumb({ item }: { item: Item }) {
  const params: Record<string, number> = item.model === undefined ? {} : { model: item.model };
  switch (item.type) {
    case 'amp': return <span className="thumb thumb-amp" aria-hidden><i /><i /></span>;
    case 'cab': return <span className="thumb thumb-cab" aria-hidden><i /><i /><i /><i /></span>;
    case 'mic': return <span className="thumb thumb-mic" aria-hidden><MicArt model={0} /></span>;
    case 'power': return <span className="thumb thumb-brick" aria-hidden><i /></span>;
    case 'wah': case 'volume': return <span className="thumb thumb-treadle" aria-hidden><i /></span>;
    case 'input': case 'output': case 'splitter': case 'joiner':
      return <span className={`thumb thumb-steel${item.type === 'output' ? ' dark' : ''}`} aria-hidden><i /><i /></span>;
    default: {
      const color = colorOf(item.type, params);
      const n = Math.min(4, knobParams(item.type).filter((p) => !p.options).length);
      return (
        <span className={`thumb thumb-pedal${isLight(color) ? ' light' : ''}`} style={{ '--body': color } as CSSProperties} aria-hidden>
          <span className="thumb-knobs">{Array.from({ length: n }, (_, i) => <i key={i} />)}</span>
          <span className="thumb-plate" />
          <span className="thumb-label" />
        </span>
      );
    }
  }
}
