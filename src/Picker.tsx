// A dropdown with search, for lists that are too long to scroll: presets, replace-with, captures.
// The menu is portalled to the page and positioned from the trigger, so it works inside the board's
// zoomed canvas and the device window's scaled stage, and is never clipped. ↑ ↓ Enter Esc work; typing filters.
// `favorites` adds a star per row (kept in localStorage under that key) and a favourites filter.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, Star } from 'lucide-react';

export type Option = { value: string; label: string; group?: string; hint?: string };
const stored = (key: string): string[] => { try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; } };

export function Picker({ options, value, onChange, placeholder = 'Choose', label, className = '', favorites, empty, children }: {
  options: Option[]; value?: string; onChange: (value: string) => void; placeholder?: string; label: string; className?: string;
  favorites?: string; empty?: string; children?: ReactNode; // children replace the trigger's text
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState(false);
  const [at, setAt] = useState(0);
  const [favs, setFavs] = useState(() => (favorites ? stored(favorites) : []));
  const [box, setBox] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  // A query matches the label or the group's name; favourites float to the top section when not searching.
  const shown = useMemo(() => options.filter((o) => (!only || favs.includes(o.value))
    && (!q || o.label.toLowerCase().includes(q) || o.group?.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q))), [options, q, only, favs]);
  const rows = useMemo(() => {
    const out: { head?: string; o?: Option }[] = [];
    if (favorites && favs.length && !only && !q) {
      out.push({ head: 'Favourites' });
      for (const o of options) if (favs.includes(o.value)) out.push({ o });
    }
    let g: string | undefined;
    for (const o of shown) {
      if (o.group !== g) { g = o.group; if (g) out.push({ head: g }); }
      out.push({ o });
    }
    return out;
  }, [shown, options, favs, only, q, favorites]);
  const items = rows.flatMap((r) => (r.o ? [r.o] : []));

  const close = () => { setOpen(false); setQuery(''); trigger.current?.focus(); };
  const pick = (o: Option) => { onChange(o.value); close(); };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const room = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const up = room < 280 && above > room;
    setBox({ position: 'fixed', left: Math.min(r.left, window.innerWidth - 332), minWidth: Math.max(r.width, 240), width: 320,
      ...(up ? { bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(480, above) } : { top: r.bottom + 4, maxHeight: Math.min(480, room) }) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => { setAt(0); }, [q, only]);
  useEffect(() => { menu.current?.querySelector('[data-active=true]')?.scrollIntoView({ block: 'nearest' }); }, [at, open]);
  // Start on the current choice.
  useEffect(() => { if (open) setAt(Math.max(0, items.findIndex((o) => o.value === value))); }, [open]);

  const star = (v: string) => {
    const next = favs.includes(v) ? favs.filter((k) => k !== v) : [...favs, v];
    setFavs(next);
    try { localStorage.setItem(favorites!, JSON.stringify(next)); } catch { /* private window */ }
  };
  const current = options.find((o) => o.value === value);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setAt((a) => Math.min(items.length - 1, a + 1));
    else if (e.key === 'ArrowUp') setAt((a) => Math.max(0, a - 1));
    else if (e.key === 'Enter' && items[at]) pick(items[at]);
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let index = -1;
  return (
    <>
      <button ref={trigger} type="button" className={`picker-trigger nodrag ${className}`} aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}>
        <span>{children ?? current?.label ?? placeholder}</span><ChevronDown size={14} strokeWidth={1.5} aria-hidden />
      </button>
      {open && createPortal(
        <div ref={menu} className="picker-menu" style={box} role="dialog" aria-label={label} onKeyDown={onKey}>
          <div className="picker-search">
            <label className="search"><Search size={14} strokeWidth={1.5} aria-hidden />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label={`Search ${label}`} />
            </label>
            {favorites && (
              <button type="button" className={`icon${only ? ' active' : ''}`} aria-pressed={only} title="Favourites only" aria-label="Favourites only" onClick={() => setOnly(!only)}>
                <Star size={16} strokeWidth={1.5} fill={only ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
          <div className="picker-list" role="listbox" aria-label={label}>
            {rows.map((r, i) => {
              if (!r.o) return <h3 key={`h${i}`}>{r.head}</h3>;
              const o = r.o, k = ++index, fav = favs.includes(o.value);
              return (
                <div key={`${i}:${o.value}`} className={`picker-row${o.value === value ? ' on' : ''}${k === at ? ' active' : ''}`} data-active={k === at}
                  onMouseMove={() => setAt(k)}>
                  <button type="button" role="option" aria-selected={o.value === value} className="picker-name" onClick={() => pick(o)}>
                    {o.label}{o.hint && <small>{o.hint}</small>}
                  </button>
                  {favorites && (
                    <button type="button" className={`icon small star${fav ? ' on' : ''}`} aria-pressed={fav} aria-label={`${fav ? 'Unfavourite' : 'Favourite'} ${o.label}`} onClick={() => star(o.value)}>
                      <Star size={14} strokeWidth={1.5} fill={fav ? 'currentColor' : 'none'} />
                    </button>
                  )}
                </div>
              );
            })}
            {!items.length && <p className="hint picker-none">{only && !favs.length ? 'Star an item to keep it here.' : empty ?? 'Nothing matches.'}</p>}
          </div>
        </div>, document.body)}
    </>
  );
}
