// Phase 5.9 — Dunning auto-suspend.
//
// Runs once an hour. Finds orgs whose subscription has been `past_due` for
// longer than the grace window (default 7 days) and suspends the org so its
// users can no longer log in. Recovery: a successful payment fires the
// existing `invoice.payment_succeeded` webhook which flips the subscription
// back to `active`; a separate manual reactivation through the admin panel
// is required for `organization.status` to flip back.
import { prisma, withRlsBypass } from './db.js';
import { getConnection } from '../lib/redis.js';

const TICK_INTERVAL_MS = Number(process.env.DUNNING_TICK_INTERVAL_MS ?? 60 * 60 * 1000); // 1h
const GRACE_DAYS = Number(process.env.DUNNING_GRACE_DAYS ?? 7);
const LOCK_KEY = 'lock:dunning-tick';
const LOCK_TTL_S = Math.ceil(TICK_INTERVAL_MS / 1000) + 30;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

async function tick(): Promise<void> {
  const redis = getConnection();
  const lock = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_S, 'NX');
  if (lock !== 'OK') return;

  const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
  // Subscriptions stuck in past_due whose last status change was before the
  // cutoff. We use updatedAt as a proxy for "when they entered past_due"
  // since the billing webhook flips the column on every status change.
  const overdue = await withRlsBypass((tx) =>
    tx.subscription.findMany({
      where: { status: 'past_due', updatedAt: { lt: cutoff } },
      select: { organizationId: true },
      take: 200,
    }),
  );
  if (overdue.length === 0) return;

  for (const row of overdue) {
    try {
      await withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({
          where: { id: row.organizationId },
          select: { id: true, status: true, name: true },
        });
        if (!org || org.status !== 'active') return;
        await tx.organization.update({
          where: { id: org.id },
          data: { status: 'suspended' },
        });
        await tx.auditLog.create({
          data: {
            organizationId: org.id,
            action: 'org_suspended',
            entityType: 'organization',
            entityId: org.id,
            metadata: { reason: 'dunning_auto_suspend', graceDays: GRACE_DAYS } as never,
          },
        });
        // Notify the org's admins (in-app bell). Email side is up to the
        // billing-dunning workflow on Stripe; we're the platform side here.
        const admins = await tx.membership.findMany({
          where: { organizationId: org.id, role: 'admin', isActive: true },
          select: { userId: true },
        });
        if (admins.length > 0) {
          await tx.notification.createMany({
            data: admins.map((m) => ({
              organizationId: org.id,
              userId: m.userId,
              kind: 'org_suspended_for_billing',
              severity: 'error',
              title: 'Account suspended',
              body: `Your subscription has been past-due for over ${GRACE_DAYS} days. Update your payment method to restore access.`,
            })),
          });
        }
      });
      console.log(`[dunning] suspended org ${row.organizationId}`);
    } catch (err) {
      console.error('[dunning] suspend failed', row.organizationId, err);
    }
  }
}

export function startDunningTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[dunning] tick error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // Initial run 60s after boot — give other workers a moment.
  timer = setTimeout(run, 60_000);
  return {
    name: 'dunning-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
