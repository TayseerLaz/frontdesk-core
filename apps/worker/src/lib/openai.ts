// Worker-side chat-completion client. Primary path goes to Groq
// (llama-3.3-70b-versatile, LPU inference) and falls back to OpenAI
// gpt-4o-mini ONLY when Groq is rate-limited / degraded — the
// daily-token-cap case that hit prod on 2026-06-01 and silently zeroed
// every crawl's extraction. Reintroducing OpenAI was an explicit user
// decision after we previously removed it; see chat 2026-06-01.
//
// Why not always-OpenAI: Groq is ~30x faster on the same model class
// at our scale and the bot's prompt is tuned to llama-3.3-70b.
// Why not fail-on-429: the operator-visible symptom (empty crawl
// review panel) is much worse than a slightly more expensive call
// served by gpt-4o-mini for the next ~1h while the Groq bucket rolls.
//
// The OpenAI SDK works against Groq's /openai/v1 endpoint with just a
// baseURL + apiKey swap — same client class, same call signature,
// so the fallback retries the EXACT request shape (response_format,
// max_tokens, temperature, messages) against a different host.
//
// Hardening lessons from the 2026-06-01 review (in-file comments mark
// the specific call sites): maxRetries:0 + timeout:60s + widened
// isRetryableError + AbortSignal pass-through + empty-200 = retry +
// jsonMode safety net on the OpenAI path.
import OpenAI from 'openai';

import { env } from './env.js';

let _groqClient: OpenAI | null = null;
let _openaiClient: OpenAI | null = null;

// Per-request timeout. Above gpt-4o-mini's p99 for a 4K-token JSON
// response by a healthy margin; below BullMQ's stalled-job watchdog
// so one slow LLM call can't park the worker slot indefinitely.
const REQUEST_TIMEOUT_MS = 60_000;

function groqClient(): OpenAI {
  if (!env.GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is not configured. Worker chat completions (crawl ' +
        'analysis) require Groq — add the key to .env / .env.production ' +
        'and restart.',
    );
  }
  if (_groqClient) return _groqClient;
  // maxRetries:0 — the SDK's default of 2 retries with Retry-After respect
  // would block the primary call for tens of seconds (sometimes >1h on a
  // Groq daily-cap response) BEFORE the 429 propagates and we get to fall
  // back. This negates the whole point of having a fallback.
  _groqClient = new OpenAI({
    apiKey: env.GROQ_API_KEY,
    baseURL: env.GROQ_BASE_URL,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return _groqClient;
}

function openaiClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (_openaiClient) return _openaiClient;
  // Same retry / timeout discipline as the Groq client — the fallback is
  // only useful if it itself can't hang.
  _openaiClient = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return _openaiClient;
}

// True when ANY chat-completion provider is reachable. Crawl analysis
// gates on this; today either Groq alone, OpenAI alone, or both is
// enough to satisfy callers. We keep the historical export name so
// we don't have to touch every call site.
export function isOpenAIConfigured(): boolean {
  return !!env.GROQ_API_KEY || !!env.OPENAI_API_KEY;
}

// Treat HTTP 429 (rate-limit) AND HTTP 502/503 (Groq load-shedding +
// upstream blips) as "fall back to the other provider." The 503 case
// matters because Groq surfaces quota pressure as 503 under sustained
// load — same symptom (zero extraction) via a different status code.
// Also matches OpenAI SDK's typed error shapes (.status / .statusCode /
// .response.status / .code / .error.code) so we don't depend on which
// transport layer the error came from.
function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const status = (e.status as number | undefined) ?? (e.statusCode as number | undefined);
  if (status === 429 || status === 502 || status === 503) return true;
  const r = e.response as Record<string, unknown> | undefined;
  if (r) {
    const rs = r.status as number | undefined;
    if (rs === 429 || rs === 502 || rs === 503) return true;
  }
  // OpenAI SDK error-code shape, varies by transport.
  if (e.code === 'rate_limit_exceeded') return true;
  const inner = e.error as Record<string, unknown> | undefined;
  if (inner && inner.code === 'rate_limit_exceeded') return true;
  // Last-resort string match — some Groq-via-OpenAI-SDK 429s come
  // through with status===0 and the actual reason buried in the
  // message body.
  const msg = (e.message as string | undefined) ?? '';
  if (typeof msg === 'string' && /rate.?limit|too many requests|service unavailable/i.test(msg)) {
    return true;
  }
  // OpenAI SDK's named subclass — check by constructor name so we
  // don't have to import the type just for instanceof.
  const ctorName = (e.constructor as { name?: string } | undefined)?.name;
  if (ctorName === 'RateLimitError') return true;
  return false;
}

// Sentinel error we synthesize when Groq returns HTTP 200 but no
// content. Looks like a rate-limit to the fallback router because the
// observable failure mode is identical (silent zero-extraction).
class GroqEmptyResponseError extends Error {
  status = 503;
  constructor() {
    super('Groq returned a 200 response with empty choices / content');
    this.name = 'GroqEmptyResponseError';
  }
}

