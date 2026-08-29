// Helpers shared across integration tests.
import bcrypt from 'bcryptjs';

import { prisma } from './setup.js';

interface SeededOrg {
  organizationId: string;
  userId: string;
  email: string;
  password: string;
  cookies: { name: string; value: string }[];
}

const PW = 'TestPassword1!';

/**
 * Create an org + admin user, log in, and return the access token + cookies.
 * Used by tests that need an authenticated request.
 */
export async function seedOrgAndLogin(
  app: import('fastify').FastifyInstance,
  slug: string,
): Promise<{ accessToken: string; refreshCookie: string; orgId: string; userId: string }> {
  const passwordHash = await bcrypt.hash(PW, 4);
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
  const org = await prisma.organization.create({ data: { slug, name: slug } });
  const user = await prisma.user.create({
    data: {
      email: `${slug}@example.com`,
      passwordHash,
      firstName: slug,
      lastName: 'Admin',
      status: 'active',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.membership.create({
    data: { organizationId: org.id, userId: user.id, role: 'admin' },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: `${slug}@example.com`, password: PW },
  });
  const body = res.json() as { accessToken: string };
  const setCookie = res.headers['set-cookie'];
  const refreshCookie = Array.isArray(setCookie)
    ? setCookie.find((c) => c.startsWith('aligned_refresh=')) ?? ''
    : (setCookie ?? '');
  return { accessToken: body.accessToken, refreshCookie, orgId: org.id, userId: user.id };
}

export const TEST_PASSWORD = PW;
