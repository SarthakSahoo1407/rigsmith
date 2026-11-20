import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ChevronLeft, ChevronRight, Download, FolderOpen, Keyboard, MicOff, Mic, Redo2, Save, Settings2, Trash2, Undo2, Volume2, VolumeX, X,
} from 'lucide-react';
import { Board, type Edit, type View } from './Board';
import { GearDefs, type Live } from './gear';
import { call, inApp, on, type Meter, type State } from './native';
import { DEFAULT_PRESET, PRESETS } from './presets';
import { commit, compile, history, parseRig, redo, toggle, undo, type History, type Rig } from './rig';

const AUTOSAVE = '_autosave';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const toLevel = (peak: number) => Math.max(0, Math.min(1, (20 * Math.log10(peak || 1e-6) + 60) / 60));

const KEYS: [string, string][] = [
  ['← →', 'Previous / next preset'], ['V', 'Board / Grid'], ['T', 'Tuner'], ['M', 'Mute output'], ['I', 'Mute guitar input'],
  ['1 – 9', 'Stomp pedal 1–9 in signal order'], ['B', 'Bypass the selected device'], ['P', 'Plug the selected device into power'],
  ['Enter', 'Open the selected device'], ['⌫', 'Delete the selected device or cable'], ['Esc', 'Close / deselect'],
  ['\\', 'Show or hide the gear list'], ['⌘Z  ⇧⌘Z', 'Undo / redo'], ['⌘S', 'Save preset'], ['⌘O  ⌘E', 'Open / export a .rigsmith file'], ['?', 'This list'],
];

