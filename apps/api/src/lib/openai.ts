// Thin wrapper around the OpenAI SDK so route + worker code stays
// short and so we centralise token-cap policy here.
//
// Notes:
//   - OpenAI auto-caches identical prompt prefixes >1024 tokens, so the
//     long system prompt (KB blob) doesn't need an explicit cache flag.
//   - Per-org daily token budget is enforced in Redis to bound spend.
//   - When the env var is missing we throw a SERVICE_UNAVAILABLE so
//     callers can 503 cleanly.
//   - The complete() function routes to a different provider per the
//     tenant's Organization.aiPlan — `basic` = Groq Llama 3.3 70B +
//     OpenAI gpt-4o-mini fallback; `middle` = OpenAI gpt-4o; `max` =
//     Anthropic Claude (Sonnet by default). The plan lookup is cached
//     per-request via withRlsBypass to avoid an extra DB hit on the
//     hot bot-reply path.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { withRlsBypass } from './db.js';
import { env } from './env.js';
import { reportModelDegrade } from './model-degrade.js';
import { getRedis } from './redis.js';

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is not configured.');
    (err as Error & { code?: string }).code = 'NO_KEY';
    throw err;
  }
  if (_client) return _client;
  _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _client;
}

// Groq is the primary backend for chat completions. Groq's /openai/v1
// endpoint is OpenAI-API-compatible so the same SDK works with just a
// baseURL + apiKey swap. Transcription stays on the OpenAI client below
// (gpt-4o-transcribe is materially better than Groq's Whisper for Arabic
// dialects + code-switched audio, which is most of our customer base).
//
// Fallback policy: when Groq returns a rate-limit / 5xx error AND
// OPENAI_API_KEY is set, the bot retries the same prompt against
// gpt-4o-mini on OpenAI. Groq's free tier has a 100K-tokens-per-day cap
// on llama-3.3-70b-versatile that the live bot blows through in ~6 hours
// of traffic; without the fallback every bot reply after that goes silent
// until the cap resets. We don't have an env-flag to disable this — the
// alternative is the silent-bot bug we are explicitly fixing.
let _groqClient: OpenAI | null = null;
function groqClient(): OpenAI {
  if (!env.GROQ_API_KEY) {
    const err = new Error(
      'GROQ_API_KEY is not configured. Chat completions require Groq — ' +
        'add the key to .env / .env.production and restart. (Transcription ' +
        'still uses OPENAI_API_KEY; that key is separate.)',
    );
    (err as Error & { code?: string }).code = 'NO_KEY';
    throw err;
  }
  if (_groqClient) return _groqClient;
  _groqClient = new OpenAI({
    apiKey: env.GROQ_API_KEY,
    baseURL: env.GROQ_BASE_URL,
  });
  return _groqClient;
}

// Returns the client + model + a label for chat completions. Primary Groq,
// OpenAI used only as the 429 / 5xx fallback below. Each call site stays
// provider-agnostic; provenance + logs include the label so an operator
// can see which provider/model actually ran.
function chatClientAndModel(): { client: OpenAI; model: string; provider: 'openai' | 'groq' } {
  return { client: groqClient(), model: env.GROQ_MODEL, provider: 'groq' };
}

let _anthropicClient: Anthropic | null = null;
function anthropicClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (_anthropicClient) return _anthropicClient;
  _anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _anthropicClient;
}

// Per-org plan lookup. Cached in-process for ~30s so the bot's hot
// reply loop doesn't hit Postgres on every turn — plan changes are
// rare and the operator who changes it gets the new behaviour at
// most one cache-cycle late.
type AiPlanRow = { aiPlan: 'basic' | 'middle' | 'max' | 'ultra' };
const planCache = new Map<string, { plan: 'basic' | 'middle' | 'max' | 'ultra'; expiresAt: number }>();
const PLAN_CACHE_TTL_MS = 30_000;

