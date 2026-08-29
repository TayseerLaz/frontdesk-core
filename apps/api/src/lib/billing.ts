// Phase 3 §5.1.3 — billing helpers.
//
// - getStripe()                lazy singleton; throws if STRIPE_SECRET_KEY unset
// - isStripeConfigured()       cheap check for routes that should 503 cleanly
// - resolveOrgPlan(tx, orgId)  current Plan (or Free fallback) for cap checks
// - capCheck(tx, orgId, kind)  throws RATE_LIMITED if a hard cap is breached
//
// Cap policy: writes that would push usage above the plan's monthly cap
// are blocked with 402-ish RATE_LIMITED + a message naming the cap. The
// cap is checked against `usage_monthly` (read in O(1)). The write path
// also increments `usage_events` so the daily roll-up stays correct.
import { ApiErrorCode } from '@platform/shared';
import Stripe from 'stripe';

import { env } from './env.js';
import { badRequest } from './errors.js';

let _stripe: Stripe | null = null;
export function isStripeConfigured(): boolean {
  return !!env.STRIPE_SECRET_KEY;
}
export function getStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw badRequest(
      ApiErrorCode.SERVICE_UNAVAILABLE,
      'Stripe is not configured on this deployment.',
    );
  }
  if (_stripe) return _stripe;
  _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' as never });
  return _stripe;
}

export function currentYearMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

// super-admins operate internal / demo orgs and shouldn't be throttled.
// Result is cached 5 minutes in Redis per-org so the hot write path
// (capCheck on every product create etc.) doesn't hit Postgres every call.
// Invalidate by deleting `plan:unlimited:<orgId>` if you flip a user's
// isSuperAdmin flag and want it to take effect immediately.
export async function isOrgUnlimited(orgId: string): Promise<boolean> {
  const { getRedis } = await import('./redis.js');
  const redis = getRedis();
  const cacheKey = `plan:unlimited:${orgId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached === '1') return true;
  if (cached === '0') return false;
  const { prisma } = await import('./db.js');
  const adminMember = await prisma.membership.findFirst({
    where: {
      organizationId: orgId,
      isActive: true,
      user: { isSuperAdmin: true },
    },
    select: { id: true },
  });
  const unlimited = !!adminMember;
  await redis.set(cacheKey, unlimited ? '1' : '0', 'EX', 300).catch(() => {});
  return unlimited;
}

// All cap kinds the cap-check middleware understands. Note these are
// PER-MONTH or POINT-IN-TIME depending on the metric. Caps named
// `monthly_*` are reset at month boundary; the rest are absolute.
export type CapKind =
  | 'product'
  | 'service'
  | 'member'
  | 'monthly_message'
  | 'monthly_broadcast'
  | 'monthly_import'
  | 'api_key'
  | 'webhook';

interface MinimalTx {
  subscription: { findUnique: (args: { where: { organizationId: string } }) => Promise<{ planId: string; status: string; trialEndsAt: Date | null } | null> };
  plan: { findUnique: (args: { where: { id: string } }) => Promise<unknown | null>; findFirst: (args: { where: { code: string } }) => Promise<unknown | null> };
  product: { count: (args?: unknown) => Promise<number> };
  service: { count: (args?: unknown) => Promise<number> };
  membership: { count: (args?: unknown) => Promise<number> };
  apiKey: { count: (args?: unknown) => Promise<number> };
  webhookEndpoint: { count: (args?: unknown) => Promise<number> };
  usageMonthly: {
    findFirst: (args: { where: { organizationId: string; yearMonth: string; kind: string } }) => Promise<{ count: number } | null>;
  };
}

interface PlanRow {
  id: string;
  code: string;
  productCap: number | null;
  serviceCap: number | null;
  memberCap: number | null;
  monthlyMessageCap: number | null;
  monthlyBroadcastCap: number | null;
  monthlyImportCap: number | null;
  apiKeyCap: number | null;
  webhookCap: number | null;
}

export async function resolveOrgPlan(tx: MinimalTx, orgId: string): Promise<PlanRow> {
  const sub = await tx.subscription.findUnique({ where: { organizationId: orgId } });
  if (sub) {
    const plan = (await tx.plan.findUnique({ where: { id: sub.planId } })) as PlanRow | null;
    if (plan) return plan;
  }
  const free = (await tx.plan.findFirst({ where: { code: 'free' } })) as PlanRow | null;
  if (free) return free;
  // Last-ditch: synthesise an unlimited "no plan" so an unconfigured deploy
  // doesn't accidentally lock writes.
  return {
    id: 'no-plan',
    code: 'no-plan',
    productCap: null,
    serviceCap: null,
    memberCap: null,
    monthlyMessageCap: null,
    monthlyBroadcastCap: null,
    monthlyImportCap: null,
    apiKeyCap: null,
    webhookCap: null,
  };
}

export async function capCheck(
  tx: MinimalTx,
  orgId: string,
  kind: CapKind,
  opts: { actorIsSuperAdmin?: boolean } = {},
): Promise<void> {
  // Fast path: the JWT already tells us the caller is an super-admin.
  // Skip the cap unconditionally — admin actions are unmetered.
  if (opts.actorIsSuperAdmin) return;
  // Slow path: any active org member who is an super-admin also
  // qualifies the whole org for unlimited (covers worker / webhook
  // paths that don't have a request actor).
  if (await isOrgUnlimited(orgId)) return;
  const plan = await resolveOrgPlan(tx, orgId);
  const cap =
    kind === 'product' ? plan.productCap
    : kind === 'service' ? plan.serviceCap
    : kind === 'member' ? plan.memberCap
    : kind === 'monthly_message' ? plan.monthlyMessageCap
    : kind === 'monthly_broadcast' ? plan.monthlyBroadcastCap
    : kind === 'monthly_import' ? plan.monthlyImportCap
    : kind === 'api_key' ? plan.apiKeyCap
    : plan.webhookCap;

  if (cap == null) return; // unlimited

  let current = 0;
  // products and must not consume their plan's product allowance.
  if (kind === 'product') current = await tx.product.count({ where: { deletedAt: null } });
  else if (kind === 'service') current = await tx.service.count({ where: { deletedAt: null } });
  else if (kind === 'member') current = await tx.membership.count({ where: { isActive: true } });
  else if (kind === 'api_key') current = await tx.apiKey.count({ where: { revokedAt: null } });
  else if (kind === 'webhook') current = await tx.webhookEndpoint.count();
  else {
    // monthly_message / monthly_broadcast / monthly_import — rolling counter.
    const ym = currentYearMonth();
    const eventKind =
      kind === 'monthly_message' ? 'message_outbound'
      : kind === 'monthly_broadcast' ? 'broadcast_started'
      : 'import_started';
    const row = await tx.usageMonthly.findFirst({
      where: { organizationId: orgId, yearMonth: ym, kind: eventKind },
    });
    current = row?.count ?? 0;
  }

  if (current >= cap) {
    // Human-readable, area-specific so the UI never shows a vague error — the
    // operator sees exactly which plan limit they hit.
    const AREA: Record<CapKind, string> = {
      product: 'product',
      service: 'service',
      member: 'team-member',
      monthly_message: 'monthly message',
      monthly_broadcast: 'monthly broadcast',
      monthly_import: 'monthly import',
      api_key: 'API-key',
      webhook: 'webhook',
    };
    const area = AREA[kind] ?? kind;
    throw badRequest(
      ApiErrorCode.RATE_LIMITED,
      `Plan limit reached — you've used all ${cap} of your ${area} allowance (${current}/${cap}). Upgrade your plan to continue.`,
    );
  }
}

