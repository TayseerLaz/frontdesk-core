import { createHash } from 'node:crypto';

import {
  ORG_FEATURES,
  ORG_FEATURE_DEFAULT_DISABLED,
  ORG_FEATURE_KEYS,
  SALES_SCAN_CONSENT_TEXT,
  SALES_SCAN_CONSENT_VERSION,
  SALES_SCAN_MAX_WINDOW_DAYS,
  SALES_SCAN_MIN_WINDOW_DAYS,
  isHrefDisabled,
} from '@platform/shared';
import { describe, expect, it } from 'vitest';

// Imported from the PURE module on purpose: ../src/lib/sales-scan.js pulls in env.ts,
// which process.exit(1)s on an unconfigured environment and would make this whole file
// unrunnable in the blocking CI gate.
import {
  INGEST_HEARTBEAT_MAX_AGE_MS,
  clampWindowDays,
  currentConsentSha256,
  daysRemaining,
  effectiveEndsAt,
  isHeartbeatFresh,
} from '../../src/lib/sales-scan-window.js';

/**
 * Pure invariants for Sales Scan ("Teach the bot with your own data"). No DB, no Redis
 * — so this file belongs in the HARD (blocking) CI gate. Each block below encodes a
 * requirement that failed review once already; if one of these regresses, the feature
 * is either invisible to the tenants who need the upsell, silently unbounded, or
 * consenting people to text they never saw.
 */

describe('sales_scan feature registration', () => {
  it('is registered and opt-in (OFF by default for every tenant)', () => {
    const entry = ORG_FEATURES.find((f) => f.key === 'sales_scan');
    expect(entry, 'sales_scan must exist in ORG_FEATURES').toBeTruthy();
    expect(ORG_FEATURE_DEFAULT_DISABLED).toContain('sales_scan');
  });

  /**
   * THE load-bearing gating invariant. Sales Scan is hidden when off, like every other
   * paged feature — declaring the href is what lets isHrefDisabled() hide the Settings
   * card and bounce /settings/sales-scan in (dashboard)/layout.tsx.
   *
   * This asserts the OPPOSITE of what it did before 2026-08-05, when the card was
   * deliberately left visible to show "contact admin to upgrade". That deviation was
   * reversed by owner decision. If you are here because this test failed after emptying
   * `hrefs`, the reversal is the intended behaviour — do not restore the old form.
   */
  it('declares its href, so the card is hidden and the route is bounced when off', () => {
    const entry = ORG_FEATURES.find((f) => f.key === 'sales_scan')!;
    expect(
      entry.hrefs,
      'sales_scan.hrefs must list the page so the feature hides when off',
    ).toEqual(['/settings/sales-scan']);

    // Disabled → hidden and bounced.
    expect(isHrefDisabled('/settings/sales-scan', ['sales_scan'])).toBe(true);
    // Child paths too, since the guard matches on prefix.
    expect(isHrefDisabled('/settings/sales-scan/anything', ['sales_scan'])).toBe(true);

    // Positive controls, so this pins the gate rather than a constant: enabled must be
    // reachable, and the parent Settings page must never be collateral.
    expect(isHrefDisabled('/settings/sales-scan', [])).toBe(false);
    expect(isHrefDisabled('/settings', ['sales_scan'])).toBe(false);
    expect(isHrefDisabled('/settings/billing', ['sales_scan'])).toBe(false);
  });

  /**
   * The feature stays OPT-IN. "Make it match every other feature" must not be read as
   * dropping defaultDisabled — that would enable Sales Scan for every currently-disabled
   * org at once, the same fail-open shape as the 2026-07-20 fleet-wide incident.
   */
  it('is still opt-in after the gating reversal', () => {
    const entry = ORG_FEATURES.find((f) => f.key === 'sales_scan')!;
    expect('defaultDisabled' in entry && entry.defaultDisabled).toBe(true);
    expect(ORG_FEATURE_DEFAULT_DISABLED).toContain('sales_scan');
  });

  /**
   * `disabledFeatures` is capped in two places (packages/shared/src/schemas/org.ts and
   * admin.routes.ts). If the cap ever falls back to the key count, turning every
   * feature off 400s on the HQ "Save access" button with no obvious cause.
   */
  it('leaves headroom under the disabledFeatures array cap', () => {
    expect(ORG_FEATURE_KEYS.length).toBeLessThanOrEqual(40);
    expect(new Set(ORG_FEATURE_KEYS).size).toBe(ORG_FEATURE_KEYS.length);
  });
});

