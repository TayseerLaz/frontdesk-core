import {
  COEXISTENCE_CONSENT_TEXT,
  COEXISTENCE_CONSENT_VERSION,
  SALES_SCAN_CONSENT_TEXT,
  SALES_SCAN_CONSENT_VERSION,
  SALES_SCAN_MAX_WINDOW_DAYS,
  type SalesScanStatus,
} from '@platform/shared';

import { coexistenceConsentSha256 } from './coexistence-capture.js';
import type { Tx } from './db.js';
import { env } from './env.js';
import { isCaptureLive } from './sales-scan-ingest.js';
import { addDays, clampWindowDays, currentConsentSha256 } from './sales-scan-window.js';

// Pure helpers live in ./sales-scan-window.js (no env/db coupling so they stay
// testable in the blocking CI gate). Re-exported here so callers have one import.
export {
  addDays,
  clampWindowDays,
  consentTextSha256,
  currentConsentSha256,
  daysRemaining,
  effectiveEndsAt,
  serializeGrant,
} from './sales-scan-window.js';

/**
 * Sales Scan engine — "Teach the bot with your own data".
 *
 * Slice 1 (this file) owns the GRANT lifecycle: consent evidence, the absolute
 * compliance deadline, and the terminal-state transition. The capture half (the
 * `hader-wa-ingest` service, the reapers, the summary job) is deliberately NOT here
 * yet — see docs/SALES-SCAN-REVIEW-BLOCKERS.md for the 16 blockers that gate it.
 *
 * Invariants this file is responsible for:
 *  - a grant's `grantExpiresAt` is stamped once at creation and NEVER moved;
 *  - `windowDays` is clamped to [1, 14] here as well as in Zod, so no env var,
 *    migration or future caller can widen a "one week" window into surveillance;
 *  - at most one non-terminal grant exists per org (Postgres cannot express the
 *    partial unique index, so it is enforced here and asserted in tests).
 */

/** Statuses in which a grant still owns — or may yet own — a live WhatsApp session. */
export const LIVE_STATUSES: SalesScanStatus[] = ['pending', 'linking', 'active'];

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: SalesScanStatus[] = [
  'completed',
  'revoked',
  'expired',
  'failed',
];

/**
 * Is the capture backend CONFIGURED? Note: configured, not working — this only says the
 * operator has pointed this deployment at a capture service. Kept as a precondition (and
 * as the documented staged-rollout switch in apps/wa-ingest/README.md) but it is NOT
 * sufficient to offer a tenant a QR code. See isCaptureAvailable().
 */
export function isIngestConfigured(): boolean {
  return Boolean(env.WA_INGEST_URL && env.WA_INGEST_SECRET);
}

/** Demo/preview mode: the flow is walkable but nothing is really captured. */
export function isDemoMode(): boolean {
  return env.SALES_SCAN_DEMO_MODE === true;
}

/**
 * Is capture ACTUALLY available — i.e. is a capture service alive right now with capture
 * switched on?
 *
 * THIS IS THE FIX FOR A REAL INCIDENT. Availability used to be `isIngestConfigured()`
 * alone: "are the env vars set?". Vars being set says nothing about whether anything is
 * running, so when the capture service was left with WA_CAPTURE_ENABLED=false, production
 * kept telling tenants "scan this QR code" while no process existed that could ever draw
 * one. A grant sat wedged in `linking` for six days.
 *
 * Both halves are required, and each catches what the other cannot:
 *  - configured  — the operator intends this deployment to capture (and it is the
 *                  instant, no-code kill switch: unset the URL and it is off now, without
 *                  waiting for a heartbeat to age out);
 *  - live        — something is genuinely running with capture armed, proven by a beat
 *                  the capture service only emits when WA_CAPTURE_ENABLED is on.
 *
 * Fails CLOSED: any doubt (no beat, stale beat, Redis down) reports unavailable, so the
 * tenant sees an honest "scanning goes live soon" instead of an impossible promise.
 */
export async function isCaptureAvailable(): Promise<boolean> {
  if (isDemoMode()) return true;
  if (!isIngestConfigured()) return false;
  return isCaptureLive();
}

/**
 * Can a tenant start a scan at all — really, or as a labelled preview?
 *
 * Async because liveness is a fact about the world, not about config. Every caller is
 * already inside an async handler.
 */
export async function isScanStartable(): Promise<boolean> {
  return isCaptureAvailable();
}

/** True when this org has the feature switched on by an ALIGNED admin. */
export async function isSalesScanEnabled(tx: Tx, organizationId: string): Promise<boolean> {
  const org = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { disabledFeatures: true },
  });
  return !(org?.disabledFeatures ?? []).includes('sales_scan');
}

