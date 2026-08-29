// Worker-side Prisma client + tenant helper. Mirrors apps/api/src/lib/db.ts so
// that RLS is enforced for any queries done on behalf of a specific tenant.
import { withSecretCrypto } from '@platform/db';
import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __workerPrisma: PrismaClient | undefined;
}

// withSecretCrypto is inert unless SECRET_ENCRYPTION_KEY is set; mirrors the
// api client so the worker also decrypts whatsapp_channels secrets at read.
export const prisma: PrismaClient =
  globalThis.__workerPrisma ??
  (globalThis.__workerPrisma = withSecretCrypto(
    new PrismaClient({ log: ['warn', 'error'] }),
  ));

export async function withTenant<T>(organizationId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // H-1 — switch to the non-superuser `app_user` role so RLS policies
    // actually filter. The worker's Prisma connects as the superuser (which
    // bypasses RLS unconditionally), so WITHOUT this, withTenant provided NO
    // database backstop and was behaviourally identical to withRlsBypass — every
    // background query relied solely on a hand-written `where: { organizationId }`.
    // Mirrors apps/api/src/lib/db.ts. (app_user has blanket DML grants; the
    // superuser can SET ROLE to it.)
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, organizationId);
    return fn(tx as unknown as PrismaClient);
  });
}

export async function withRlsBypass<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // H-1 — also run under app_user; the tenant_isolation policies carry an
    // `OR rls_bypassed()` escape, so bypass works via the flag rather than via
    // superuser (which would silently mask a missing org filter on any table).
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx as unknown as PrismaClient);
  });
}