async function loadOrgPlan(orgId: string): Promise<'basic' | 'middle' | 'max' | 'ultra'> {
  const now = Date.now();
  const cached = planCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.plan;
  try {
    const row = await withRlsBypass((tx) =>
      tx.organization.findUnique({ where: { id: orgId }, select: { aiPlan: true } }),
    );
    const plan = (row as AiPlanRow | null)?.aiPlan ?? 'basic';
    planCache.set(orgId, { plan, expiresAt: now + PLAN_CACHE_TTL_MS });
    return plan;
  } catch {
    return 'basic';
  }
}

/**
 * Test-only: clear the in-process plan cache so an integration test
 * can flip an org's plan and see the change immediately. Production
 * code should never call this.
 */
export function _clearAiPlanCacheForTests(): void {
  planCache.clear();
}

/**
 * Public accessor for a tenant's AI plan (cached). Used by the bot
 * call-site to decide whether to run the ultra-plan extras (persona
 * memory load + post-reply summarization) without duplicating the
 * cache logic.
 */
export async function getOrgAiPlan(
  orgId: string,
): Promise<'basic' | 'middle' | 'max' | 'ultra'> {
  return loadOrgPlan(orgId);
}

// Treat 429 (rate-limit) and 502/503 (Groq load-shedding) as "fall back
// to OpenAI." Matches every shape the OpenAI SDK uses across transports
// — top-level .status, nested .response.status, the typed RateLimitError
// constructor name, and the rate_limit_exceeded code. Mirrors the worker's
// isRetryableError helper (apps/worker/src/lib/openai.ts) so the two
// fallback policies stay aligned.
function isGroqRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const status = (e.status as number | undefined) ?? (e.statusCode as number | undefined);
  if (status === 429 || status === 502 || status === 503) return true;
  const r = e.response as Record<string, unknown> | undefined;
  if (r) {
    const rs = r.status as number | undefined;
    if (rs === 429 || rs === 502 || rs === 503) return true;
  }
  if (e.code === 'rate_limit_exceeded') return true;
  const inner = e.error as Record<string, unknown> | undefined;
  if (inner && inner.code === 'rate_limit_exceeded') return true;
  const ctorName = (e.constructor as { name?: string } | undefined)?.name;
  if (ctorName === 'RateLimitError') return true;
  const msg = (e.message as string | undefined) ?? '';
  if (typeof msg === 'string' && /rate.?limit|too many requests|service unavailable/i.test(msg)) {
    return true;
  }
  return false;
}

export function isOpenAIConfigured(): boolean {
  return !!env.OPENAI_API_KEY;
}

// Phase 12 — surface the active chat provider + model so the provenance
// row + logs reflect what actually ran (not just env.OPENAI_MODEL).
export function activeChatProvider(): { provider: 'openai' | 'groq'; model: string } {
  const { provider, model } = chatClientAndModel();
  return { provider, model };
}

// Per-org daily token cap. Configurable via env; default raised from the old
// hardcoded 200k now that usage is reconciled to ACTUAL tokens (below) instead
// of the pessimistic pre-charge, so the cap reflects real consumption.
export const DAILY_TOKEN_LIMIT_PER_ORG = Number(process.env.AI_DAILY_TOKEN_LIMIT ?? 1_000_000);

// gpt-4o-mini price points (USD per 1M tokens), used to estimate cost.
// We don't track input/output split per call; assume a 70/30 mix which
// is conservative-ish for our prompts (long system prompt + short reply).
export const PRICE_INPUT_PER_M = 0.15;
export const PRICE_OUTPUT_PER_M = 0.60;
export const PRICE_BLENDED_PER_M = 0.7 * PRICE_INPUT_PER_M + 0.3 * PRICE_OUTPUT_PER_M;

export function estimateCostUsd(tokens: number): number {
  return (tokens / 1_000_000) * PRICE_BLENDED_PER_M;
}

// ALIGNED admins get unlimited daily tokens. Same predicate the
// billing cap check uses — single source of truth.
async function isUnlimitedOrg(orgId: string): Promise<boolean> {
  const { isOrgUnlimited } = await import('./billing.js');
  return isOrgUnlimited(orgId);
}