export interface WorkerCompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  // Which provider actually served this request. Operators can grep
  // logs / aggregate this in metrics later to spot fallback rates
  // climbing — a leading indicator that Groq's quota needs to grow.
  provider: 'groq' | 'openai';
}

export interface WorkerCompleteArgs {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  // When true, the model is asked to return STRICT JSON (no prose, no
  // code fences). Used by the crawl-analyze step so we don't have to
  // guess at fence markers in the output. Both Groq and gpt-4o-mini
  // support response_format: json_object natively, so the fallback
  // path is feature-equivalent — but gpt-4o-mini also requires the
  // literal string 'json' to appear in the messages, so we inject
  // a sentinel on the OpenAI path when callers didn't already.
  jsonMode?: boolean;
  // Forwarded to the OpenAI SDK so an operator-cancelled crawl can
  // interrupt an in-flight LLM call instead of waiting for the 60s
  // timeout. Caller is responsible for creating the AbortController
  // and aborting it when its own cancellation check fires.
  signal?: AbortSignal;
}

export async function workerComplete(args: WorkerCompleteArgs): Promise<WorkerCompleteResult> {
  const payload = {
    max_tokens: args.maxTokens ?? 2048,
    temperature: args.temperature ?? 0.3,
    ...(args.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    messages: [
      { role: 'system' as const, content: args.systemPrompt },
      { role: 'user' as const, content: args.userPrompt },
    ],
  };
  const requestOpts = args.signal ? { signal: args.signal } : {};

  // -------- Primary: Groq -------------------------------------------------
  if (env.GROQ_API_KEY) {
    let groqError: unknown = null;
    try {
      const res = await groqClient().chat.completions.create(
        { ...payload, model: env.GROQ_MODEL },
        requestOpts,
      );
      const text = (res.choices[0]?.message.content ?? '').trim();
      if (text === '' || res.choices.length === 0) {
        // Synthesise so we fall through to the OpenAI path with the
        // same diagnostic the operator would see for a real 429.
        throw new GroqEmptyResponseError();
      }
      return {
        text,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        provider: 'groq',
      };
    } catch (err) {
      groqError = err;
      if (!isRetryableError(err)) throw err;
    }
    // 429 / 503 / empty-200: try OpenAI if available and not disabled.
    console.warn(
      '[workerComplete] Groq retryable error:',
      groqError instanceof Error ? groqError.message : String(groqError),
    );
    if (!env.OPENAI_FALLBACK_ENABLED) {
      console.warn('[workerComplete] OPENAI_FALLBACK_ENABLED=false — propagating Groq error.');
      throw groqError;
    }
    if (args.signal?.aborted) {
      // Operator already cancelled — no point burning an OpenAI call.
      throw groqError;
    }
    const fallback = openaiClient();
    if (!fallback) {
      console.warn('[workerComplete] OPENAI_API_KEY unset — no fallback available.');
      throw groqError;
    }
    console.warn('[workerComplete] falling back to OpenAI', env.OPENAI_MODEL);
    return runOpenAI(fallback, args, payload, requestOpts);
  }

  // -------- Fallback (or sole provider): OpenAI ---------------------------
  const openai = openaiClient();
  if (!openai) {
    throw new Error(
      'Neither GROQ_API_KEY nor OPENAI_API_KEY is configured — worker chat ' +
        'completions need at least one provider keyed.',
    );
  }
  return runOpenAI(openai, args, payload, requestOpts);
}

async function runOpenAI(
  openai: OpenAI,
  args: WorkerCompleteArgs,
  payload: {
    max_tokens: number;
    temperature: number;
    messages: { role: 'system' | 'user'; content: string }[];
    response_format?: { type: 'json_object' };
  },
  requestOpts: { signal?: AbortSignal },
): Promise<WorkerCompleteResult> {
  // gpt-4o-mini requires the literal string 'json' (case-insensitive)
  // to appear somewhere in the messages when response_format is
  // json_object. Defensively inject a one-liner if the caller's prompts
  // don't already include it, so a future caller can't silently break
  // the fallback path the next time Groq is degraded.
  let messages = payload.messages;
  if (
    payload.response_format?.type === 'json_object' &&
    !/json/i.test(args.systemPrompt) &&
    !/json/i.test(args.userPrompt)
  ) {
    messages = [
      {
        role: 'system',
        content: messages[0]!.content + '\n\nReturn STRICT JSON.',
      },
      messages[1]!,
    ];
  }
  const res = await openai.chat.completions.create(
    { ...payload, messages, model: env.OPENAI_MODEL },
    requestOpts,
  );
  const text = (res.choices[0]?.message.content ?? '').trim();
  return {
    text,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    provider: 'openai',
  };
}
