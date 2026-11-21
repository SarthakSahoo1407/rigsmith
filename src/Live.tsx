// Live mode: the stage screen, built around a set. A set is your setlist: songs, each with scenes, and
// every scene is a whole sound taken from any preset (built-in, yours, or what's on the board now) and
// changed however you like. Left: the setlist. Right: the scene playing, the next one, the
// footswitches of the rig, tuner, tap tempo and levels. Knobs stay on the board.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2, VolumeX, Volume2, X } from 'lucide-react';
import { def } from './catalog';
import { deviceName, useShot, type Edit, type Live as LiveData } from './gear';
import { layoutGrid } from './layout';
import { call } from './native';
import { PRESETS, SETS } from './presets';
import { isPowered, setTempo, tempoOf, toggle, type Device, type Rig } from './rig';
import { addToSet, changeScene, moveInSet, parseSets, removeFromSet, sameShape, sameSound, songsOf, type LiveSet, type SetScene } from './sets';

const SETS_FILE = '_sets';
const STOMP_KEYS = 'qwertyuio';
const icon = { size: 16, strokeWidth: 1.5 };
const level = (peak: number) => Math.max(0, Math.min(1, (20 * Math.log10(peak || 1e-6) + 60) / 60));
const presetName = (key: string) => (key ? key.slice(2) : 'Board');

// Where Live mode is in which set; kept by the app so leaving Live and coming back keeps your place.
export type Stage = { set: string; at: number }; // set: 'b:' example or 'u:' yours; at: -1 before the first scene

