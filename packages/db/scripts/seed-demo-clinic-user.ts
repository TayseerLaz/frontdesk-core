// A normal tenant admin for Aurora Skin Clinic (NOT a super-admin), so the
// portal renders the tenant view — which is the one the demo is about, and the
// only one whose sidebar includes Phone tasks.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const EMAIL = 'calle@hackathon.com';
const PASSWORD = 'CallE-Hackathon-2026!';

async function main() {
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
  const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!org) throw new Error('no org');
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash, emailVerifiedAt: new Date(), status: 'active', isSuperAdmin: false },
    create: {
      email: EMAIL, passwordHash, firstName: 'Elena', lastName: 'Voss',
      status: 'active', emailVerifiedAt: new Date(), isSuperAdmin: false,
    },
  });
  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    update: { role: 'admin', isActive: true },
    create: { organizationId: org.id, userId: user.id, role: 'admin' },
  });
  console.warn(`[clinic-user] ${EMAIL} / ${PASSWORD}  → ${org.name}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
