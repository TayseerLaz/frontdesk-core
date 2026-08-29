import { createHash } from 'node:crypto';

import {
  COEXISTENCE_CONSENT_TEXT,
  COEXISTENCE_CONSENT_VERSION,
  type CoexistenceHistoryConsent,
  type SalesScanStatus,
} from '@platform/shared';
import { describe, expect, it } from 'vitest';

// Imported from the PURE module on purpose: ../src/lib/sales-scan.js and the whatsapp
// routes both pull in env.ts, which process.exit(1)s on an unconfigured environment and
// would make this whole file unrunnable in the blocking CI gate.
import {
  coexistenceConsentSha256,
  mayPersistCapturedMessage,
  shouldRequestHistory,
} from '../../src/lib/coexistence-capture.js';

/**
 * Pure invariants for WhatsApp Coexistence capture. No DB, no Redis, no env — so this
 * file belongs in the HARD (blocking) CI gate.
 *
 * What this file exists to prevent, concretely: the deployed Embedded Signup exchange
 * route used to ask Meta for 180 days of a tenant's customers' conversations on EVERY
 * connect, unconditionally, with no consent record, no grant and no retention clock. That
 * request is one-shot and cannot be undone. These assertions are the gate that replaced it.
 */

describe('coexistence consent evidence', () => {
  /**
   * Pinned hash. Reword COEXISTENCE_CONSENT_TEXT and this fails — bump
   * COEXISTENCE_CONSENT_VERSION and update the pin in the SAME commit. This is what makes
   * a stored grant's consent reproducible months later, when the copy has moved on and
   * the only record of what someone actually agreed to is the grant row.
   */
  const PINNED_SHA256 = '947b66e37b12cbf3f271fa2aacbb90ca52c9ffc85b951b6e83493f331ecb7d49';
  const PINNED_VERSION = '2026-08-29.1';

  it('consent text matches its pinned hash for the pinned version', () => {
    expect(COEXISTENCE_CONSENT_VERSION).toBe(PINNED_VERSION);
    expect(coexistenceConsentSha256()).toBe(PINNED_SHA256);
    expect(createHash('sha256').update(COEXISTENCE_CONSENT_TEXT, 'utf8').digest('hex')).toBe(
      PINNED_SHA256,
    );
  });

  /**
   * Pins the DISCLOSURES, not just the hash. A reword that bumps the version and the pin
   * would otherwise be free to drop any of these — and each one is a thing a tenant would
   * have a legitimate complaint about not being told.
   */
  it('discloses every consequence a tenant must not be surprised by', () => {
    const t = COEXISTENCE_CONSENT_TEXT.toLowerCase();

    // The depth, stated as a number. Meta documents 180 days, so unlike the Baileys copy
    // this is a promise we can actually keep.
    expect(t).toContain('180 days');
    // That it reaches back before they agreed.
    expect(t).toContain('before you agreed');
    // Contacts, not just messages.
    expect(t).toContain('contact list');
    // Ongoing echoes of what they send from the handset.
    expect(t).toContain('every message you send from your phone');
    // The two exclusions, so nobody expects a complete archive.
    expect(t).toContain('group chats');
    expect(t).toContain('older than 14 days');
    // One-shot delivery.
    expect(t).toContain('once');
    // What connecting does to their other devices.
    expect(t).toContain('sign your other devices out');
    // The keep-using-the-app requirement, which appears nowhere else in the product.
    expect(t).toContain('every week or two');
    // Retention, and the honest note that held-for-90-days is not aged-under-90-days.
    expect(t).toContain('90 days');
    // Controller/processor split.
    expect(t).toContain('have not agreed anything with us');
    // The clause that keeps us on the right side of Meta's Jan-2026 AI terms. Matched
    // short of "other customers" because the copy wraps mid-phrase — asserting across a
    // line break pins the wrapping, not the promise.
    expect(t).toContain('never use it to train anything shared');
    // Offboarding is on the handset, not in the platform.
    expect(t).toContain('business platform');
  });

  it('does NOT repeat the Baileys-era claims that are false under coexistence', () => {
    const t = COEXISTENCE_CONSENT_TEXT.toLowerCase();
    // Coexistence does not consume a linked-device slot, so the 4-device warning would be
    // a scare about the wrong thing.
    expect(t).not.toContain('4 linked devices');
    expect(t).not.toContain('linked device');
    // And the depth is no longer unpromisable.
    expect(t).not.toContain('cannot promise a specific cut-off');
  });
});

