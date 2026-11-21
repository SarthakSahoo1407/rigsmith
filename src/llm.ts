// The assistant's OpenRouter settings and calls (native/Llm.h). The key lives in the app's settings
// on this Mac; only the chat text and a list of the rig's blocks are ever sent.
import { call } from './native';

export type LlmStatus = { hasKey: boolean; model: string };
export type FreeModel = { id: string; name: string };
export const AUTO_MODEL = 'openrouter/free'; // OpenRouter's router over its free models

export const llmStatus = () => call<LlmStatus>('llmStatus');
export const setLlmKey = (key: string) => call('set', 'orKey', key);
export const setLlmModel = (model: string) => call('set', 'orModel', model);
export const freeModels = () => call<{ models: FreeModel[] } | { error: string }>('llmModels');