describe('consent evidence', () => {
  /**
   * Pinned hash. Reword SALES_SCAN_CONSENT_TEXT and this fails — bump
   * SALES_SCAN_CONSENT_VERSION and update the pin in the same commit. This is what
   * makes a stored grant's consent reproducible months later.
   */
  const PINNED_SHA256 = 'b01bbb0da9c28a16b5535846e73374f1ff883c67ba8c42ccaddd24baf60d29a8';
  const PINNED_VERSION = '2026-08-05.1';

  it('consent text matches its pinned hash for the pinned version', () => {
    expect(SALES_SCAN_CONSENT_VERSION).toBe(PINNED_VERSION);
    expect(currentConsentSha256()).toBe(PINNED_SHA256);
    expect(createHash('sha256').update(SALES_SCAN_CONSENT_TEXT, 'utf8').digest('hex')).toBe(
      PINNED_SHA256,
    );
  });

  it('discloses the things a tenant must not be surprised by', () => {
    const t = SALES_SCAN_CONSENT_TEXT.toLowerCase();
    // NOTE: the unofficial-client / ban-risk disclosure was removed from the copy by the
    // owner on 2026-07-30 (version .2), so it is deliberately NOT asserted here. The
    // acknowledgedBanRisk checkbox still exists in salesScanConnectBodySchema.
    // The 4-linked-device cap.
    expect(t).toContain('4 linked devices');
    // Retention + deletion.
    expect(t).toContain('90 days');
    // Who else can see it.
    expect(t).toContain('aligned staff');
    // We must NOT claim to redact PII broadly — we only strip payment credentials.
    expect(t).not.toContain('anonymis');
    expect(t).not.toContain('anonymiz');
  });

  /**
   * Backward history disclosure (blocker B8), added in version 2026-08-05.1.
   *
   * Linking a number makes WhatsApp stream conversation history from BEFORE the tenant
   * agreed to anything — and how far back is decided by WhatsApp and the handset, not by
   * us. The copy previously said "for the window shown above", which read as forward-only
   * and was therefore false the moment history sync was enabled.
   *
   * The owner's decision (2026-08-05) was to keep history sync and widen the wording. That
   * makes this disclosure the thing standing between "detailed training data" and
   * collecting people's older messages under a promise that never mentioned them. Pinned
   * so it cannot be dropped in a future reword without failing the build.
   */
  it('discloses that linking pulls history from BEFORE the tenant agreed', () => {
    const t = SALES_SCAN_CONSENT_TEXT.toLowerCase();
    // It reaches backwards at all.
    expect(t).toContain('before');
    expect(t).toContain('history');
    // And we do not pretend to know how far — claiming a cut-off we cannot enforce would
    // be a worse lie than the one being fixed.
    expect(t).toContain('cannot promise');
    // Older messages are covered by the same retention and erasure promises.
    expect(t).toContain('90 days');
  });
});

