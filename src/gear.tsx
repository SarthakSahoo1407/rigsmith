// How each device looks on the Board, drawn like the real thing: pedals in the enclosures they're
// modelled on (compact, MXR-style, wide, round fuzz, TS rocker, hammertone) with chrome, cream or
// chicken-head knobs; amp heads in their maker's tolex, tweed and panels; cabs with grille cloth and
// the mics in front of them, seen from behind. Every piece carries its maker (catalog.ts makerOf).
// A strip of gaffer tape marks duplicates and gear that has no power.

import { createContext, useContext, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { ampKnob, def, itemParams, makerOf, nameOf, VARIANTS, type DeviceType, type Item, type Param } from './catalog';
import { LICENSES, useLibrary } from './library';
import { CAB_FOOT, cones, gearSize, MIC_HEAD, micsOn, shapeOf } from './layout';
import {
  ampShell, ampShot, cabShell, cabShot, darkBox, footswitch, jewel, knobBody, knobTop, micBehind, micStanding, pedalShell, pedalShot, speaker, steelShell,
  type Finish,
} from './models';
import { spriteStyle, useSprite, type Model } from './render3d';
import { call } from './native';
import { isPowered, placeMic, setFile, setParam, toggle, type Device, type Rig } from './rig';

const maker = (d: Device) => makerOf(d.type, d.params);

export type Edit = (change: (rig: Rig) => Rig, group?: string) => void;
// Live readouts from the engine, by device id: tuner pitch, looper state, gate open/closed.
export type Live = Record<string, { hz?: number; mode?: string; length?: number; position?: number; open?: boolean; missing?: boolean; wrongRate?: boolean }>;
type Props = { d: Device; rig: Rig; edit: Edit; inputs: string[]; live: Live };

const fmt = (p: Param, v: number) => (p.options ? p.options[v] : String(Number(v.toFixed(p.max - p.min > 20 ? 0 : 2))));
const LABELS: Record<string, string> = { makeup: 'gain', predelay: 'pre', feedback: 'repeats', pingpong: 'ping-pong', reference: 'ref', threshold: 'thresh' };
const label = (name: string) => LABELS[name] ?? name;
const UNITS: Record<string, string> = { time: ' ms', predelay: ' ms', release: ' ms', attack: ' ms', decay: ' s', threshold: ' dB', makeup: ' dB', detune: ' ct', interval: ' st', trim: ' dB', reference: ' Hz', lowCut: ' Hz', highCut: ' Hz', angle: '°', align: ' ms', input: ' dB', output: ' dB', voltage: '%' };
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
// One drawing for every knob: knurled skirt, cap, shine, pointer and a chicken-head; the gear around
// it picks which parts show and in what finish (.cap-chrome, .cap-cream, .cap-chicken, .cap-gold).
export function Knob({ p, value, onChange, look = 'small' }: { p: Param; value: number; onChange: (v: number, group?: string) => void; look?: KnobStyle }) {
  if (p.options) return <Selector p={p} value={value} onChange={onChange} />;
  const angle = -150 + ((value - p.min) / (p.max - p.min)) * 300;
  const scale = look === 'amp' || look === 'big';
  return (
    <div className={`knob knob-${look} nodrag`} {...sliderProps(p, value)}
      onPointerDown={dragger(value, p.min, p.max, onChange)} onKeyDown={arrows(value, p.min, p.max, onChange)} onDoubleClick={reset(() => onChange(p.def))}>
      <svg viewBox={look === 'amp' ? '-25 -25 50 50' : '-20 -20 40 40'} aria-hidden>
        {scale && Array.from({ length: 11 }, (_, i) => {
          const a = ((-150 + i * 30) * Math.PI) / 180;
          return look === 'amp'
            ? <text key={i} x={Math.sin(a) * 21.5} y={-Math.cos(a) * 21.5 + 1.3} className="knob-num">{i}</text>
            : <line key={i} y1="-19.5" y2={i % 5 === 0 ? -16.5 : -17.8} className="knob-tick" transform={`rotate(${-150 + i * 30})`} />;
        })}
        <KnobArt angle={angle} view={look === 'amp' ? 'stand' : 'floor'} />
      </svg>
      <span>{label(p.name)}</span>
      {look === 'big' && <output>{readout(p, value)}</output>}
    </div>
  );
}

// The knob itself: a rendered body and a rendered top that turns (models.ts), or the flat drawing
// until the renders are ready. The finish comes from the gear around it.
const FinishCtx = createContext<Finish>('black');
function KnobArt({ angle, view }: { angle: number; view: 'floor' | 'stand' }) {
  const finish = useContext(FinishCtx);
  const body = useSprite(`kb:${finish}:${view}`, () => knobBody(finish, view));
  const top = useSprite(`kt:${finish}:${view}`, () => knobTop(finish, view));
  if (body && top) {
    return (
      <>
        <image href={body.url} x={body.x} y={body.y} width={body.w} height={body.h} />
        <image href={top.url} x={top.x} y={top.y} width={top.w} height={top.h} transform={`rotate(${angle} ${top.x + top.w / 2} ${top.y + top.h / 2})`} />
      </>
    );
  }
  return (
    <>
      <circle r="14" className="knob-skirt" />
      <circle r="14" className="knob-knurl" />
      <circle r="10.5" className="knob-cap" />
      <circle r="7" className="knob-top" />
      <g transform={`rotate(${angle})`}>
        <path d="M -4.6 7 L -2.2 -15 Q 0 -16.6 2.2 -15 L 4.6 7 Q 0 9.2 -4.6 7 Z" className="knob-head" />
        <line y1="-4" y2="-12.5" className="knob-mark" />
      </g>
    </>
  );
}

// The rendered body of a piece of gear, behind its live controls. Returns the image and the class
// that tells the CSS to stop painting the flat body.
function useShell(key: string, make: () => Model): [ReactNode, string] {
  const s = useSprite(key, make);
  return s ? [<img key="shell" className="shell" src={s.url} alt="" draggable={false} style={spriteStyle(s)} />, ' shelled'] : [null, ''];
}
// A small rendered part centred in its box (footswitch, jewel lamp).
function Part({ k, make, className }: { k: string; make: () => Model; className?: string }) {
  const s = useSprite(k, make);
  if (!s) return null;
  return <img className={`part ${className ?? ''}`} src={s.url} alt="" draggable={false}
    style={{ left: `calc(50% + ${s.x}px)`, top: `calc(50% + ${s.y}px)`, width: s.w, height: s.h }} />;
}

// Gradients and textures every knob and mic shares, defined once for the whole page.
export function GearDefs() {
  const radial = (id: string, stops: [number, string][], cx = '38%', cy = '32%') => (
    <radialGradient id={id} cx={cx} cy={cy} r="75%">{stops.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}</radialGradient>
  );
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        {radial('k-black', [[0, '#4a4a4d'], [0.55, '#151516'], [1, '#050505']])}
        {radial('k-black-top', [[0, '#3a3a3c'], [1, '#121213']])}
        {radial('k-chrome', [[0, '#ffffff'], [0.35, '#d9dade'], [0.7, '#8f9196'], [1, '#e4e5e8']])}
        {radial('k-chrome-top', [[0, '#ffffff'], [0.6, '#c8c9cd'], [1, '#9a9ca1']])}
        {radial('k-cream', [[0, '#fffdf6'], [0.6, '#e9e1cb'], [1, '#b9ad8e']])}
        {radial('k-gold', [[0, '#fff2c4'], [0.5, '#d6b25c'], [1, '#8a6a26']])}
        <linearGradient id="mic-dark" x1="0" x2="1"><stop offset="0" stopColor="#1b1c1f" /><stop offset=".45" stopColor="#5a5c63" /><stop offset="1" stopColor="#141518" /></linearGradient>
        <linearGradient id="mic-bronze" x1="0" x2="1"><stop offset="0" stopColor="#4a361d" /><stop offset=".45" stopColor="#c89f62" /><stop offset="1" stopColor="#3c2b16" /></linearGradient>
        <linearGradient id="mic-silver" x1="0" x2="1"><stop offset="0" stopColor="#8a8d92" /><stop offset=".45" stopColor="#f4f5f7" /><stop offset="1" stopColor="#7d8085" /></linearGradient>
        <linearGradient id="plug-metal" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#8d8f94" /><stop offset=".3" stopColor="#f4f5f7" /><stop offset=".6" stopColor="#a9abaf" /><stop offset="1" stopColor="#5b5d61" /></linearGradient>
        <pattern id="mesh-silver" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#c3c5c9" /><circle cx="1.5" cy="1.5" r=".9" fill="#5e6065" /></pattern>
        <pattern id="mesh-bronze" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#2b2116" /><circle cx="1.5" cy="1.5" r=".9" fill="#8a6634" /></pattern>
      </defs>
    </svg>
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
export const plateParams = (type: DeviceType) => def(type).params.filter((p) => PLATES.has(p.name) && p.name !== VARIANTS[type]?.param);
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
  fuzz: ['#c8302a', '#c9cbcf'],
  boost: ['#d9d0b4', '#b5482a', '#2e6b8f'],
  delay: ['#e2e3e5', '#7a5a3a', '#3d4a7a'],
  reverb: ['#22314f', '#5b6e8f', '#c9c4b8', '#5b4a3a'],
};
// Amps by their panel, cabs by their grille cloth (catalog AMP_MAKERS / CAB_MAKERS order).
const AMP_COLORS = ['#2a2a2c', '#c9a46a', '#b8794a', '#d4b066', '#c9a24e', '#9fa2a6', '#1f1f22', '#e6dcc4', '#b9bcc0'];
const CAB_COLORS = ['#7d766a', '#232324', '#c9a46a', '#a7a9ad'];
export const colorOf = (type: DeviceType, params: Record<string, number> = {}) =>
  type === 'amp' ? AMP_COLORS[params.model ?? 0] : type === 'cab' ? CAB_COLORS[params.speaker ?? 0]
    : MODEL_COLORS[type]?.[params.model ?? 0] ?? PEDALS[type] ?? '#444';

// Knob finish and typeface per pedal, keyed by type, or type + model for pedals with variants.
type Look = { cap: 'black' | 'chrome' | 'cream' | 'chicken' | 'gold'; font: string; upper?: boolean };
const SANS = 'Futura, "Avenir Next", sans-serif', COND = '"Avenir Next Condensed", "Arial Narrow", sans-serif', IMPACT = 'Impact, "Arial Black", sans-serif';
const SCRIPT = '"Snell Roundhand", "Brush Script MT", cursive', SERIF = 'Baskerville, Georgia, serif', TYPE = '"American Typewriter", Courier, serif';
const DIDOT = 'Didot, "Bodoni 72", serif', PLATE = 'Copperplate, "Copperplate Gothic Light", serif';
const LOOKS: Record<string, Look> = {
  tuner: { cap: 'black', font: SANS, upper: true }, gate: { cap: 'black', font: SANS, upper: true },
  compressor: { cap: 'cream', font: SERIF }, boost0: { cap: 'chrome', font: COND, upper: true },
  boost1: { cap: 'chicken', font: SCRIPT }, boost2: { cap: 'black', font: SANS, upper: true },
  distortion0: { cap: 'black', font: IMPACT, upper: true }, distortion1: { cap: 'black', font: SANS, upper: true },
  distortion2: { cap: 'chrome', font: COND, upper: true }, distortion3: { cap: 'black', font: IMPACT, upper: true },
  fuzz0: { cap: 'chrome', font: SCRIPT }, fuzz1: { cap: 'black', font: PLATE, upper: true },
  octave: { cap: 'chrome', font: SANS, upper: true }, eq: { cap: 'black', font: SANS, upper: true },
  chorus: { cap: 'black', font: SANS, upper: true }, flanger: { cap: 'chrome', font: DIDOT },
  phaser: { cap: 'black', font: IMPACT, upper: true }, tremolo: { cap: 'cream', font: SCRIPT },
  delay0: { cap: 'black', font: SANS, upper: true }, delay1: { cap: 'cream', font: TYPE }, delay2: { cap: 'chrome', font: PLATE, upper: true },
  reverb0: { cap: 'black', font: SANS, upper: true }, reverb1: { cap: 'chrome', font: DIDOT },
  reverb2: { cap: 'cream', font: SERIF }, reverb3: { cap: 'chicken', font: TYPE },
  looper: { cap: 'black', font: COND, upper: true }, pitch: { cap: 'chrome', font: COND, upper: true }, acoustic: { cap: 'cream', font: SERIF },
};
const lookOf = (d: Device): Look => LOOKS[`${d.type}${d.params.model ?? ''}`] ?? LOOKS[d.type] ?? { cap: 'black', font: SANS, upper: true };

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

// A stompbox in its enclosure. Compact: a hinged plate is the switch and the maker's label runs
// along the bottom. Everything else: a big printed name and a chrome stomp button (a TS-style
// rocker on the screamer).
function Pedal(props: Props) {
  const { d, rig, edit } = props;
  const color = colorOf(d.type, d.params);
  const shape = shapeOf(d.type, d.params);
  const look = lookOf(d);
  const plates = plateParams(d.type);
  const powered = isPowered(rig, d.id);
  const looper = d.type === 'looper';
  const mode = props.live[d.id]?.mode;
  const lit = looper ? powered && !!mode && mode !== 'empty' && mode !== 'stopped' : powered && d.on;
  const bands = knobParams(d.type).filter((p) => p.name.endsWith('Hz'));
  const gateOpen = d.type === 'gate' && lit && props.live[d.id]?.open;
  const stomp = {
    'aria-label': looper ? 'Looper: record, play, overdub' : `${deviceName(d)} footswitch`,
    'aria-pressed': looper ? undefined : d.on,
    onClick: () => (looper ? call('looper', d.id, 'main') : edit((r) => toggle(r, d.id))),
  };
  const size = gearSize(d);
  const [shell, shelled] = useShell(`pedal:${shape}:${color}:${size.w}x${size.h}`, () => pedalShell(shape, size.w, size.h, color));
  return (
    <FinishCtx.Provider value={look.cap}>
    <div className={`pedal shape-${shape} cap-${look.cap}${isLight(color) ? ' light' : ''}${shelled}`} style={{ '--body': color } as CSSProperties}>
      {shell}
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
        {d.type === 'namPedal' && <CaptureSelect d={d} edit={edit} slot="model" kind="nam" label="Capture" />}
        <div className="pedal-knobs">{knobs(props, 'pedal', (p) => !p.name.endsWith('Hz'))}</div>
        {d.type === 'tuner' && <TunerScreen {...props} />}
        {looper && <LooperScreen {...props} />}
      </div>
      {shape === 'compact' ? (
        <>
          <button className="pedal-plate nodrag" {...stomp}><span className="plate-pad" /></button>
          <div className="pedal-label"><b>{maker(d)}</b><span>{deviceName(d)}</span></div>
        </>
      ) : (
        <>
          <div className={`pedal-name${look.upper ? ' upper' : ''}`} style={{ fontFamily: look.font }}>{d.type === 'namPedal' ? d.files?.model?.name ?? 'NAM' : deviceName(d)}</div>
          <div className="pedal-maker">{maker(d)}</div>
          {shape === 'screamer'
            ? <button className="rocker-switch nodrag" {...stomp}><span /></button>
            : <button className="stomp nodrag" {...stomp}><span className="stomp-cap" /><Part k="footswitch" make={footswitch} /></button>}
        </>
      )}
      <TapeIf rig={rig} d={d} />
    </div>
    </FinishCtx.Provider>
  );
}

// Wah and volume: a rocking treadle. Drag it, or scroll over it.
function Treadle(props: Props) {
  const { d, rig, edit } = props;
  const pos = d.params.position;
  const p = def(d.type).params.find((x) => x.name === 'position')!;
  const set = (v: number, g?: string) => edit((r) => setParam(r, d.id, 'position', v), g);
  const powered = isPowered(rig, d.id);
  const size = gearSize(d);
  const [shell, shelled] = useShell(`treadle:${size.w}x${size.h}`, () => pedalShell('stomp', size.w, size.h, '#1b1b1c', true));
  return (
    <div className={`treadle${shelled}`}>
      {shell}
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
      <div className="treadle-maker">{maker(d)} · {deviceName(d)}</div>
      <TapeIf rig={rig} d={d} />
    </div>
  );
}

// American-style amps carry their controls on a top panel; British and modern ones below the grille.
const PANEL_TOP = new Set([0, 1, 2, 8]);
const AMP_CAP = ['black', 'chicken', 'chicken', 'gold', 'gold', 'black', 'chrome', 'cream', 'black'];

function Amp(props: Props) {
  const { rig, d, edit } = props;
  const m = d.params.model;
  const loaded = rig.cables.some((c) => c.from.device === d.id && c.from.jack === 'speaker');
  const size = gearSize(d);
  const [shell, shelled] = useShell(`amp:${m}:${size.w}x${size.h}`, () => ampShell(size.w, size.h, m));
  return (
    <FinishCtx.Provider value={AMP_CAP[m] as Finish}>
    <div className={`amp m${m}${PANEL_TOP.has(m) ? ' panel-top' : ''} cap-${AMP_CAP[m]}${shelled}`}>
      {shell}
      <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
      <span className="amp-handle" />
      <div className="amp-face">
        <div className="amp-grille">
          <span className="amp-plate"><b>{maker(d)}</b><i>{deviceName(d)}</i></span>
          {!loaded && <span className="warn">no load: cable a cab</span>}
        </div>
        <div className="amp-panel">
          <AmpChannel {...props} />
          <div className="amp-knobs">{ampFace(props)}</div>
          <div className="amp-switches">
            {AMP_SWITCHES.map((name) => (
              <button key={name} className={`mini-toggle nodrag${d.params[name] ? ' up' : ''}`} aria-pressed={!!d.params[name]}
                onClick={() => edit((r) => setParam(r, d.id, name, d.params[name] ? 0 : 1))}><i />{name}</button>
            ))}
          </div>
          <div className="amp-power">
            <span className="toggle" title="Power" /><span className="toggle" title="Standby" />
            <Jewel lit={loaded} />
          </div>
        </div>
      </div>
      <TapeIf rig={rig} d={d} className="on-top" />
    </div>
    </FinishCtx.Provider>
  );
}

// The amber jewel pilot lamp: lit only when the gear is passing sound.
function Jewel({ lit }: { lit: boolean }) {
  return <span className={`jewel${lit ? ' lit' : ''}`} title={lit ? 'On' : 'Not passing sound'}><Part k={`jewel:${lit}`} make={() => jewel(lit)} /></span>;
}

// The face knobs follow the channel: the clean and lead channels have their own gain and EQ.
const AMP_FACE = ['gain', 'bass', 'mid', 'treble', 'presence', 'master'];
export const AMP_SWITCHES = ['bright', 'deep', 'fat'];
export const ampFace = ({ d, edit }: Pick<Props, 'd' | 'edit'>, look: KnobStyle = 'amp') => AMP_FACE.map((name) => {
  const real = ampKnob(name, d.params.channel);
  const p = def('amp').params.find((x) => x.name === real)!;
  return <Knob key={name} p={{ ...p, name }} look={look} value={d.params[real]} onChange={(v, g) => edit((r) => setParam(r, d.id, real, v), g)} />;
});

// The channel switch: three lamps, like a footswitchable head's front panel.
export function AmpChannel({ d, edit }: Pick<Props, 'd' | 'edit'>) {
  const names = def('amp').params.find((p) => p.name === 'channel')!.options!;
  return (
    <div className="amp-channels nodrag" role="radiogroup" aria-label="Channel">
      {names.map((n, i) => (
        <button key={n} role="radio" aria-checked={d.params.channel === i} className={d.params.channel === i ? 'on' : ''}
          onClick={() => edit((r) => setParam(r, d.id, 'channel', i))}><i />{n}</button>
      ))}
    </div>
  );
}

// Picks a library file for a device slot. Shows the file's creator and license, as TONE3000 asks.
export function CaptureSelect({ d, edit, slot, kind, label }: Pick<Props, 'd' | 'edit'> & { slot: string; kind: 'nam' | 'ir'; label?: string }) {
  const { entries } = useLibrary();
  const files = entries.filter((e) => e.kind === kind);
  const current = d.files?.[slot];
  const known = !current || files.some((e) => e.id === current.id);
  return (
    <select className="capture-select nodrag" aria-label={label ?? `${slot} file`} value={current?.id ?? ''}
      onChange={(e) => {
        const entry = files.find((f) => f.id === e.target.value);
        edit((r) => setFile(r, d.id, slot, entry && { id: entry.id, name: entry.name, kind: entry.kind, source: entry.source, author: entry.author,
          authorUrl: entry.authorUrl, license: entry.license, toneId: entry.toneId, modelId: entry.modelId, toneUrl: entry.toneUrl, gear: entry.gear }));
      }}>
      <option value="">{files.length ? `Choose ${kind === 'nam' ? 'a capture' : 'an IR'}` : `No ${kind === 'nam' ? 'captures' : 'IRs'} yet`}</option>
      {!known && <option value={current.id}>{current.name} (not on this Mac)</option>}
      {files.map((f) => <option key={f.id} value={f.id}>{f.name}{f.author ? ` · ${f.author}` : ''}</option>)}
    </select>
  );
}

export const credit = (f?: { author?: string; license?: string }) =>
  f && [f.author, f.license && (LICENSES[f.license] ?? f.license)].filter(Boolean).join(' · ');

// A NAM amp or full-rig capture: a plain head with the capture on its plate and its levels.
function NamHead(props: Props) {
  const { d, rig, edit, live } = props;
  const f = d.files?.model;
  const state = live[d.id];
  const loaded = d.type === 'namRig' || rig.cables.some((c) => c.from.device === d.id && c.from.jack === 'speaker');
  const size = gearSize(d);
  const [shell, shelled] = useShell(`amp:6:${size.w}x${size.h}`, () => ampShell(size.w, size.h, 6));
  return (
    <FinishCtx.Provider value="chrome">
    <div className={`amp nam-head cap-chrome${shelled}`}>
      {shell}
      <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
      <span className="amp-handle" />
      <div className="amp-face">
        <div className="amp-grille">
          <span className="amp-plate"><b>{f ? f.name : 'Neural capture'}</b><i>{d.type === 'namRig' ? 'NAM full rig' : 'NAM amp'}{f && credit(f) ? ` · ${credit(f)}` : ''}</i></span>
          {state?.missing && <span className="warn">capture file missing</span>}
          {!state?.missing && state?.wrongRate && <span className="warn">set the interface to 48 kHz</span>}
          {!loaded && <span className="warn">no load: cable a cab</span>}
        </div>
        <div className="amp-panel">
          <CaptureSelect d={d} edit={edit} slot="model" kind="nam" label="Capture" />
          <div className="amp-knobs">{knobs(props, 'amp')}</div>
          <div className="amp-power"><Jewel lit={loaded && !!f && !state?.missing} /></div>
        </div>
      </div>
      <TapeIf rig={rig} d={d} className="on-top" />
    </div>
    </FinishCtx.Provider>
  );
}

// The speakers show faintly through the cloth, so you can see where the mics point.
function Cab(props: Props) {
  const { d, rig, edit } = props;
  const size = d.params.size;
  const sizes = def('cab').params[0].options!;
  const mics = micsOn(rig, d.id);
  const models = def('mic').params[0].options!;
  const box = gearSize(d);
  const [shell, shelled] = useShell(`cab:${box.w}x${box.h}:${d.params.speaker}`, () => cabShell(box.w, box.h, d.params.speaker));
  return (
    <div className={`cab s${d.params.speaker}${shelled}`}>
      {shell}
      <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
      <div className="cab-grille" style={{ bottom: CAB_FOOT }} />
      {cones(size).map((c, i) => <Speaker key={i} x={c.x} y={c.y} r={c.r} kind={d.params.speaker} />)}
      <span className="cab-logo" style={{ bottom: CAB_FOOT + 10 }}>{maker(d)}</span>
      <div className="cab-foot" style={{ height: CAB_FOOT }}>
        <div className="cab-row">
          <span className="cab-spk">{d.params.source === 1 ? `IR · ${[d.files?.irA?.name, d.files?.irB?.name].filter(Boolean).join(' + ') || 'no IR loaded'}` : def('cab').params[1].options![d.params.speaker]}</span>
          <div className="size-pick nodrag" role="radiogroup" aria-label="Cab size">
            {sizes.map((s, i) => (
              <button key={s} role="radio" aria-checked={i === size} className={i === size ? 'on' : ''} onClick={() => edit((r) => setParam(r, d.id, 'size', i))}>{s}</button>
            ))}
          </div>
        </div>
        <div className="cab-row">
          {mics.length === 0 && <span className="cab-spk">drag a mic onto the cab</span>}
          {mics.map((m) => (
            <label key={m.id} className="cab-mic">{tapeName(rig, m)}
              <select className="nodrag" value={m.params.model} onChange={(e) => edit((r) => setParam(r, m.id, 'model', Number(e.target.value)))}>
                {models.map((o, i) => <option key={o} value={i}>{o}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>
      <TapeIf rig={rig} d={d} className="on-top" />
    </div>
  );
}

// One speaker behind the grille: rendered, or a faint circle until the render is ready.
function Speaker({ x, y, r, kind }: { x: number; y: number; r: number; kind: number }) {
  const s = useSprite(`spk:${Math.round(r)}:${kind}`, () => speaker(Math.round(r), kind));
  return s
    ? <img className="speaker-art" src={s.url} alt="" draggable={false} style={{ left: x - r + s.x, top: y - r + s.y, width: s.w, height: s.h }} />
    : <span className="speaker" style={{ left: x - r, top: y - r, width: 2 * r, height: 2 * r }} />;
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
  const s = useSprite(`mic-up:${model}`, () => micStanding(model));
  if (s) return <img className="mic-art" src={s.url} alt="" draggable={false} />;
  return (
    <svg viewBox="0 0 80 120" aria-hidden className="mic-art">
      <path d="M 18 116 L 40 104 L 62 116 M 40 104 L 40 116" className="stand" />
      <line x1="40" y1="104" x2="40" y2="62" className="stand" />
      <circle cx="40" cy="62" r="3" className="stand-joint" />
      <line x1="40" y1="62" x2="40" y2="52" className="stand" />
      {model === 0 && (
        <g>
          <path d="M 35 52 L 34 26 L 46 26 L 45 52 Z" fill="url(#mic-dark)" />
          <path d="M 34 26 L 33 12 Q 40 4 47 12 L 46 26 Z" fill="url(#mesh-silver)" stroke="#3a3b3f" />
          <rect x="34" y="25" width="12" height="2" fill="#c9cbcf" />
        </g>
      )}
      {model === 1 && (
        <g>
          <rect x="37" y="42" width="6" height="12" fill="#2a2016" />
          <rect x="27" y="6" width="26" height="38" rx="12" fill="url(#mic-bronze)" />
          <rect x="31" y="11" width="18" height="28" rx="8" fill="url(#mesh-bronze)" />
          {[16, 22, 28, 34].map((y) => <line key={y} x1="31" x2="49" y1={y} y2={y} stroke="#2a2016" strokeWidth="1.4" />)}
        </g>
      )}
      {model === 2 && (
        <g>
          <rect x="31" y="30" width="18" height="24" rx="3" fill="url(#mic-silver)" />
          <rect x="29" y="4" width="22" height="28" rx="11" fill="url(#mesh-silver)" stroke="#8a8d92" />
          <circle cx="40" cy="38" r="2" fill="#d9a441" />
        </g>
      )}
    </svg>
  );
}

// A mic on a cab, seen from behind the way you'd see it at a session: its head on the cone, the
// body coming toward you, the XLR cable out of the back, a boom arm from the side. The farther
// back it stands, the smaller the head. Scroll over it to move it closer or farther.
function MicOnCab({ d, edit }: Props) {
  const model = d.params.model;
  const shrink = 1 - d.mic!.distance * 0.3;
  const body = ['url(#mic-dark)', 'url(#mic-bronze)', 'url(#mic-silver)'][model];
  const art = useSprite(`mic-back:${model}`, () => micBehind(model));
  if (art) {
    return (
      <div className="mic-front nowheel" title="Drag across the cone to move it, scroll to move it closer or farther"
        onWheel={(e: WheelEvent) => edit((r) => placeMic(r, d.id, { ...d.mic!, distance: Math.min(1, Math.max(0, d.mic!.distance + e.deltaY * 0.002)) }), `wheel:${d.id}`)}>
        <div className="mic-rendered" style={{ left: MIC_HEAD.x, top: MIC_HEAD.y, transform: `scale(${shrink})` }}>
          <img src={art.url} alt="" draggable={false} style={spriteStyle(art)} />
        </div>
      </div>
    );
  }
  return (
    <div className="mic-front nowheel" title="Drag across the cone to move it, scroll to move it closer or farther"
      onWheel={(e: WheelEvent) => edit((r) => placeMic(r, d.id, { ...d.mic!, distance: Math.min(1, Math.max(0, d.mic!.distance + e.deltaY * 0.002)) }), `wheel:${d.id}`)}>
      <svg viewBox="0 0 64 172" aria-hidden>
        <path d="M 36 96 L 90 124" stroke="#1c1c1e" strokeWidth="5" strokeLinecap="round" />
        <path d="M 32 150 L 32 172" stroke="#0e0e10" strokeWidth="6" />
        <g transform={`translate(32 22) scale(${shrink}) translate(-32 -22)`}>
          {model === 1 ? (
            <>
              <path d="M 22 30 L 18 138 Q 32 146 46 138 L 42 30 Z" fill={body} />
              <rect x="14" y="6" width="36" height="30" rx="10" fill={body} />
              <rect x="18" y="10" width="28" height="22" rx="7" fill="url(#mesh-bronze)" />
            </>
          ) : (
            <>
              <path d={model === 2 ? 'M 22 32 L 19 138 Q 32 146 45 138 L 42 32 Z' : 'M 26 28 L 22 138 Q 32 145 42 138 L 38 28 Z'} fill={body} />
              <ellipse cx="32" cy="22" rx={model === 2 ? 17 : 13} ry={model === 2 ? 15 : 11} fill="url(#mesh-silver)" stroke={model === 2 ? '#d9a441' : '#cfd1d5'} strokeWidth="2" />
            </>
          )}
        </g>
        <circle cx="36" cy="96" r="4" fill="#3a3a3e" />
        <rect x="23" y="136" width="18" height="16" rx="3" fill="url(#mic-silver)" />
      </svg>
    </div>
  );
}

function Mic(props: Props) {
  const { d, rig, edit } = props;
  if (d.mic && rig.devices[d.mic.cab]) return <MicOnCab {...props} />;
  const model = d.params.model;
  const models = def('mic').params[0].options!;
  const cab = d.mic && rig.devices[d.mic.cab];
  return (
    <div className="mic">
      <MicArt model={model} />
      <span className="mic-maker">{maker(d)}</span>
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
  const size = gearSize(d);
  const [shell, shelled] = useShell(`steel:${size.w}x${size.h}`, () => steelShell(size.w, size.h));
  return (
    <div className={`steelbox${shelled}`}>
      {shell}
      <Screws />
      <span className="steel-maker">{maker(d)} DI</span>
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
  const size = gearSize(props.d);
  const [shell, shelled] = useShell(`dark:${size.w}x${size.h}:40`, () => darkBox(size.w, size.h, 40));
  return (
    <div className={`interface${shelled}`}>
      {shell}
      <div className="interface-top"><span className="badge">{maker(props.d)}</span><span className="dim-text">monitor</span></div>
      <div className="interface-body">
        <div className="combo-jacks" aria-hidden><span /><span /></div>
        <div className="monitor-knob" style={{ '--v': vol } as CSSProperties}>{knobs(props, 'amp')}</div>
      </div>
      <TapeIf rig={props.rig} d={props.d} />
    </div>
  );
}

function Brick({ d, rig }: Props) {
  const size = gearSize(d);
  const [shell, shelled] = useShell(`dark:${size.w}x${size.h}:24`, () => darkBox(size.w, size.h, 24));
  return (
    <div className={`brick${shelled}`}>
      {shell}
      <span className="brick-led" />
      <span className="brick-maker">{maker(d)}</span>
      <span>9V DC · 8 isolated outputs</span>
      <TapeIf rig={rig} d={d} className="side" />
    </div>
  );
}

function SteelBox(props: Props) {
  const size = gearSize(props.d);
  const [shell, shelled] = useShell(`steel:${size.w}x${size.h}`, () => steelShell(size.w, size.h));
  return (
    <div className={`steelbox small${shelled}`}>
      {shell}
      <Screws />
      <span className="steel-maker">{maker(props.d)}</span>
      <span className="steel-name">{deviceName(props.d)}</span>
      {knobParams(props.d.type).length > 0 && <div className="pedal-knobs">{knobs(props, 'pedal')}</div>}
      <TapeIf rig={props.rig} d={props.d} />
    </div>
  );
}

export function Gear(props: Props) {
  switch (props.d.type) {
    case 'amp': return <Amp {...props} />;
    case 'namAmp': case 'namRig': return <NamHead {...props} />;
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
  const params = itemParams(item);
  const shot = useShot(item.type, params);
  if (shot) return <img className="thumb thumb-shot" src={shot.url} alt="" draggable={false} />;
  switch (item.type) {
    case 'amp': return <span className={`thumb thumb-amp m${params.model}`} aria-hidden><i /><i /></span>;
    case 'cab': return <span className={`thumb thumb-cab s${params.speaker}`} aria-hidden><i /><i /><i /><i /></span>;
    case 'mic': return <span className="thumb thumb-mic" aria-hidden><MicArt model={0} /></span>;
    case 'power': return <span className="thumb thumb-brick" aria-hidden><i /></span>;
    case 'wah': case 'volume': return <span className="thumb thumb-treadle" aria-hidden><i /></span>;
    case 'input': case 'output': case 'splitter': case 'joiner':
      return <span className={`thumb thumb-steel${item.type === 'output' ? ' dark' : ''}`} aria-hidden><i /><i /></span>;
    default: {
      const color = colorOf(item.type, params);
      const shape = shapeOf(item.type, params);
      const n = Math.min(shape === 'wide' ? 5 : shape === 'round' ? 2 : 3, knobParams(item.type).filter((p) => !p.options).length);
      return (
        <span className={`thumb thumb-pedal t-${shape}${isLight(color) ? ' light' : ''}`} style={{ '--body': color } as CSSProperties} aria-hidden>
          <span className="thumb-knobs">{Array.from({ length: n }, (_, i) => <i key={i} />)}</span>
          {shape === 'compact' ? <span className="thumb-plate" /> : <span className="thumb-stomp" />}
          {shape === 'compact' && <span className="thumb-label" />}
        </span>
      );
    }
  }
}

// A small rendered picture of the whole thing, for the gear list, grid tiles and Live mode.
export const useShot = (type: DeviceType, params: Record<string, number>) => {
  const key = `${type}:${['model', 'speaker', 'size'].map((k) => params[k] ?? '').join(':')}`;
  return useSprite(`shot:${key}`, () => shotOf(type, params));
};
function shotOf(type: DeviceType, params: Record<string, number>): Model {
  const size = gearSize({ id: '', type, params, on: true, pos: { board: { x: 0, y: 0 }, grid: { x: 0, y: 0 } } });
  switch (type) {
    case 'amp': return ampShot(params.model ?? 0);
    case 'namAmp': case 'namRig': return ampShot(6, 540, 200);
    case 'cab': return cabShot(params.speaker ?? 0);
    case 'mic': return micStanding(params.model ?? 0);
    case 'input': case 'splitter': case 'joiner': return { ...steelShell(size.w, size.h), scale: 0.7 };
    case 'output': return { ...darkBox(size.w, size.h, 40), scale: 0.7 };
    case 'power': return { ...darkBox(size.w, size.h, 24), scale: 0.6 };
    case 'wah': case 'volume': return { ...pedalShell('stomp', size.w, size.h, '#1b1b1c', true), scale: 0.7 };
    default: {
      const shape = shapeOf(type, params);
      const look = LOOKS[`${type}${params.model ?? ''}`] ?? LOOKS[type] ?? { cap: 'black' };
      return pedalShot(shape, size.w, size.h, colorOf(type, params), knobParams(type).filter((p) => !p.options).length, look.cap);
    }
  }
}
