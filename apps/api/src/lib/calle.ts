// CALL-E client wrapper — the ONLY file that imports @call-e/calle.
//
// Every outbound phone call the platform places goes through `createCalleCall`,
// which enforces three safety rails in code (not in docs):
//
//   1. DRY RUN BY DEFAULT. `CALLE_DRY_RUN` defaults to true. In dry-run nothing
//      is dialed; the caller gets a fake `in_progress` call whose terminal
//      result the tick later synthesises from the task's own result schema, so
//      the whole write-back path (cart flip, inbox note, notification,
//      webhook) is exercised end to end without credentials.
//   2. LIVE OVERRIDE. While `CALLE_LIVE_OVERRIDE_PHONE` is set, every live call
//      is redirected to that one verified number and the substitution is
//      recorded in the call metadata. A demo can never dial a real customer.
//   3. REGION GATE. CALL-E can only dial the countries in
//      CALLE_SUPPORTED_REGIONS; anything else is rejected before a row exists.
//
// Idempotency: callers persist their key BEFORE calling us and pass it as the
// `Idempotency-Key` header, so a crash between our insert and CALL-E's reply
// can be retried without placing a second call.
import { CalleClient, type Call } from '@call-e/calle';

type CallRecipientInput = NonNullable<Parameters<CalleClient['calls']['create']>[0]['recipients']>[number];
import { CALLE_SUPPORTED_REGIONS, regionForE164 } from '@platform/shared';

import { env } from './env.js';

export type { Call as CalleCall };

export interface CalleRuntime {
  dryRun: boolean;
  configured: boolean;
  liveOverridePhone: string | null;
  baseUrl: string;
  supportedRegions: string[];
}

export function calleRuntime(): CalleRuntime {
  return {
    dryRun: env.CALLE_DRY_RUN,
    configured: Boolean(env.CALLE_API_KEY),
    liveOverridePhone: env.CALLE_LIVE_OVERRIDE_PHONE?.trim() || null,
    baseUrl: env.CALLE_BASE_URL,
    supportedRegions: Object.keys(CALLE_SUPPORTED_REGIONS),
  };
}

let client: CalleClient | null = null;
function getClient(): CalleClient {
  if (!env.CALLE_API_KEY) {
    throw new Error('CALLE_API_KEY is not configured (and CALLE_DRY_RUN is false).');
  }
  if (!client) client = new CalleClient({ apiKey: env.CALLE_API_KEY, baseUrl: env.CALLE_BASE_URL });
  return client;
}

export interface CreateCalleCallArgs {
  task: string;
  /** E.164 number of the person we WANT to reach (may be overridden — see dialedPhone). */
  phoneE164: string;
  /** BCP-47, e.g. en-US. Optional; CALL-E infers from region when absent. */
  locale?: string | null;
  resultSchema: Record<string, unknown>;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  webhookUrl?: string | null;
}

export interface CreateCalleCallResult {
  call: Call;
  dialedPhone: string;
  region: string;
  dryRun: boolean;
}

/** Default spoken locale per region when the contact has none on file. */
const REGION_DEFAULT_LOCALE: Record<string, string> = {
  US: 'en-US',
  CA: 'en-US',
  GB: 'en-GB',
  AU: 'en-AU',
  SG: 'en-SG',
  IN: 'en-IN',
  PK: 'en-PK',
  PH: 'en-PH',
  MY: 'en-MY',
  DE: 'de-DE',
  ES: 'es-ES',
  MX: 'es-MX',
  FI: 'fi-FI',
  NL: 'nl-NL',
  PL: 'pl-PL',
  TR: 'tr-TR',
  TH: 'th-TH',
  ID: 'id-ID',
  VN: 'vi-VN',
  BD: 'bn-BD',
  CN: 'zh-CN',
  JP: 'ja-JP',
  BR: 'pt-BR',
};

export function defaultLocaleForRegion(region: string): string {
  return REGION_DEFAULT_LOCALE[region] ?? 'en-US';
}

/** Coerce whatever the contact row holds ("ar", "en_US", "en-US") to BCP-47 or null. */
export function normalizeLocale(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().replace('_', '-');
  if (/^[a-z]{2}-[A-Z]{2}$/.test(v)) return v;
  if (/^[a-z]{2}$/i.test(v)) {
    const lang = v.toLowerCase();
    const hit = Object.values(REGION_DEFAULT_LOCALE).find((l) => l.startsWith(`${lang}-`));
    return hit ?? null;
  }
  return null;
}

export class CalleRegionUnsupportedError extends Error {
  constructor(public readonly phone: string) {
    super(`CALL-E cannot dial ${phone}: country not supported yet.`);
  }
}

