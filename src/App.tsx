import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Download, FolderOpen, Redo2, Save, Settings2, Trash2, Undo2 } from 'lucide-react';
import { Board, type Edit, type View } from './Board';
import type { Live } from './gear';
import { call, inApp, on, type Meter, type State } from './native';
import { DEFAULT_PRESET, PRESETS } from './presets';
import { commit, compile, history, parseRig, redo, undo, type History, type Rig } from './rig';

const AUTOSAVE = '_autosave';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const [meter, setMeter] = useState<Meter>({ peak: 0, cpu: 0 });
  const [clipAt, setClipAt] = useState(-Infinity);
  const [live, setLive] = useState<Live>({});

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
  const loadBuiltIn = (name: string) => {
    const rig = PRESETS[name].build();
    edit(() => rig);
    setCurrent({ key: `b:${name}`, rig });
  };
  const saveAs = async (name: string) => {
    await call('saveRig', name, JSON.stringify(hRef.current!.present));
    await refreshPresets();
    setCurrent({ key: `u:${name}`, rig: hRef.current!.present });
    setSaving(null);
    flash(`Saved ${name}`);
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
      if (m.peak >= 0.99) setClipAt(performance.now());
    });
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || !hRef.current) return;
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      e.preventDefault();
      apply(e.shiftKey ? redo(hRef.current) : undo(hRef.current));
    };
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

  if (!inApp) return <div className="banner">Open this inside the Rig app. The browser can't reach the audio engine.</div>;
  if (!h || !audio) return null;

  const setMaster = (value: number) => {
    setAudio({ ...audio, volume: value });
    call('set', 'volume', value);
  };
  const level = Math.max(0, Math.min(1, (20 * Math.log10(meter.peak || 1e-6) + 60) / 60));
  const clipping = performance.now() - clipAt < 1000;
  const latency = (audio.inputMs ?? 0) + (audio.outputMs ?? 0);
  const categories = [...new Set(Object.values(PRESETS).map((p) => p.category))];
  const userPreset = current?.key.startsWith('u:') ? current.key.slice(2) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Rig</span>
        <div className="segmented" role="group" aria-label="View">
          <button aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button>
          <button aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Grid</button>
        </div>
        <div className="tool-group">
          <button className="icon" disabled={!h.past.length} onClick={() => apply(undo(h))} title="Undo (⌘Z)" aria-label="Undo"><Undo2 size={16} strokeWidth={1.5} /></button>
          <button className="icon" disabled={!h.future.length} onClick={() => apply(redo(h))} title="Redo (⇧⌘Z)" aria-label="Redo"><Redo2 size={16} strokeWidth={1.5} /></button>
        </div>
        <div className="preset">
          {saving === null ? (
            <>
              <select className="preset-select" aria-label="Preset" value={current?.key ?? ''} onChange={(e) => {
                const key = e.target.value;
                if (key.startsWith('b:')) loadBuiltIn(key.slice(2));
                else call<string | null>('loadRig', key.slice(2)).then((text) => open(text, key));
              }}>
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
              {current && current.rig !== h.present && <span className="edited">edited</span>}
              <button className="icon" title="Save as preset" aria-label="Save as preset" onClick={() => setSaving(userPreset ?? '')}><Save size={16} strokeWidth={1.5} /></button>
              {userPreset && (
                <button className="icon" title={`Delete ${userPreset}`} aria-label={`Delete preset ${userPreset}`} onClick={async () => {
                  await call('deleteRig', userPreset);
                  await refreshPresets();
                  setCurrent(undefined);
                  flash(`Deleted ${userPreset}`);
                }}><Trash2 size={16} strokeWidth={1.5} /></button>
              )}
              <button className="icon" title="Open rig file" aria-label="Open rig file" onClick={() => call<string | null>('importRig').then((t) => open(t))}><FolderOpen size={16} strokeWidth={1.5} /></button>
              <button className="icon" title="Export rig file" aria-label="Export rig file" onClick={() => call<boolean>('exportRig', JSON.stringify(h.present, null, 2), userPreset ?? current?.key.slice(2) ?? 'rig')
                .then((ok) => ok && flash('Exported'))}><Download size={16} strokeWidth={1.5} /></button>
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
          <span className="io-label">Input</span>
          <div className="meter" role="meter" aria-label="Input level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ transform: `scaleX(${level})` }} />
          </div>
          <span className={`clip${clipping ? ' on' : ''}`} title="Clip" aria-label={clipping ? 'Clipping' : 'Not clipping'} />
          <label className="io-label master">Master
            <input type="range" min={0} max={1} step={0.01} value={audio.volume} onChange={(e) => setMaster(Number(e.target.value))} />
          </label>
          <span className="readout">{audio.sampleRate ? `${latency.toFixed(1)} ms · CPU ${Math.round(meter.cpu * 100)}%` : 'no audio device'}</span>
          <button className="icon" title="Audio settings" aria-label="Audio settings" onClick={() => call('openAudioSettings')}><Settings2 size={16} strokeWidth={1.5} /></button>
        </div>
      </header>
      <ReactFlowProvider>
        <Board rig={h.present} view={view} edit={edit} flash={flash} inputs={audio.inputs ?? []} live={live} />
      </ReactFlowProvider>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
