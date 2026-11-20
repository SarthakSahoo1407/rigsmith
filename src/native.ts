// Bridge to the JUCE backend. Same protocol as JUCE's
// juce_gui_extra/native/javascript/index.js, minus the parts we don't use.

type Token = [string, number];
type Backend = {
  addEventListener(id: string, fn: (payload: any) => void): Token;
  removeEventListener(token: Token): void;
  emitEvent(id: string, payload: unknown): void;
};

const backend = (globalThis as { __JUCE__?: { backend: Backend } }).__JUCE__?.backend;
export const inApp = backend !== undefined;

let nextId = 0;
const pending = new Map<number, (result: unknown) => void>();
backend?.addEventListener('__juce__complete', ({ promiseId, result }) => {
  pending.get(promiseId)?.(result);
  pending.delete(promiseId);
});

export function call<T = void>(name: string, ...params: unknown[]): Promise<T> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve as (r: unknown) => void);
    backend!.emitEvent('__juce__invoke', { name, params, resultId: id });
  });
}

export function on<T>(event: string, fn: (payload: T) => void) {
  const token = backend!.addEventListener(event, fn);
  return () => backend!.removeEventListener(token);
}

export type State = {
  volume: number;
  plugin?: boolean; // running inside a DAW
  t3kKey?: boolean; // a TONE3000 key is set
  device?: string;
  inputs?: string[];
  sampleRate?: number;
  bufferSize?: number;
  inputMs?: number;
  outputMs?: number;
};
// Levels are peaks since the last update (output before the safety clipper); ram in MB.
export type Meter = { peak: number; out: number; cpu: number; ram: number };

// Audio CPU as two digits, 00-99, so readouts never change width (and shift the bar) when the load crosses 10%.
export const cpuText = (load: number) => String(Math.max(0, Math.min(99, Math.round(load * 100)))).padStart(2, '0');
