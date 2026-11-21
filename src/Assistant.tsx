// "Ask": type what you want ("more reverb", "swap the delay for a tape echo", "add a delay after the
// reverb") and it's done, as one undo step. assistant.ts turns the sentence into checked edits.
// Also the OpenRouter settings (key and model) shown in Settings.

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Sparkles, Undo2, X } from 'lucide-react';
import { applyPlan, ask, type Result } from './ops';
import { AUTO_MODEL, freeModels, llmStatus, setLlmKey, setLlmModel, type FreeModel, type LlmStatus } from './llm';
import { Picker } from './Picker';
import type { Edit } from './gear';
import type { Rig } from './rig';

const EXAMPLES = ['more reverb', 'a bit less gain', 'swap the delay for a tape echo', 'add a delay after the reverb', 'remove the chorus', 'delay on dotted eighths at 96 bpm'];
type Shown = { say?: string; ask?: string; done: string[]; failed: string[]; error?: string; changed?: boolean };

export function Assistant({ getRig, edit, onUndo, onSettings, onClose }: {
  getRig: () => Rig | undefined; edit: Edit; onUndo: () => void; onSettings: () => void; onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Shown>();
  const [example] = useState(() => EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const send = async () => {
    const request = text.trim(), rig = getRig();
    if (!request || !rig || busy) return;
    setBusy(true);
    setShown(undefined);
    const status = await llmStatus();
    if (!status.hasKey) { setBusy(false); setShown({ done: [], failed: [], error: 'Add your OpenRouter key in Settings to use the assistant.' }); return; }
    const reply = await ask(rig, request);
    setBusy(false);
    if ('error' in reply) { setShown({ done: [], failed: [], error: reply.error }); return; }
    const { plan } = reply;
    if (plan.ask && !plan.ops.length) { setShown({ ask: plan.ask, done: [], failed: [] }); return; }
    // Applied to the rig as it is now, as one undo step, in case you changed something while it thought.
    let result: Result | undefined;
    edit((r) => { result = applyPlan(r, plan); return result.rig; });
    setShown({ say: plan.say, done: result?.done ?? [], failed: result?.failed ?? [], changed: !!result?.done.length });
    setText('');
  };

  return (
    <div className="assistant" role="dialog" aria-label="Ask the assistant" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      {shown && (
        <div className="assistant-result" role="status" aria-live="polite">
          {shown.error && <p className="inline-error">{shown.error}{shown.error.includes('Settings') && <button className="text-button" onClick={onSettings}>Open Settings</button>}</p>}
          {shown.ask && <p className="assistant-ask">{shown.ask}</p>}
          {shown.say && <p className="assistant-say">{shown.say}</p>}
          {shown.done.length > 0 && <ul>{shown.done.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          {shown.failed.length > 0 && <ul className="failed">{shown.failed.map((d, i) => <li key={i}>Skipped: {d}</li>)}</ul>}
          {!shown.error && !shown.ask && !shown.done.length && !shown.failed.length && <p className="hint">Nothing needed changing.</p>}
          {shown.changed && <button className="text-button" onClick={() => { onUndo(); setShown(undefined); }}><Undo2 size={14} strokeWidth={1.5} />Undo</button>}
        </div>
      )}
      <form className="assistant-bar" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <Sparkles size={16} strokeWidth={1.5} aria-hidden />
        <input ref={input} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} placeholder={`Ask for a change, like "${example}"`} aria-label="What do you want changed?" disabled={busy} />
        <button type="submit" className="icon" disabled={busy || !text.trim()} aria-label="Send" title="Send (Enter)">{busy ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <ArrowUp size={16} strokeWidth={1.5} />}</button>
        <button type="button" className="icon" aria-label="Close" title="Close (Esc)" onClick={onClose}><X size={16} strokeWidth={1.5} /></button>
      </form>
    </div>
  );
}

// Settings: the OpenRouter key and which free model answers.
export function AssistantSettings() {
  const [status, setStatus] = useState<LlmStatus>();
  const [models, setModels] = useState<FreeModel[]>();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    llmStatus().then(setStatus);
    freeModels().then((r) => ('error' in r ? setError(r.error) : setModels(r.models)));
  }, []);
  const options = [{ value: AUTO_MODEL, label: 'Auto: any free model', hint: 'recommended' },
    ...(models ?? []).filter((m) => m.id !== AUTO_MODEL).map((m) => ({ value: m.id, label: m.name || m.id, hint: m.id.endsWith(':free') ? 'free' : '' }))];
  return (
    <section>
      <h3>Assistant (OpenRouter)</h3>
      <p className="hint">Type what you want changed and the assistant edits the rig. It uses a free model on openrouter.ai: make a free key at openrouter.ai/keys. Only your request and a list of the rig's blocks and knobs are sent, never audio or capture files.</p>
      <form className="key-form" onSubmit={async (e) => { e.preventDefault(); if (key.trim()) { await setLlmKey(key); setKey(''); setStatus(await llmStatus()); } }}>
        <label className="field"><span>Key</span>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status?.hasKey ? 'Saved. Paste a new one to replace it' : 'sk-or-...'} autoComplete="off" />
        </label>
        <button type="submit" className="button" disabled={!key.trim()}>Save key</button>
      </form>
      <label className="field model-field"><span>Model</span>
        <Picker label="Assistant model" value={status?.model ?? AUTO_MODEL} options={options} placeholder="Loading models" empty={error || 'No free models found'}
          onChange={async (m) => { await setLlmModel(m); setStatus(await llmStatus()); }} />
      </label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <p className="hint">Free models are rate-limited and vary in quality. If one is busy or answers badly, pick another.</p>
    </section>
  );
}
