// Idempotent dev seed: one demo org + admin user.
// Login: admin@aligned.local / Aligned123!
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_ORG_SLUG = 'demo';
const DEMO_USER_EMAIL = 'admin@aligned.local';
const DEMO_USER_PASSWORD = 'Aligned123!';

async function main() {
  console.warn('[seed] Starting…');

  // Bypass RLS for seeding (we're acting as an admin).
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

  const passwordHash = await bcrypt.hash(DEMO_USER_PASSWORD, 12);

  const org = await prisma.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    update: {},
    create: { slug: DEMO_ORG_SLUG, name: 'Demo Organization' },
  });

  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: { passwordHash, emailVerifiedAt: new Date(), status: 'active' },
    create: {
      email: DEMO_USER_EMAIL,
      passwordHash,
      firstName: 'Demo',
      lastName: 'Admin',
      status: 'active',
      emailVerifiedAt: new Date(),
      isSuperAdmin: true,
    },
  });

  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: { role: 'admin', isActive: true },
    create: { organizationId: org.id, userId: user.id, role: 'admin' },
  });

  console.warn(`[seed] Org:  ${org.slug} (${org.id})`);
  console.warn(`[seed] User: ${user.email} / ${DEMO_USER_PASSWORD}`);
  console.warn('[seed] Done.');
}

main()
  .catch((err) => {
    console.error('[seed] failed', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