async function consumeDailyTokens(orgId: string, tokens: number): Promise<boolean> {
  const redis = getRedis();
  const day = new Date().toISOString().slice(0, 10);
  const key = `aitokens:${orgId}:${day}`;
  // We still bump the counter for unlimited orgs so we can show their
  // usage / cost in the dashboard — we just don't enforce the cap.
  const used = await redis.incrby(key, tokens);
  if (used === tokens) {
    await redis.expire(key, 60 * 60 * 26);
  }
  // Tracking only — the enforced cap is now the per-tenant MONTHLY AI-MESSAGE
  // allowance (lib/ai-messages.ts), NOT this daily token counter. We keep
  // counting tokens purely for the ALIGNED-admin cost view (tokens/USD per
  // day/month), so this never gates a reply. (Avoids the old failure mode where
  // a low daily token cap silently bricked the bot.)
  void orgId;
  return true;
}

// Adjust today's counter by a (possibly negative) delta. Used to reconcile the
// pessimistic pre-charge down to the actual tokens a completion used — and to
// refund the full pre-charge when a call is aborted (budget gate / LLM error).
// Clamps at 0 so a refund can never drive the counter negative.
async function reconcileDailyTokens(orgId: string, delta: number): Promise<void> {
  const d = Math.round(delta);
  if (d === 0) return;
  const redis = getRedis();
  const day = new Date().toISOString().slice(0, 10);
  const key = `aitokens:${orgId}:${day}`;
  const after = await redis.incrby(key, d);
  if (after < 0) await redis.set(key, '0', 'KEEPTTL');
}

// Read-only helper for the dashboard widget. Returns today's running
// total (in tokens) for the given org. Never throws — falls back to 0.
export async function readDailyTokenUsage(orgId: string): Promise<{
  used: number;
  limit: number;
  unlimited: boolean;
  percentUsed: number;
  estCostUsd: number;
}> {
  const redis = getRedis();
  const day = new Date().toISOString().slice(0, 10);
  const key = `aitokens:${orgId}:${day}`;
  const raw = await redis.get(key);
  const used = raw ? Number(raw) : 0;
  const unlimited = await isUnlimitedOrg(orgId);
  const limit = DAILY_TOKEN_LIMIT_PER_ORG;
  const percentUsed = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return {
    used,
    limit,
    unlimited,
    percentUsed,
    estCostUsd: estimateCostUsd(used),
  };
}

interface CompleteArgs {
  organizationId: string;
  systemPrompt: string;
  // Optional stable/variable split of systemPrompt (they concatenate to the
  // same content). When provided, the Claude tiers prompt-CACHE only the stable
  // prefix (persona + rules + business info) and send the per-message variable
  // tail (top-K catalog/FAQs) fresh — so a conversation's follow-up turns hit
  // the cache (read @ 0.1x) instead of re-writing the whole prompt (@ 1.25x).
  // Non-Claude tiers ignore these and use systemPrompt as before.
  systemPromptStable?: string;
  systemPromptVariable?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
  // EVAL-ONLY plan override. When set, route to this model tier instead of the
  // org's configured aiPlan — lets the eval harness run the SAME questions on
  // every plan (basic/middle/max/ultra) to compare quality. Never set in prod.
  planOverride?: 'basic' | 'middle' | 'max' | 'ultra';
}

// inputTokens = TOTAL input processed (uncached + cache read + cache write).
// cacheReadTokens / cacheWriteTokens are subsets of it, surfaced so the cost
// layer can price each bucket at its real rate. Non-caching providers return 0.
type CompleteResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  // True when a max/ultra tier silently fell back to the basic stack (missing
  // Anthropic key / provider error). The reply still went out; WS6b alerts on it.
  degraded?: boolean;
};

