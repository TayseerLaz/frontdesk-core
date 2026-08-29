import { createHash } from 'node:crypto';

import {
  SALES_SCAN_CONSENT_TEXT,
  SALES_SCAN_CONSENT_VERSION,
  SALES_SCAN_MAX_WINDOW_DAYS,
  SALES_SCAN_MIN_WINDOW_DAYS,
  type SalesScanGrantDto,
  type SalesScanStatus,
} from '@platform/shared';

/**
 * Pure Sales Scan logic: window bounds, deadlines, consent hashing, serialization.
 *
 * Deliberately imports NOTHING from ./env.js or ./db.js. env.ts calls process.exit(1)
 * on an unconfigured environment, which would make these invariants untestable in the
 * blocking CI gate — and these are exactly the invariants that must never regress
 * (a window that cannot become unbounded, consent that is reproducible).
 */

/**
 * How long a capture-service heartbeat stays believable.
 *
 * The service beats every 60s while capture is genuinely armed, so this tolerates three
 * missed beats before we call it down — long enough to ride out a restart or a network
 * blip, short enough that a tenant is never offered a QR by a service that died minutes
 * ago. Kept here (not in env) so no deployment can widen "is it alive?" into "it was
 * alive once".
 */
export const INGEST_HEARTBEAT_MAX_AGE_MS = 180_000;

/**
 * Is the capture service actually alive right now?
 *
 * This is the difference between asking "is the address written down?" and "is anyone
 * home?". The old availability check tested only that config vars were SET, which is why
 * production spent a week offering tenants a QR code that no running process could ever
 * produce. A heartbeat is emitted ONLY when the capture service has capture switched on,
 * so its freshness is the one signal that tracks reality.
 *
 * Fails CLOSED on purpose: unknown/missing/garbled => not live => the UI says "coming
 * soon" rather than promising a QR. Being wrongly pessimistic costs a tenant a few
 * minutes; being wrongly optimistic strands them on a spinner forever.
 */
export function isHeartbeatFresh(
  beatAt: Date | number | null | undefined,
  now: Date = new Date(),
  maxAgeMs: number = INGEST_HEARTBEAT_MAX_AGE_MS,
): boolean {
  if (beatAt === null || beatAt === undefined) return false;
  const ms = beatAt instanceof Date ? beatAt.getTime() : beatAt;
  if (!Number.isFinite(ms)) return false;
  const age = now.getTime() - ms;
  // A beat from the future means a clock skew we cannot reason about — refuse it rather
  // than let a bad timestamp pin the service "alive" indefinitely.
  if (age < -maxAgeMs) return false;
  return age <= maxAgeMs;
}

type GrantRow = {
  id: string;
  status: SalesScanStatus;
  phoneE164: string | null;
  windowDays: number;
  grantedAt: Date;
  grantExpiresAt: Date;
  linkedAt: Date | null;
  captureEndsAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  messageCount: number;
  consentVersion: string;
};

export function consentTextSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hash of the consent copy currently shipped in `@platform/shared`. */
export function currentConsentSha256(): string {
  return consentTextSha256(SALES_SCAN_CONSENT_TEXT);
}

export function clampWindowDays(days: number): number {
  if (!Number.isFinite(days)) return SALES_SCAN_MIN_WINDOW_DAYS;
  return Math.min(SALES_SCAN_MAX_WINDOW_DAYS, Math.max(SALES_SCAN_MIN_WINDOW_DAYS, Math.trunc(days)));
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Whole days left before capture stops. Null when the window has not started (no
 * link yet) or has already ended — the UI shows a different state in both cases.
 */
export function daysRemaining(
  captureEndsAt: Date | null,
  now: Date = new Date(),
): number | null {
  if (!captureEndsAt) return null;
  const ms = captureEndsAt.getTime() - now.getTime();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/**
 * The effective end of capture: the earlier of the tenant-facing window and the
 * absolute compliance deadline. A grant that is queued or half-linked therefore
 * still has a hard stop.
 */
export function effectiveEndsAt(grant: {
  grantExpiresAt: Date;
  captureEndsAt: Date | null;
}): Date {
  if (!grant.captureEndsAt) return grant.grantExpiresAt;
  return grant.captureEndsAt < grant.grantExpiresAt ? grant.captureEndsAt : grant.grantExpiresAt;
}

export function serializeGrant(grant: GrantRow, now: Date = new Date()): SalesScanGrantDto {
  const capturing = grant.status === 'active';
  return {
    id: grant.id,
    status: grant.status,
    phoneE164: grant.phoneE164,
    windowDays: grant.windowDays,
    grantedAt: grant.grantedAt.toISOString(),
    grantExpiresAt: grant.grantExpiresAt.toISOString(),
    linkedAt: grant.linkedAt ? grant.linkedAt.toISOString() : null,
    captureEndsAt: grant.captureEndsAt ? grant.captureEndsAt.toISOString() : null,
    endedAt: grant.endedAt ? grant.endedAt.toISOString() : null,
    endReason: grant.endReason,
    messageCount: grant.messageCount,
    consentVersion: grant.consentVersion,
    daysRemaining: capturing ? daysRemaining(effectiveEndsAt(grant), now) : null,
  };
}