describe('capture window bounds', () => {
  it('clamps windowDays into [min, max] regardless of caller or env', () => {
    expect(clampWindowDays(7)).toBe(7);
    expect(clampWindowDays(0)).toBe(SALES_SCAN_MIN_WINDOW_DAYS);
    expect(clampWindowDays(-5)).toBe(SALES_SCAN_MIN_WINDOW_DAYS);
    expect(clampWindowDays(365)).toBe(SALES_SCAN_MAX_WINDOW_DAYS);
    expect(clampWindowDays(3.9)).toBe(3);
    expect(clampWindowDays(Number.NaN)).toBe(SALES_SCAN_MIN_WINDOW_DAYS);
    expect(clampWindowDays(Number.POSITIVE_INFINITY)).toBe(SALES_SCAN_MIN_WINDOW_DAYS);
  });

  /**
   * A grant must always have a hard stop. `captureEndsAt` is unknown until the number
   * links, so the absolute `grantExpiresAt` is what bounds a pending/queued grant —
   * otherwise "one week" quietly becomes open-ended.
   */
  it('always resolves to the EARLIER of capture end and the absolute deadline', () => {
    const grantExpiresAt = new Date('2026-08-13T00:00:00Z');

    // Not linked yet → the absolute deadline governs.
    expect(effectiveEndsAt({ grantExpiresAt, captureEndsAt: null })).toEqual(grantExpiresAt);

    // Normal case: capture ends first.
    const soon = new Date('2026-08-06T00:00:00Z');
    expect(effectiveEndsAt({ grantExpiresAt, captureEndsAt: soon })).toEqual(soon);

    // A captureEndsAt beyond the absolute deadline must NOT extend the window.
    const tooLate = new Date('2026-12-01T00:00:00Z');
    expect(effectiveEndsAt({ grantExpiresAt, captureEndsAt: tooLate })).toEqual(grantExpiresAt);
  });

  /**
   * Capture availability must track REALITY, not config. Production offered tenants a QR
   * code for six days because the check was "are the env vars set?" while the capture
   * service sat switched off — a grant wedged in `linking` the whole time. The heartbeat
   * is emitted only when capture is genuinely armed, so its freshness is the signal.
   *
   * Every ambiguous case must resolve to NOT fresh. Being wrongly pessimistic costs a
   * tenant a few minutes of "coming soon"; being wrongly optimistic strands them on a
   * spinner that can never resolve.
   */
  it('treats only a recent heartbeat as proof the capture service is alive', () => {
    const now = new Date('2026-08-05T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);

    // Fresh: a beat lands every 60s, so these are healthy.
    expect(isHeartbeatFresh(now, now)).toBe(true);
    expect(isHeartbeatFresh(ago(60_000), now)).toBe(true);
    expect(isHeartbeatFresh(ago(INGEST_HEARTBEAT_MAX_AGE_MS), now)).toBe(true);

    // Stale: three missed beats means the service is gone.
    expect(isHeartbeatFresh(ago(INGEST_HEARTBEAT_MAX_AGE_MS + 1), now)).toBe(false);
    expect(isHeartbeatFresh(ago(60 * 60_000), now)).toBe(false);

    // Never heard from it at all — the production case that caused the incident.
    expect(isHeartbeatFresh(null, now)).toBe(false);
    expect(isHeartbeatFresh(undefined, now)).toBe(false);

    // Garbage must not read as alive.
    expect(isHeartbeatFresh(Number.NaN, now)).toBe(false);
    expect(isHeartbeatFresh(Number.POSITIVE_INFINITY, now)).toBe(false);

    // A wildly future timestamp (clock skew) must not pin it "alive" forever.
    expect(isHeartbeatFresh(new Date(now.getTime() + 60 * 60_000), now)).toBe(false);

    // Epoch millis are accepted as well as Dates, since that is what Redis stores.
    expect(isHeartbeatFresh(ago(1_000).getTime(), now)).toBe(true);
  });

  it('reports whole days remaining and never goes negative', () => {
    const now = new Date('2026-08-01T00:00:00Z');
    expect(daysRemaining(null, now)).toBeNull();
    expect(daysRemaining(new Date('2026-08-08T00:00:00Z'), now)).toBe(7);
    expect(daysRemaining(new Date('2026-08-01T06:00:00Z'), now)).toBe(1);
    expect(daysRemaining(new Date('2026-07-31T00:00:00Z'), now)).toBe(0);
  });
});