// Fire-and-forget: increment the rolling usage counter. Called from write
// paths after the write succeeds.
export async function bumpUsage(
  prisma: {
    usageEvent: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
    usageMonthly: { upsert: (args: { where: { organizationId_yearMonth_kind: { organizationId: string; yearMonth: string; kind: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown> };
  },
  orgId: string,
  kind: string,
  count = 1,
): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: { organizationId: orgId, kind, count },
    });
    const updated = (await prisma.usageMonthly.upsert({
      where: {
        organizationId_yearMonth_kind: {
          organizationId: orgId,
          yearMonth: currentYearMonth(),
          kind,
        },
      },
      create: { organizationId: orgId, yearMonth: currentYearMonth(), kind, count },
      update: { count: { increment: count } as never },
    })) as { count?: number };
    // Fire a one-per-crossing quota warning to the tenant when a monthly cap
    // is approached/hit (75/80/85/90/95/100%). Fire-and-forget.
    if (typeof updated?.count === 'number') {
      void maybeFireQuotaNotice(orgId, kind, updated.count);
    }
  } catch (err) {
    console.error('[billing] bumpUsage failed', err);
  }
}

// ---- Quota visibility + threshold notices ---------------------------------

// Notify the tenant once as usage crosses each of these % marks of a cap.
export const QUOTA_THRESHOLDS = [75, 80, 85, 90, 95, 100];

const MONTHLY_KIND_TO_CAP: Record<
  string,
  { capField: 'monthlyMessageCap' | 'monthlyBroadcastCap' | 'monthlyImportCap'; label: string }
> = {
  message_outbound: { capField: 'monthlyMessageCap', label: 'WhatsApp messages' },
  broadcast_started: { capField: 'monthlyBroadcastCap', label: 'broadcasts' },
  import_started: { capField: 'monthlyImportCap', label: 'imports' },
};

