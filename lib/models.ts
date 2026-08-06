import { gateway, type LanguageModel } from 'ai';

export const MODEL_IDS = {
  sonnet: 'claude-sonnet-4-6',
  'gpt-4o': 'gpt-4o',
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-pro': 'gemini-2.5-pro',
} as const;

export type ModelKey = keyof typeof MODEL_IDS;

/**
 * Published list price, US dollars per million tokens.
 *
 * Hard-coded rather than fetched: a cost figure in an eval row has to mean the
 * same thing when the row is read a year later, and a price that silently moves
 * makes every historical row incomparable. Wrong-but-pinned beats
 * right-but-drifting for a number whose job is comparison. Update deliberately.
 */
export const PRICING: Record<ModelKey, { inputPerMTok: number; outputPerMTok: number }> = {
  sonnet: { inputPerMTok: 3, outputPerMTok: 15 },
  'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'gemini-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-pro': { inputPerMTok: 1.25, outputPerMTok: 10 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export function costOf(key: ModelKey, usage: Usage): number {
  const p = PRICING[key];
  return (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}

/** Route every model through the Vercel AI Gateway — one key, no per-provider SDKs. */
export function modelFor(key: ModelKey): LanguageModel {
  if (key === 'gpt-4o') return gateway('openai/gpt-4o') as unknown as LanguageModel;
  if (key === 'gemini-flash') return gateway('google/gemini-2.5-flash') as unknown as LanguageModel;
  if (key === 'gemini-pro') return gateway('google/gemini-2.5-pro') as unknown as LanguageModel;
  return gateway('anthropic/claude-sonnet-4-6') as unknown as LanguageModel;
}
