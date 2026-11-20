import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ChevronLeft, ChevronRight, Download, FolderOpen, Keyboard, MicOff, Mic, Redo2, Save, Settings2, Trash2, Undo2, Volume2, VolumeX, X,
} from 'lucide-react';
import { Board, type Edit } from './Board';
import { PresetPicker } from './PresetPicker';
import { LiveMode, type Stage } from './Live';
import { download, failed, models, refresh as refreshLibrary, resolve, setKey, signIn, signOut, tone, useLibrary } from './library';
import { focusOnOpen, GearDefs, pitchOf, tuneColor, useSmoothed, type Live } from './gear';
import { call, cpuText, inApp, on, type Meter, type State } from './native';
import { DEFAULT_PRESET, PRESET_CAPTURES, PRESETS, SETS } from './presets';
import { commit, compile, history, parseRig, redo, toggle, undo, type FileRef, type History, type Rig } from './rig';
import type { SetScene } from './sets';

type View = 'board' | 'grid' | 'live';

const AUTOSAVE = '_autosave';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toLevel = (peak: number) => Math.max(0, Math.min(1, (20 * Math.log10(peak || 1e-6) + 60) / 60));

const KEYS: [string, string][] = [
  ['← →', 'Previous / next preset'], ['V', 'Board / Grid'], ['L', 'Live mode'], ['1 – 9, space', 'In Live mode: pick a scene, next scene (← → too); Q–O stomp'], ['T', 'Tuner'], ['M', 'Mute output'], ['I', 'Mute guitar input'],
  ['1 – 9', 'Stomp pedal 1–9 in signal order'], ['B', 'Bypass the selected device'], ['P', 'Plug the selected device into power'],
  ['Enter', 'Open the selected device'], ['⌫', 'Delete the selected device or cable'], ['Esc', 'Close / deselect'],
  ['\\', 'Show or hide the gear list'], ['⌘Z  ⇧⌘Z', 'Undo / redo'], ['⌘S', 'Save preset'], ['⌘O  ⌘E', 'Open / export a .rigsmith file'], ['?', 'This list'],
];

