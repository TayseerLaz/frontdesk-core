// Sprint 1 M-3 — two-step recovery code persistence.
//
// The security property under test: after /enable, the user record is NOT
// yet totpEnabled. Only after /confirm-recovery-codes does the flag flip
// and the secret + hashes commit. If the response carrying the codes is
// lost, the pending payload expires after 15 minutes and the account
// remains in its prior state — no lock-out.
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

const PENDING_RECOVERY_KEY = (userId: string) => `2fa:pending-recovery:${userId}`;

async function getRedis() {
  const { getRedis } = await import('../src/lib/redis.js');
  return getRedis();
}

describe('two-step recovery code persistence (M-3)', () => {
  it('confirm without a pending payload returns 400', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'twostep1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/2fa/confirm-recovery-codes',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('confirm with a seeded pending enable payload flips totpEnabled', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'twostep2');

    // Simulate the state /enable leaves the system in: a pending payload
    // staged in Redis, but the user record is not yet totpEnabled.
    const redis = await getRedis();
    const payload = {
      kind: 'enable' as const,
      totpSecret: 'JBSWY3DPEHPK3PXP', // any base32 secret will do
      recoveryCodesHashed: ['a'.repeat(64), 'b'.repeat(64)],
    };
    await redis.set(PENDING_RECOVERY_KEY(me.userId), JSON.stringify(payload), 'EX', 900);

    // Sanity: the user is not yet totpEnabled.
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const before = await prisma.user.findUnique({ where: { id: me.userId } });
    expect(before?.totpEnabled).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/2fa/confirm-recovery-codes',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const after = await prisma.user.findUnique({ where: { id: me.userId } });
    expect(after?.totpEnabled).toBe(true);
    // H-02: the TOTP secret is encrypted at rest. It must round-trip back to
    // the original via decryptSecret (which is a plaintext passthrough when no
    // SECRET_ENCRYPTION_KEY is configured, so this holds in every environment).
    const { decryptSecret } = await import('@platform/db');
    expect(decryptSecret(after?.totpSecret ?? null)).toBe('JBSWY3DPEHPK3PXP');
    expect(after?.recoveryCodesHashed).toHaveLength(2);

    // Redis pending payload is cleared.
    const stillPending = await redis.get(PENDING_RECOVERY_KEY(me.userId));
    expect(stillPending).toBeNull();
  });

  it('confirm with a regenerate payload replaces hashes only (no flag change)', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'twostep3');

    // Pre-condition: user already has 2FA on with one set of hashes.
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    await prisma.user.update({
      where: { id: me.userId },
      data: {
        totpEnabled: true,
        totpSecret: 'JBSWY3DPEHPK3PXP',
        totpEnrolledAt: new Date(),
        recoveryCodesHashed: ['old-hash-'.padEnd(64, '0')],
      },
    });

    const redis = await getRedis();
    const payload = {
      kind: 'regenerate-recovery' as const,
      recoveryCodesHashed: ['new-hash-'.padEnd(64, '1'), 'new-hash-'.padEnd(64, '2')],
    };
    await redis.set(PENDING_RECOVERY_KEY(me.userId), JSON.stringify(payload), 'EX', 900);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/2fa/confirm-recovery-codes',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const after = await prisma.user.findUnique({ where: { id: me.userId } });
    expect(after?.totpEnabled).toBe(true);
    expect(after?.recoveryCodesHashed).toHaveLength(2);
    expect(after?.recoveryCodesHashed[0]).toMatch(/^new-hash-/);
  });
});
