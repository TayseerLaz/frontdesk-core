import { prisma } from '@platform/db';
import type { Prisma, PrismaClient } from '@platform/db';

import { captureError } from './sentry.js';

export { prisma };

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// Sprint 3 #25 — Postgres surfaces RLS-blocked queries as `permission denied`
// (SQLSTATE 42501) or, for a missing policy, as `new row violates row-level
// security policy` (42710). Either way these should be RARE in production —
// they mean the application layer thought it was authorised to touch a row
// but RLS disagreed. That's a sign of a regression in tenant scoping. Tag
// the Sentry event so on-call can grep for "rls-violation" in alerts.
function reportPostgresRlsViolation(error: unknown, ctx: { kind: 'tenant' | 'bypass'; organizationId?: string }) {
  const message = String((error as { message?: string } | null)?.message ?? error);
  const code = String((error as { code?: string } | null)?.code ?? '');
  const isRlsLike =
    code === '42501' ||
    code === '42710' ||
    /permission denied for/i.test(message) ||
    /violates row-level security/i.test(message);
  if (!isRlsLike) return;
  captureError(error, {
    tag: 'rls-violation',
    pgCode: code,
    kind: ctx.kind,
    organizationId: ctx.organizationId ?? null,
  });
}

/**
 * Run callback inside a transaction with `app.current_org_id` set.
 * Switches to the non-superuser `app_user` role so RLS policies actually
 * filter — superusers bypass RLS unconditionally.
 */
export async function withTenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, organizationId);
      return fn(tx as Tx);
    });
  } catch (err) {
    reportPostgresRlsViolation(err, { kind: 'tenant', organizationId });
    throw err;
  }
}

/**
 * Bypass RLS — for ALIGNED super-admin cross-tenant ops and auth bootstrap.
 * Caller MUST gate access with requireSuperAdmin or be in the auth path.
 */
export async function withRlsBypass<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      return fn(tx as Tx);
    });
  } catch (err) {
    reportPostgresRlsViolation(err, { kind: 'bypass' });
    throw err;
  }
}

export type { Prisma };
