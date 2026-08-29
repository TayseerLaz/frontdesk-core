import fs from 'node:fs';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Refusing to start: ${name} must be set`);
  return v;
}

const DATA_DIR = path.resolve(process.env.WA_INGEST_DATA_DIR ?? './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const env = {
  PORT: Number(process.env.WA_INGEST_PORT ?? 4200),
  DATA_DIR,
  AUTH_DIR: path.join(DATA_DIR, 'auth'),

  /**
   * Hader API base. This service runs on the AlignDesk box (the Baileys host), NOT on
   * the Hader box, so this is a PUBLIC https URL: https://api.hader.ai
   *
   * Why off-box: the Hader box has a documented `next build` OOM history that has taken
   * the whole server down, and Baileys sessions sharing that headroom was the weakest
   * part of the same-box plan. Running here also keeps an unofficial WhatsApp client off
   * the host serving the official Meta Cloud API integration, and stops a Baileys leak
   * from being able to OOM Hader's Postgres.
   *
   * Consequence: the Hader-side receiver is internet-facing, so HMAC alone is not
   * enough — it needs timestamp-skew + a replay nonce (same hardening as the
   * MyFatoorah webhook).
   */
  HADER_API_URL: required('HADER_API_URL'),
  /** Shared secret for both directions (Hader -> ingest admin, ingest -> Hader receiver). */
  INGEST_SECRET: required('WA_INGEST_SECRET'),

  /**
   * Contact-sync secret — SEPARATE from INGEST_SECRET on purpose.
   *
   * Sales Scan capture is gated behind 16 open blockers; contact sync is a seconds-long,
   * read-the-address-book-only session. Sharing one credential would mean enabling the
   * safe feature also handed this process the keys to the gated one. Optional: unset
   * simply means the contacts pool never starts.
   */
  CONTACTS_SECRET: process.env.WA_CONTACTS_SECRET,

  /**
   * Sales Scan capture — OPT-IN, and off unless explicitly enabled.
   *
   * Contact sync and capture share this process but not their readiness: contact sync is
   * a seconds-long, contact-list-only pairing, while capture is gated behind 16 open
   * blockers (docs/SALES-SCAN-REVIEW-BLOCKERS.md). Defaulting capture ON meant a box
   * deployed for contact sync also ran the capture pool.
   *
   * That was not theoretical. On 2026-08-03 this box was found holding an UNPAIRED
   * capture session that had been cycling QR requests for four days — no number linked,
   * no consent, nothing captured, but four days of repeated connections from a datacenter
   * IP shared with a paying customer's live WhatsApp bot. That is the H5/H7 ban signal,
   * spent on a session nobody was waiting for.
   */
  CAPTURE_ENABLED: process.env.WA_CAPTURE_ENABLED === 'true',

  /**
   * Hard concurrency cap. Prose in a doc is not a control (blocker B13): the shared
   * datacenter IP has no residential proxies wired, so this stays at 2 until
   * BOT_PROXIES exists. Raising it is a deliberate, reviewable code change.
   */
  MAX_SESSIONS: Number(process.env.WA_INGEST_MAX_SESSIONS ?? 2),

  /** How often the supervised reaper sweeps for expired windows. */
  REAP_INTERVAL_MS: Number(process.env.WA_INGEST_REAP_INTERVAL_MS ?? 60_000),
  /**
   * Dead-man switch: if we cannot reach the system holding the consent record for this
   * long, tear every session down. A capture process that has lost contact with its
   * authority must not keep capturing (blocker B3).
   */
  HEARTBEAT_FAIL_LIMIT_MS: Number(process.env.WA_INGEST_HEARTBEAT_FAIL_LIMIT_MS ?? 600_000),
  HEARTBEAT_INTERVAL_MS: Number(process.env.WA_INGEST_HEARTBEAT_INTERVAL_MS ?? 60_000),
};

fs.mkdirSync(env.AUTH_DIR, { recursive: true });
