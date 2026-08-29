// Session 2 deploy gate for account lifecycle: export must return a
// structured bundle for the current user; delete must revoke all sessions;
// delete must be refused when the user is the last admin of any org.
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

describe('account export', () => {
  it('returns a JSON bundle for the current user and does not leak other orgs', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'exportme');
    // Seed a second org with a different user to prove isolation.
    const other = await seedOrgAndLogin(app, 'exportother');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/account/export',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const body = JSON.parse(res.body) as {
      user: { id: string } | null;
      memberships: { organizationId: string }[];
      sessions: unknown[];
    };
    expect(body.user?.id).toBe(me.userId);
    expect(body.memberships.map((m) => m.organizationId)).toContain(me.orgId);
    // The other org is only accessible to the other user's export.
    expect(body.memberships.map((m) => m.organizationId)).not.toContain(other.orgId);
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});

describe('account delete', () => {
  it('revokes all sessions and anonymises the user row on self-delete', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'deleteme');
    // Add a second admin so the last-admin guard does not block.
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const buddy = await prisma.user.create({
      data: {
        email: 'buddy-deleteme@example.com',
        passwordHash: '!',
        firstName: 'Buddy',
        lastName: 'Admin',
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { organizationId: me.orgId, userId: buddy.id, role: 'admin' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.user.findUnique({ where: { id: me.userId } });
    expect(after?.status).toBe('disabled');
    expect(after?.email).toMatch(/^deleted-/);
    expect(after?.firstName).toBeNull();

    const sessions = await prisma.session.findMany({ where: { userId: me.userId } });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    const memberships = await prisma.membership.findMany({ where: { userId: me.userId } });
    expect(memberships.every((m) => m.isActive === false)).toBe(true);
  });

  it('refuses self-delete when the user is the last admin of an org', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'lastadmin');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { message?: string; error?: { message?: string } };
    const msg = body.message ?? body.error?.message ?? '';
    expect(String(msg)).toMatch(/last admin/i);

    // User should still be active.
    const after = await prisma.user.findUnique({ where: { id: me.userId } });
    expect(after?.status).toBe('active');
  });
});

describe('cross-tenant audit log gate', () => {
  it('403s for a non-admin user', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'notaligned');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/hq/audit-log?limit=10',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns rows for an ALIGNED super-admin', async () => {
    const app = getApp();
    // Promote the user to isSuperAdmin directly in the DB, then re-login
    // so the new JWT carries the claim.
    const me = await seedOrgAndLogin(app, 'adminaligned');
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    await prisma.user.update({ where: { id: me.userId }, data: { isSuperAdmin: true } });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'adminaligned@example.com', password: 'TestPassword1!' },
    });
    const body = login.json() as { accessToken: string };

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/hq/audit-log?limit=10',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const envelope = res.json() as { data: unknown[] };
    expect(Array.isArray(envelope.data)).toBe(true);
  });
});
