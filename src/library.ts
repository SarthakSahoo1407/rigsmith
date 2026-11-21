// The capture library on this Mac (native Library.h) and the TONE3000 connection, as one small
// store the gear list, the device slots and preset loading all read.

import { useSyncExternalStore } from 'react';
import { call, inApp, on } from './native';
import type { FileRef, Rig } from './rig';

export type Entry = FileRef & { kind: 'nam' | 'ir'; bytes: number; title?: string };
export type T3kStatus = { hasKey: boolean; signedIn: boolean; user: string };
// What TONE3000's API returns for a tone and a model (only the fields we use).
export type Tone = {
  id: number; title: string; gear: string; format: string; license: string; url: string; images?: string[] | null;
  models_count?: number; downloads_count?: number;
  user: { username: string; display_name: string | null; avatar_url: string | null; url: string };
};
export type Model = { id: number; name: string; size: string; model_url: string; architecture_version?: number };
type Failure = { error: string };
export const failed = (r: unknown): r is Failure => typeof r === 'object' && r !== null && 'error' in r;

type Store = { entries: Entry[]; loaded: boolean; t3k: T3kStatus; signIn?: { userCode: string; url: string } };
let store: Store = { entries: [], loaded: false, t3k: { hasKey: false, signedIn: false, user: '' } };
const listeners = new Set<() => void>();
const set = (change: Partial<Store>) => { store = { ...store, ...change }; listeners.forEach((l) => l()); };
export const useLibrary = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => store);

export async function refresh() {
  if (!inApp) return;
  const [entries, t3k] = await Promise.all([call<Entry[]>('library'), call<T3kStatus>('t3kStatus')]);
  set({ entries: entries.sort((a, b) => a.name.localeCompare(b.name)), t3k, loaded: true });
}
if (inApp) {
  refresh();
  on<T3kStatus | Failure>('t3k', (r) => {
    set({ signIn: undefined });
    if (!failed(r)) set({ t3k: r });
  });
}

export const importFiles = async () => { const added = await call<Entry[]>('importLibrary'); await refresh(); return added; };
export const removeFile = async (id: string) => { await call('deleteLibrary', id); await refresh(); };

export async function signIn(): Promise<string | undefined> {
  const r = await call<{ userCode: string; url: string } | Failure>('t3kSignIn');
  if (failed(r)) return r.error;
  set({ signIn: r });
}
export const signOut = async () => set({ t3k: await call<T3kStatus>('t3kSignOut') });
export const setKey = async (key: string) => { await call('set', 't3kKey', key); await refresh(); };

export const search = (q: { query?: string; gears?: string; format?: string; page?: number }) =>
  call<{ data: Tone[]; total_pages?: number } | Failure>('t3kSearch', q);
export const models = (toneId: number) => call<{ data: Model[] } | Failure>('t3kModels', String(toneId));
export const tone = (toneId: number | string) => call<Tone | Failure>('t3kTone', String(toneId));
export async function download(t: Tone, m: Model): Promise<Entry | Failure> {
  const r = await call<Entry | Failure>('t3kDownload', t, m);
  await refresh();
  return r;
}

// A creator is shown by display name when it has one, as TONE3000 asks.
export const creator = (t: Tone) => t.user.display_name || t.user.username;
export const LICENSES: Record<string, string> = {
  t3k: 'T3K: use, don’t redistribute', 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA', 'cc-by-nc': 'CC BY-NC',
  'cc-by-nc-sa': 'CC BY-NC-SA', 'cc-by-nd': 'CC BY-ND', 'cc-by-nc-nd': 'CC BY-NC-ND', cco: 'CC0',
};

// Files a rig refers to that aren't on this Mac. A TONE3000 file is matched by its tone (and model
// when known), so a rig from another Mac or a built-in preset finds a copy downloaded here.
export function resolve(rig: Rig, entries: Entry[]): { rig: Rig; missing: { device: string; slot: string; file: FileRef }[] } {
  const missing: { device: string; slot: string; file: FileRef }[] = [];
  let changed = false;
  const devices = { ...rig.devices };
  for (const d of Object.values(rig.devices)) {
    if (!d.files) continue;
    const files = { ...d.files };
    for (const [slot, f] of Object.entries(d.files)) {
      if (entries.some((e) => e.id === f.id)) continue;
      const same = (e: Entry) => f.toneId !== undefined && String(e.toneId) === String(f.toneId);
      const match = entries.find((e) => same(e) && (f.modelId === undefined || String(e.modelId) === String(f.modelId))) ?? entries.find(same);
      if (!match) { missing.push({ device: d.id, slot, file: f }); continue; }
      const { bytes: _, title: __, ...ref } = match;
      files[slot] = ref;
      changed = true;
    }
    devices[d.id] = { ...d, files };
  }
  return { rig: changed ? { ...rig, devices } : rig, missing };
}
