// The preset menu: search by name or category, star favourites, show favourites only.
// Favourites are per-viewer, kept in localStorage by preset key ('b:' built-in, 'u:' saved).

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, Star } from 'lucide-react';

export type PresetGroup = { label: string; keys: string[] };
const name = (key: string) => key.slice(2);

const loadFavs = (): string[] => { try { return JSON.parse(localStorage.getItem('favs') ?? '[]'); } catch { return []; } };

export function PresetPicker({ groups, current, onPick }: { groups: PresetGroup[]; current?: string; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [favs, setFavs] = useState(loadFavs);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  const star = (key: string) => {
    const next = favs.includes(key) ? favs.filter((k) => k !== key) : [...favs, key];
    setFavs(next);
    try { localStorage.setItem('favs', JSON.stringify(next)); } catch { /* private window */ }
  };
  const q = query.trim().toLowerCase();
  // A query matches the preset's name or its category.
  const shown = groups.map((g) => ({
    ...g, keys: g.keys.filter((k) => (!onlyFavs || favs.includes(k)) && (!q || name(k).toLowerCase().includes(q) || g.label.toLowerCase().includes(q))),
  })).filter((g) => g.keys.length);
  const pick = (k: string) => { onPick(k); setOpen(false); };
  return (
    <div className="preset-picker" ref={root}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}>
      <button className="preset-select preset-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{current ? name(current) : 'Unsaved rig'}</span><ChevronDown size={14} strokeWidth={1.5} />
      </button>
      {open && (
        <div className="preset-menu" role="listbox" aria-label="Presets">
          <div className="preset-search">
            <label className="search"><Search size={14} strokeWidth={1.5} aria-hidden />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search presets" aria-label="Search presets"
                onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) pick(shown[0].keys[0]); }} />
            </label>
            <button className={`icon${onlyFavs ? ' active' : ''}`} aria-pressed={onlyFavs} title="Favourites only" aria-label="Favourites only" onClick={() => setOnlyFavs(!onlyFavs)}>
              <Star size={16} strokeWidth={1.5} fill={onlyFavs ? 'currentColor' : 'none'} />
            </button>
          </div>
          <div className="preset-list">
            {favs.length > 0 && !onlyFavs && !q && (
              <section><h3>Favourites</h3>{groups.flatMap((g) => g.keys).filter((k) => favs.includes(k)).map((k) => (
                <Row key={`f${k}`} k={k} on={k === current} fav pick={pick} star={star} />))}</section>
            )}
            {shown.map((g) => (
              <section key={g.label}><h3>{g.label}</h3>
                {g.keys.map((k) => <Row key={k} k={k} on={k === current} fav={favs.includes(k)} pick={pick} star={star} />)}</section>
            ))}
            {!shown.length && <p className="hint preset-none">{onlyFavs && !favs.length ? 'Star a preset to keep it here.' : 'No presets match.'}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, on, fav, pick, star }: { k: string; on: boolean; fav: boolean; pick: (k: string) => void; star: (k: string) => void }) {
  return (
    <div className={`preset-row${on ? ' on' : ''}`}>
      <button role="option" aria-selected={on} className="preset-name" onClick={() => pick(k)}>{name(k)}</button>
      <button className={`icon small star${fav ? ' on' : ''}`} aria-pressed={fav} aria-label={`${fav ? 'Unfavourite' : 'Favourite'} ${name(k)}`} onClick={() => star(k)}>
        <Star size={14} strokeWidth={1.5} fill={fav ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}