describe('shouldRequestHistory — the gate on asking Meta for 180 days', () => {
  const valid: CoexistenceHistoryConsent = {
    version: COEXISTENCE_CONSENT_VERSION,
    acknowledgedScope: true,
    acknowledgedControllerDuty: true,
    acknowledgedOnboardingEffects: true,
  };

  // The ALLOW half. A gate that only ever refuses is indistinguishable from a broken
  // feature, so both halves are asserted.
  it('PERMITS the request when consent is present and current', () => {
    const d = shouldRequestHistory(valid);
    expect(d.request).toBe(true);
    if (d.request) expect(d.consentVersion).toBe(COEXISTENCE_CONSENT_VERSION);
  });

  // The REFUSE half, and the reason each refusal gives.
  it('REFUSES when no consent block was sent at all (fails closed)', () => {
    expect(shouldRequestHistory(undefined)).toEqual({ request: false, reason: 'not_offered' });
    expect(shouldRequestHistory(null)).toEqual({ request: false, reason: 'not_offered' });
  });

  it('REFUSES consent given against a different version of the copy', () => {
    expect(shouldRequestHistory({ ...valid, version: '2026-08-05.1' })).toEqual({
      request: false,
      reason: 'stale_copy',
    });
    expect(shouldRequestHistory({ ...valid, version: '' })).toEqual({
      request: false,
      reason: 'stale_copy',
    });
  });

  /**
   * Absence is never consent. Clicking Connect is not agreement to hand over six months
   * of customer conversations — a tenant may be connecting a number purely to send from,
   * and may never have been shown the history copy at all.
   */
  it('treats a bare connect (no consent) as a refusal, not a default yes', () => {
    expect(shouldRequestHistory(undefined).request).toBe(false);
  });
});

describe('mayPersistCapturedMessage — the gate on storing what Meta keeps sending', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');
  const future = new Date('2026-09-08T12:00:00.000Z');
  const past = new Date('2026-08-25T12:00:00.000Z');

  it('PERMITS storage inside a live window', () => {
    expect(
      mayPersistCapturedMessage(
        { status: 'active', grantExpiresAt: future, captureEndsAt: future },
        now,
      ),
    ).toEqual({ persist: true });
  });

  it('REFUSES with no grant at all (fails closed)', () => {
    expect(mayPersistCapturedMessage(null, now)).toEqual({ persist: false, reason: 'no_grant' });
    expect(mayPersistCapturedMessage(undefined, now)).toEqual({
      persist: false,
      reason: 'no_grant',
    });
  });

  /**
   * This is what "stop capturing" means under coexistence. There is no socket to close and
   * no way to make Meta stop sending, so a revoked grant has to be enforced here or the
   * button is a lie — the exact defect blocker B11 named on the Baileys path.
   */
  it('REFUSES for every terminal grant status', () => {
    const terminal: SalesScanStatus[] = ['completed', 'revoked', 'expired', 'failed'];
    for (const status of terminal) {
      expect(
        mayPersistCapturedMessage({ status, grantExpiresAt: future, captureEndsAt: future }, now),
        `status ${status} must not permit storage`,
      ).toEqual({ persist: false, reason: 'grant_terminal' });
    }
  });

  it('REFUSES once the window has closed, even while the grant still reads active', () => {
    expect(
      mayPersistCapturedMessage({ status: 'active', grantExpiresAt: past, captureEndsAt: past }, now),
    ).toEqual({ persist: false, reason: 'window_closed' });
  });

  /**
   * The two deadlines exist so a grant that never linked, or linked late, still stops. The
   * earlier one must win in BOTH directions, or one of them is decoration.
   */
  it('stops at the EARLIER of captureEndsAt and grantExpiresAt', () => {
    // Absolute deadline is the earlier one.
    expect(
      mayPersistCapturedMessage(
        { status: 'active', grantExpiresAt: past, captureEndsAt: future },
        now,
      ),
    ).toEqual({ persist: false, reason: 'window_closed' });
    // Tenant-facing window is the earlier one.
    expect(
      mayPersistCapturedMessage(
        { status: 'active', grantExpiresAt: future, captureEndsAt: past },
        now,
      ),
    ).toEqual({ persist: false, reason: 'window_closed' });
  });

  it('falls back to the absolute deadline when the window never started', () => {
    // Never linked: captureEndsAt is null, so grantExpiresAt alone governs. Both halves.
    expect(
      mayPersistCapturedMessage(
        { status: 'pending', grantExpiresAt: future, captureEndsAt: null },
        now,
      ),
    ).toEqual({ persist: true });
    expect(
      mayPersistCapturedMessage({ status: 'pending', grantExpiresAt: past, captureEndsAt: null }, now),
    ).toEqual({ persist: false, reason: 'window_closed' });
  });
});
