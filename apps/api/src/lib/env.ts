import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),


  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // 30 days, and SLIDING — every /auth/refresh pushes the expiry forward
  // (auth.service.ts), so an active user effectively stays signed in and
  // only a full month of no-opens forces a re-login. This is the "stay
  // logged in on my phone" window: mobile browsers evict the in-memory
  // access token constantly, so the session lives on the refresh cookie,
  // and 7 days was too short (felt like re-login every week). Refresh-token
  // rotation + reuse-detection still cap the damage window if one leaks.
  // Ops can shorten per-env for stricter tenants.
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),

  EMAIL_FROM: z.string().default('ALIGNED <noreply@aligned.local>'),
  EMAIL_DEV_SMTP_HOST: z.string().default('localhost'),
  EMAIL_DEV_SMTP_PORT: z.coerce.number().int().positive().default(1025),
  // Production SMTP (AWS SES). Falls back to dev transport when EMAIL_SMTP_HOST is empty.
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().optional(),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  EMAIL_SMTP_SECURE: z
    .string()
    .optional()
    .transform((s) => s === 'true'),

  // Wasabi (S3-compatible) — leave keys empty to disable in dev (uploads will 503).
  WASABI_ENDPOINT: z.string().url().default('https://s3.eu-central-1.wasabisys.com'),
  WASABI_REGION: z.string().default('eu-central-1'),
  WASABI_BUCKET: z.string().default('aligned-dev'),
  // Sales Scan ("Teach the bot with your own data") — the WhatsApp capture service.
  //
  // These say the operator INTENDS this deployment to capture. They do NOT say anything
  // is running: availability is `isIngestConfigured() && isCaptureLive()`, where liveness
  // is a heartbeat the capture service emits only while WA_CAPTURE_ENABLED is on. Setting
  // these alone will NOT offer tenants a QR code — that was the 2026-08-05 incident, where
  // both vars were set, the capture service had capture switched off, and production
  // promised QRs for six days with a grant wedged in `linking`.
  //
  // Unsetting either is still the instant, no-code kill switch (no waiting for a beat to
  // age out). Mirrors how storage.ts degrades when Wasabi keys are absent.
  WA_INGEST_URL: z.string().url().optional(),
  WA_INGEST_SECRET: z.string().optional(),
  // Contact sync's WhatsApp option — DELIBERATELY A SEPARATE SWITCH from the two above.
  //
  // isScanStartable() gates on WA_INGEST_URL + WA_INGEST_SECRET (plus a live heartbeat).
  // So reusing those to turn on WhatsApp contact
  // sync would ALSO arm Sales Scan capture — the thing 16 open blockers exist to prevent
  // (docs/SALES-SCAN-REVIEW-BLOCKERS.md). One shared credential for two features with
  // very different readiness is exactly how a gate gets bypassed by accident.
  //
  // Only a secret is needed, not a URL: the ingest service PULLS work from Hader and
  // pushes results back, so Hader never dials out to it. Unset => the WhatsApp option is
  // reported unavailable and the tenant sees the two phone flows only.
  WA_CONTACTS_SECRET: z.string().optional(),
  // PREVIEW MODE. Lets the full Sales Scan flow be demoed before the capture service is
  // deployed: /connect works and a clearly-labelled placeholder QR renders. The QR is NOT
  // a WhatsApp link code and nothing is captured. Never enable this for a tenant who
  // believes they are really connecting a number.
  SALES_SCAN_DEMO_MODE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  WASABI_ACCESS_KEY_ID: z.string().optional(),
  WASABI_SECRET_ACCESS_KEY: z.string().optional(),
  WASABI_PUBLIC_URL_BASE: z.string().url().optional(),
  // Phase 5 hotfix — Wasabi accounts default to "no public objects allowed",
  // so even when WASABI_PUBLIC_URL_BASE is set, the public URL 403s. Only
  // emit public URLs when the bucket is explicitly opt-in public.
  WASABI_PUBLIC_BUCKET: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
  WASABI_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // Phase 6 — Google Cloud TTS for voice replies. Optional; bot routes
  // fall back to text replies when the key is missing.
  GOOGLE_TTS_API_KEY: z.string().optional(),
  GOOGLE_TTS_DEFAULT_VOICE_EN: z.string().default('en-US-Neural2-J'),
  GOOGLE_TTS_DEFAULT_VOICE_AR: z.string().default('ar-XA-Wavenet-B'),
  // ElevenLabs — alternate TTS provider. Same fallback behaviour as Google:
  // missing key + voice id ⇒ provider is unavailable, the bot routes
  // silently fall back to text.
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  // Phase 11.2 — default switched from `eleven_multilingual_v2` (1.5-3.5s
  // per voice note) to `eleven_flash_v2_5` (0.4-0.8s, ~3x faster).
  // Quality on short customer-service replies is comparable; the
  // difference matters more for long-form narration. Operators can pin
  // back to the older model via the env var without a code push if
  // quality regresses on a specific use case.
  ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),

  // Voice media gateway — shared multi-tenant mode. A single platform secret
  // (NOT org-scoped) held only by the trusted Aseer-time voicebot infra. When
  // set, the voicebot resolves an inbound dialed number to a tenant phone line
  // via GET /voice/resolve and posts call lifecycle with this secret +
  // X-Phone-Integration-Id. Leave empty to disable gateway mode (those routes
  // 503); per-line X-Api-Key auth keeps working regardless.
  VOICE_GATEWAY_SECRET: z.string().optional(),

  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_API_PER_SECOND: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_READ_API_PER_SECOND: z.coerce.number().int().positive().default(200),

  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // UptimeRobot — read-only API key ("monitor-specific" or "main" account
  // key). Leave empty to hide the uptime tile in the admin panel.
  UPTIMEROBOT_API_KEY: z.string().optional(),
  UPTIMEROBOT_MONITOR_IDS: z.string().optional(), // csv of monitor ids

  // Phase 2 — OpenAI API key for the AI bot builder + bot runtime.
  // Leave empty to disable AI features (analyze + simulate + scenarios all
  // 503; the rest of the platform keeps working).
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  // Phase 11 — Whisper-1 (the original 2022 model) was OK at English but
  // mediocre on Arabic dialects; it routinely normalised Lebanese /
  // Egyptian / Gulf into MSA and butchered code-switched audio. We've
  // upgraded the default to gpt-4o-transcribe — best-in-class on dialects
  // + code-switching, same cost-per-minute as whisper-1. The env var
  // exists so ops can roll back to "whisper-1" without a code push if
  // gpt-4o-transcribe has an outage.
  OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-4o-transcribe'),
  // Groq is the sole chat-completion backend. Llama 3.3 70B on Groq's
  // LPU runs at ~500 tok/sec vs OpenAI's ~50-100 tok/sec, so bot replies
  // land in 3-8s instead of 22-26s. The /openai/v1 endpoint is OpenAI-
  // API-compatible so the existing SDK works unchanged. When this key
  // is missing the API throws on the first chat call with a clear
  // "GROQ_API_KEY is not configured" message (no silent fallback to
  // OpenAI — that previously hid misconfig + latency regressions).
  //
  // Transcription stays on the OPENAI_* config above (gpt-4o-transcribe
  // is materially better on Arabic dialects than Groq's Whisper Large v3,
  // and most of our customer base is Gulf/Levant Arabic).
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  // Phase 2 follow-up — Groq's Whisper transcription endpoint. Used for
  // English-language voice notes (cuts transcription from ~2.5s on OpenAI
  // gpt-4o-transcribe to ~250-400ms on Groq). Arabic / dialectal voice
  // notes still go through OpenAI because gpt-4o-transcribe handles Gulf
  // + Levant Arabic noticeably better.
  GROQ_WHISPER_MODEL: z.string().default('whisper-large-v3-turbo'),

  // Anthropic — used as the `max` tier in Organization.aiPlan. The
  // model defaults to Sonnet's current flagship for cost-efficiency;
  // operators who want Opus can set ANTHROPIC_MODEL=claude-opus-4-8.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  // `ultra` tier (hybrid Haiku + Sonnet). The cheap auxiliary passes
  // (intent classification + persona summarization) run on Haiku; the
  // final grounded reply runs on Sonnet. Pinned separately from
  // ANTHROPIC_MODEL so an operator who sets the `max` tier to Opus
  // doesn't also drag the ultra reply onto Opus.
  ANTHROPIC_FAST_MODEL: z.string().default('claude-haiku-4-5'),
  ANTHROPIC_ULTRA_MODEL: z.string().default('claude-sonnet-4-6'),

  // Two-stage retrieval (lib/retrieval.ts). The in-memory hybrid (dense +
  // trigram sparse + RRF) always runs; the Cohere cross-encoder rerank is
  // gated by RERANK_MODE + a key. 'off' = hybrid only; 'shadow' = call the
  // reranker + log its order but don't use it; 'enforce' = use it. Missing key
  // → the reranker no-ops (returns the input order), so nothing breaks.
  RERANK_MODE: z.enum(['off', 'shadow', 'enforce']).default('off'),
  COHERE_API_KEY: z.string().optional(),
  COHERE_RERANK_MODEL: z.string().default('rerank-v3.5'),
  RERANK_CANDIDATE_N: z.coerce.number().int().positive().default(60),
  // Cold Cohere calls from the server can take 1–2s; give the cross-encoder
  // room before falling back to the unreranked order.
  RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),

  // Grounding gate (lib/grounding-gate.ts). 'shadow' (default) logs what it
  // would block without changing output; 'enforce' replaces an ungrounded reply
  // with the fallback + escalates; 'off' disables. Ships in shadow so the block
  // rate can be tuned on real traffic before it ever withholds a reply.
  GROUNDING_GATE_MODE: z.enum(['off', 'shadow', 'enforce']).default('shadow'),
  GROUNDING_GATE_FALLBACK: z.string().optional(),

  // MyFatoorah payment gateway — used by the bot to mint per-order
  // invoice URLs at checkout. When MYFATOORAH_API_KEY is unset, the
  // bot's payment-link request falls back to a generic gateway URL
  // (so dev / staging tenants without merchant credentials still
  // get a non-broken reply). Base URL toggles between sandbox + prod.
  MYFATOORAH_API_KEY: z.string().optional(),
  MYFATOORAH_BASE_URL: z.string().url().default('https://apitest.myfatoorah.com'),

  // Phase 3 §5.1.3 — Stripe billing. Empty values disable billing surfaces:
  // /billing/checkout 503s, /webhooks/stripe rejects, cap middleware
  // skips. Existing orgs stay on whatever subscription state they had.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PORTAL_RETURN_URL: z.string().url().optional(),
  TRIAL_LENGTH_DAYS: z.coerce.number().int().positive().default(14),

  // Phase 3 §5.1.4 — custom CNAMEs. Customers point a CNAME at this host;
  // we verify with `dns.promises.resolveCname` before the row goes
  // 'verified' (which is the gate for Caddy on-demand TLS).
  CUSTOM_CNAME_TARGET: z.string().default('hader.ai'),

  // Sprint 4 — WAF readiness. Controls which upstream proxies we trust
  // when reading X-Forwarded-For and CF-Connecting-IP. Three modes:
  //   • "true"  (default)  → trust any proxy (current behaviour; safe ONLY
  //                          when the API is exposed exclusively to Caddy /
  //                          a private network, never the public internet).
  //   • "false"            → don't trust any proxy. req.ip = socket peer.
  //   • "cloudflare"       → preset: trust the Cloudflare IPv4 + IPv6
  //                          ranges plus the LAN/loopback so Caddy works.
  //   • CIDR list (csv)    → trust exactly those CIDRs, e.g.
  //                          "10.0.0.0/8,2606:4700::/32".
  // Pair with TRUST_CF_CONNECTING_IP when the request flows through
  // Cloudflare so req.ip resolves to the original client.
  TRUST_PROXY: z.string().default('true'),
  // When 'true', the api prefers CF-Connecting-IP over X-Forwarded-For when
  // the request arrived from a trusted upstream. Required if you sit
  // behind Cloudflare; harmless otherwise.
  TRUST_CF_CONNECTING_IP: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),

  // Envelope-encryption key for tenant secrets at rest (WhatsApp tokens,
  // Messenger page tokens, connector auth blobs). 32 bytes as 64 hex chars
  // or base64. Optional in dev/test (secret-crypto then passes through as
  // plaintext — fine for local work), but REQUIRED in production: shipping
  // prod without it silently stores every tenant's channel credentials in
  // plaintext, and rotating it later orphans already-encrypted rows (F-06).
  SECRET_ENCRYPTION_KEY: z.string().optional(),

  // Google Calendar OAuth app (per-tenant booking → calendar sync). Optional:
  // when unset the integration is dormant ("not configured"). Create an OAuth
  // client in Google Cloud, enable the Calendar API, and set the redirect URI
  // to `${API_PUBLIC_URL}/api/v1/google-calendar/callback`.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // ---- Meta Embedded Signup / Coexistence -------------------------------
  // App "Hader Ai" 1727898828528257 (business 332283114091818), which holds the
  // Tech Provider verification and has history / smb_app_state_sync /
  // smb_message_echoes subscribed.
  //
  // ALL OPTIONAL, deliberately. loadEnv() below process.exit(1)s on any
  // validation failure, and redeploy.sh auto-rolls-back an unhealthy boot — so
  // a `required` var here that is missing from .env.production takes the whole
  // fleet down rather than disabling one feature. Unset simply means
  // POST /whatsapp/embedded-signup/exchange returns 503, exactly the degrade
  // shape storage.ts uses when Wasabi keys are absent.
  //
  // Named META_ES_* on purpose: five DEAD single-tenant META_WA_* vars still
  // sit in .env.example, and reusing that prefix would make it impossible to
  // tell which set is live.
  META_ES_APP_ID: z.string().optional(),
  META_ES_APP_SECRET: z.string().optional(),
  // Facebook Login for Business configuration id. NOT a secret — it ships in
  // client-side JS as FB.login({ config_id }). Kept server-side too so the
  // exchange route can assert it was configured at all.
  META_ES_CONFIG_ID: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v25.0'),
})
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;

    // M-4 — the httpOnly refresh cookie carries the long-lived session; without
    // the Secure flag it can travel over any plaintext-HTTP hop. Require it in
    // production so a deploy can't silently ship an insecure cookie.
    if (cfg.COOKIE_SECURE !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production (set COOKIE_SECURE=true).',
      });
    }

    const raw = cfg.SECRET_ENCRYPTION_KEY;
    if (!raw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRET_ENCRYPTION_KEY'],
        message:
          'SECRET_ENCRYPTION_KEY is required in production (tenant channel/connector secrets would otherwise be stored in plaintext).',
      });
      return;
    }
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRET_ENCRYPTION_KEY'],
        message: 'SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or base64).',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] invalid configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export const env: Env = loadEnv();
