// Admin resets another member's password (temporary-password flow): the member
// gets a new password, all their sessions are revoked, the old password stops
// working and the new one works. Plus the guardrails: can't reset yourself, a
// protected account, or a member in another org.
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

async function makeMember(
  orgId: string,
  email: string,
  password: string,
  opts: { protected?: boolean } = {},
) {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, 4),
      firstName: 'Mem',
      lastName: 'Ber',
      status: 'active',
      emailVerifiedAt: new Date(),
    },
  });
  const membership = await prisma.membership.create({
    data: { organizationId: orgId, userId: user.id, role: 'editor', isProtected: opts.protected ?? false },
  });
  return { user, membership };
}

describe('admin reset member password', () => {
  it('sets a temp password, revokes sessions, old creds fail + new work', async () => {
    const app = getApp();
    const admin = await seedOrgAndLogin(app, 'mrp-admin');
    const auth = { authorization: `Bearer ${admin.accessToken}` };
    const { user, membership } = await makeMember(admin.orgId, 'mrp-member@example.com', 'MemberPass1!');

    // Member signs in — creates a session.
    const login1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'mrp-member@example.com', password: 'MemberPass1!' },
    });
    expect(login1.statusCode).toBe(200);

    // Admin resets it.
    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/members/${membership.id}/reset-password`,
      headers: auth,
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    const data = (reset.json() as { data: { temporaryPassword: string | null; email: string } }).data;
    expect(data.email).toBe('mrp-member@example.com');
    expect(typeof data.temporaryPassword).toBe('string');
    expect((data.temporaryPassword ?? '').length).toBeGreaterThanOrEqual(12);

    // Old password rejected, new one accepted.
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'mrp-member@example.com', password: 'MemberPass1!' },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'mrp-member@example.com', password: data.temporaryPassword },
    });
    expect(newLogin.statusCode).toBe(200);

    // The pre-reset session was revoked (only the fresh newLogin session is active).
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const active = await prisma.session.count({ where: { userId: user.id, revokedAt: null } });
    expect(active).toBe(1);
  });

  it('accepts an admin-supplied password (and does not echo it back)', async () => {
    const app = getApp();
    const admin = await seedOrgAndLogin(app, 'mrp-supplied');
    const auth = { authorization: `Bearer ${admin.accessToken}` };
    const { membership } = await makeMember(admin.orgId, 'mrp-supplied-m@example.com', 'MemberPass1!');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/members/${membership.id}/reset-password`,
      headers: auth,
      payload: { password: 'BrandNewPass9X' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { temporaryPassword: string | null } }).data.temporaryPassword).toBeNull();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'mrp-supplied-m@example.com', password: 'BrandNewPass9X' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects resetting your own password (use settings)', async () => {
    const app = getApp();
    const admin = await seedOrgAndLogin(app, 'mrp-self');
    const auth = { authorization: `Bearer ${admin.accessToken}` };
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const own = await prisma.membership.findFirst({
      where: { userId: admin.userId, organizationId: admin.orgId },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/members/${own!.id}/reset-password`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects resetting a protected account', async () => {
    const app = getApp();
    const admin = await seedOrgAndLogin(app, 'mrp-prot');
    const auth = { authorization: `Bearer ${admin.accessToken}` };
    const { membership } = await makeMember(admin.orgId, 'mrp-prot-m@example.com', 'MemberPass1!', {
      protected: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/members/${membership.id}/reset-password`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('cannot reset a member of another org (tenant-scoped)', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'mrp-orga');
    const b = await seedOrgAndLogin(app, 'mrp-orgb');
    const { membership } = await makeMember(b.orgId, 'mrp-orgb-m@example.com', 'MemberPass1!');
    // Org A admin tries to reset a member of org B → not found (RLS-scoped).
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/members/${membership.id}/reset-password`,
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