export async function complete(args: CompleteArgs): Promise<CompleteResult> {
  // Pre-charge the budget pessimistically (estimate input length / 4 chars
  // per token, plus the maxTokens we're requesting). Final accounting on
  // the response is best-effort.
  const estIn = Math.ceil(args.systemPrompt.length / 4)
    + args.messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
  const estOut = args.maxTokens ?? 1024;
  const prePaid = estIn + estOut;
  const ok = await consumeDailyTokens(args.organizationId, prePaid);
  if (!ok) {
    // We incremented the counter in the gate check but are NOT making the call —
    // refund the pre-charge so a blocked attempt doesn't permanently burn budget.
    await reconcileDailyTokens(args.organizationId, -prePaid);
    const err = new Error('Daily AI token budget exceeded for this organization.');
    (err as Error & { code?: string }).code = 'TOKEN_BUDGET_EXCEEDED';
    throw err;
  }

  const plan = args.planOverride ?? (await loadOrgPlan(args.organizationId));

  try {
    let result: CompleteResult;
    switch (plan) {
      case 'ultra':
        result = await completeUltra(args);
        break;
      case 'max':
        result = await completeMax(args);
        break;
      case 'middle':
        result = await completeMiddle(args);
        break;
      case 'basic':
      default:
        result = await completeBasic(args);
        break;
    }
    // Reconcile the pessimistic pre-charge down to actual usage (almost always a
    // refund: we pre-charge 1024 output tokens but most replies are far shorter).
    await reconcileDailyTokens(
      args.organizationId,
      result.inputTokens + result.outputTokens - prePaid,
    );
    // WS6b: if a max/ultra plan silently degraded to basic, alert admins
    // (deduped 1/day/tenant). Fire-and-forget — never delays or breaks the reply.
    if (result.degraded && (plan === 'max' || plan === 'ultra')) {
      void reportModelDegrade(args.organizationId, plan, result.model);
    }
    return result;
  } catch (err) {
    // The call failed (network / provider error) — refund the full pre-charge.
    await reconcileDailyTokens(args.organizationId, -prePaid);
    throw err;
  }
}

// ---------- basic tier (Groq Llama → OpenAI mini fallback) ----------------

async function completeBasic(args: CompleteArgs): Promise<CompleteResult> {
  const payload = {
    max_tokens: args.maxTokens ?? 1024,
    temperature: args.temperature ?? 0.4,
    messages: [
      { role: 'system' as const, content: args.systemPrompt },
      ...args.messages,
    ],
  };

  // Primary: Groq. On 429/5xx we fall back to OpenAI if a key is set.
  try {
    const { client: c, model } = chatClientAndModel();
    const res = await c.chat.completions.create({ model, ...payload });
    return {
      text: (res.choices[0]?.message.content ?? '').trim(),
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      cacheReadTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
      model: `groq:${model}`,
    };
  } catch (err) {
    if (!isGroqRetryableError(err)) throw err;
    if (!env.OPENAI_API_KEY) throw err;
    // eslint-disable-next-line no-console
    console.warn(
      '[chat] Groq retryable error — falling back to OpenAI',
      env.OPENAI_MODEL,
      ':',
      err instanceof Error ? err.message.slice(0, 200) : String(err),
    );
    const res = await client().chat.completions.create({
      model: env.OPENAI_MODEL,
      ...payload,
    });
    return {
      text: (res.choices[0]?.message.content ?? '').trim(),
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      cacheReadTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
      model: `openai:${env.OPENAI_MODEL}`,
    };
  }
}

// ---------- middle tier (OpenAI gpt-4o) ----------------------------------

const MIDDLE_MODEL = 'gpt-4o';

async function completeMiddle(args: CompleteArgs): Promise<CompleteResult> {
  const res = await client().chat.completions.create({
    model: MIDDLE_MODEL,
    max_tokens: args.maxTokens ?? 1024,
    temperature: args.temperature ?? 0.4,
    messages: [
      { role: 'system', content: args.systemPrompt },
      ...args.messages,
    ],
  });
  return {
    text: (res.choices[0]?.message.content ?? '').trim(),
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    cacheReadTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    model: `openai:${MIDDLE_MODEL}`,
  };
}

// ---------- max tier (Anthropic Claude) ----------------------------------
// Anthropic's Messages API takes the system prompt as a separate
// argument (not a message). Output tokens come back on usage.output_tokens.
// On any error (including missing API key) we degrade gracefully to the
// basic stack so a key misconfig doesn't take the bot offline.

