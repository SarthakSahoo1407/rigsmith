import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ChevronLeft, ChevronRight, Download, FolderOpen, Keyboard, MicOff, Mic, Redo2, Save, Settings2, Trash2, Undo2, Volume2, VolumeX, X,
} from 'lucide-react';
import { Board, type Edit } from './Board';
import { Picker } from './Picker';
import { LiveMode, type Stage } from './Live';
import { Mixer } from './Mixer';
import { download, failed, models, refresh as refreshLibrary, resolve, setKey, signIn, signOut, tone, useLibrary } from './library';
import { GearDefs, type Live } from './gear';
import { call, inApp, on, type Meter, type State } from './native';
import { DEFAULT_PRESET, PRESETS, SETS } from './presets';
import { commit, compile, history, parseRig, redo, toggle, undo, type History, type Rig } from './rig';
import type { SetScene } from './sets';

type View = 'board' | 'grid' | 'live' | 'mixer';

const AUTOSAVE = '_autosave';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const toLevel = (peak: number) => Math.max(0, Math.min(1, (20 * Math.log10(peak || 1e-6) + 60) / 60));

const KEYS: [string, string][] = [
  ['← →', 'Previous / next preset'], ['V', 'Board / Grid'], ['X', 'Mixer'], ['L', 'Live mode'], ['1 – 9, space', 'In Live mode: pick a scene, next scene (← → too); Q–O stomp'], ['T', 'Tuner'], ['M', 'Mute output'], ['I', 'Mute guitar input'],
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
      <div className={`gb-tuner${inTune ? ' in-tune' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} ref={(el) => el?.focus()} aria-label="Tuner">
        <header><button className="gb-close" aria-label="Close tuner" title="Close (T or Esc)" onClick={onClose} />{input}</header>
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

// Settings: the audio device, the TONE3000 key and sign-in, and the open-source parts inside.
function Settings({ audio, onClose }: { audio: State; onClose: () => void }) {
  const { t3k, signIn: pending } = useLibrary();
  const [key, setKeyText] = useState('');
  const [error, setError] = useState('');
  const latency = (audio.inputMs ?? 0) + (audio.outputMs ?? 0);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" tabIndex={-1} ref={(el) => el?.focus()} aria-label="Settings">
        <header className="inspector-head"><div className="inspector-title"><h2>Settings</h2></div>
          <button className="icon" aria-label="Close" onClick={onClose}><X size={16} strokeWidth={1.5} /></button></header>
        <section>
          <h3>Audio</h3>
          <p className="settings-value">{audio.sampleRate
            ? `${audio.device} · ${(audio.sampleRate / 1000).toFixed(1)} kHz · ${audio.bufferSize} samples${audio.plugin ? '' : ` · ${latency.toFixed(1)} ms`}`
            : 'No audio device'}</p>
          {audio.plugin
            ? <p className="hint">In a DAW, the host chooses the device, rate and buffer.</p>
            : <button className="button quiet" onClick={() => call('openAudioSettings')}>Choose audio device</button>}
          <p className="hint">NAM captures are made at 48 kHz; run your interface at 48 kHz to hear them as made.</p>
        </section>
        <section>
          <h3>TONE3000</h3>
          <p className="hint">Rigsmith downloads NAM captures and IRs from TONE3000 when you ask. Create a free publishable key on tone3000.com under Settings, API.</p>
          <form className="key-form" onSubmit={async (e) => { e.preventDefault(); if (key.trim()) { await setKey(key); setKeyText(''); } }}>
            <label className="field"><span>Key</span>
              <input type="password" value={key} onChange={(e) => setKeyText(e.target.value)} placeholder={t3k.hasKey ? 'Saved. Paste a new one to replace it' : 'Paste your key'} autoComplete="off" />
            </label>
            <button type="submit" className="button" disabled={!key.trim()}>Save key</button>
          </form>
          {t3k.signedIn ? (
            <p className="settings-value"><i className="lamp on" />Signed in{t3k.user ? ` as ${t3k.user}` : ''}
              <button className="text-button" onClick={signOut}>Sign out</button></p>
          ) : pending ? (
            <p className="settings-value">Enter <code className="device-code">{pending.userCode}</code> on tone3000.com to finish</p>
          ) : (
            <button className="button quiet" disabled={!t3k.hasKey} onClick={async () => { const err = await signIn(); if (err) setError(err); }}>Sign in</button>
          )}
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="powered" onClick={() => call('openUrl', 'https://www.tone3000.com')}>Powered by TONE3000</button>
        </section>
        <section>
          <h3>Inside Rigsmith</h3>
          <ul className="credits">
            <li>Neural Amp Modeler core by Steven Atkinson, MIT license</li>
            <li>Eigen, MPL 2.0</li>
            <li>JUCE 8, AGPLv3 or commercial license</li>
            <li>React Flow, MIT · lucide icons, ISC · Geist fonts, SIL OFL 1.1</li>
          </ul>
        </section>
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
  const [settings, setSettings] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [stage, setStage] = useState<Stage>({ set: `b:${Object.keys(SETS)[0]}`, at: -1 });
  const library = useLibrary();

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
    rig = resolve(rig, library.entries).rig;
    edit(() => rig);
    setCurrent(key ? { key, rig } : undefined);
  };
  const load = (key: string) => {
    if (key.startsWith('b:')) {
      const rig = resolve(PRESETS[key.slice(2)].build(), library.entries).rig;
      edit(() => rig);
      setCurrent({ key, rig });
    } else call<string | null>('loadRig', key.slice(2)).then((text) => open(text, key));
  };
  // A preset's rig without putting it on the board (for a live set's scenes).
  const loadPreset = async (key: string): Promise<Rig> => key.startsWith('b:')
    ? PRESETS[key.slice(2)].build()
    : parseRig((await call<string | null>('loadRig', key.slice(2))) ?? 'null');
  const play = (scene: SetScene) => {
    const rig = resolve(scene.rig, library.entries).rig;
    edit(() => rig, `scene:${performance.now()}`);
    setCurrent(scene.from ? { key: scene.from, rig } : undefined);
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

  // Captures the rig uses that aren't on this Mac, and fetching them from TONE3000.
  const missing = h ? resolve(h.present, library.entries).missing : [];
  useEffect(() => {
    if (!h || !library.loaded) return;
    const fixed = resolve(h.present, library.entries).rig;
    if (fixed === h.present) return;
    const wasLoaded = current?.rig === h.present;
    edit(() => fixed, 'resolve');
    if (wasLoaded && current) setCurrent({ ...current, rig: fixed });
  }, [library.entries, h?.present]);
  const fetchMissing = async () => {
    if (!library.t3k.signedIn) { setSettings(true); flash('Sign in to TONE3000 to download the captures'); return; }
    setFetching(true);
    for (const m of missing.filter((x) => x.file.toneId !== undefined)) {
      const t = await tone(m.file.toneId!);
      const list = failed(t) ? t : await models(t.id);
      if (failed(t) || failed(list)) { flash((failed(t) ? t : (list as { error: string })).error); continue; }
      const model = list.data.find((x) => String(x.id) === String(m.file.modelId)) ?? list.data.find((x) => x.size === 'standard') ?? list.data[0];
      if (!model) { flash(`${t.title} has no models to download`); continue; }
      const r = await download(t, model);
      if (failed(r)) flash(r.error);
    }
    await refreshLibrary();
    setFetching(false);
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
    if (settings && k === 'escape') { setSettings(false); return; }
    // Live.tsx has its own keys for scenes and footswitches; tuner, mute and settings still work there.
    if (view === 'live') {
      if (k === 'escape' || k === 'l') { setView('board'); return; }
      if (!'tmi,?'.includes(k)) return;
    }
    const act = {
      l: () => setView('live'),
      arrowleft: () => step(-1), arrowright: () => step(1), '[': () => step(-1), ']': () => step(1),
      v: () => setView((x) => (x === 'board' ? 'grid' : 'board')), x: () => setView((x) => (x === 'mixer' ? 'board' : 'mixer')), m: () => setMute(!muted), i: muteInputs, t: () => setTuner(true), '?': () => setHelp(true), ',': () => setSettings(true),
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
          <button aria-pressed={view === 'mixer'} onClick={() => setView('mixer')} title="Mixer (X)">Mixer</button>
          <button aria-pressed={view === 'live'} onClick={() => setView('live')} title="Live mode (L)">Live</button>
        </div>
        <div className="tool-group">
          <button className="icon" disabled={!h.past.length} onClick={() => apply(undo(h))} title="Undo (⌘Z)" aria-label="Undo"><Undo2 {...icon} /></button>
          <button className="icon" disabled={!h.future.length} onClick={() => apply(redo(h))} title="Redo (⇧⌘Z)" aria-label="Redo"><Redo2 {...icon} /></button>
        </div>
        <div className="preset">
          {saving === null ? (
            <>
              <button className="icon" title="Previous preset (←)" aria-label="Previous preset" onClick={() => step(-1)}><ChevronLeft {...icon} /></button>
              <Picker className="preset-picker" label="Preset" favorites="favs" placeholder="Unsaved rig" value={current?.key} onChange={load}
                options={[
                  ...categories.flatMap((cat) => Object.entries(PRESETS).filter(([, p]) => p.category === cat).map(([n]) => ({ value: `b:${n}`, label: n, group: cat }))),
                  ...presets.map((n) => ({ value: `u:${n}`, label: n, group: 'Your presets' })),
                ]} />
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
          <span className="readout" title={`RAM ${Math.round(meter.ram)} MB`}>
            {audio.sampleRate ? `${latency.toFixed(1)} ms` : 'no audio device'} · CPU {Math.round(meter.cpu * 100)}%
          </span>
          <button className="icon" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}><Keyboard {...icon} /></button>
          <button className="icon" title="Settings (,)" aria-label="Settings" onClick={() => setSettings(true)}><Settings2 {...icon} /></button>
        </div>
      </header>
      {missing.length > 0 && (
        <div className="subbar">
          <div className="missing" role="status">
            <span><i className="lamp warn" />{missing.length} {missing.length === 1 ? 'capture isn\u2019t' : 'captures aren\u2019t'} on this Mac</span>
            {missing.some((m) => m.file.toneId !== undefined)
              ? <button className="text-button" disabled={fetching} onClick={fetchMissing}>{fetching ? 'Downloading' : 'Get from TONE3000'}</button>
              : <span className="hint">Add the file under Captures</span>}
          </div>
        </div>
      )}
      {view === 'live' ? (
        <LiveMode rig={h.present} edit={edit} current={current?.key} presets={presets} loadPreset={loadPreset} play={play}
          stage={stage} setStage={setStage} flash={flash}
          onExit={() => setView('board')} onTune={() => setTuner(true)} muted={muted} onMute={() => setMute(!muted)}
          levels={{ in: meter.peak, out: meter.out }} live={live} />
      ) : view === 'mixer' ? (
        <Mixer rig={h.present} edit={edit} levels={{ in: meter.peak, out: meter.out }} />
      ) : (
        <ReactFlowProvider>
          <Board rig={h.present} view={view} edit={edit} flash={flash} inputs={audio.inputs ?? []} live={live} onSettings={() => setSettings(true)}
            levels={{ in: meter.peak, out: meter.out, cpu: meter.cpu, ram: meter.ram }} />
        </ReactFlowProvider>
      )}
      {settings && <Settings audio={audio} onClose={() => { setSettings(false); refreshLibrary(); }} />}
      {tuning && <Tuner hz={live.__tuner?.hz ?? 0} input={audio.inputs?.[inputs[0]?.params.channel ?? 0] ?? 'Input 1'} onClose={() => setTuner(false)} />}
      {help && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setHelp(false)}>
          <div className="help" role="dialog" aria-modal="true" tabIndex={-1} ref={(el) => el?.focus()} aria-label="Keyboard shortcuts">
            <header className="inspector-head"><div className="inspector-title"><h2>Keyboard shortcuts</h2></div>
              <button className="icon" aria-label="Close" onClick={() => setHelp(false)}><X {...icon} /></button></header>
            <dl>{KEYS.map(([k, what]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>)}</dl>
          </div>
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
