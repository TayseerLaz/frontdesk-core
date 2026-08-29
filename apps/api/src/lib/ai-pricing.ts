// Per-provider, per-model pricing — used to convert prompt/completion
// token counts (stored on every MessageProvenance row) into a dollar
// figure shown in /hq. All rates are USD per 1M tokens.
//
// Source of truth: each provider's public pricing page as of the most
// recent code-review pass. If a provider changes pricing, edit this
// table and re-deploy — no schema change, no migration. Operators
// reviewing historical bills should remember the rate applies to the
// time-of-call, not retroactively (we don't snapshot rates per row).

export type ChatModelKey =
  | 'groq:llama-3.3-70b-versatile'
  | 'openai:gpt-4o-mini'
  | 'openai:gpt-4o'
  | 'anthropic:claude-haiku-4-5'
  | 'anthropic:claude-sonnet-4-6'
  | 'anthropic:claude-opus-4-8';

interface Rate {
  /** Input rate, USD per 1M tokens. */
  inUsdPerM: number;
  /** Output rate, USD per 1M tokens. */
  outUsdPerM: number;
}

export const CHAT_PRICING: Record<ChatModelKey, Rate> = {
  'groq:llama-3.3-70b-versatile': { inUsdPerM: 0.59, outUsdPerM: 0.79 },
  'openai:gpt-4o-mini': { inUsdPerM: 0.15, outUsdPerM: 0.6 },
  'openai:gpt-4o': { inUsdPerM: 2.5, outUsdPerM: 10 },
  'anthropic:claude-haiku-4-5': { inUsdPerM: 1, outUsdPerM: 5 },
  'anthropic:claude-sonnet-4-6': { inUsdPerM: 3, outUsdPerM: 15 },
  'anthropic:claude-opus-4-8': { inUsdPerM: 15, outUsdPerM: 75 },
};

/**
 * Convert a (modelLabel, promptTokens, completionTokens) triple into a
 * cost in USD. `modelLabel` is whatever the bot-engine recorded in
 * MessageProvenance.model — "groq:<model>" or "<model>" depending on
 * provider. Returns 0 for any unknown model so historical rows from
 * before the dispatch existed don't break aggregation queries.
 */
export function tokensToUsd(
  modelLabel: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  // Delegates to the cache-aware pricer. With cache counts 0 (the common case
  // for callers that don't track the split) this is the plain input×rate +
  // output×rate it always was.
  return costUsdWithCache(
    modelLabel,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
  );
}

// Cache multipliers relative to the base input rate. Anthropic: reads are 10%
// of the base rate, writes (cache creation) are 125%. OpenAI: cached input is
// billed at 50% (and there is no separate "write" charge). Groq: no caching.
const CACHE_READ_MULT: Record<string, number> = {
  anthropic: 0.1,
  openai: 0.5,
  groq: 1, // unused (no cache)
};
const CACHE_WRITE_MULT: Record<string, number> = {
  anthropic: 1.25,
  openai: 1, // OpenAI has no explicit cache-write charge
  groq: 1,
};

function providerOf(key: ChatModelKey): 'anthropic' | 'openai' | 'groq' {
  if (key.startsWith('anthropic:')) return 'anthropic';
  if (key.startsWith('groq:')) return 'groq';
  return 'openai';
}

/**
 * Exact cost in USD for a reply, pricing the prompt-cache split at its real
 * per-bucket rate. `promptTokens` is the TOTAL input (uncached + cache read +
 * cache write); `cacheReadTokens`/`cacheWriteTokens` are subsets of it. The
 * uncached remainder is priced at the base input rate, cache reads/writes at
 * their multiplier, completion at the output rate. With both cache counts 0
 * this equals {@link tokensToUsd} exactly (so old rows are unaffected).
 */
