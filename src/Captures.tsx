// The Captures tab of the gear list: NAM captures and IRs on this Mac, and the TONE3000 catalog.
// Library rows drag onto the rig like gear: a capture becomes a NAM amp, rig or pedal; an IR loads
// into the cab it's dropped on. TONE3000 content always shows its creator and license and is
// presented as TONE3000's, as its API terms ask.

import { useEffect, useState } from 'react';
import { ArrowUpRight, AudioWaveform, Cpu, Download, FolderPlus, Search, Trash2 } from 'lucide-react';
import { call } from './native';
import {
  creator, download, failed, importFiles, LICENSES, models, removeFile, search, signIn, useLibrary, type Entry, type Model, type Tone,
} from './library';

export const DND_FILE = 'application/x-rigsmith-file';
const icon = { size: 16, strokeWidth: 1.5 };
const open = (url?: string) => url && call('openUrl', url);
const GEAR: Record<string, string> = { amp: 'Amp', 'amp-cab': 'Full rig', 'full-rig': 'Full rig', pedal: 'Pedal', cab: 'Cab', outboard: 'Outboard' };

export function Captures({ onSettings }: { onSettings: () => void }) {
  const [tab, setTab] = useState<'library' | 't3k'>('library');
  return (
    <div className="captures">
      <div className="segmented wide" role="tablist">
        <button role="tab" aria-selected={tab === 'library'} aria-pressed={tab === 'library'} onClick={() => setTab('library')}>On this Mac</button>
        <button role="tab" aria-selected={tab === 't3k'} aria-pressed={tab === 't3k'} onClick={() => setTab('t3k')}>TONE3000</button>
      </div>
      {tab === 'library' ? <Library onBrowse={() => setTab('t3k')} /> : <Catalog onSettings={onSettings} />}
    </div>
  );
}

function Library({ onBrowse }: { onBrowse: () => void }) {
  const { entries, loaded } = useLibrary();
  const [kind, setKind] = useState<'all' | 'nam' | 'ir'>('all');
  const shown = entries.filter((e) => kind === 'all' || e.kind === kind);
  return (
    <>
      <div className="captures-bar">
        <div className="chips" role="radiogroup" aria-label="Show">
          {(['all', 'nam', 'ir'] as const).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {{ all: 'All', nam: 'Captures', ir: 'IRs' }[k]}
            </button>
          ))}
        </div>
        <button className="text-button" onClick={importFiles}><FolderPlus {...icon} />Add files</button>
      </div>
      {!loaded && <Skeleton />}
      {loaded && !shown.length && (
        <div className="empty">
          <AudioWaveform size={20} strokeWidth={1.5} />
          <p>{kind === 'ir' ? 'No IRs yet' : 'No captures yet'}</p>
          <span>Add .nam captures or .wav IRs from your Mac, or get them from TONE3000.</span>
          <div className="empty-actions">
            <button className="button" onClick={importFiles}>Add files</button>
            <button className="button quiet" onClick={onBrowse}>Browse TONE3000</button>
          </div>
        </div>
      )}
      <ul className="file-list">
        {shown.map((e) => <FileRow key={e.id} e={e} />)}
      </ul>
    </>
  );
}

function FileRow({ e }: { e: Entry }) {
  return (
    <li className="file-row" draggable title="Drag onto the rig, or onto a cab for an IR"
      onDragStart={(ev) => { ev.dataTransfer.setData(DND_FILE, JSON.stringify(e)); ev.dataTransfer.effectAllowed = 'copy'; }}>
      <span className="file-icon">{e.kind === 'nam' ? <Cpu {...icon} /> : <AudioWaveform {...icon} />}</span>
      <div className="file-text">
        <span className="file-name">{e.name}</span>
        <span className="file-meta">
          {[e.kind === 'ir' ? 'IR' : GEAR[e.gear ?? ''] ?? 'Capture', e.author, e.license && (LICENSES[e.license] ?? e.license)].filter(Boolean).join(' · ')}
        </span>
      </div>
      {e.toneUrl && <button className="icon small" title="Open on TONE3000" aria-label="Open on TONE3000" onClick={() => open(e.toneUrl)}><ArrowUpRight {...icon} /></button>}
      <button className="icon small danger" title="Remove from this Mac" aria-label={`Remove ${e.name}`} onClick={() => removeFile(e.id)}><Trash2 {...icon} /></button>
    </li>
  );
}

const Skeleton = () => (
  <ul className="file-list" aria-busy="true">
    {[0, 1, 2, 3].map((i) => <li key={i} className="file-row skeleton"><span className="file-icon" /><div className="file-text"><span /><span /></div></li>)}
  </ul>
);

const FILTERS: [string, string, string][] = [['amp', 'nam', 'Amps'], ['amp-cab', 'nam', 'Full rigs'], ['pedal', 'nam', 'Pedals'], ['', 'ir', 'IRs']];

