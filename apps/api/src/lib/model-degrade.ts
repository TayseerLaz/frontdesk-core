// WS6b — silent-degrade alerting.
//
// When a `max`/`ultra` tenant's reply falls back to the basic stack (Anthropic
// key missing, rate-limited, or a provider error), the reply STILL goes out
// (fail-open, per the engine doctrine) — but the tenant is quietly running on a
// weaker model and nobody knows. This surfaces it: once per tenant per day,
// notify every ALIGNED admin. Entirely fire-and-forget — any error in here must
// never touch or slow the reply path.

import { prisma } from './db.js';
import { createNotification } from './notifications.js';
import { getRedis } from './redis.js';

function dayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC) — dedupe bucket
}

/**
 * Alert ALIGNED admins that `orgId` (on the `plan` tier) degraded to `actualModel`.
 * Deduped to one alert per tenant per day via Redis SET NX. Best-effort.
 */
export async function reportModelDegrade(
  orgId: string,
  plan: string,
  actualModel: string,
): Promise<void> {
  try {
    const redis = getRedis();
    const flag = `degrade:${orgId}:${dayKey()}`;
    const claimed = await redis.set(flag, '1', 'EX', 60 * 60 * 24, 'NX');
    if (claimed !== 'OK') return; // already alerted for this tenant today

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true, slug: true },
    });
    const tenant = org?.name ?? org?.slug ?? 'A tenant';

    const admins = await prisma.user.findMany({
      where: { isSuperAdmin: true },
      select: { id: true, memberships: { select: { organizationId: true }, take: 1 } },
    });
    for (const a of admins) {
      const adminOrg = a.memberships[0]?.organizationId;
      if (!adminOrg) continue;
      await createNotification({
        organizationId: adminOrg,
        targetUserId: a.id,
        kind: 'generic',
        severity: 'warning',
        title: `${tenant}: AI running on a fallback model`,
        body: `${tenant} is on the "${plan}" AI plan, but at least one reply today fell back to the basic model (${actualModel}) — usually a missing or rate-limited Anthropic key. Replies still went out, but at degraded quality. Check ANTHROPIC_API_KEY / provider status.`,
        link: '/hq',
      });
    }
  } catch {
    // Fire-and-forget: alerting must never break or slow a bot reply.
  }
}