// Anthropic's `usage.input_tokens` counts only the UNCACHED input. With prompt
// caching on (we cache the large per-tenant system prompt), the bulk of the real
// input is billed under cache_read_input_tokens (cache hit, ~10% price) +
// cache_creation_input_tokens (cache write, ~125% price). Summing all three
// gives the true input token volume that Anthropic actually bills — otherwise a
// cached reply looks like ~9 input tokens when it really processed ~3,500, and
// our cost dashboard reads near-zero vs the real Anthropic invoice.
function anthropicInputTokens(usage: {
  input_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

// Build the Anthropic `system` blocks with prompt caching applied to the STABLE
// prefix only. When buildBotResponse supplies a stable/variable split, we cache
// the persona+rules+business-info prefix (identical across a conversation's
// turns → the 2nd+ message reads it at ~0.1x instead of re-writing the whole
// prompt at ~1.25x) and send the per-message catalog/FAQ tail uncached. Without
// the split we fall back to caching the whole prompt (legacy behaviour).
function anthropicSystemBlocks(
  args: CompleteArgs,
): { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] {
  if (args.systemPromptStable && args.systemPromptVariable) {
    return [
      { type: 'text', text: args.systemPromptStable, cache_control: { type: 'ephemeral' } },
      // Lead with the '\n' that joined the two halves in the original single
      // string, so the concatenated blocks are byte-identical to systemPrompt
      // (the '# Catalog' header stays on its own line — not glued to the prefix).
      { type: 'text', text: `\n${args.systemPromptVariable}` },
    ];
  }
  return [{ type: 'text', text: args.systemPrompt, cache_control: { type: 'ephemeral' } }];
}

async function completeMax(args: CompleteArgs): Promise<CompleteResult> {
  const a = anthropicClient();
  if (!a) {
    // eslint-disable-next-line no-console
    console.warn('[chat] aiPlan=max but ANTHROPIC_API_KEY unset — degrading to basic');
    return { ...(await completeBasic(args)), degraded: true };
  }
  try {
    const res = await a.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: args.maxTokens ?? 1024,
      temperature: args.temperature ?? 0.4,
      // Prompt caching: cache the stable prefix (persona/rules/business info),
      // not the per-message catalog/FAQ tail — so a conversation's follow-up
      // turns hit the cache (~0.1x) instead of re-writing everything (~1.25x).
      system: anthropicSystemBlocks(args),
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    // Concatenate text blocks (Claude can return multi-block content).
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim();
    return {
      text,
      inputTokens: anthropicInputTokens(res.usage),
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      model: `anthropic:${res.model}`,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[chat] Anthropic error — degrading to basic',
      err instanceof Error ? err.message.slice(0, 200) : String(err),
    );
    return { ...(await completeBasic(args)), degraded: true };
  }
}

// ---------- ultra tier (Haiku-assisted Sonnet) ---------------------------
// The conversational reply runs on Sonnet (ANTHROPIC_ULTRA_MODEL) for
// top-tier reasoning + faithfulness. The cheap auxiliary passes (intent
// classification, persona summarization) run on Haiku via completeFast()
// below. Same graceful-degradation contract as completeMax: if Anthropic
// is unavailable we fall back to the basic stack so a key misconfig never
// takes the bot offline.
async function completeUltra(args: CompleteArgs): Promise<CompleteResult> {
  const a = anthropicClient();
  if (!a) {
    // eslint-disable-next-line no-console
    console.warn('[chat] aiPlan=ultra but ANTHROPIC_API_KEY unset — degrading to basic');
    return { ...(await completeBasic(args)), degraded: true };
  }
  try {
    const res = await a.messages.create({
      model: env.ANTHROPIC_ULTRA_MODEL,
      max_tokens: args.maxTokens ?? 1024,
      temperature: args.temperature ?? 0.4,
      // Cache the stable prefix only (see completeMax / anthropicSystemBlocks).
      system: anthropicSystemBlocks(args),
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim();
    return {
      text,
      inputTokens: anthropicInputTokens(res.usage),
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      model: `anthropic:${res.model}`,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[chat] Anthropic (ultra) error — degrading to basic',
      err instanceof Error ? err.message.slice(0, 200) : String(err),
    );
    return { ...(await completeBasic(args)), degraded: true };
  }
}

// ---------- fast auxiliary pass (Haiku JSON) ------------------------------
// Cheap, structured side-calls for the ultra plan: intent classification,
// per-contact persona summarization, etc. Runs on Haiku for speed + low
// cost; falls back to the basic JSON path (Groq/OpenAI json_object mode)
// when Anthropic isn't configured. Metered against the same per-org daily
// token budget as the main reply. Returns parsed JSON of the caller's type.
export async function completeFast<T = unknown>(args: {
  organizationId: string;
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<T> {
  const estIn = Math.ceil((args.systemPrompt.length + args.userContent.length) / 4);
  const estOut = args.maxTokens ?? 400;
  const ok = await consumeDailyTokens(args.organizationId, estIn + estOut);
  if (!ok) {
    const err = new Error('Daily AI token budget exceeded for this organization.');
    (err as Error & { code?: string }).code = 'TOKEN_BUDGET_EXCEEDED';
    throw err;
  }

  const a = anthropicClient();
  if (a) {
    try {
      const res = await a.messages.create({
        model: env.ANTHROPIC_FAST_MODEL,
        max_tokens: args.maxTokens ?? 400,
        temperature: args.temperature ?? 0,
        system: `${args.systemPrompt}\n\nRespond with ONLY a single minified JSON object — no prose, no markdown, no code fences.`,
        messages: [{ role: 'user', content: args.userContent }],
      });
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      return parseJsonLoose<T>(text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[chat] Haiku fast pass failed — falling back to basic JSON',
        err instanceof Error ? err.message.slice(0, 160) : String(err),
      );
      // fall through to the basic JSON path below
    }
  }

  // Fallback: basic chat provider in JSON mode. We already pre-charged the
  // budget above, so we call the raw client here (not completeJson) to
  // avoid double-charging.
  const { client: c, model } = chatClientAndModel();
  const res = await c.chat.completions.create({
    model,
    max_tokens: args.maxTokens ?? 400,
    temperature: args.temperature ?? 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: args.systemPrompt },
      { role: 'user', content: args.userContent },
    ],
  });
  return parseJsonLoose<T>(res.choices[0]?.message.content ?? '{}');
}

// Tolerant JSON parse — strips ``` fences and, on failure, grabs the
// outermost { … } so a stray prefix/suffix from the model doesn't throw.
function parseJsonLoose<T>(raw: string): T {
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1)) as T;
    }
    throw new Error('completeFast: could not parse JSON from model output');
  }
}

