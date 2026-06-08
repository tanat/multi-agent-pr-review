import { gateway, type LanguageModel } from 'ai';

export const MODEL_IDS = {
  sonnet: 'claude-sonnet-4-6',
  'gpt-4o': 'gpt-4o',
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-pro': 'gemini-2.5-pro',
} as const;

export type ModelKey = keyof typeof MODEL_IDS;

/** Route every model through the Vercel AI Gateway — one key, no per-provider SDKs. */
export function modelFor(key: ModelKey): LanguageModel {
  if (key === 'gpt-4o') return gateway('openai/gpt-4o') as unknown as LanguageModel;
  if (key === 'gemini-flash') return gateway('google/gemini-2.5-flash') as unknown as LanguageModel;
  if (key === 'gemini-pro') return gateway('google/gemini-2.5-pro') as unknown as LanguageModel;
  return gateway('anthropic/claude-sonnet-4-6') as unknown as LanguageModel;
}