export function LiveMode({ rig, edit, current, presets, loadPreset, play, stage, setStage, flash, onExit, onTune, muted, onMute, levels, live }: {
  rig: Rig; edit: Edit; current?: string; presets: string[]; loadPreset: (key: string) => Promise<Rig>;
  play: (scene: SetScene) => void; stage: Stage; setStage: (s: Stage) => void; flash: (msg: string) => void;
  onExit: () => void; onTune: () => void; muted: boolean; onMute: () => void; levels: { in: number; out: number }; live: LiveData;
}) {
  const [mine, setMine] = useState<Record<string, LiveSet>>();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  useEffect(() => { call<string | null>('loadRig', SETS_FILE).then((t) => setMine(parseSets(t))); }, []);
  const saveMine = (next: Record<string, LiveSet>) => { setMine(next); call('saveRig', SETS_FILE, JSON.stringify(next)); };

  const example = stage.set.startsWith('b:') && SETS[stage.set.slice(2)];
  const built = useMemo(() => (example ? example() : undefined), [stage.set]);
  const set: LiveSet | undefined = built ?? mine?.[stage.set.slice(2)];
  const scene = set?.scenes[stage.at];
  const next = set?.scenes[stage.at + 1];

  const go = (i: number) => {
    if (!set || i < 0 || i >= set.scenes.length) return;
    setStage({ ...stage, at: i });
    play(set.scenes[i]);
  };
  // Any change to an example set makes it yours: it's copied under a free name first.
  const change = (fn: (s: LiveSet) => LiveSet, at = stage.at) => {
    if (!set || !mine) return;
    let name = set.name;
    if (example) for (let n = 1; mine[name] || SETS[name]; n++) name = `${set.name} ${n + 1}`;
    try {
      const updated = { ...fn(set), name };
      saveMine({ ...mine, [name]: updated });
      setStage({ set: `u:${name}`, at: Math.min(at, updated.scenes.length - 1) });
      if (example) flash(`Saved your copy as ${name}`);
    } catch (e) { flash(e instanceof Error ? e.message : String(e)); }
  };
  const newSet = (name: string) => {
    if (!mine) return;
    if (mine[name] || SETS[name]) { flash(`There's already a set called ${name}`); return; }
    saveMine({ ...mine, [name]: { name, scenes: [] } });
    setStage({ set: `u:${name}`, at: -1 });
    setEditing(true);
    setAdding(true);
  };
  const deleteSet = () => {
    if (!mine || example || !set) return;
    const { [set.name]: _, ...rest } = mine;
    saveMine(rest);
    setStage({ set: `b:${Object.keys(SETS)[0]}`, at: -1 });
    setEditing(false);
  };
  const add = (s: Omit<SetScene, 'song'>) => {
    const at = stage.at >= 0 ? stage.at + 1 : set?.scenes.length ?? 0;
    const song = (stage.at >= 0 ? scene?.song : set?.scenes[set.scenes.length - 1]?.song) || 'Song 1';
    change((x) => addToSet(x, { ...s, song }, at), at);
    play({ ...s, song });
    setAdding(false);
  };

  // Keys: 1-9 pick a scene, space or arrows step through the set (foot controllers send these),
  // Q-O stomp the footswitches.
  const keys = useRef<(e: KeyboardEvent) => void>(undefined);
  keys.current = (e) => {
    if (adding || e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest('input, select, textarea'))) return;
    const k = e.key.toLowerCase();
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (digit) go(Number(digit) - 1);
    else if (k === ' ' || k === 'arrowright' || k === 'arrowdown' || k === 'pagedown') go(stage.at + 1);
    else if (k === 'arrowleft' || k === 'arrowup' || k === 'pageup') go(stage.at - 1);
    else if (STOMP_KEYS.includes(k)) document.querySelectorAll<HTMLButtonElement>('.live-stomp')[STOMP_KEYS.indexOf(k)]?.click();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pos = layoutGrid(rig);
  const stomps = Object.values(rig.devices).filter((d) => def(d.type).footswitch && d.type !== 'tuner' && pos[d.id])
    .sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
  const taps = useRef<number[]>([]);
  // Tap tempo: the average of the last few taps sets the rig's tempo; synced delays and modulation follow.
  const tap = () => {
    const t = performance.now();
    taps.current = [...taps.current.filter((x) => t - x < 2500), t].slice(-5);
    if (taps.current.length < 2) return;
    const ms = (taps.current[taps.current.length - 1] - taps.current[0]) / (taps.current.length - 1);
    edit((r) => setTempo(r, 60000 / ms), 'tap');
  };
  const changed = useMemo(() => scene && !sameSound(rig, scene.rig), [rig, scene]);
  // Which scenes load another rig (a short gap) rather than switching knobs and footswitches.
  const loads = useMemo(() => set?.scenes.map((s, i) => i > 0 && !sameShape(set.scenes[i - 1].rig, s.rig)) ?? [], [set]);

  return (
    <div className="live">
      <aside className="setlist" aria-label="Setlist">
        <header className="setlist-head">
          {naming === null ? (
            <>
              <select className="set-select" aria-label="Set" value={stage.set} onChange={(e) => { setStage({ set: e.target.value, at: -1 }); setEditing(false); }}>
                {mine && Object.keys(mine).length > 0 && (
                  <optgroup label="Your sets">{Object.keys(mine).map((n) => <option key={n} value={`u:${n}`}>{n}</option>)}</optgroup>
                )}
                <optgroup label="Examples">{Object.keys(SETS).map((n) => <option key={n} value={`b:${n}`}>{n}</option>)}</optgroup>
              </select>
              <button className="icon" title="New set" aria-label="New set" onClick={() => setNaming('')}><Plus {...icon} /></button>
              <button className={`icon${editing ? ' active' : ''}`} title={editing ? 'Done editing' : 'Edit this set'} aria-pressed={editing} aria-label="Edit set"
                onClick={() => setEditing(!editing)}><Pencil {...icon} /></button>
            </>
          ) : (
            <form className="set-new" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) { newSet(naming.trim().slice(0, 60)); setNaming(null); } }}>
              <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Set name" aria-label="Set name"
                onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
              <button type="submit" className="button" disabled={!naming.trim()}>Create</button>
            </form>
          )}
        </header>
        {example && !editing && <p className="setlist-note">An example set. Change anything and it's saved as your own copy.</p>}

        <ol className="songs">
          {set && songsOf(set).map(({ song, scenes }, s) => (
            <li key={`${s}-${song}`} className="song">
              <h3>{song || 'Untitled song'}</h3>
              <ol>
                {scenes.map(({ scene: sc, index }) => {
                  return editing ? (
                    <li key={index} className="cue editing">
                      <input value={sc.name} aria-label="Scene name" maxLength={32} onChange={(e) => change((x) => changeScene(x, index, { name: e.target.value }))} />
                      <input value={sc.song} aria-label="Song" placeholder="Song" maxLength={40} onChange={(e) => change((x) => changeScene(x, index, { song: e.target.value }))} />
                      <span className="cue-tools">
                        <button className="icon small" aria-label={`Move ${sc.name} up`} disabled={!index} onClick={() => change((x) => moveInSet(x, index, -1), index - 1)}><ArrowUp {...icon} /></button>
                        <button className="icon small" aria-label={`Move ${sc.name} down`} disabled={index === set.scenes.length - 1} onClick={() => change((x) => moveInSet(x, index, 1), index + 1)}><ArrowDown {...icon} /></button>
                        <button className="icon small danger" aria-label={`Remove ${sc.name}`} onClick={() => change((x) => removeFromSet(x, index), Math.min(stage.at, set.scenes.length - 2))}><Trash2 {...icon} /></button>
                      </span>
                    </li>
                  ) : (
                    <li key={index}>
                      <button className={`cue${index === stage.at ? ' on' : ''}`} aria-current={index === stage.at} onClick={() => go(index)}>
                        <i className="lamp" />
                        <span className="cue-text"><b>{sc.name}</b><span>{presetName(sc.from)}{loads[index] ? ' · new rig' : ''}</span></span>
                        {index < 9 && <kbd>{index + 1}</kbd>}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
        {set && !set.scenes.length && (
          <div className="empty small"><p>No scenes yet</p><span>Add a preset, or what's on the board now. Each scene can be its own sound.</span></div>
        )}
        <footer className="setlist-foot">
          <button className="text-button" onClick={() => setAdding(true)} disabled={!set}><Plus {...icon} />Add a scene</button>
          {editing && !example && <button className="text-button danger" onClick={deleteSet}><Trash2 {...icon} />Delete set</button>}
        </footer>
      </aside>

      <main className="stage">
        <header className="stage-head">
          <div className="stage-title">
            <span>{scene ? `${scene.song || 'Untitled song'} · ${presetName(scene.from)}` : set?.name}</span>
            <h1>{scene ? scene.name : current ? presetName(current) : 'Board'}</h1>
            {!scene && <span>Playing what's on the board. Pick a scene, or press 1 or space to start the set.</span>}
          </div>
          <button className="icon live-exit" onClick={onExit} aria-label="Leave Live mode" title="Leave Live mode (Esc)"><X size={18} strokeWidth={1.5} /></button>
        </header>

        <div className="stage-nav">
          <button className="live-nav" onClick={() => go(stage.at - 1)} disabled={stage.at <= 0} aria-label="Previous scene"><ChevronLeft size={24} strokeWidth={1.5} /></button>
          <button className="stage-next" onClick={() => go(stage.at + 1)} disabled={!next}>
            <span>Next</span>
            <b>{next ? next.name : 'End of the set'}</b>
            {next && <span>{next.song !== scene?.song ? next.song || 'Untitled song' : 'same song'}{loads[stage.at + 1] ? ' · new rig' : ''}</span>}
            <kbd>space</kbd>
          </button>
          <button className="live-nav" onClick={() => go(stage.at + 1)} disabled={!next} aria-label="Next scene"><ChevronRight size={24} strokeWidth={1.5} /></button>
        </div>

        {changed && scene && (
          <div className="stage-changes" role="status">
            <span><i className="lamp warn" />Changed since this scene started</span>
            <button className="text-button" onClick={() => change((x) => changeScene(x, stage.at, { rig }))}>Save into the scene</button>
            <button className="text-button" onClick={() => add({ name: `${scene.name} 2`, from: scene.from, rig })}>Save as a new scene</button>
            <button className="text-button" onClick={() => play(scene)}>Undo changes</button>
          </div>
        )}

        <section className="live-stomps" aria-label="Footswitches">
          {stomps.map((d, i) => {
            const lit = d.on && isPowered(rig, d.id);
            return (
              <button key={d.id} className={`live-stomp${lit ? ' on' : ''}`} aria-pressed={d.on} onClick={() => edit((r) => toggle(r, d.id))}>
                <StompShot d={d} /><span>{deviceName(d)}</span><i className="lamp red" />{i < 9 && <kbd>{STOMP_KEYS[i].toUpperCase()}</kbd>}
              </button>
            );
          })}
        </section>

        <footer className="live-foot">
          <button className="live-tool" onClick={onTune}>Tune</button>
          <button className="live-tool" onClick={tap} title="Tap the beat: sets the tempo that synced delays and modulation follow">
            Tap<b>{tempoOf(rig)} BPM</b>
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
      </main>

      {adding && <AddScene rig={rig} current={current} presets={presets} loadPreset={loadPreset} onAdd={add} onClose={() => setAdding(false)} />}
    </div>
  );
}

// The pedal itself, small, beside its name on the footswitch.
function StompShot({ d }: { d: Device }) {
  const shot = useShot(d.type, d.params);
  return <span className="stomp-shot">{shot && <img src={shot.url} alt="" draggable={false} />}</span>;
}

// Picks the sound for a new scene: what's on the board now, one of your presets, or a built-in one.
function AddScene({ rig, current, presets, loadPreset, onAdd, onClose }: {
  rig: Rig; current?: string; presets: string[]; loadPreset: (key: string) => Promise<Rig>;
  onAdd: (s: Omit<SetScene, 'song'>) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const match = (n: string) => n.toLowerCase().includes(query.trim().toLowerCase());
  const pick = async (key: string) => onAdd({ name: key.slice(2), from: key, rig: await loadPreset(key) });
  const groups: [string, string[]][] = [
    ['Your presets', presets.filter(match).map((n) => `u:${n}`)],
    ...[...new Set(Object.values(PRESETS).map((p) => p.category))].map((cat): [string, string[]] =>
      [cat, Object.entries(PRESETS).filter(([n, p]) => p.category === cat && match(n)).map(([n]) => `b:${n}`)]),
  ];
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="add-scene" role="dialog" aria-modal="true" aria-label="Add a scene">
        <header className="inspector-head"><div className="inspector-title"><h2>Add a scene</h2></div>
          <button className="icon" aria-label="Close" onClick={onClose}><X {...icon} /></button></header>
        <button className="pick board-pick" onClick={() => onAdd({ name: current ? presetName(current) : 'Board', from: current ?? '', rig })}>
          <b>What's on the board now</b><span>{current ? presetName(current) : 'Unsaved rig'}, with every change you made. Build a new sound on the board, then add it here.</span>
        </button>
        <form className="search" onSubmit={(e) => e.preventDefault()}>
          <Search {...icon} aria-hidden /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search presets" aria-label="Search presets" />
        </form>
        <div className="pick-groups">
          {groups.filter(([, keys]) => keys.length).map(([cat, keys]) => (
            <section key={cat}>
              <h3>{cat}</h3>
              <div className="picks">{keys.map((k) => <button key={k} className="pick" onClick={() => pick(k)}>{presetName(k)}</button>)}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