// The standalone tuner, styled after a studio app's: an arc from -50 to +50 cents, an orange needle
// with the gap to centre shaded, the note big, Hz and cents either side. The output is muted while open.
const PIVOT = { x: 450, y: 470 };
const polar = (r: number, deg: number) => ({ x: PIVOT.x + r * Math.sin((deg * Math.PI) / 180), y: PIVOT.y - r * Math.cos((deg * Math.PI) / 180) });
const arc = (r: number, from: number, to: number) => {
  const [a, b] = [polar(r, from), polar(r, to)];
  return `M ${a.x} ${a.y} A ${r} ${r} 0 0 ${to > from ? 1 : 0} ${b.x} ${b.y}`;
};
function Tuner({ hz, input, onClose }: { hz: number; input: string; onClose: () => void }) {
  const n = hz ? 12 * Math.log2(hz / 440) + 69 : 0;
  const cents = hz ? Math.round((n - Math.round(n)) * 100) : 0;
  const angle = Math.max(-50, Math.min(50, cents)) * 1.2;
  const inTune = hz > 0 && Math.abs(cents) <= 3;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`gb-tuner${inTune ? ' in-tune' : ''}`} role="dialog" aria-modal="true" aria-label="Tuner">
        <header><button className="gb-close" aria-label="Close tuner" title="Close (T or Esc)" onClick={onClose} autoFocus />{input}</header>
        <div className="gb-face">
          <svg viewBox="0 0 900 560" aria-hidden>
            <path d="M 0 560 L 900 170 L 900 0 L 0 0 Z" fill="rgba(255,255,255,.035)" />
            <path d={arc(300, -60, 60)} stroke="#2a2a2c" strokeWidth="16" fill="none" />
            {Array.from({ length: 21 }, (_, i) => {
              const c = -50 + i * 5, a = polar(292, c * 1.2), b = polar(308, c * 1.2);
              return <line key={c} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#1a1a1b" strokeWidth={c % 10 ? 2 : 3} />;
            })}
            {Array.from({ length: 11 }, (_, i) => {
              const c = -50 + i * 10, p = polar(350, c * 1.2);
              return <text key={c} x={p.x} y={p.y + 9} className="gb-label">{c}</text>;
            })}
            {hz > 0 && (
              <>
                <path d={`M ${polar(150, 0).x} ${polar(150, 0).y} L ${polar(300, 0).x} ${polar(300, 0).y} A 300 300 0 0 ${angle > 0 ? 1 : 0} ${polar(300, angle).x} ${polar(300, angle).y} L ${polar(150, angle).x} ${polar(150, angle).y} Z`} fill="rgba(240,138,36,.16)" />
                <path d={arc(300, 0, angle || 0.01)} stroke="#f08a24" strokeWidth="16" fill="none" opacity=".75" />
                <g className="gb-needle" style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${PIVOT.x}px ${PIVOT.y}px` }}>
                  <line x1={PIVOT.x} y1={PIVOT.y - 150} x2={PIVOT.x} y2={PIVOT.y - 312} stroke="#f08a24" strokeWidth="5" strokeLinecap="round" />
                </g>
              </>
            )}
            <path d={arc(140, -42, 42)} stroke="#3a3a3c" strokeWidth="3" fill="none" />
          </svg>
          <div className="gb-readout" aria-live="polite">
            <span>{hz ? `${hz.toFixed(1)} Hz` : '– Hz'}</span>
            <b>{hz ? NOTES[((Math.round(n) % 12) + 12) % 12] : '–'}</b>
            <span>{hz ? `${cents > 0 ? '+' : ''}${cents} cents` : 'play a string'}</span>
          </div>
        </div>
        <footer>Tuner</footer>
      </div>
    </div>
  );
}

export function App() {
  const [h, setH] = useState<History>();
  const hRef = useRef(h);
  const [view, setView] = useState<View>('board');
  const [toast, setToast] = useState('');
  const [presets, setPresets] = useState<string[]>([]);
  // The preset on screen ('b:' built-in, 'u:' saved) and the rig as it was loaded, to show "edited".
  const [current, setCurrent] = useState<{ key: string; rig: Rig }>();
  const [saving, setSaving] = useState<string | null>(null);
  const [audio, setAudio] = useState<State>();
  const [meter, setMeter] = useState<Meter>({ peak: 0, out: 0, cpu: 0, ram: 0 });
  const [clipAt, setClipAt] = useState(-Infinity);
  const [live, setLive] = useState<Live>({});
  const [muted, setMuted] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [help, setHelp] = useState(false);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? '' : t)), 3000);
  };
  const apply = (next: History) => { hRef.current = next; setH(next); };
  const edit: Edit = (change, group) => {
    const cur = hRef.current;
    if (!cur) return;
    try {
      const next = change(cur.present);
      if (next !== cur.present) apply(commit(cur, next, group));
    } catch (e) {
      flash(message(e));
    }
  };
  const refreshPresets = () => call<string[]>('listRigs').then((l) => setPresets(l.filter((n) => n !== AUTOSAVE)));
  const open = (text: string | null, key?: string) => {
    if (!text) return;
    let rig: Rig;
    try { rig = parseRig(text); } catch (e) { flash(`Can't open that rig: ${message(e)}`); return; }
    edit(() => rig);
    setCurrent(key ? { key, rig } : undefined);
  };
  const load = (key: string) => {
    if (key.startsWith('b:')) {
      const rig = PRESETS[key.slice(2)].build();
      edit(() => rig);
      setCurrent({ key, rig });
    } else call<string | null>('loadRig', key.slice(2)).then((text) => open(text, key));
  };
  const saveAs = async (name: string) => {
    await call('saveRig', name, JSON.stringify(hRef.current!.present));
    await refreshPresets();
    setCurrent({ key: `u:${name}`, rig: hRef.current!.present });
    setSaving(null);
    flash(`Saved ${name}`);
  };
  const importFile = () => call<string | { error: string } | null>('importRig').then((r) => {
    if (r && typeof r === 'object') flash(r.error);
    else open(r);
  });
  const exportFile = () => {
    const name = current?.key.slice(2) ?? 'rig';
    call<boolean>('exportRig', JSON.stringify(hRef.current!.present), name).then((ok) => ok && flash(`Exported ${name}.rigsmith`));
  };

  const categories = [...new Set(Object.values(PRESETS).map((p) => p.category))];
  const order = [
    ...categories.flatMap((cat) => Object.entries(PRESETS).filter(([, p]) => p.category === cat).map(([n]) => `b:${n}`)),
    ...presets.map((n) => `u:${n}`),
  ];
  const step = (dir: number) => {
    const at = current ? order.indexOf(current.key) : -1;
    load(order[(at + dir + order.length) % order.length]);
  };

  const inputs = h ? Object.values(h.present.devices).filter((d) => d.type === 'input') : [];
  const inputMuted = inputs.length > 0 && inputs.every((d) => !d.on);
  const muteInputs = () => edit((r) => inputs.filter((d) => d.on === !inputMuted).reduce((acc, d) => toggle(acc, d.id), r));
  const setMute = (v: boolean) => { setMuted(v); call('set', 'mute', v); };
  const setTuner = (v: boolean) => {
    setTuning(v);
    call('tuner', v, inputs[0]?.params.channel ?? 0);
  };

  // Global keys; Board.tsx handles the ones about the selection.
  const keys = useRef<(e: KeyboardEvent) => void>(undefined);
  keys.current = (e: KeyboardEvent) => {
    if (!hRef.current || (e.target instanceof Element && e.target.closest('input, select, textarea'))) return;
    const k = e.key.toLowerCase();
    if (e.metaKey || e.ctrlKey) {
      const act = { z: () => apply(e.shiftKey ? redo(hRef.current!) : undo(hRef.current!)), s: () => setSaving(current?.key.startsWith('u:') ? current.key.slice(2) : ''), o: importFile, e: exportFile }[k];
      if (act) { e.preventDefault(); act(); }
      return;
    }
    if (e.altKey) return;
    if (tuning && (k === 't' || k === 'escape')) { setTuner(false); return; }
    if (help && (k === 'escape' || k === '?')) { setHelp(false); return; }
    const act = {
      arrowleft: () => step(-1), arrowright: () => step(1), '[': () => step(-1), ']': () => step(1),
      v: () => setView((x) => (x === 'board' ? 'grid' : 'board')), m: () => setMute(!muted), i: muteInputs, t: () => setTuner(true), '?': () => setHelp(true),
    }[k];
    if (act) { e.preventDefault(); act(); }
  };

  useEffect(() => {
    if (!inApp) return;
    call<string | null>('loadRig', AUTOSAVE).then((text) => {
      let rig = PRESETS[DEFAULT_PRESET].build();
      if (text) {
        try { rig = parseRig(text); } catch (e) { flash(`Last session's rig was unreadable, starting fresh: ${message(e)}`); }
      } else setCurrent({ key: `b:${DEFAULT_PRESET}`, rig });
      apply(history(rig));
    });
    refreshPresets();
    call<State>('getState').then(setAudio);
    const offState = on<State>('state', setAudio);
    const offLive = on<Live>('live', setLive);
    const offMeter = on<Meter>('meter', (m) => {
      setMeter(m);
      if (m.peak >= 0.99 || m.out >= 0.99) setClipAt(performance.now());
    });
    const onKey = (e: KeyboardEvent) => keys.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => { offState(); offMeter(); offLive(); window.removeEventListener('keydown', onKey); };
  }, []);

  // The engine plays whatever is on the board, right away.
  useEffect(() => {
    if (h) call('setRig', compile(h.present));
  }, [h?.present]);

  // Autosave half a second after the last change.
  useEffect(() => {
    if (!h) return;
    const t = setTimeout(() => call('saveRig', AUTOSAVE, JSON.stringify(h.present)), 500);
    return () => clearTimeout(t);
  }, [h?.present]);

  if (!inApp) return <div className="banner">Open this inside the Rigsmith app. The browser can't reach the audio engine.</div>;
  if (!h || !audio) return null;

  const setMaster = (value: number) => {
    setAudio({ ...audio, volume: value });
    call('set', 'volume', value);
  };
  const clipping = performance.now() - clipAt < 1000;
  const latency = (audio.inputMs ?? 0) + (audio.outputMs ?? 0);
  const userPreset = current?.key.startsWith('u:') ? current.key.slice(2) : undefined;
  const icon = { size: 16, strokeWidth: 1.5 };

  return (
    <div className="app">
      <GearDefs />
      <header className="topbar">
        <span className="brand"><img src="./mark.svg" alt="" width={24} height={24} />Rigsmith</span>
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={view === 'board'} onClick={() => setView('board')} title="Board (V)">Board</button>
          <button aria-pressed={view === 'grid'} onClick={() => setView('grid')} title="Grid (V)">Grid</button>
        </div>
        <div className="tool-group">
          <button className="icon" disabled={!h.past.length} onClick={() => apply(undo(h))} title="Undo (⌘Z)" aria-label="Undo"><Undo2 {...icon} /></button>
          <button className="icon" disabled={!h.future.length} onClick={() => apply(redo(h))} title="Redo (⇧⌘Z)" aria-label="Redo"><Redo2 {...icon} /></button>
        </div>
        <div className="preset">
          {saving === null ? (
            <>
              <button className="icon" title="Previous preset (←)" aria-label="Previous preset" onClick={() => step(-1)}><ChevronLeft {...icon} /></button>
              <select className="preset-select" aria-label="Preset" value={current?.key ?? ''} onChange={(e) => load(e.target.value)}>
                <option value="" disabled>Unsaved rig</option>
                {categories.map((cat) => (
                  <optgroup key={cat} label={cat}>
                    {Object.entries(PRESETS).filter(([, p]) => p.category === cat).map(([n]) => <option key={n} value={`b:${n}`}>{n}</option>)}
                  </optgroup>
                ))}
                {presets.length > 0 && (
                  <optgroup label="Your presets">
                    {presets.map((n) => <option key={n} value={`u:${n}`}>{n}</option>)}
                  </optgroup>
                )}
              </select>
              <button className="icon" title="Next preset (→)" aria-label="Next preset" onClick={() => step(1)}><ChevronRight {...icon} /></button>
              {current && current.rig !== h.present && <span className="edited">edited</span>}
              <button className="icon" title="Save as preset (⌘S)" aria-label="Save as preset" onClick={() => setSaving(userPreset ?? '')}><Save {...icon} /></button>
              {userPreset && (
                <button className="icon" title={`Delete ${userPreset}`} aria-label={`Delete preset ${userPreset}`} onClick={async () => {
                  await call('deleteRig', userPreset);
                  await refreshPresets();
                  setCurrent(undefined);
                  flash(`Deleted ${userPreset}`);
                }}><Trash2 {...icon} /></button>
              )}
              <button className="icon" title="Open a .rigsmith file (⌘O)" aria-label="Open rig file" onClick={importFile}><FolderOpen {...icon} /></button>
              <button className="icon" title="Export as .rigsmith (⌘E)" aria-label="Export rig file" onClick={exportFile}><Download {...icon} /></button>
            </>
          ) : (
            <form className="save-form" onSubmit={(e) => { e.preventDefault(); if (saving.trim()) saveAs(saving.trim()); }}>
              <input autoFocus value={saving} onChange={(e) => setSaving(e.target.value)} placeholder="Preset name" aria-label="Preset name"
                onKeyDown={(e) => e.key === 'Escape' && setSaving(null)} />
              <button type="submit" className="primary" disabled={!saving.trim()}>Save</button>
              <button type="button" onClick={() => setSaving(null)}>Cancel</button>
            </form>
          )}
        </div>
        <div className="spacer" />
        <div className="io">
          <button className={`tuner-button${tuning ? ' on' : ''}`} onClick={() => setTuner(!tuning)} title="Tuner (T)" aria-pressed={tuning}>Tune</button>
          <button className={`icon${inputMuted ? ' alert' : ''}`} onClick={muteInputs} title={inputMuted ? 'Unmute guitar input (I)' : 'Mute guitar input (I)'} aria-pressed={inputMuted} aria-label="Mute guitar input">
            {inputMuted ? <MicOff {...icon} /> : <Mic {...icon} />}
          </button>
          <div className="meters">
            <div className="meter" role="meter" aria-label="Input level" aria-valuenow={Math.round(toLevel(meter.peak) * 100)} aria-valuemin={0} aria-valuemax={100} title="Input">
              <i style={{ transform: `scaleX(${toLevel(meter.peak)})` }} />
            </div>
            <div className="meter" role="meter" aria-label="Output level" aria-valuenow={Math.round(toLevel(meter.out) * 100)} aria-valuemin={0} aria-valuemax={100} title="Output">
              <i style={{ transform: `scaleX(${toLevel(meter.out)})` }} />
            </div>
          </div>
          <span className={`clip${clipping ? ' on' : ''}`} title="Clip" aria-label={clipping ? 'Clipping' : 'Not clipping'} />
          <button className={`icon${muted ? ' alert' : ''}`} onClick={() => setMute(!muted)} title={muted ? 'Unmute output (M)' : 'Mute output (M)'} aria-pressed={muted} aria-label="Mute output">
            {muted ? <VolumeX {...icon} /> : <Volume2 {...icon} />}
          </button>
          <input className="master" type="range" min={0} max={1} step={0.01} value={audio.volume} aria-label="Master volume" title="Master volume"
            onChange={(e) => setMaster(Number(e.target.value))} />
          <span className="readout">
            {audio.sampleRate ? `${latency.toFixed(1)} ms` : 'no audio device'} · CPU {Math.round(meter.cpu * 100)}% · RAM {Math.round(meter.ram)} MB
          </span>
          <button className="icon" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}><Keyboard {...icon} /></button>
          <button className="icon" title="Audio settings" aria-label="Audio settings" onClick={() => call('openAudioSettings')}><Settings2 {...icon} /></button>
        </div>
      </header>
      <ReactFlowProvider>
        <Board rig={h.present} view={view} edit={edit} flash={flash} inputs={audio.inputs ?? []} live={live}
          levels={{ in: meter.peak, out: meter.out, cpu: meter.cpu, ram: meter.ram }} />
      </ReactFlowProvider>
      {tuning && <Tuner hz={live.__tuner?.hz ?? 0} input={audio.inputs?.[inputs[0]?.params.channel ?? 0] ?? 'Input 1'} onClose={() => setTuner(false)} />}
      {help && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setHelp(false)}>
          <div className="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
            <header className="inspector-head"><div className="inspector-title"><h2>Keyboard shortcuts</h2></div>
              <button className="icon" aria-label="Close" onClick={() => setHelp(false)} autoFocus><X {...icon} /></button></header>
            <dl>{KEYS.map(([k, what]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>)}</dl>
          </div>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
