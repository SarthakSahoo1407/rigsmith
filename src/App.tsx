import { useEffect, useState } from 'react';
import { call, inApp, on, type Meter, type State } from './native';

export function App() {
  const [state, setState] = useState<State>();
  const [meter, setMeter] = useState<Meter>({ peak: 0, cpu: 0 });
  const [clipAt, setClipAt] = useState(-Infinity);

  useEffect(() => {
    if (!inApp) return;
    call<State>('getState').then(setState);
    const offState = on<State>('state', setState);
    const offMeter = on<Meter>('meter', (m) => {
      setMeter(m);
      if (m.peak >= 0.99) setClipAt(performance.now());
    });
    return () => { offState(); offMeter(); };
  }, []);

  if (!inApp) return <main><div className="banner">Open this inside the Rig app. The browser can't reach the audio engine.</div></main>;
  if (!state) return null;

  const set = (key: keyof State, value: number) => {
    setState({ ...state, [key]: value });
    call('set', key, value);
  };
  const level = Math.max(0, Math.min(1, (20 * Math.log10(meter.peak || 1e-6) + 60) / 60));
  const clipping = performance.now() - clipAt < 1000;
  const total = (state.inputMs ?? 0) + (state.outputMs ?? 0);

  return (
    <main>
      <section>
        <h2>AUDIO</h2>
        <p style={{ margin: 0 }}>
          {state.device ?? 'No device'}
          {state.sampleRate && <span className="dim"> · {state.sampleRate} Hz · {state.bufferSize} samples</span>}
        </p>
        <button onClick={() => call('openAudioSettings')}>Audio settings…</button>
        {state.sampleRate && (
          <p className="dim" style={{ margin: 0 }}>
            Round-trip latency: <b>{total.toFixed(1)} ms</b> = input {state.inputMs!.toFixed(1)} + output {state.outputMs!.toFixed(1)}
            {' '}· CPU {Math.round(meter.cpu * 100)}%
          </p>
        )}
      </section>
      <section>
        <h2>GUITAR INPUT</h2>
        <label>
          Channel
          <select value={state.channel} onChange={(e) => set('channel', Number(e.target.value))}>
            {(state.inputs ?? []).map((name, i) => <option key={i} value={i}>{name}</option>)}
          </select>
          <span />
        </label>
        <label>
          Trim
          <input type="range" min={-24} max={24} step={0.5} value={state.trimDb} onChange={(e) => set('trimDb', Number(e.target.value))} />
          <span>{state.trimDb > 0 ? '+' : ''}{state.trimDb} dB</span>
        </label>
        <label>
          Level
          <div className="meter" role="meter" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${level * 100}%` }} />
          </div>
          <div className={`led${clipping ? ' on' : ''}`} title="Clip" aria-label={clipping ? 'Clipping' : 'Not clipping'} />
        </label>
      </section>
      <section>
        <h2>OUTPUT</h2>
        <label>
          Volume
          <input type="range" min={0} max={1} step={0.01} value={state.volume} onChange={(e) => set('volume', Number(e.target.value))} />
          <span>{Math.round(state.volume * 100)}%</span>
        </label>
      </section>
    </main>
  );
}