// The standalone tuner, styled after a studio app's: an arc from -50 to +50 cents, a needle that glides
// to the pitch, the note big, Hz and cents either side. Colour says how close: green in tune, then
// yellow, orange, red. Reference pitch (A4) and mute or bypass while tuning are set at the bottom.
const PIVOT = { x: 450, y: 470 };
const polar = (r: number, deg: number) => ({ x: PIVOT.x + r * Math.sin((deg * Math.PI) / 180), y: PIVOT.y - r * Math.cos((deg * Math.PI) / 180) });
const arc = (r: number, from: number, to: number) => {
  const [a, b] = [polar(r, from), polar(r, to)];
  return `M ${a.x} ${a.y} A ${r} ${r} 0 0 ${to > from ? 1 : 0} ${b.x} ${b.y}`;
};
const TUNE_COLORS = { green: '#3ecf6e', yellow: '#e6c23a', orange: '#f08a24', red: '#e5484d' };
type TunerPrefs = { reference: number; mute: boolean };
function Tuner({ hz, input, prefs, setPrefs, onClose }: { hz: number; input: string; prefs: TunerPrefs; setPrefs: (p: TunerPrefs) => void; onClose: () => void }) {
  const pitch = pitchOf(hz, prefs.reference);
  const cents = pitch ? Math.round(pitch.cents) : 0;
  const angle = useSmoothed(pitch ? Math.max(-50, Math.min(50, pitch.cents)) * 1.2 : 0);
  const color = TUNE_COLORS[pitch ? tuneColor(pitch.cents) : 'orange'];
  const ref = (v: number) => setPrefs({ ...prefs, reference: Math.max(430, Math.min(450, v)) });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`gb-tuner${pitch ? ` tune-${tuneColor(pitch.cents)}` : ''}`} style={{ '--tune': color } as CSSProperties} role="dialog" aria-modal="true" tabIndex={-1} ref={focusOnOpen} aria-label="Tuner">
        <header><button className="gb-close" aria-label="Close tuner" title="Close (T or Esc)" onClick={onClose} />{input}</header>
        <div className="gb-face">
          <svg viewBox="0 0 900 560" aria-hidden>
            <path d="M 0 560 L 900 170 L 900 0 L 0 0 Z" fill="rgba(255,255,255,.035)" />
            <path d={arc(300, -60, 60)} stroke="#2a2a2c" strokeWidth="16" fill="none" />
            {/* the zones: green ±3, yellow ±10, orange ±25, red beyond */}
            {([[-50, -25, 'red'], [-25, -10, 'orange'], [-10, -3, 'yellow'], [-3, 3, 'green'], [3, 10, 'yellow'], [10, 25, 'orange'], [25, 50, 'red']] as const).map(([a, b, c]) => (
              <path key={a} d={arc(326, a * 1.2, b * 1.2)} stroke={TUNE_COLORS[c]} strokeWidth="6" fill="none" opacity=".55" />
            ))}
            {Array.from({ length: 21 }, (_, i) => {
              const c = -50 + i * 5, a = polar(292, c * 1.2), b = polar(308, c * 1.2);
              return <line key={c} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#1a1a1b" strokeWidth={c % 10 ? 2 : 3} />;
            })}
            {Array.from({ length: 11 }, (_, i) => {
              const c = -50 + i * 10, p = polar(356, c * 1.2);
              return <text key={c} x={p.x} y={p.y + 9} className="gb-label">{c}</text>;
            })}
            {pitch && (
              <>
                <path d={`M ${polar(150, 0).x} ${polar(150, 0).y} L ${polar(300, 0).x} ${polar(300, 0).y} A 300 300 0 0 ${angle > 0 ? 1 : 0} ${polar(300, angle).x} ${polar(300, angle).y} L ${polar(150, angle).x} ${polar(150, angle).y} Z`} fill={color} opacity=".16" />
                <path d={arc(300, 0, angle || 0.01)} stroke={color} strokeWidth="16" fill="none" opacity=".75" />
                <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${PIVOT.x}px ${PIVOT.y}px` }}>
                  <line x1={PIVOT.x} y1={PIVOT.y - 150} x2={PIVOT.x} y2={PIVOT.y - 312} stroke={color} strokeWidth="5" strokeLinecap="round" />
                </g>
              </>
            )}
            <path d={arc(140, -42, 42)} stroke="#3a3a3c" strokeWidth="3" fill="none" />
          </svg>
          <div className="gb-readout" aria-live="polite">
            <span>{hz ? `${hz.toFixed(1)} Hz` : '– Hz'}</span>
            <b>{pitch?.note ?? '–'}</b>
            <span>{pitch ? `${cents > 0 ? '+' : ''}${cents} cents` : 'play a string'}</span>
          </div>
        </div>
        <footer className="gb-controls">
          <div className="gb-ref" role="group" aria-label="Reference pitch">
            <span>A4</span>
            <button className="icon small" aria-label="Lower reference" onClick={() => ref(prefs.reference - 1)} disabled={prefs.reference <= 430}>−</button>
            <output>{prefs.reference} Hz</output>
            <button className="icon small" aria-label="Raise reference" onClick={() => ref(prefs.reference + 1)} disabled={prefs.reference >= 450}>+</button>
            {prefs.reference !== 440 && <button className="text-button" onClick={() => ref(440)}>440</button>}
          </div>
          <div className="segmented" role="group" aria-label="While tuning">
            <button aria-pressed={prefs.mute} onClick={() => setPrefs({ ...prefs, mute: true })} title="Silence the output while tuning">Mute</button>
            <button aria-pressed={!prefs.mute} onClick={() => setPrefs({ ...prefs, mute: false })} title="Keep hearing the rig while tuning">Bypass</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// Settings: the audio device, the TONE3000 key and sign-in, and the open-source parts inside.
function Settings({ audio, onClose, captures }: {
  audio: State; onClose: () => void; captures: { missing: number; total: number; busy?: string; get: () => void };
}) {
  const { t3k, signIn: pending } = useLibrary();
  const [key, setKeyText] = useState('');
  const [error, setError] = useState('');
  const latency = (audio.inputMs ?? 0) + (audio.outputMs ?? 0);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" tabIndex={-1} ref={focusOnOpen} aria-label="Settings">
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
          <p className="hint">NAM captures are made at 48 kHz; at other rates Rigsmith converts to and from it, adding about 1 ms.</p>
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
          <p className="settings-value">
            {captures.missing ? `${captures.missing} of the ${captures.total} captures the built-in presets use aren't on this Mac` : `All ${captures.total} preset captures are on this Mac`}
            {captures.missing > 0 && (
              <button className="text-button" disabled={!t3k.signedIn || !!captures.busy} onClick={captures.get}>{captures.busy ?? 'Download all'}</button>
            )}
          </p>
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
  const [tunerPrefs, setTunerPrefs] = useState<TunerPrefs>(() => {
    try { return { reference: 440, mute: true, ...JSON.parse(localStorage.getItem('tuner') ?? '{}') }; } catch { return { reference: 440, mute: true }; }
  });
  const [help, setHelp] = useState(false);
  const [settings, setSettings] = useState(false);
  const [fetching, setFetching] = useState<string>(); // progress while downloading captures
  const [stage, setStage] = useState<Stage>({ set: `b:${Object.keys(SETS)[0]}`, at: -1 });
  const library = useLibrary();

  const flash = (msg: string, ms = 3000) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? '' : t)), ms);
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
  // Downloads captures from TONE3000, one tone at a time (its standard-size model unless the rig
  // names one), then reports what didn't come down and why.
  const fetchCaptures = async (files: FileRef[]) => {
    if (!library.t3k.signedIn) { setSettings(true); flash('Sign in to TONE3000 to download the captures'); return; }
    const todo = [...new Map(files.filter((f) => f.toneId !== undefined).map((f) => [String(f.toneId), f])).values()];
    const errors: string[] = [];
    for (const [i, f] of todo.entries()) {
      setFetching(`Downloading ${i + 1} of ${todo.length}`);
      const t = await tone(f.toneId!);
      const list = failed(t) ? t : await models(t.id);
      if (failed(t) || failed(list)) { errors.push(`${f.name}: ${(failed(t) ? t : (list as { error: string })).error}`); continue; }
      const model = list.data.find((x) => String(x.id) === String(f.modelId)) ?? list.data.find((x) => x.size === 'standard') ?? list.data[0];
      if (!model) { errors.push(`${t.title}: TONE3000 lists no models for it (private or removed?)`); continue; }
      const r = await download(t, model);
      if (failed(r)) errors.push(r.error);
    }
    await refreshLibrary();
    setFetching(undefined);
    if (errors.length) flash(`${todo.length - errors.length} of ${todo.length} downloaded. ${errors.join('; ')}`, 12000);
    else flash(`Downloaded ${todo.length} ${todo.length === 1 ? 'capture' : 'captures'}`);
  };
  const fetchMissing = () => fetchCaptures(missing.map((m) => m.file));
  const presetsMissing = PRESET_CAPTURES.filter((f) => !library.entries.some((e) => String(e.toneId) === String(f.toneId)));

  const inputs = h ? Object.values(h.present.devices).filter((d) => d.type === 'input') : [];
  const inputMuted = inputs.length > 0 && inputs.every((d) => !d.on);
  const muteInputs = () => edit((r) => inputs.filter((d) => d.on === !inputMuted).reduce((acc, d) => toggle(acc, d.id), r));
  const setMute = (v: boolean) => { setMuted(v); call('set', 'mute', v); };
  const setTuner = (v: boolean, prefs = tunerPrefs) => {
    setTuning(v);
    call('tuner', v, inputs[0]?.params.channel ?? 0, prefs.mute);
  };
  const changeTunerPrefs = (p: TunerPrefs) => {
    setTunerPrefs(p);
    try { localStorage.setItem('tuner', JSON.stringify(p)); } catch { /* private window */ }
    if (tuning) setTuner(true, p);
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
      v: () => setView((x) => (x === 'board' ? 'grid' : 'board')), m: () => setMute(!muted), i: muteInputs, t: () => setTuner(true), '?': () => setHelp(true), ',': () => setSettings(true),
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
              <PresetPicker current={current?.key} onPick={load} groups={[
                ...categories.map((cat) => ({ label: cat, keys: Object.entries(PRESETS).filter(([, p]) => p.category === cat).map(([n]) => `b:${n}`) })),
                ...(presets.length ? [{ label: 'Your presets', keys: presets.map((n) => `u:${n}`) }] : []),
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
            {audio.sampleRate ? `${latency.toFixed(1).padStart(4, '\u2007')} ms` : 'no audio device'} · CPU {cpuText(meter.cpu)}%
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
              ? <>
                  <button className="text-button" disabled={!!fetching} onClick={fetchMissing}>{fetching ?? 'Get from TONE3000'}</button>
                  {!fetching && presetsMissing.length > missing.length && (
                    <button className="text-button" onClick={() => fetchCaptures(presetsMissing)}>Get all {presetsMissing.length} preset captures</button>
                  )}
                </>
              : <span className="hint">Add the file under Captures</span>}
          </div>
        </div>
      )}
      {view === 'live' ? (
        <LiveMode rig={h.present} edit={edit} current={current?.key} presets={presets} loadPreset={loadPreset} play={play}
          stage={stage} setStage={setStage} flash={flash}
          onExit={() => setView('board')} onTune={() => setTuner(true)} muted={muted} onMute={() => setMute(!muted)}
          levels={{ in: meter.peak, out: meter.out }} live={live} inputs={audio.inputs ?? []}
          onSave={() => (userPreset ? saveAs(userPreset) : setSaving(''))} />
      ) : (
        <ReactFlowProvider>
          <Board rig={h.present} view={view} edit={edit} flash={flash} inputs={audio.inputs ?? []} live={live} onSettings={() => setSettings(true)}
            levels={{ in: meter.peak, out: meter.out, cpu: meter.cpu, ram: meter.ram }} />
        </ReactFlowProvider>
      )}
      {settings && <Settings audio={audio} onClose={() => { setSettings(false); refreshLibrary(); }}
        captures={{ missing: presetsMissing.length, total: PRESET_CAPTURES.length, busy: fetching, get: () => fetchCaptures(presetsMissing) }} />}
      {tuning && <Tuner hz={live.__tuner?.hz ?? 0} input={audio.inputs?.[inputs[0]?.params.channel ?? 0] ?? 'Input 1'}
        prefs={tunerPrefs} setPrefs={changeTunerPrefs} onClose={() => setTuner(false)} />}
      {help && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setHelp(false)}>
          <div className="help" role="dialog" aria-modal="true" tabIndex={-1} ref={focusOnOpen} aria-label="Keyboard shortcuts">
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
