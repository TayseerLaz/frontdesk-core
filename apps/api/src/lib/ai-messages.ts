// Per-tenant MONTHLY AI-MESSAGE allowance — the tenant-facing usage limit.
//
// One "AI message" = one bot reply (chat) or one bot turn (voice). The admin
// assigns each org a monthly allowance (Organization.monthlyAiMessageCap; null =
// unlimited; column default 2000). When the month's count reaches the cap the
// bot pauses (callers/chatters are left for a human) until the 1st of next
// month. Tenants only ever see MESSAGES — tokens/USD stay admin-only (cost).
//
// Counter: Redis `aimsgs:{orgId}:{YYYY-MM}` (UTC month, ~35-day TTL). Threshold
// alerts at 80% + 100% fire once per month each (Redis NX flags) to BOTH the
// tenant (org-wide) and every super-admin.

import { isOrgUnlimited } from './billing.js';
import { prisma } from './db.js';
import { createNotification } from './notifications.js';
import { getRedis } from './redis.js';

export const MONTHLY_AI_MESSAGE_DEFAULT = Number(
  process.env.DEFAULT_MONTHLY_AI_MESSAGES ?? 2000,
);

function monthKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
}

function usageKey(orgId: string): string {
  return `aimsgs:${orgId}:${monthKey()}`;
}

export interface AiMessageCap {
  cap: number | null; // null = unlimited
  unlimited: boolean;
}

/** Resolve an org's effective monthly AI-message cap. */
export async function resolveMonthlyAiCap(orgId: string): Promise<AiMessageCap> {
  if (await isOrgUnlimited(orgId)) return { cap: null, unlimited: true };
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { monthlyAiMessageCap: true },
  });
  // null column = admin opted this org out of metering (unlimited).
  const cap = org?.monthlyAiMessageCap ?? null;
  return { cap, unlimited: cap === null };
}

export interface AiMessageUsage {
  used: number;
  cap: number | null;
  unlimited: boolean;
  percentUsed: number; // 0..100; 0 when unlimited
}

/** Read this month's AI-message usage for an org (never throws). */
export async function readAiMessageUsage(orgId: string): Promise<AiMessageUsage> {
  try {
    const { cap, unlimited } = await resolveMonthlyAiCap(orgId);
    const raw = await getRedis().get(usageKey(orgId));
    const used = raw ? Number(raw) : 0;
    const percentUsed =
      unlimited || !cap ? 0 : Math.min(100, Math.round((used / cap) * 100));
    return { used, cap, unlimited, percentUsed };
  } catch {
    return { used: 0, cap: null, unlimited: true, percentUsed: 0 };
  }
}

/**
 * Gate: may this org still send a bot reply this month? Unlimited orgs always
 * can. Never throws (fails open so a Redis blip can't silence the bot).
 */
export async function canSendAiMessage(orgId: string): Promise<boolean> {
  try {
    const { cap, unlimited } = await resolveMonthlyAiCap(orgId);
    if (unlimited || cap === null) return true;
    const raw = await getRedis().get(usageKey(orgId));
    const used = raw ? Number(raw) : 0;
    return used < cap;
  } catch {
    return true;
  }
}

/**
 * Count `n` AI messages against this month's allowance and fire 80%/100% alerts
 * on first crossing. Call AFTER a bot reply/turn is actually produced. Never
 * throws.
 */
export async function recordAiMessages(orgId: string, n = 1): Promise<void> {
  if (n <= 0) return;
  try {
    const redis = getRedis();
    const key = usageKey(orgId);
    const used = await redis.incrby(key, n);
    if (used === n) await redis.expire(key, 60 * 60 * 24 * 35); // first write this month
    void maybeNotifyAiThreshold(orgId, used).catch(() => {});
  } catch {
    /* best-effort */
  }
}

async function maybeNotifyAiThreshold(orgId: string, used: number): Promise<void> {
  const { cap, unlimited } = await resolveMonthlyAiCap(orgId);
  if (unlimited || !cap) return;
  const pct = (used / cap) * 100;
  const threshold: 80 | 100 | null = pct >= 100 ? 100 : pct >= 80 ? 80 : null;
  if (!threshold) return;
  const redis = getRedis();
  const flag = `aimsgs:${orgId}:${monthKey()}:notified${threshold}`;
  const claimed = await redis.set(flag, '1', 'EX', 60 * 60 * 24 * 35, 'NX');
  if (claimed !== 'OK') return; // already alerted for this threshold this month

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true, slug: true },
  });
  const tenantName = org?.name ?? org?.slug ?? 'A tenant';
  const remaining = Math.max(0, cap - used);

  if (threshold === 100) {
    // Tenant: bot paused.
    await createNotification({
      organizationId: orgId,
      kind: 'quota_warning',
      severity: 'error',
      title: 'AI replies paused — monthly allowance used up',
      body: `Your bot has used all ${cap.toLocaleString()} AI messages for this month, so automatic replies are paused. Reply manually from the Inbox; the allowance resets on the 1st. Contact support to raise it.`,
      link: '/dashboard',
    });
    // super-admins.
    await notifySuperAdmins({
      severity: 'error',
      title: `${tenantName}: monthly AI messages exhausted`,
      body: `${tenantName} has used all ${cap.toLocaleString()} of this month's AI messages — its bot is now paused until the 1st (or you raise the cap).`,
    });
  } else {
    await createNotification({
      organizationId: orgId,
      kind: 'quota_warning',
      severity: 'warning',
      title: 'AI messages running low (80% used)',
      body: `Your bot has used 80% of this month's ${cap.toLocaleString()} AI messages (${remaining.toLocaleString()} left). At 100%, automatic replies pause until the 1st.`,
      link: '/dashboard',
    });
    await notifySuperAdmins({
      severity: 'warning',
      title: `${tenantName}: AI messages at 80%`,
      body: `${tenantName} has used 80% of this month's ${cap.toLocaleString()} AI messages (${remaining.toLocaleString()} left). Raise the cap from the org page if needed.`,
    });
  }
}

/** Notify every super-admin (targeted, in their primary org). */
async function notifySuperAdmins(args: {
  severity: 'warning' | 'error';
  title: string;
  body: string;
}): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { isSuperAdmin: true },
    select: { id: true, memberships: { select: { organizationId: true }, take: 1 } },
  });
  for (const a of admins) {
    const orgId = a.memberships[0]?.organizationId;
    if (!orgId) continue;
    await createNotification({
      organizationId: orgId,
      targetUserId: a.id,
      kind: 'quota_warning',
      severity: args.severity,
      title: args.title,
      body: args.body,
      link: '/hq',
    });
  }
}
