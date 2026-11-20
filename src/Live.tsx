// Live mode: the stage screen. Big targets, nothing to knock by accident: the preset, its scenes,
// the footswitches in signal order, the tuner, tap tempo and levels. Knobs are out of reach here.

import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, VolumeX, Volume2, X } from 'lucide-react';
import { def } from './catalog';
import { deviceName, type Edit, type Live as LiveData } from './gear';
import { layoutGrid } from './layout';
import { applyScene, isPowered, selectScene, setParam, toggle, type Rig } from './rig';

const level = (peak: number) => Math.max(0, Math.min(1, (20 * Math.log10(peak || 1e-6) + 60) / 60));

export function LiveMode({ rig, edit, preset, category, onStep, onExit, onTune, muted, onMute, levels, live }: {
  rig: Rig; edit: Edit; preset: string; category?: string; onStep: (dir: number) => void; onExit: () => void; onTune: () => void;
  muted: boolean; onMute: () => void; levels: { in: number; out: number }; live: LiveData;
}) {
  const now = applyScene(rig);
  const pos = layoutGrid(now);
  const stomps = Object.values(now.devices).filter((d) => def(d.type).footswitch && d.type !== 'tuner' && pos[d.id])
    .sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
  const delays = Object.values(now.devices).filter((d) => d.type === 'delay');
  const taps = useRef<number[]>([]);
  const [bpm, setBpm] = useState<number>();

  // Tap tempo: the average of the last few taps sets every delay's time.
  const tap = () => {
    const t = performance.now();
    taps.current = [...taps.current.filter((x) => t - x < 2500), t].slice(-5);
    if (taps.current.length < 2) return;
    const ms = (taps.current[taps.current.length - 1] - taps.current[0]) / (taps.current.length - 1);
    setBpm(Math.round(60000 / ms));
    edit((r) => delays.reduce((acc, d) => setParam(acc, d.id, 'time', ms), r), 'tap');
  };

  return (
    <div className="live">
      <header className="live-head">
        <button className="live-nav" onClick={() => onStep(-1)} aria-label="Previous preset"><ChevronLeft size={24} strokeWidth={1.5} /></button>
        <div className="live-title">
          <span>{category ?? 'Preset'}</span>
          <h1>{preset}</h1>
        </div>
        <button className="live-nav" onClick={() => onStep(1)} aria-label="Next preset"><ChevronRight size={24} strokeWidth={1.5} /></button>
        <button className="icon live-exit" onClick={onExit} aria-label="Leave Live mode" title="Leave Live mode (Esc)"><X size={18} strokeWidth={1.5} /></button>
      </header>

      {rig.scenes ? (
        <section className="live-scenes" aria-label="Scenes">
          {rig.scenes.list.map((s, i) => (
            <button key={i} className={`live-scene${rig.scenes!.active === i ? ' on' : ''}`} aria-pressed={rig.scenes!.active === i}
              onClick={() => edit((r) => selectScene(r, i))}>
              <i className="lamp" /><kbd>{i + 1}</kbd><span>{s.name}</span>
            </button>
          ))}
        </section>
      ) : <p className="live-note">This preset has no scenes. Add them in the editor to switch many pedals with one press.</p>}

      <section className="live-stomps" aria-label="Footswitches">
        {stomps.map((d, i) => {
          const lit = d.on && isPowered(now, d.id);
          return (
            <button key={d.id} className={`live-stomp${lit ? ' on' : ''}`} aria-pressed={d.on} onClick={() => edit((r) => toggle(r, d.id))}>
              <i className="lamp red" /><span>{deviceName(d)}</span>{i < 9 && <kbd>{['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O'][i]}</kbd>}
            </button>
          );
        })}
      </section>

      <footer className="live-foot">
        <button className="live-tool" onClick={onTune}>Tune</button>
        <button className="live-tool" onClick={tap} disabled={!delays.length} title={delays.length ? 'Tap the beat to set every delay' : 'No delay in this preset'}>
          Tap{bpm ? <b>{bpm} BPM</b> : null}
        </button>
        <div className="live-meters">
          <span>In</span><div className="meter"><i style={{ transform: `scaleX(${level(levels.in)})` }} /></div>
          <span>Out</span><div className="meter"><i style={{ transform: `scaleX(${level(levels.out)})` }} /></div>
        </div>
        <button className={`live-tool${muted ? ' alert' : ''}`} onClick={onMute} aria-pressed={muted}>
          {muted ? <VolumeX size={18} strokeWidth={1.5} /> : <Volume2 size={18} strokeWidth={1.5} />}{muted ? 'Muted' : 'Mute'}
        </button>
        {Object.values(live).some((x) => x.missing) && <span className="live-warn">A capture is missing</span>}
      </footer>
    </div>
  );
}
