import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),

  // Wasabi (CSV uploads live here)
  WASABI_ENDPOINT: z.string().url().default('https://s3.eu-central-1.wasabisys.com'),
  WASABI_REGION: z.string().default('eu-central-1'),
  WASABI_BUCKET: z.string().default('aligned-dev'),
  WASABI_ACCESS_KEY_ID: z.string().optional(),
  WASABI_SECRET_ACCESS_KEY: z.string().optional(),

  // Outbound webhook delivery
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  // Worker concurrency knobs
  IMPORT_CONCURRENCY: z.coerce.number().int().positive().default(2),
  SYNC_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WEBHOOK_CONCURRENCY: z.coerce.number().int().positive().default(8),
  EMAIL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // OpenAI is used as a fallback when Groq returns 429/503/empty.
  // (Re-added 2026-06-01 — explicit operator decision after the daily-
  // token-cap incident that zeroed crawl extraction.) Crawl analysis
  // (the worker's chat-completion path) routes through Groq first;
  // gpt-4o-mini handles spillover.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  // Operator-facing kill switch. Set to false to disable the OpenAI
  // spillover without redeploying (e.g. if the OpenAI account spend
  // is approaching its monthly cap and you'd rather have a degraded
  // crawl than a surprise bill). Default true so the fallback is on
  // unless explicitly turned off.
  OPENAI_FALLBACK_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() !== 'false' && v !== '0'))
    .default(true),

  // Groq — chat completions for the worker (currently crawl analysis).
  // Worker no-ops AI step if both GROQ_API_KEY and OPENAI_API_KEY are
  // unset; otherwise Groq is preferred to keep latency low.
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),

  // SMTP — used by the data-export worker to email the recipient a signed
  // download link. Same env var shape as the API. Falls back to Mailpit/Mailhog
  // when EMAIL_SMTP_HOST is unset.
  EMAIL_FROM: z.string().default('ALIGNED <noreply@aligned.local>'),
  EMAIL_DEV_SMTP_HOST: z.string().default('localhost'),
  EMAIL_DEV_SMTP_PORT: z.coerce.number().int().positive().default(1025),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.coerce.number().int().positive().optional(),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  EMAIL_SMTP_SECURE: z
    .string()
    .optional()
    .transform((s) => s === 'true'),

  // Same env var as the API portal — used in the export-ready email so the
  // user can deep-link back to the portal.
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  DATA_EXPORT_CONCURRENCY: z.coerce.number().int().positive().default(1),

  // Must match the API's key — the worker shares the same Prisma client +
  // secret-crypto extension, so it has to decrypt the same tenant secrets.
  // Optional in dev/test, REQUIRED in production (F-06).
  SECRET_ENCRYPTION_KEY: z.string().optional(),
})
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
    const raw = cfg.SECRET_ENCRYPTION_KEY;
    if (!raw) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRET_ENCRYPTION_KEY'],
        message: 'SECRET_ENCRYPTION_KEY is required in production.',
      });
      return;
    }
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SECRET_ENCRYPTION_KEY'],
        message: 'SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes.',
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
