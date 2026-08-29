// Phase 3 §5.1.3 — Stripe billing routes.
//
// Surfaces:
//   GET    /billing/plans                 (public — pricing page can read)
//   GET    /billing/subscription          (current org's plan + status + caps + usage)
//   POST   /billing/checkout              (creates Stripe Checkout session for a plan)
//   POST   /billing/portal                (Stripe Customer Portal for self-serve)
//   POST   /webhooks/stripe               (signed webhook receiver — public, no JWT)
//   GET    /hq/revenue         (MRR + churn + plan distribution)
//
// Trial flow: every new org gets a 14-day Free trial via the migration's
// backfill. After expiry, the worker's daily roll-up downgrades to "free"
// status (read-only soft cap). When a user upgrades to a paid plan via
// Stripe Checkout, the webhook flips status → "active" and links the IDs.
import {
  ApiErrorCode,
  DEFAULT_PRICE_MICROS,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  uuidSchema,
} from '@platform/shared';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type Stripe from 'stripe';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { currentYearMonth, getStripe, isOrgUnlimited, isStripeConfigured, resolveOrgPlan } from '../../lib/billing.js';
import { prisma, withRlsBypass } from '../../lib/db.js';
import * as wallet from '../../lib/wallet.js';
import { env } from '../../lib/env.js';
import { badRequest, notFound } from '../../lib/errors.js';

const planDto = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  highlights: z.array(z.string()),
  productCap: z.number().int().nullable(),
  serviceCap: z.number().int().nullable(),
  memberCap: z.number().int().nullable(),
  monthlyMessageCap: z.number().int().nullable(),
  monthlyBroadcastCap: z.number().int().nullable(),
  monthlyImportCap: z.number().int().nullable(),
  apiKeyCap: z.number().int().nullable(),
  webhookCap: z.number().int().nullable(),
  priceMonthlyMinor: z.number().int().nullable(),
  priceYearlyMinor: z.number().int().nullable(),
  currency: z.string(),
  sortOrder: z.number().int(),
  hasStripePrice: z.boolean(),
});

const subscriptionDto = z.object({
  id: uuidSchema,
  planCode: z.string(),
  planName: z.string(),
  status: z.string(),
  trialEndsAt: z.string().datetime().nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  caps: z.object({
    productCap: z.number().int().nullable(),
    serviceCap: z.number().int().nullable(),
    memberCap: z.number().int().nullable(),
    monthlyMessageCap: z.number().int().nullable(),
    monthlyBroadcastCap: z.number().int().nullable(),
    monthlyImportCap: z.number().int().nullable(),
    apiKeyCap: z.number().int().nullable(),
    webhookCap: z.number().int().nullable(),
  }),
  usage: z.object({
    products: z.number().int(),
    services: z.number().int(),
    members: z.number().int(),
    apiKeys: z.number().int(),
    webhooks: z.number().int(),
    monthlyMessages: z.number().int(),
    monthlyBroadcasts: z.number().int(),
    monthlyImports: z.number().int(),
  }),
  yearMonth: z.string(),
});

