import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { env } from './env.js';
import { getRedis } from './redis.js';
import { INGEST_HEARTBEAT_MAX_AGE_MS, isHeartbeatFresh } from './sales-scan-window.js';

/**
 * Server side of the Sales Scan capture seam.
 *
 * The capture service runs OFF-BOX (AlignDesk), so these endpoints are internet-facing.
 * HMAC alone is therefore not enough: we also bound the timestamp skew and burn a replay
 * nonce, the same hardening applied to the MyFatoorah webhook.
 */

const SKEW_MS = 5 * 60 * 1000;

export function ingestConfigured(): boolean {
  return Boolean(env.WA_INGEST_SECRET);
}

/**
 * Verify an ingest -> Hader call. MUST be given the RAW body bytes: hashing a
 * re-serialized object is the classic way a signature check silently stops matching.
 */
export function verifyIngestSignature(args: {
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
}): boolean {
  if (!env.WA_INGEST_SECRET) return false;
  const { rawBody } = args;
  const ts = args.timestamp ?? '';
  const got = (args.signature ?? '').replace(/^sha256=/, '');
  if (!ts || !got) return false;

  const skew = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(skew) || skew > SKEW_MS) return false;

  const want = createHmac('sha256', env.WA_INGEST_SECRET).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Single-use claim on a signature. Without this, a captured request stays replayable for
 * the whole skew window — which for /messages would mean duplicated rows and for /purged
 * a false "credentials destroyed" record.
 */
export async function claimIngestNonce(signature: string): Promise<boolean> {
  const key = `wa-ingest:nonce:${createHash('sha256').update(signature).digest('hex')}`;
  const res = await getRedis().set(key, '1', 'EX', Math.ceil((SKEW_MS * 2) / 1000), 'NX');
  return res === 'OK';
}

/**
 * Stable per-org pseudonym for a counterparty phone.
 *
 * NOT de-identification: the Lebanese mobile keyspace is small enough to exhaust in
 * seconds given the salt, and message bodies contain names regardless. This is a join and
 * erasure key only — never describe the corpus as anonymised.
 */
export function counterpartyHash(organizationId: string, phoneDigits: string): string {
  const salt = env.WA_INGEST_SECRET ?? 'unsalted';
  return createHash('sha256')
    .update(`${salt}:${organizationId}:${phoneDigits.replace(/\D/g, '')}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Strip payment credentials from a captured message.
 *
 * Named honestly: this is PAYMENT-CREDENTIAL STRIPPING, not PII redaction. A sales
 * corpus is mostly names, addresses and landmarks, none of which this touches — so no
 * user-facing string may call the result redacted or anonymised (blocker B7).
 */
export function stripPaymentCredentials(input: string | null): string | null {
  if (!input) return input;
  let s = input;

  // Card numbers: 13-19 digits, optionally space/dash grouped, Luhn-valid only so we
  // don't eat order quantities, prices or phone numbers.
  s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhnValid(m) ? '[redacted:card]' : m));

  // IBANs. The trailing group is OPTIONAL and separators are allowed inside it: an IBAN
  // whose groups all happen to be 4 chars (LB, DE, GB — i.e. most of them) could never
  // match a pattern that demanded a final ungrouped 1-4 chars, so the previous form
  // silently passed every space-separated IBAN, which is how people actually type them.
  // Case-insensitive for the same reason.
  s = s.replace(
    /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,6}(?:[ -]?[A-Z0-9]{1,4})?\b/gi,
    '[redacted:iban]',
  );

  // One-time codes: 4-8 digits adjacent to an OTP-ish word, EN + AR.
  s = s.replace(
    /((?:otp|code|pin|cvv|verification|رمز|كود|التحقق)\D{0,12})\b\d{4,8}\b/gi,
    '$1[redacted:code]',
  );

  return s;
}

function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * The QR rotates every ~20s, so it belongs in Redis with a short TTL rather than in a
 * column we would have to keep clearing.
 */
const QR_TTL_SECONDS = 90;

export interface LiveSessionState {
  status: string;
  qr?: string | null;
  pairingCode?: string | null;
  phone?: string | null;
}

export async function setLiveSessionState(grantId: string, state: LiveSessionState): Promise<void> {
  await getRedis().set(`wa-ingest:session:${grantId}`, JSON.stringify(state), 'EX', QR_TTL_SECONDS);
}

export async function getLiveSessionState(grantId: string): Promise<LiveSessionState | null> {
  const raw = await getRedis().get(`wa-ingest:session:${grantId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LiveSessionState;
  } catch {
    return null;
  }
}

export async function clearLiveSessionState(grantId: string): Promise<void> {
  await getRedis().del(`wa-ingest:session:${grantId}`);
}

/**
 * Capture-service liveness.
 *
 * The service beats every 60s, but ONLY when WA_CAPTURE_ENABLED is on (see
 * apps/wa-ingest/src/index.ts — the heartbeat interval lives inside that branch). So a
 * fresh beat means "a process is running AND capture is armed", which is precisely the
 * question the tenant UI needs answered before it offers a QR code.
 *
 * Redis with a TTL rather than a column: liveness is worthless once stale, and expiry is
 * the storage layer's job. No migration, and a Redis flush degrades to "not live", which
 * is the safe direction.
 */
const HEARTBEAT_KEY = 'wa-ingest:heartbeat';

export async function recordIngestHeartbeat(active: number): Promise<void> {
  await getRedis().set(
    HEARTBEAT_KEY,
    JSON.stringify({ at: Date.now(), active }),
    'EX',
    Math.ceil(INGEST_HEARTBEAT_MAX_AGE_MS / 1000),
  );
}

/** Last heartbeat, or null if none/unreadable. Never throws — Redis being down must not
 *  500 the tenant's status page; it degrades to "capture not live". */
export async function readIngestHeartbeat(): Promise<{ at: number; active: number } | null> {
  try {
    const raw = await getRedis().get(HEARTBEAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; active?: unknown };
    if (typeof parsed.at !== 'number') return null;
    return { at: parsed.at, active: typeof parsed.active === 'number' ? parsed.active : 0 };
  } catch {
    return null;
  }
}

/** True when the capture service has beaten recently enough to be trusted. */
export async function isCaptureLive(): Promise<boolean> {
  return isHeartbeatFresh((await readIngestHeartbeat())?.at ?? null);
}

/** Ask the capture service to pick up a newly-created grant so the QR appears promptly. */
export async function nudgeIngestReconcile(): Promise<void> {
  if (!env.WA_INGEST_URL || !env.WA_INGEST_SECRET) return;
  const body = JSON.stringify({});
  const ts = Date.now().toString();
  const sig = createHmac('sha256', env.WA_INGEST_SECRET).update(`${ts}.${body}`).digest('hex');
  await fetch(`${env.WA_INGEST_URL}/v1/reconcile`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wa-ingest-timestamp': ts,
      'x-wa-ingest-signature': `sha256=${sig}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
}

/** Ask the capture service to stop + purge a grant. */
export async function requestIngestStop(grantId: string, reason: string): Promise<void> {
  if (!env.WA_INGEST_URL || !env.WA_INGEST_SECRET) return;
  const body = JSON.stringify({ grantId, reason });
  const ts = Date.now().toString();
  const sig = createHmac('sha256', env.WA_INGEST_SECRET).update(`${ts}.${body}`).digest('hex');
  await fetch(`${env.WA_INGEST_URL}/v1/stop`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wa-ingest-timestamp': ts,
      'x-wa-ingest-signature': `sha256=${sig}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
}