/** The current non-terminal grant if there is one, else the most recent grant. */
export async function currentGrant(tx: Tx, organizationId: string) {
  const live = await tx.salesScanGrant.findFirst({
    where: { organizationId, status: { in: LIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });
  if (live) return live;
  return tx.salesScanGrant.findFirst({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function hasLiveGrant(tx: Tx, organizationId: string): Promise<boolean> {
  const n = await tx.salesScanGrant.count({
    where: { organizationId, status: { in: LIVE_STATUSES } },
  });
  return n > 0;
}

/**
 * Record a permission grant. Stores the consent text verbatim plus its hash so the
 * agreement is reproducible even if the copy is later reworded, and stamps the
 * absolute deadline that no later code path may extend.
 */
export async function createGrant(
  tx: Tx,
  args: {
    organizationId: string;
    windowDays: number;
    grantedByUserId: string;
    now?: Date;
  },
) {
  const now = args.now ?? new Date();
  const windowDays = clampWindowDays(args.windowDays);
  return tx.salesScanGrant.create({
    data: {
      organizationId: args.organizationId,
      status: 'pending',
      windowDays,
      consentVersion: SALES_SCAN_CONSENT_VERSION,
      consentText: SALES_SCAN_CONSENT_TEXT,
      consentTextSha256: currentConsentSha256(),
      grantedByUserId: args.grantedByUserId,
      grantedAt: now,
      // Absolute deadline. Deliberately independent of `captureEndsAt` (which is
      // only known once the number links) so a grant that never links, or links
      // late, still expires. Never moved after this insert.
      grantExpiresAt: addDays(now, SALES_SCAN_MAX_WINDOW_DAYS),
    },
  });
}

/**
 * Record a COEXISTENCE grant, at the moment the tenant connects their number.
 *
 * A separate function from createGrant above rather than an options bag on it, because
 * almost nothing about the two is the same and conflating them invites a future edit to
 * one from quietly changing the other:
 *
 *  - It stores the COEXISTENCE consent copy and hash, not the Baileys copy. The two
 *    disclose materially different things (see the comment on COEXISTENCE_CONSENT_TEXT).
 *  - It is born `active` with `linkedAt` already set. There is no QR to scan and no
 *    `linking` state to sit in: by the time this runs, Meta has already confirmed the
 *    number belongs to the WABA and the channel row exists.
 *  - It knows the phone number up front, so `phoneE164` is set at insert rather than
 *    learned later from a session callback.
 *
 * `grantExpiresAt` is still the absolute deadline stamped once and never moved, and
 * `captureEndsAt` is still linkedAt + windowDays clamped to it — so effectiveEndsAt() and
 * both reaper sweeps work on these rows unchanged. windowDays governs the ONGOING echo
 * stream only; the 180-day history arrives in one burst regardless of window length, which
 * is why the window is not what bounds the corpus here.
 */
export async function createCoexistenceGrant(
  tx: Tx,
  args: {
    organizationId: string;
    windowDays: number;
    grantedByUserId: string;
    phoneE164: string | null;
    now?: Date;
  },
) {
  const now = args.now ?? new Date();
  const windowDays = clampWindowDays(args.windowDays);
  const grantExpiresAt = addDays(now, SALES_SCAN_MAX_WINDOW_DAYS);
  const windowEnd = addDays(now, windowDays);
  return tx.salesScanGrant.create({
    data: {
      organizationId: args.organizationId,
      // Already linked — Meta confirmed the number before we got here.
      status: 'active',
      windowDays,
      phoneE164: args.phoneE164,
      consentVersion: COEXISTENCE_CONSENT_VERSION,
      consentText: COEXISTENCE_CONSENT_TEXT,
      consentTextSha256: coexistenceConsentSha256(),
      grantedByUserId: args.grantedByUserId,
      grantedAt: now,
      grantExpiresAt,
      linkedAt: now,
      // Clamped to the absolute deadline, so a widened window can never outlive it.
      captureEndsAt: windowEnd < grantExpiresAt ? windowEnd : grantExpiresAt,
    },
  });
}

/**
 * Move a grant to a terminal state. Idempotent by design: only non-terminal rows
 * transition, so duplicate stop requests are harmless.
 *
 * NOTE for Slice 2: credential teardown must NOT live behind this guard. Once a row
 * is terminal every call here is a no-op, so a purge that failed at this moment
 * could never be retried — blocker B1. Keep `ensurePurged` a separate, unguarded,
 * retried step that drives `authPurgedAt` to non-null.
 */
export async function terminateGrant(
  tx: Tx,
  args: {
    organizationId: string;
    grantId: string;
    status: Extract<SalesScanStatus, 'completed' | 'revoked' | 'expired' | 'failed'>;
    endReason: string;
    now?: Date;
  },
): Promise<number> {
  const now = args.now ?? new Date();
  const res = await tx.salesScanGrant.updateMany({
    where: {
      id: args.grantId,
      organizationId: args.organizationId,
      status: { in: LIVE_STATUSES },
    },
    data: { status: args.status, endedAt: now, endReason: args.endReason },
  });
  return res.count;
}