export default async function billingRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /billing/plans ---------------------------------------
  r.get(
    '/billing/plans',
    {
      schema: {
        tags: ['billing'],
        summary: 'List active plans (used by the pricing page).',
        response: { 200: listEnvelopeSchema(planDto) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async () => {
      const plans = await withRlsBypass((tx) =>
        tx.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      );
      return {
        data: plans.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          description: p.description,
          highlights: p.highlights,
          productCap: p.productCap,
          serviceCap: p.serviceCap,
          memberCap: p.memberCap,
          monthlyMessageCap: p.monthlyMessageCap,
          monthlyBroadcastCap: p.monthlyBroadcastCap,
          monthlyImportCap: p.monthlyImportCap,
          apiKeyCap: p.apiKeyCap,
          webhookCap: p.webhookCap,
          priceMonthlyMinor: p.priceMonthlyMinor,
          priceYearlyMinor: p.priceYearlyMinor,
          currency: p.currency,
          sortOrder: p.sortOrder,
          hasStripePrice: !!(p.stripePriceMonthlyId || p.stripePriceYearlyId),
        })),
        nextCursor: null,
      };
    },
  );

  // ---------- GET /billing/subscription --------------------------------
  r.get(
    '/billing/subscription',
    {
      schema: {
        tags: ['billing'],
        summary: 'Current org subscription + caps + month-to-date usage.',
        response: { 200: itemEnvelopeSchema(subscriptionDto) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const sub = await tx.subscription.findUnique({
          where: { organizationId: orgId },
          include: { plan: true },
        });
        if (!sub) {
          throw notFound('No subscription on this organisation. Run the billing migration.');
        }
        const ym = currentYearMonth();
        const [products, services, members, apiKeys, webhooks, msgs, broadcasts, imports] = await Promise.all([
          tx.product.count({ where: { deletedAt: null } }),
          tx.service.count({ where: { deletedAt: null } }),
          tx.membership.count({ where: { isActive: true } }),
          tx.apiKey.count({ where: { revokedAt: null } }),
          tx.webhookEndpoint.count(),
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
        // ALIGNED-admin-operated orgs render as a synthetic "Unlimited
        // (admin)" plan with null caps so the UI knows there's nothing
        // to throttle. The actual subscription row is left intact so
        // demoting the admin later snaps things back.
        //
        // Fast path: the JWT claim (`req.auth.isSuperAdmin`) is already
        // resolved at this point — trust it directly so admins always
        // see the unlimited plan even if the membership-based check
        // misses (different org context, RLS edge case, etc.).
        const unlimited =
          req.auth!.isSuperAdmin || (await isOrgUnlimited(orgId));
        return {
          data: {
            id: sub.id,
            planCode: unlimited ? 'admin' : sub.plan.code,
            planName: unlimited ? 'Unlimited (admin)' : sub.plan.name,
            status: unlimited ? 'active' : sub.status,
            trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
            currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            caps: unlimited
              ? {
                  productCap: null,
                  serviceCap: null,
                  memberCap: null,
                  monthlyMessageCap: null,
                  monthlyBroadcastCap: null,
                  monthlyImportCap: null,
                  apiKeyCap: null,
                  webhookCap: null,
                }
              : {
                  productCap: sub.plan.productCap,
                  serviceCap: sub.plan.serviceCap,
                  memberCap: sub.plan.memberCap,
                  monthlyMessageCap: sub.plan.monthlyMessageCap,
                  monthlyBroadcastCap: sub.plan.monthlyBroadcastCap,
                  monthlyImportCap: sub.plan.monthlyImportCap,
                  apiKeyCap: sub.plan.apiKeyCap,
                  webhookCap: sub.plan.webhookCap,
                },
            usage: {
              products,
              services,
              members,
              apiKeys,
              webhooks,
              monthlyMessages: msgs,
              monthlyBroadcasts: broadcasts,
              monthlyImports: imports,
            },
            yearMonth: ym,
          },
        };
      });
    },
  );

  // ======================================================================
  // Tenant wallet & WhatsApp balance (self-service view of metered billing)
  // ======================================================================

  const tenantWalletDto = z.object({
    metered: z.boolean(),
    availableMicros: z.number(),
    heldMicros: z.number(),
    pricePerMessageMicros: z.number(),
    messagesRemaining: z.number(),
    lowBalanceThresholdMicros: z.number(),
    lifetimeSpentMicros: z.number(),
    lifetimeMessages: z.number(),
    lifetimeToppedUpMicros: z.number(),
    // Balance-depletion alert (drives the red banner on dashboard + this page).
    alert: z.object({
      pctUsed: z.number(),
      level: z.enum(['ok', 'alert', 'empty']),
      message: z.string().nullable(),
    }),
  });

  // ---------- GET /billing/overview ------------------------------------
  // The tenant's own wallet: balance, per-message price, how many messages
  // that buys, and the low-balance line. Never exposes our Meta cost/margin.
  r.get(
    '/billing/overview',
    {
      schema: {
        tags: ['billing'],
        summary: 'Current org WhatsApp balance + per-message price + messages remaining.',
        response: { 200: itemEnvelopeSchema(tenantWalletDto) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const w = await wallet.getWallet(orgId);
      const price = w?.pricePerMessageMicros ?? DEFAULT_PRICE_MICROS;
      const available = w?.availableMicros ?? 0;
      const alert = wallet.walletAlertState(w);
      return {
        data: {
          metered: w?.meteringEnabled ?? false,
          availableMicros: available,
          heldMicros: w?.heldMicros ?? 0,
          pricePerMessageMicros: price,
          messagesRemaining: price > 0 ? Math.floor(available / price) : 0,
          lowBalanceThresholdMicros: w?.lowBalanceThresholdMicros ?? 0,
          lifetimeSpentMicros: w?.lifetimeSpentMicros ?? 0,
          lifetimeMessages: w?.lifetimeMessages ?? 0,
          lifetimeToppedUpMicros: w?.lifetimeToppedUpMicros ?? 0,
          alert: { pctUsed: alert.pctUsed, level: alert.level, message: alert.message },
        },
      };
    },
  );

  // ---------- GET /billing/ledger --------------------------------------
  // The tenant's own wallet history, GROUPED so a broadcast that charged 2,000
  // messages shows as ONE "Messages sent · 2,000 · -$160.00" row, not 2,000
  // rows. Aggregated by (day, kind, broadcast): per-broadcast message charges +
  // refunds roll up to a single line each; top-ups/adjustments stay effectively
  // individual (rarely more than one a day). Holds are hidden (transient).
  r.get(
    '/billing/ledger',
    {
      schema: {
        tags: ['billing'],
        summary: "This org's wallet history, grouped (charges/refunds rolled up).",
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                day: z.string(), // YYYY-MM-DD
                kind: z.string(),
                type: z.string(), // friendly label
                count: z.number().int(),
                amountMicros: z.number(),
                availableAfterMicros: z.number(),
                note: z.string().nullable(),
              }),
            ),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const { limit } = req.query;
      const rows = await prisma.$queryRaw<
        {
          day: Date;
          kind: string;
          cnt: bigint;
          total_micros: bigint;
          available_after: bigint;
          broadcast_name: string | null;
          a_note: string | null;
        }[]
      >`
        SELECT date_trunc('day', wl.created_at) AS day,
               wl.kind,
               count(*) AS cnt,
               sum(wl.amount_micros) AS total_micros,
               (array_agg(wl.available_after_micros ORDER BY wl.created_at DESC))[1] AS available_after,
               max(b.name) AS broadcast_name,
               max(wl.note) AS a_note
          FROM wallet_ledger wl
          LEFT JOIN broadcasts b ON b.id = wl.broadcast_id
         WHERE wl.organization_id = ${orgId}::uuid AND wl.kind <> 'hold'
         GROUP BY date_trunc('day', wl.created_at), wl.kind, wl.broadcast_id
         ORDER BY date_trunc('day', wl.created_at) DESC, max(wl.created_at) DESC
         LIMIT ${limit}`;

      const describe = (
        kind: string,
        count: number,
        name: string | null,
        note: string | null,
      ): { type: string; label: string | null } => {
        const nm = name ? ` · ${name}` : '';
        switch (kind) {
          case 'settle':
            return { type: 'Messages sent', label: `${count.toLocaleString()} message${count === 1 ? '' : 's'}${nm}` };
          case 'release':
            return {
              type: 'Refunds',
              label: `${count.toLocaleString()} failed delivery refunded${nm}`,
            };
          case 'topup':
            return { type: 'Top-up', label: count > 1 ? `${count} top-ups` : note ?? 'Wallet top-up' };
          case 'adjust':
            return { type: 'Adjustment', label: count > 1 ? `${count} adjustments` : note ?? 'Manual adjustment' };
          default:
            return { type: kind, label: note };
        }
      };

      return {
        data: rows.map((r) => {
          const count = Number(r.cnt);
          const d = describe(r.kind, count, r.broadcast_name, r.a_note);
          return {
            day: r.day.toISOString().slice(0, 10),
            kind: r.kind,
            type: d.type,
            count,
            amountMicros: Number(r.total_micros),
            availableAfterMicros: Number(r.available_after),
            note: d.label,
          };
        }),
      };
    },
  );

  // ---------- POST /billing/checkout -----------------------------------
  r.post(
    '/billing/checkout',
    {
      schema: {
        tags: ['billing'],
        summary: 'Start a Stripe Checkout session for a plan upgrade.',
        body: z.object({
          planCode: z.string().min(1),
          interval: z.enum(['monthly', 'yearly']).default('monthly'),
          successUrl: z.string().url().optional(),
          cancelUrl: z.string().url().optional(),
        }),
        response: { 200: itemEnvelopeSchema(z.object({ url: z.string() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!isStripeConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'Stripe is not configured on this deployment.',
        );
      }
      const orgId = req.auth!.organizationId;
      const stripe = getStripe();

      const { plan, sub, orgName, userEmail } = await withRlsBypass(async (tx) => {
        const plan = await tx.plan.findUnique({ where: { code: req.body.planCode } });
        if (!plan) throw notFound('Unknown plan code.');
        const priceId =
          req.body.interval === 'yearly' ? plan.stripePriceYearlyId : plan.stripePriceMonthlyId;
        if (!priceId)
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            `Plan "${plan.code}" has no Stripe ${req.body.interval} price configured.`,
          );
        const sub = await tx.subscription.findUnique({ where: { organizationId: orgId } });
        const org = await tx.organization.findUnique({ where: { id: orgId } });
        const user = await tx.user.findUnique({ where: { id: req.auth!.userId } });
        return { plan, sub, orgName: org?.name ?? 'Aligned', userEmail: user?.email ?? '' };
      });

      // Reuse Stripe customer if we have one, else let Checkout create.
      const successUrl =
        req.body.successUrl ?? `${env.WEB_PUBLIC_URL}/settings/billing?checkout=success`;
      const cancelUrl =
        req.body.cancelUrl ?? `${env.WEB_PUBLIC_URL}/settings/billing?checkout=cancel`;

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [
          {
            price:
              req.body.interval === 'yearly'
                ? (await withRlsBypass((tx) => tx.plan.findUnique({ where: { code: req.body.planCode } })))
                    ?.stripePriceYearlyId ?? ''
                : (await withRlsBypass((tx) => tx.plan.findUnique({ where: { code: req.body.planCode } })))
                    ?.stripePriceMonthlyId ?? '',
            quantity: 1,
          },
        ],
        ...(sub?.stripeCustomerId
          ? { customer: sub.stripeCustomerId }
          : { customer_email: userEmail || undefined }),
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: orgId,
        metadata: { organizationId: orgId, planCode: plan.code, orgName },
        subscription_data: {
          metadata: { organizationId: orgId, planCode: plan.code },
          ...(sub?.trialEndsAt && sub.trialEndsAt > new Date() && sub.status === 'trialing'
            ? { trial_end: Math.floor(sub.trialEndsAt.getTime() / 1000) }
            : {}),
        },
      });

      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'subscription',
        metadata: { event: 'checkout_started', planCode: plan.code, interval: req.body.interval },
      });

      return { data: { url: session.url ?? '' } };
    },
  );

  // ---------- POST /billing/portal -------------------------------------
  // Stripe Customer Portal — self-serve plan changes, invoice history,
  // payment-method management. Returns a one-shot URL valid for ~5 min.
  r.post(
    '/billing/portal',
    {
      schema: {
        tags: ['billing'],
        summary: 'Start a Stripe Customer Portal session.',
        response: { 200: itemEnvelopeSchema(z.object({ url: z.string() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (!isStripeConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'Stripe is not configured on this deployment.',
        );
      }
      const orgId = req.auth!.organizationId;
      const sub = await withRlsBypass((tx) =>
        tx.subscription.findUnique({ where: { organizationId: orgId } }),
      );
      if (!sub?.stripeCustomerId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'No Stripe customer attached yet. Upgrade to a paid plan first.',
        );
      }
      const stripe = getStripe();
      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url:
          env.STRIPE_PORTAL_RETURN_URL ?? `${env.WEB_PUBLIC_URL}/settings/billing`,
      });
      return { data: { url: session.url } };
    },
  );

  // ---------- POST /webhooks/stripe ------------------------------------
  // Public, signature-verified. We handle:
  //   customer.subscription.created/updated → mirror plan + status + period
  //   customer.subscription.deleted         → mark cancelled
  //   invoice.payment_succeeded             → keep status active
  //   invoice.payment_failed                → mark past_due
  r.post(
    '/webhooks/stripe',
    {
      schema: {
        tags: ['billing'],
        summary: 'Stripe webhook receiver (signature-verified).',
      },
      // Public — no preHandler.
      logLevel: 'warn',
      config: {
        // Stripe needs the raw body for signature verification. Disable
        // Fastify's JSON parser for this route.
        rawBody: true,
      },
    },
    async (req, reply) => {
      if (!isStripeConfigured() || !env.STRIPE_WEBHOOK_SECRET) {
        reply.code(503);
        return { error: 'stripe not configured' };
      }
      const sig = req.headers['stripe-signature'];
      if (!sig || Array.isArray(sig)) {
        reply.code(400);
        return { error: 'missing signature' };
      }
      const stripe = getStripe();
      const raw = JSON.stringify(req.body ?? {});
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(raw, sig, env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        req.log.warn({ err }, '[stripe] signature verification failed');
        reply.code(400);
        return { error: 'invalid signature' };
      }

      try {
        await handleStripeEvent(event);
      } catch (err) {
        req.log.error({ err, type: event.type }, '[stripe] handler failed');
        reply.code(500);
        return { error: 'handler error' };
      }
      return { received: true };
    },
  );

  // ---------- GET /hq/revenue --------------------------------
  r.get(
    '/hq/revenue',
    {
      schema: {
        tags: ['admin'],
        summary: 'Revenue dashboard — MRR, plan distribution, churn (last 30 d).',
      },
      preHandler: [app.requireSuperAdmin],
    },
    async () => {
      const subs = await withRlsBypass((tx) =>
        tx.subscription.findMany({ include: { plan: true } }),
      );
      const byStatus: Record<string, number> = {};
      const byPlan: Record<string, { count: number; mrrMinor: number; currency: string }> = {};
      let mrrMinor = 0;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let cancelled30 = 0;
      let active30StartCount = 0;
      for (const s of subs) {
        byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
        const planEntry =
          byPlan[s.plan.code] ?? { count: 0, mrrMinor: 0, currency: s.plan.currency };
        planEntry.count += 1;
        if (s.status === 'active' && s.plan.priceMonthlyMinor) {
          planEntry.mrrMinor += s.plan.priceMonthlyMinor;
          mrrMinor += s.plan.priceMonthlyMinor;
        }
        byPlan[s.plan.code] = planEntry;
        if (s.status === 'cancelled' && s.updatedAt && s.updatedAt > thirtyDaysAgo) cancelled30 += 1;
        if (s.createdAt < thirtyDaysAgo && s.status !== 'cancelled') active30StartCount += 1;
      }
      const churnRate = active30StartCount > 0 ? cancelled30 / active30StartCount : 0;
      return {
        data: {
          tenantsTotal: subs.length,
          mrrMinor,
          mrrCurrency: 'USD',
          byStatus,
          byPlan: Object.entries(byPlan).map(([code, v]) => ({
            planCode: code,
            tenantCount: v.count,
            mrrMinor: v.mrrMinor,
            currency: v.currency,
          })),
          churnLast30d: { cancelled: cancelled30, churnRate: Number(churnRate.toFixed(4)) },
        },
      };
    },
  );

  // ---------- POST /hq/plans/sync-stripe ---------------------
  // Admin-only utility — once Stripe prices are created, paste their IDs
  // into the request and we'll update the plans table.
  r.post(
    '/hq/plans/sync-stripe',
    {
      schema: {
        tags: ['admin'],
        summary: 'Attach Stripe price IDs to plans.',
        body: z.array(
          z.object({
            code: z.string(),
            stripePriceMonthlyId: z.string().nullable().optional(),
            stripePriceYearlyId: z.string().nullable().optional(),
          }),
        ),
        response: { 200: successSchema },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      await withRlsBypass(async (tx) => {
        for (const item of req.body) {
          await tx.plan.updateMany({
            where: { code: item.code },
            data: {
              stripePriceMonthlyId: item.stripePriceMonthlyId ?? undefined,
              stripePriceYearlyId: item.stripePriceYearlyId ?? undefined,
            },
          });
        }
      });
      return { ok: true as const };
    },
  );
}

// ----- Stripe webhook event handler -----
async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const orgId =
        (sub.metadata?.organizationId as string | undefined) ??
        // Older subs may have it on the customer instead.
        (typeof sub.customer === 'string' ? null : (sub.customer as Stripe.Customer).metadata?.organizationId) ??
        null;
      if (!orgId) {
        console.warn('[stripe] subscription event without organizationId', sub.id);
        return;
      }
      const planCode = sub.metadata?.planCode as string | undefined;
      const status =
        sub.status === 'active'
          ? 'active'
          : sub.status === 'trialing'
            ? 'trialing'
            : sub.status === 'past_due'
              ? 'past_due'
              : sub.status === 'canceled' || sub.status === 'unpaid'
                ? 'cancelled'
                : sub.status === 'paused'
                  ? 'paused'
                  : 'free';
      await withRlsBypass(async (tx) => {
        const plan = planCode
          ? await tx.plan.findUnique({ where: { code: planCode } })
          : null;
        await tx.subscription.upsert({
          where: { organizationId: orgId },
          create: {
            organizationId: orgId,
            planId: plan?.id ?? (await tx.plan.findFirstOrThrow({ where: { code: 'free' } })).id,
            status: status as never,
            stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
            stripeSubscriptionId: sub.id,
            currentPeriodEnd: stripeSubPeriodEnd(sub),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          },
          update: {
            ...(plan ? { planId: plan.id } : {}),
            status: status as never,
            stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
            stripeSubscriptionId: sub.id,
            currentPeriodEnd: stripeSubPeriodEnd(sub),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          },
        });
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.organizationId as string | undefined;
      if (!orgId) return;
      await withRlsBypass((tx) =>
        tx.subscription.update({
          where: { organizationId: orgId },
          data: { status: 'cancelled' as never },
        }),
      );
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      const subId = stripeInvoiceSubId(inv);
      if (!subId) return;
      await withRlsBypass((tx) =>
        tx.subscription.updateMany({
          where: { stripeSubscriptionId: subId },
          data: { status: 'past_due' as never },
        }),
      );
      break;
    }
    case 'invoice.payment_succeeded': {
      const inv = event.data.object as Stripe.Invoice;
      const subId = stripeInvoiceSubId(inv);
      if (!subId) return;
      await withRlsBypass((tx) =>
        tx.subscription.updateMany({
          where: { stripeSubscriptionId: subId },
          data: { status: 'active' as never },
        }),
      );
      break;
    }
    default:
      // Ignore everything else — Stripe sends a lot.
      break;
  }
}

// Suppress unused-imports warning when Stripe is mocked in tests.
void crypto;

// Stripe SDK types drift between minor versions. We access these fields
// via runtime property names — they exist in the JSON Stripe sends —
// while bypassing the (overly-strict) TS types.
function stripeSubPeriodEnd(sub: Stripe.Subscription): Date | null {
  const raw = sub as unknown as Record<string, number | undefined>;
  const ts = raw.current_period_end;
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts * 1000);
  return null;
}
function stripeInvoiceSubId(inv: Stripe.Invoice): string | null {
  const raw = inv as unknown as { subscription?: string | { id?: string } };
  if (typeof raw.subscription === 'string') return raw.subscription;
  if (raw.subscription && typeof raw.subscription === 'object' && raw.subscription.id) {
    return raw.subscription.id;
  }
  return null;
}
