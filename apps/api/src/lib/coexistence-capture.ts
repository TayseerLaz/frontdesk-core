import { createHash } from 'node:crypto';

import {
  COEXISTENCE_CONSENT_TEXT,
  COEXISTENCE_CONSENT_VERSION,
  type CoexistenceHistoryConsent,
  type SalesScanStatus,
} from '@platform/shared';

import { effectiveEndsAt } from './sales-scan-window.js';

/**
 * Coexistence capture gates — the two decisions that keep a tenant's customers' messages
 * inside the promise the tenant actually agreed to.
 *
 * Deliberately imports NOTHING from ./env.js or ./db.js, same reasoning as
 * sales-scan-window.ts: env.ts calls process.exit(1) on an unconfigured environment, and
 * vitest cannot boot on a developer machine for that reason. Keeping these pure is what
 * lets them live in the BLOCKING pure CI gate (apps/api/test/pure/**) rather than in a
 * suite nobody can run locally.
 *
 * These are the invariants that must never regress:
 *  - we never ASK Meta for a tenant's conversation history without fresh, versioned,
 *    explicitly-acknowledged consent (shouldRequestHistory);
 *  - we never STORE a captured message once the grant that authorised it is over
 *    (mayPersistCapturedMessage).
 *
 * The second one carries weight it did not have on the Baileys path. There, "stop" closed
 * a socket and destroyed credentials — the backstop was physical. Under coexistence there
 * is nothing to disconnect short of the tenant fully offboarding from their handset, which
 * would also destroy their live Cloud API channel and their bot. So revocation becomes a
 * software gate, and this is it.
 */

/** SHA-256 of the coexistence consent copy currently shipped in `@platform/shared`. */
export function coexistenceConsentSha256(): string {
  return createHash('sha256').update(COEXISTENCE_CONSENT_TEXT, 'utf8').digest('hex');
}

/** Why we refused to ask Meta for history. Surfaced in logs, never to the tenant verbatim. */
export type HistoryRefusal =
  /** The client sent no consent block at all — the default, and the fail-closed case. */
  | 'not_offered'
  /** The tenant ticked boxes against a different version of the copy than we ship now. */
  | 'stale_copy';

export type HistoryDecision =
  | { request: true; consentVersion: string }
  | { request: false; reason: HistoryRefusal };

/**
 * May we ask Meta to send this tenant's 180 days of customer conversations?
 *
 * FAILS CLOSED. An absent consent block is not "assume yes because they clicked Connect" —
 * it is a refusal, because the tenant may simply be connecting a number to send messages
 * from and may never have been shown the history copy at all. Absence is never consent.
 *
 * The version check is not ceremony. History is delivered ONCE and cannot be re-requested
 * without a full offboard, so a tenant who agreed to older, weaker copy can never be
 * re-asked about the same corpus. Refusing a stale version is the only moment where that
 * mismatch is still fixable.
 *
 * Note what this function does NOT check: the acknowledgement booleans. They are
 * `z.literal(true)` in coexistenceHistoryConsentSchema, so Zod has already rejected the
 * request before any handler runs — re-checking them here would be dead code that reads
 * like a safety net. The type is the check.
 */
export function shouldRequestHistory(
  consent: CoexistenceHistoryConsent | null | undefined,
): HistoryDecision {
  if (!consent) return { request: false, reason: 'not_offered' };
  if (consent.version !== COEXISTENCE_CONSENT_VERSION) {
    return { request: false, reason: 'stale_copy' };
  }
  return { request: true, consentVersion: consent.version };
}

/** Statuses from which no further transition is possible. Mirrors lib/sales-scan.ts. */
const TERMINAL: SalesScanStatus[] = ['completed', 'revoked', 'expired', 'failed'];

export type CapturedMessageRefusal =
  /** No grant at all — nothing ever authorised storing this. */
  | 'no_grant'
  /** The tenant revoked, or a reaper ended it. */
  | 'grant_terminal'
  /** Past min(captureEndsAt, grantExpiresAt). */
  | 'window_closed';

export type CaptureDecision =
  | { persist: true }
  | { persist: false; reason: CapturedMessageRefusal };

/**
 * May we STORE a message Meta just handed us for the capture corpus?
 *
 * Called per payload on the receiving side, because Meta keeps delivering after the window
 * closes and there is no way to make it stop. A payload we are not allowed to keep is
 * discarded on arrival rather than stored and swept later — "we delete it within 90 days"
 * and "we never wrote it down" are different promises, and this one is the stronger.
 *
 * FAILS CLOSED on a missing grant. Note this deliberately says nothing about the tenant's
 * `disabledFeatures`: switching the feature off must never disable a tenant's own ability
 * to stop capture (the 2026-08-05 consent hole), and the mirror of that rule is that
 * switching it off must not silently start permitting storage either. The grant is the
 * authority, in both directions.
 */
export function mayPersistCapturedMessage(
  grant:
    | { status: SalesScanStatus; grantExpiresAt: Date; captureEndsAt: Date | null }
    | null
    | undefined,
  now: Date = new Date(),
): CaptureDecision {
  if (!grant) return { persist: false, reason: 'no_grant' };
  if (TERMINAL.includes(grant.status)) return { persist: false, reason: 'grant_terminal' };
  if (now.getTime() > effectiveEndsAt(grant).getTime()) {
    return { persist: false, reason: 'window_closed' };
  }
  return { persist: true };
}
