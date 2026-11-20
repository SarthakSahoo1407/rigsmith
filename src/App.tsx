import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Board, type Edit, type View } from './Board';
import { call, inApp, on, type Meter, type State } from './native';
import { DEFAULT_PRESET, PRESETS } from './presets';
import { commit, compile, history, parseRig, redo, undo, type History } from './rig';

const AUTOSAVE = '_autosave';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const [h, setH] = useState<History>();
  const hRef = useRef(h);
  const [view, setView] = useState<View>('board');
  const [toast, setToast] = useState('');
  const [presets, setPresets] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [audio, setAudio] = useState<State>();
  const [meter, setMeter] = useState<Meter>({ peak: 0, cpu: 0 });
  const [clipAt, setClipAt] = useState(-Infinity);

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
  const open = (text: string | null) => {
    if (!text) return;
    try { edit(() => parseRig(text)); } catch (e) { flash(`Can't open that rig: ${message(e)}`); }
  };

  useEffect(() => {
    if (!inApp) return;
    call<string | null>('loadRig', AUTOSAVE).then((text) => {
      let rig = PRESETS[DEFAULT_PRESET]();
      if (text) {
        try { rig = parseRig(text); } catch (e) { flash(`Last session's rig was unreadable, starting fresh: ${message(e)}`); }
      }
      apply(history(rig));
    });
    refreshPresets();
    call<State>('getState').then(setAudio);
    const offState = on<State>('state', setAudio);
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
    return () => { offState(); offMeter(); window.removeEventListener('keydown', onKey); };
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

  return (
    <div className="app">
      <header className="toolbar">
        <div className="group" role="group" aria-label="View">
          <button aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button>
          <button aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Grid</button>
        </div>
        <div className="group">
          <button disabled={!h.past.length} onClick={() => apply(undo(h))} title="Cmd+Z">Undo</button>
          <button disabled={!h.future.length} onClick={() => apply(redo(h))} title="Shift+Cmd+Z">Redo</button>
        </div>
        <div className="group">
          <select value="" aria-label="Load preset" onChange={(e) => {
            const [kind, n] = [e.target.value.slice(0, 1), e.target.value.slice(2)];
            if (kind === 'b') { edit(() => PRESETS[n]()); setName(''); return; }
            setName(n);
            call<string | null>('loadRig', n).then(open);
          }}>
            <option value="" disabled>Load preset…</option>
            <optgroup label="Built-in">
              {Object.keys(PRESETS).map((p) => <option key={p} value={`b:${p}`}>{p}</option>)}
            </optgroup>
            {presets.length > 0 && (
              <optgroup label="Saved">
                {presets.map((p) => <option key={p} value={`u:${p}`}>{p}</option>)}
              </optgroup>
            )}
          </select>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Preset name" aria-label="Preset name" />
          <button disabled={!name.trim()} onClick={async () => {
            await call('saveRig', name.trim(), JSON.stringify(h.present));
            refreshPresets();
            flash(`Saved "${name.trim()}"`);
          }}>Save</button>
          <button disabled={!presets.includes(name.trim())} onClick={async () => {
            await call('deleteRig', name.trim());
            refreshPresets();
            flash(`Deleted "${name.trim()}"`);
          }}>Delete</button>
          <button onClick={() => call<string | null>('importRig').then(open)}>Import…</button>
          <button onClick={() => call<boolean>('exportRig', JSON.stringify(h.present, null, 2), name.trim() || 'rig')
            .then((ok) => ok && flash('Exported'))}>Export…</button>
        </div>
        <div className="spacer" />
        <div className="group">
          <div className="meter small" role="meter" aria-label="Input level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${level * 100}%` }} />
          </div>
          <div className={`led${clipping ? ' on' : ''}`} title="Clip" aria-label={clipping ? 'Clipping' : 'Not clipping'} />
          <label className="inline">Master
            <input type="range" min={0} max={1} step={0.01} value={audio.volume} onChange={(e) => setMaster(Number(e.target.value))} />
          </label>
        </div>
        <div className="group dim">
          {audio.sampleRate ? `${latency.toFixed(1)} ms · CPU ${Math.round(meter.cpu * 100)}%` : 'No audio device'}
          <button onClick={() => call('openAudioSettings')}>Audio settings…</button>
        </div>
      </header>
      <ReactFlowProvider>
        <Board rig={h.present} view={view} edit={edit} flash={flash} inputs={audio.inputs ?? []} />
      </ReactFlowProvider>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