export function costUsdWithCache(
  modelLabel: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const key = normaliseModelKey(modelLabel);
  const rate = key ? CHAT_PRICING[key] : null;
  if (!rate) return 0;
  const provider = providerOf(key!);
  const read = Math.max(0, cacheReadTokens);
  const write = Math.max(0, cacheWriteTokens);
  const uncached = Math.max(0, promptTokens - read - write);
  const inM = rate.inUsdPerM / 1_000_000;
  return (
    uncached * inM +
    read * inM * (CACHE_READ_MULT[provider] ?? 1) +
    write * inM * (CACHE_WRITE_MULT[provider] ?? 1) +
    (completionTokens / 1_000_000) * rate.outUsdPerM
  );
}

// ---------------------------------------------------------------------------
// Non-LLM cost rates — voice transcription, WhatsApp messaging, object storage.
// These let the billing page show a full "what this tenant costs us" picture.
// All are best-effort estimates (LABEL them "est." in the UI): we don't store
// audio duration, Meta's per-message price is country/category dependent, and
// storage is billed monthly by Wasabi. Edit + redeploy if rates change.
// ---------------------------------------------------------------------------
export const COST_RATES = {
  /**
   * Estimated USD per inbound voice-note transcription. We route most English
   * notes to Groq Whisper (~$0.00185/min) and Arabic to OpenAI gpt-4o-transcribe
   * (~$0.006/min). With a typical ~20s note this averages out to a small flat
   * figure — used only when we can't measure duration.
   */
  transcriptionUsd: 0.003,
  /**
   * Estimated USD per billable WhatsApp conversation — Meta opens a 24h
   * conversation when a template is delivered to a user and bills ONCE for it;
   * every message inside that window (and all inbound) is free. So we price the
   * count of distinct (user, 24h-window) template conversations, NOT raw message
   * volume. This is a blended marketing-conversation rate; adjust to your
   * dominant market (e.g. Lebanon marketing ≈ this ballpark).
   */
  whatsappMessageUsd: 0.03,
  /** Wasabi storage, USD per GB per month (≈ $6.99/TB/mo). */
  storageUsdPerGbMonth: 0.0068,
} as const;

/** Estimated transcription cost for a count of voice notes. */
export function transcriptionCostUsd(count: number): number {
  return Math.max(0, count) * COST_RATES.transcriptionUsd;
}

/** Estimated WhatsApp messaging cost for a count of outbound messages. */
export function whatsappMessageCostUsd(count: number): number {
  return Math.max(0, count) * COST_RATES.whatsappMessageUsd;
}

/** Estimated monthly storage cost for a number of stored bytes. */
export function storageCostUsd(bytes: number): number {
  return (Math.max(0, bytes) / 1_000_000_000) * COST_RATES.storageUsdPerGbMonth;
}

function normaliseModelKey(modelLabel: string): ChatModelKey | null {
  const m = modelLabel.toLowerCase().trim();
  if (m.includes('groq:') || m.includes('llama-3.3-70b')) {
    return 'groq:llama-3.3-70b-versatile';
  }
  if (m.includes('gpt-4o-mini')) return 'openai:gpt-4o-mini';
  if (m.includes('gpt-4o')) return 'openai:gpt-4o';
  if (m.includes('haiku')) return 'anthropic:claude-haiku-4-5';
  if (m.includes('opus')) return 'anthropic:claude-opus-4-8';
  if (m.includes('sonnet') || m.includes('claude')) return 'anthropic:claude-sonnet-4-6';
  return null;
}

// Per-plan model label — what the bot-engine should record on
// MessageProvenance.model for downstream cost roll-ups. Keep platform
// with the dispatch in lib/openai.ts complete() to avoid drift.
export function modelLabelForPlan(plan: 'basic' | 'middle' | 'max' | 'ultra'): string {
  switch (plan) {
    case 'ultra':
      // The final grounded reply (the cost driver) runs on Sonnet. The
      // ultra plan's auxiliary Haiku passes are metered + recorded
      // separately under the anthropic:claude-haiku-4-5 key.
      return 'anthropic:claude-sonnet-4-6';
    case 'max':
      return 'anthropic:claude-sonnet-4-6';
    case 'middle':
      return 'openai:gpt-4o';
    case 'basic':
    default:
      return 'groq:llama-3.3-70b-versatile';
  }
}
