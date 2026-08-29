import { describe, expect, it } from 'vitest';

import * as wallet from '../src/lib/wallet.js';
import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

// Tenant wallet & metered WhatsApp billing (docs/wallet-billing-plan.md).
// Exercises the money engine directly (atomic accounting is the thing that must
// never be wrong) plus the tenant-facing /billing/overview endpoint. No mocks.

describe('tenant wallet & metered billing', () => {
  it('top-up credits available, auto-enables metering, and writes a ledger row', async () => {
    const { orgId } = await seedOrgAndLogin(getApp(), 'wallet-topup');
    const w = await wallet.topUp(orgId, 10_000_000, null, 'seed'); // $10.00
    expect(w.availableMicros).toBe(10_000_000);
    expect(w.meteringEnabled).toBe(true);
    expect(w.lifetimeToppedUpMicros).toBe(10_000_000);

    const ledger = await prisma.walletLedger.findMany({ where: { organizationId: orgId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.kind).toBe('topup');
    expect(Number(ledger[0]!.amountMicros)).toBe(10_000_000);
    expect(Number(ledger[0]!.availableAfter)).toBe(10_000_000);
  });

  it('setPrice enforces the $0.0375 floor', async () => {
    const { orgId } = await seedOrgAndLogin(getApp(), 'wallet-price');
    const w = await wallet.setPrice(orgId, 1_000); // below floor
    expect(w.pricePerMessageMicros).toBe(37_500);
    const w2 = await wallet.setPrice(orgId, 80_000);
    expect(w2.pricePerMessageMicros).toBe(80_000);
  });

  it('quote computes affordability, maxAffordable and removeCount', async () => {
    const { orgId } = await seedOrgAndLogin(getApp(), 'wallet-quote');
    await wallet.setPrice(orgId, 80_000); // $0.08
    await wallet.topUp(orgId, 800_000, null); // $0.80 → exactly 10 messages
    const q = await wallet.quote(orgId, 15);
    expect(q.metered).toBe(true);
    expect(q.unitPriceMicros).toBe(80_000);
    expect(q.maxAffordable).toBe(10);
    expect(q.removeCount).toBe(5);
    expect(q.ok).toBe(false);

    const q2 = await wallet.quote(orgId, 8);
    expect(q2.ok).toBe(true);
    expect(q2.removeCount).toBe(0);
  });

  it('an unmetered org (no wallet) quotes as always-ok', async () => {
    const { orgId } = await seedOrgAndLogin(getApp(), 'wallet-unmetered');
    const q = await wallet.quote(orgId, 1_000_000);
    expect(q.metered).toBe(false);
    expect(q.ok).toBe(true);
    expect(q.removeCount).toBe(0);
    expect(await wallet.isMetered(orgId)).toBe(false);
  });

  it('chargeAtSend debits atomically, never goes negative, and caps at empty', async () => {
    const { orgId } = await seedOrgAndLogin(getApp(), 'wallet-charge');
    await wallet.setPrice(orgId, 100_000); // $0.10
    await wallet.topUp(orgId, 250_000, null); // $0.25 → two messages + $0.05 left

    const c1 = await wallet.chargeAtSend({ orgId, unitPriceMicros: 100_000, metaCostMicros: 37_500 });
    const c2 = await wallet.chargeAtSend({ orgId, unitPriceMicros: 100_000, metaCostMicros: 37_500 });
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);

    // Only $0.05 remains — can't cover another $0.10 message.
    const c3 = await wallet.chargeAtSend({ orgId, unitPriceMicros: 100_000, metaCostMicros: 37_500 });
    expect(c3.ok).toBe(false);

    const w = await wallet.getWallet(orgId);
    expect(w!.availableMicros).toBe(50_000); // never negative
    expect(w!.lifetimeMessages).toBe(2);
    expect(w!.lifetimeSpentMicros).toBe(200_000);
  });

  it('adjust clamps available at zero on a large debit', async () => {
    const { orgId } = await seedOrgAndLogin(getApp(), 'wallet-adjust');
    await wallet.topUp(orgId, 500_000, null); // $0.50
    const w = await wallet.adjust(orgId, -5_000_000, null, 'refund overshoot');
    expect(w.availableMicros).toBe(0); // clamped, not negative
  });

  it('GET /billing/overview reflects the wallet without leaking Meta cost', async () => {
    const { orgId, accessToken } = await seedOrgAndLogin(getApp(), 'wallet-overview');
    await wallet.setPrice(orgId, 80_000);
    await wallet.topUp(orgId, 1_600_000, null); // $1.60 → 20 messages

    const res = await getApp().inject({
      method: 'GET',
      url: '/api/v1/billing/overview',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = (res.json() as { data: Record<string, unknown> }).data;
    expect(body.metered).toBe(true);
    expect(body.pricePerMessageMicros).toBe(80_000);
    expect(body.messagesRemaining).toBe(20);
    expect(body.availableMicros).toBe(1_600_000);
    expect('metaCostMicros' in body).toBe(false); // Meta cost is HQ-internal
    expect('marginPct' in body).toBe(false);
  });
});
