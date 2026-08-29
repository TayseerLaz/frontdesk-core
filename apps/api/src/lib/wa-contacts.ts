// The WhatsApp option for "Sync contacts with phone".
//
// A tenant links their WhatsApp account as a device (Settings -> Linked Devices) and we
// read the CONTACT LIST ONLY — never messages. The pairing is done by the wa-ingest
// service, which polls the platform for work and pushes results back, so the platform never dials out
// to it and the ingest host needs no inbound connectivity.
//
// THIS RUNS ON ITS OWN SECRET. Sales Scan's capture half is gated behind 16 open blockers
// via WA_INGEST_URL/WA_INGEST_SECRET; sharing that credential would mean switching on
// contact sync silently armed a capture path nobody signed off. See env.ts.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { env } from './env.js';
import { getRedis } from './redis.js';

/** Same 5-minute window the sales-scan receiver and the MyFatoorah webhook use. */
const SKEW_MS = 5 * 60_000;

/** Unset secret => the WhatsApp option is simply not offered. */
export function isWaContactsConfigured(): boolean {
  return Boolean(env.WA_CONTACTS_SECRET);
}

/**
 * HMAC-SHA256 over `<timestamp>.<rawBody>`.
 *
 * Over the RAW BYTES, not a re-serialisation of the parsed body — this repo has already
 * shipped that bug once on the connector inbound webhook, where a JSON round-trip changed
 * key order and made valid signatures fail (and, worse, made the check meaningless).
 */
export function verifyWaContactsSignature(args: {
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
}): boolean {
  const secret = env.WA_CONTACTS_SECRET;
  if (!secret) return false;

  const ts = args.timestamp ?? '';
  const got = (args.signature ?? '').replace(/^sha256=/, '');
  if (!ts || !got) return false;

  const skew = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(skew) || skew > SKEW_MS) return false;

  const want = createHmac('sha256', secret).update(`${ts}.${args.rawBody}`).digest('hex');
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(got, 'hex');
    b = Buffer.from(want, 'hex');
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Single-use claim on a signature. Without it a captured request stays replayable for the
 * whole skew window — enough to re-push a contact batch, or forge a second "ended".
 */
export async function claimWaContactsNonce(signature: string): Promise<boolean> {
  const key = `wa-contacts:nonce:${createHash('sha256').update(signature).digest('hex')}`;
  const res = await getRedis().set(key, '1', 'EX', Math.ceil((SKEW_MS * 2) / 1000), 'NX');
  return res === 'OK';
}