export async function createCalleCall(args: CreateCalleCallArgs): Promise<CreateCalleCallResult> {
  const rt = calleRuntime();
  const wanted = args.phoneE164.startsWith('+') ? args.phoneE164 : `+${args.phoneE164}`;

  // Region is checked on the number we intend to reach, so an unsupported
  // customer is rejected even in dry-run — the operator learns now, not later.
  const wantedRegion = regionForE164(wanted);
  if (!wantedRegion) throw new CalleRegionUnsupportedError(wanted);

  let dialedPhone = wanted;
  let region = wantedRegion;
  const metadata: Record<string, unknown> = { ...args.metadata, intendedPhone: wanted };
  if (!rt.dryRun && rt.liveOverridePhone) {
    dialedPhone = rt.liveOverridePhone.startsWith('+')
      ? rt.liveOverridePhone
      : `+${rt.liveOverridePhone}`;
    const overrideRegion = regionForE164(dialedPhone);
    if (!overrideRegion) throw new CalleRegionUnsupportedError(dialedPhone);
    region = overrideRegion;
    metadata.liveOverride = true;
  }

  if (rt.dryRun) {
    return {
      call: fakeCall({
        id: `dry_${args.idempotencyKey.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60)}`,
        task: args.task,
        phone: dialedPhone,
        region,
        locale: args.locale ?? defaultLocaleForRegion(region),
        metadata: { ...metadata, dryRun: true },
      }),
      dialedPhone,
      region,
      dryRun: true,
    };
  }

  const recipient: CallRecipientInput = {
    phones: [dialedPhone],
    region,
    locale: args.locale ?? defaultLocaleForRegion(region),
  };
  const call = await getClient().calls.create(
    {
      task: args.task,
      recipients: [recipient],
      // One recipient per task, so the task-level schema IS the per-recipient
      // schema; sending both makes CALL-E validate the extraction against it.
      resultSchema: args.resultSchema,
      recipientResultSchema: args.resultSchema,
      metadata,
      ...(args.webhookUrl ? { webhookUrl: args.webhookUrl } : {}),
    },
    { idempotencyKey: args.idempotencyKey },
  );
  return { call, dialedPhone, region, dryRun: false };
}

export async function getCalleCall(callId: string): Promise<Call> {
  return getClient().calls.get(callId);
}

// ---------------------------------------------------------------------------
// Dry-run synthesis
// ---------------------------------------------------------------------------

function fakeCall(input: {
  id: string;
  task: string;
  phone: string;
  region: string;
  locale: string;
  metadata: Record<string, unknown>;
}): Call {
  const now = new Date().toISOString();
  return {
    id: input.id,
    object: 'call_task',
    status: 'in_progress',
    task: input.task,
    recipients: [
      {
        id: `${input.id}_r1`,
        phones: [input.phone],
        locale: input.locale,
        region: input.region,
        status: 'in_progress' as never,
        structuredResult: null,
        summary: null,
        attempts: [],
      },
    ],
    structuredResult: null,
    summary: null,
    taskCompleted: null,
    completionConfidence: null,
    evidence: [],
    metadata: input.metadata,
    failureCode: null,
    failureMessage: null,
    createdAt: now,
    completedAt: null,
  };
}

/**
 * Fill a JSON Schema object with its "happy path" values: the FIRST enum value
 * of every enum property (builders order enums happy-first on purpose), a
 * labelled placeholder for free strings, true/0 for booleans/numbers. Used only
 * to complete dry-run calls so the write-back path runs without credentials.
 */
export function happyPathResult(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (Array.isArray(def.enum) && def.enum.length > 0) out[key] = def.enum[0];
    else if (def.type === 'boolean') out[key] = true;
    else if (def.type === 'integer' || def.type === 'number') out[key] = 0;
    else out[key] = `(dry run) ${String(def.description ?? key)}`;
  }
  return out;
}

export function completeFakeCall(call: Call, resultSchema: Record<string, unknown>): Call {
  const result = happyPathResult(resultSchema);
  const now = new Date().toISOString();
  const turns = [
    { speaker: 'bot', text: 'Dry run — no call was placed. This transcript is synthetic.', offset_seconds: 0 },
    { speaker: 'user', text: 'Understood.', offset_seconds: 1.5 },
  ];
  return {
    ...call,
    status: 'completed',
    structuredResult: result,
    summary: 'DRY RUN: synthetic happy-path result. Set CALLE_DRY_RUN=false to place real calls.',
    taskCompleted: true,
    completionConfidence: { score: 1, label: 'high' } as never,
    evidence: ['dry-run'],
    completedAt: now,
    recipients: call.recipients.map((r) => ({
      ...r,
      status: 'completed' as never,
      structuredResult: result,
      summary: 'Dry run.',
      attempts: [
        {
          id: `${r.id}_a1`,
          phone: r.phones[0] ?? '',
          status: 'completed' as never,
          startedAt: call.createdAt,
          completedAt: now,
          summary: 'Dry run.',
          transcriptTurns: turns as never,
          providerCallId: null,
          failureCode: null,
          failureMessage: null,
        },
      ],
    })),
  };
}