// Speech-to-text. Used to transcribe inbound WhatsApp voice notes so
// the AI chatbot can understand and reply to them.
//
// Default model is `gpt-4o-transcribe` (OpenAI's best transcription
// model — materially better than the original whisper-1 on Arabic
// dialects + code-switched audio). Operators can switch the model via
// the OPENAI_TRANSCRIBE_MODEL env var without a code push if needed.
//
// API supports up to 25 MB per file in mp3 / mp4 / mpeg / mpga / m4a /
// wav / webm / ogg / flac. WhatsApp voice notes arrive as audio/ogg
// with Opus — well inside the supported set.
//
// Cost rough-cut: ~$0.006 / minute on gpt-4o-transcribe. We pre-charge
// ~600 "tokens" (≈ 1 chatbot-reply equivalent) against the daily org
// budget so a flood of long voice notes still trips the cap.
export interface TranscribeArgs {
  organizationId: string;
  bytes: Buffer;
  filename: string;
  mimeType?: string;
}

export type TranscribeProvider = 'openai' | 'groq';

export async function transcribeAudio(args: TranscribeArgs & { provider?: TranscribeProvider }): Promise<{
  text: string;
  // Detected language (ISO code). gpt-4o-transcribe doesn't return this
  // — only whisper-1 with response_format='verbose_json' did. Kept on
  // the return type so callers can stay forward-compatible; downstream
  // code never relied on it being non-null. Currently always null on
  // gpt-4o-transcribe, populated only when the env var is set to
  // 'whisper-1'.
  language: string | null;
  // Which provider actually ran the transcription — recorded in logs +
  // provenance so we can monitor the routing decision in production.
  provider: TranscribeProvider;
}> {
  const ok = await consumeDailyTokens(args.organizationId, 600);
  if (!ok) {
    const err = new Error('Daily AI token budget exceeded — voice transcription paused.');
    (err as Error & { code?: string }).code = 'TOKEN_BUDGET_EXCEEDED';
    throw err;
  }

  const provider: TranscribeProvider = args.provider === 'groq' && env.GROQ_API_KEY ? 'groq' : 'openai';

  if (provider === 'groq') {
    // Groq's Whisper Large v3 (Turbo by default) runs at ~10× OpenAI's
    // speed on the same audio. Good on English + reasonable on European
    // languages; weaker on Gulf/Levant Arabic dialect than OpenAI's
    // gpt-4o-transcribe. Callers route by language signal — Arabic gets
    // OpenAI, English/French/Spanish gets Groq.
    const groq = groqClient();
    const blob = new Blob([new Uint8Array(args.bytes)], { type: args.mimeType ?? 'audio/ogg' });
    const file = new File([blob], args.filename, { type: args.mimeType ?? 'audio/ogg' });
    const res = (await groq.audio.transcriptions.create({
      file,
      model: env.GROQ_WHISPER_MODEL,
      response_format: 'json',
      prompt: 'Customer-service voice note. English / French / Spanish.',
    })) as { text?: string; language?: string };
    return {
      text: (res.text ?? '').trim(),
      language: res.language ?? null,
      provider: 'groq',
    };
  }

  const c = client();
  const blob = new Blob([new Uint8Array(args.bytes)], { type: args.mimeType ?? 'audio/ogg' });
  const file = new File([blob], args.filename, { type: args.mimeType ?? 'audio/ogg' });
  const model = env.OPENAI_TRANSCRIBE_MODEL;
  // gpt-4o-transcribe + gpt-4o-mini-transcribe ONLY support
  // response_format = 'json' or 'text'. verbose_json is whisper-1-only.
  // We pick json regardless so the caller gets a uniform { text } shape;
  // language is no longer returned upstream on the gpt-4o models.
  const isWhisper = model === 'whisper-1';
  // The `prompt` hint biases the model to preserve dialectal Arabic
  // vocabulary rather than round-tripping it to MSA. Same hint works
  // for both whisper-1 and gpt-4o-transcribe. English / French /
  // Spanish transcripts are unaffected.
  const res = (await c.audio.transcriptions.create({
    file,
    model,
    response_format: isWhisper ? 'verbose_json' : 'json',
    prompt:
      'Customer-service voice note. Possible Arabic dialects include Lebanese / Levantine: شو، كيفك، بدي، عم. Egyptian: إزيك، عايز، فين. Gulf: شلونك، أبغى. Also English, French, Spanish.',
  })) as { text?: string; language?: string };
  return {
    text: (res.text ?? '').trim(),
    language: res.language ?? null,
    provider: 'openai',
  };
}

// Strict JSON-mode completion. The LLM is asked to return a single JSON
// object. Used by the booking extractor fallback so we don't depend on
// the conversational LLM remembering to emit our [BOOKING: {...}] marker.
export async function completeJson<T = unknown>(args: CompleteArgs): Promise<T> {
  const estIn = Math.ceil(args.systemPrompt.length / 4)
    + args.messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
  const estOut = args.maxTokens ?? 400;
  const ok = await consumeDailyTokens(args.organizationId, estIn + estOut);
  if (!ok) {
    const err = new Error('Daily AI token budget exceeded for this organization.');
    (err as Error & { code?: string }).code = 'TOKEN_BUDGET_EXCEEDED';
    throw err;
  }

  const { client: c, model } = chatClientAndModel();
  const res = await c.chat.completions.create({
    model,
    max_tokens: args.maxTokens ?? 400,
    temperature: args.temperature ?? 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: args.systemPrompt },
      ...args.messages,
    ],
  });

  const text = (res.choices[0]?.message.content ?? '').trim();
  return JSON.parse(text) as T;
}