function Catalog({ onSettings }: { onSettings: () => void }) {
  const { t3k, signIn: pending } = useLibrary();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(0);
  const [results, setResults] = useState<Tone[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openTone, setOpenTone] = useState<number>();

  const run = async (q = query, f = filter) => {
    setBusy(true);
    setError('');
    const [gears, format] = FILTERS[f];
    const r = await search({ query: q.trim() || undefined, gears: gears || undefined, format });
    setBusy(false);
    if (failed(r)) { setError(r.error); setResults(undefined); } else setResults(r.data);
  };
  useEffect(() => { if (t3k.signedIn) run(); }, [t3k.signedIn]);

  if (!t3k.hasKey) {
    return (
      <div className="empty">
        <Cpu size={20} strokeWidth={1.5} />
        <p>Connect TONE3000</p>
        <span>Browse and download thousands of NAM captures and IRs. Create a free key under Settings → API on tone3000.com, then paste it here.</span>
        <div className="empty-actions">
          <button className="button" onClick={onSettings}>Add your key</button>
          <button className="button quiet" onClick={() => open('https://www.tone3000.com/settings')}>Get a key</button>
        </div>
        <Powered />
      </div>
    );
  }
  if (!t3k.signedIn) {
    return (
      <div className="empty">
        <Cpu size={20} strokeWidth={1.5} />
        {pending ? (
          <>
            <p>Enter this code on tone3000.com</p>
            <code className="device-code">{pending.userCode}</code>
            <span>Your browser opened the page. Rigsmith signs in as soon as you approve.</span>
            <button className="button quiet" onClick={() => open(pending.url)}>Open the page again</button>
          </>
        ) : (
          <>
            <p>Sign in to TONE3000</p>
            <span>Downloads come straight from TONE3000 to this Mac, with each creator's name and license.</span>
            <button className="button" onClick={async () => { const e = await signIn(); if (e) setError(e); }}>Sign in</button>
            {error && <span className="inline-error" role="alert">{error}</span>}
          </>
        )}
        <Powered />
      </div>
    );
  }
  return (
    <>
      <form className="search" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <Search {...icon} aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search TONE3000" />
      </form>
      <div className="chips" role="radiogroup" aria-label="Type">
        {FILTERS.map(([, , label], i) => (
          <button key={label} role="radio" aria-checked={filter === i} className={filter === i ? 'on' : ''} onClick={() => { setFilter(i); run(query, i); }}>{label}</button>
        ))}
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {busy && <Skeleton />}
      {!busy && results && !results.length && <div className="empty small"><p>No tones match</p><span>Try another word or type.</span></div>}
      {!busy && (
        <ul className="tone-list">
          {results?.map((t) => <ToneRow key={t.id} t={t} open={openTone === t.id} onToggle={() => setOpenTone(openTone === t.id ? undefined : t.id)} />)}
        </ul>
      )}
      <Powered />
    </>
  );
}

function ToneRow({ t, open: expanded, onToggle }: { t: Tone; open: boolean; onToggle: () => void }) {
  const { entries } = useLibrary();
  const [list, setList] = useState<Model[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number>();
  useEffect(() => {
    if (!expanded || list) return;
    models(t.id).then((r) => (failed(r) ? setError(r.error) : setList(r.data)));
  }, [expanded]);
  const have = (m: Model) => entries.some((e) => String(e.modelId) === String(m.id));
  return (
    <li className={`tone${expanded ? ' open' : ''}`}>
      <button className="tone-head" onClick={onToggle} aria-expanded={expanded}>
        {t.images?.[0] ? <img src={t.images[0]} alt="" /> : <span className="tone-img" />}
        <span className="file-text">
          <span className="file-name">{t.title}</span>
          <span className="file-meta">{[GEAR[t.gear] ?? t.gear, t.format.toUpperCase(), LICENSES[t.license] ?? t.license].join(' · ')}</span>
          <span className="tone-creator">
            {t.user.avatar_url ? <img src={t.user.avatar_url} alt="" /> : <i />}{creator(t)}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="tone-models">
          {!list && !error && <span className="file-meta">Loading models</span>}
          {error && <span className="inline-error" role="alert">{error}</span>}
          {list?.map((m) => (
            <div key={m.id} className="model-row">
              <span className="file-name">{m.name || t.title}</span>
              <span className="file-meta">{m.size}</span>
              {have(m)
                ? <span className="file-meta lamp-on">On this Mac</span>
                : <button className="text-button" disabled={busy !== undefined} onClick={async () => {
                    setBusy(m.id);
                    const r = await download(t, m);
                    setBusy(undefined);
                    if (failed(r)) setError(r.error);
                  }}><Download {...icon} />{busy === m.id ? 'Downloading' : 'Download'}</button>}
            </div>
          ))}
          <button className="text-button" onClick={() => open(t.url)}><ArrowUpRight {...icon} />View on TONE3000</button>
        </div>
      )}
    </li>
  );
}

const Powered = () => (
  <button className="powered" onClick={() => open('https://www.tone3000.com')}>Powered by TONE3000</button>
);