async function maybeFireQuotaNotice(
  orgId: string,
  eventKind: string,
  newCount: number,
): Promise<void> {
  const map = MONTHLY_KIND_TO_CAP[eventKind];
  if (!map) return;
  try {
    if (await isOrgUnlimited(orgId)) return; // operator-owned orgs are unmetered
    const { prisma } = await import('./db.js');
    const plan = await resolveOrgPlan(prisma as unknown as MinimalTx, orgId);
    const cap = plan[map.capField];
    if (cap == null || cap <= 0) return;
    const pct = Math.min(100, Math.floor((newCount / cap) * 100));
    const reached = QUOTA_THRESHOLDS.filter((t) => pct >= t);
    if (reached.length === 0) return;

    const ym = currentYearMonth();
    const row = await prisma.usageMonthly.findUnique({
      where: { organizationId_yearMonth_kind: { organizationId: orgId, yearMonth: ym, kind: eventKind } },
      select: { notifiedThresholds: true },
    });
    const already = new Set<number>(row?.notifiedThresholds ?? []);
    const fresh = reached.filter((t) => !already.has(t));
    if (fresh.length === 0) return;
    const top = Math.max(...fresh);

    const { createNotification } = await import('./notifications.js');
    await createNotification({
      organizationId: orgId,
      kind: 'quota_warning',
      severity: top >= 100 ? 'error' : top >= 90 ? 'warning' : 'info',
      title:
        top >= 100
          ? `Monthly ${map.label} limit reached`
          : `${top}% of your monthly ${map.label} used`,
      body:
        top >= 100
          ? `You've used all ${cap} ${map.label} for this month — new ones are paused until next month or a plan upgrade.`
          : `You've used ${newCount} of ${cap} ${map.label} this month (${pct}%).`,
      link: '/settings/billing',
      metadata: { kind: eventKind, used: newCount, cap, pct, threshold: top },
    });
    await prisma.usageMonthly.update({
      where: { organizationId_yearMonth_kind: { organizationId: orgId, yearMonth: ym, kind: eventKind } },
      data: { notifiedThresholds: { set: Array.from(already).concat(fresh) } },
    });
  } catch (err) {
    console.error('[billing] quota notice failed', err);
  }
}

export interface QuotaItem {
  key: string;
  label: string;
  monthly: boolean;
  used: number;
  cap: number | null; // null = unlimited
  pct: number | null; // null when unlimited
}

// Per-kind usage + caps + percentage for an org. Used by the tenant Plan page
// (percentage only) and the super-admin views (percentage + cost). null caps
// render as "unlimited" with no bar.
export async function getOrgQuotas(
  tx: MinimalTx,
  orgId: string,
): Promise<{ planCode: string; quotas: QuotaItem[] }> {
  const plan = await resolveOrgPlan(tx, orgId);
  const ym = currentYearMonth();
  // IMPORTANT: every count filters by organizationId explicitly. This runs
  // under RLS-bypass from the admin path, so without the filter the counts
  // would span the WHOLE platform, not this tenant.
  const [products, services, members, apiKeys, webhooks, msgs, broadcasts, imports] =
    await Promise.all([
      tx.product.count({ where: { organizationId: orgId, deletedAt: null } }),
      tx.service.count({ where: { organizationId: orgId, deletedAt: null } }),
      tx.membership.count({ where: { organizationId: orgId, isActive: true } }),
      tx.apiKey.count({ where: { organizationId: orgId, revokedAt: null } }),
      tx.webhookEndpoint.count({ where: { organizationId: orgId } }),
      tx.usageMonthly
        .findFirst({ where: { organizationId: orgId, yearMonth: ym, kind: 'message_outbound' } })
        .then((r) => r?.count ?? 0),
      tx.usageMonthly
        .findFirst({ where: { organizationId: orgId, yearMonth: ym, kind: 'broadcast_started' } })
        .then((r) => r?.count ?? 0),
      tx.usageMonthly
        .findFirst({ where: { organizationId: orgId, yearMonth: ym, kind: 'import_started' } })
        .then((r) => r?.count ?? 0),
    ]);
  const pctOf = (used: number, cap: number | null): number | null =>
    cap == null || cap <= 0 ? null : Math.min(100, Math.round((used / cap) * 100));
  const quotas: QuotaItem[] = [
    { key: 'monthly_messages', label: 'Messages (this month)', monthly: true, used: msgs, cap: plan.monthlyMessageCap, pct: pctOf(msgs, plan.monthlyMessageCap) },
    { key: 'monthly_broadcasts', label: 'Broadcasts (this month)', monthly: true, used: broadcasts, cap: plan.monthlyBroadcastCap, pct: pctOf(broadcasts, plan.monthlyBroadcastCap) },
    { key: 'monthly_imports', label: 'Imports (this month)', monthly: true, used: imports, cap: plan.monthlyImportCap, pct: pctOf(imports, plan.monthlyImportCap) },
    { key: 'products', label: 'Products', monthly: false, used: products, cap: plan.productCap, pct: pctOf(products, plan.productCap) },
    { key: 'services', label: 'Services', monthly: false, used: services, cap: plan.serviceCap, pct: pctOf(services, plan.serviceCap) },
    { key: 'members', label: 'Members', monthly: false, used: members, cap: plan.memberCap, pct: pctOf(members, plan.memberCap) },
    { key: 'api_keys', label: 'API keys', monthly: false, used: apiKeys, cap: plan.apiKeyCap, pct: pctOf(apiKeys, plan.apiKeyCap) },
    { key: 'webhooks', label: 'Webhooks', monthly: false, used: webhooks, cap: plan.webhookCap, pct: pctOf(webhooks, plan.webhookCap) },
  ];
  return { planCode: plan.code, quotas };
}
