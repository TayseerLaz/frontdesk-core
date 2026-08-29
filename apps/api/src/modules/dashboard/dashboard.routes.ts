// Portal dashboard endpoints. The page's per-widget hooks each call a
// dedicated route below so widgets can be polled independently at the
// cadence each one needs (10s for live campaigns, 30-60s for counts).
//
// /dashboard/summary kept for back-compat with the older monolithic
// dashboard query (now used only by a couple of widgets). New widgets
// added since 2026-06 each have their own /dashboard/widgets/* route.
import {
  itemEnvelopeSchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { getRedis } from '../../lib/redis.js';

const CACHE_TTL_SECONDS = 30;
const cacheKey = (orgId: string) => `dashboard:summary:${orgId}`;

const dashboardSummarySchema = z.object({
  counts: z.object({
    products: z.number().int(),
    services: z.number().int(),
    faqs: z.number().int(),
    connectors: z.number().int(),
    apiKeys: z.number().int(),
    webhookEndpoints: z.number().int(),
  }),
  lastSyncAt: z.string().datetime().nullable(),
  connectorStatus: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      status: z.string(),
      lastRunAt: z.string().datetime().nullable(),
      lastSuccessAt: z.string().datetime().nullable(),
      consecutiveFailures: z.number().int(),
    }),
  ),
  recentAudits: z.array(
    z.object({
      id: uuidSchema,
      action: z.string(),
      entityType: z.string().nullable(),
      entityId: uuidSchema.nullable(),
      actorName: z.string().nullable(),
      actorEmail: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  ),
});

export default async function dashboardRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /dashboard/summary --------------------------------------
  r.get(
    '/dashboard/summary',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Counts + last sync + connector status + recent audit entries.',
        response: { 200: itemEnvelopeSchema(dashboardSummarySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const redis = getRedis();

      // Cache-first.
      const cached = await redis.get(cacheKey(orgId)).catch(() => null);
      if (cached) {
        try {
          return { data: JSON.parse(cached) };
        } catch {
          // fall through — refetch.
        }
      }

      const data = await app.tenant(req, async (tx) => {
        const [
          products,
          services,
          faqs,
          connectors,
          apiKeys,
          webhookEndpoints,
          lastSync,
          connectorRows,
          auditRows,
        ] = await Promise.all([
          tx.product.count({ where: { deletedAt: null } }),
          tx.service.count({ where: { deletedAt: null } }),
          tx.fAQ.count({ where: { visibility: 'public' } }),
          tx.apiConnector.count(),
          tx.apiKey.count({ where: { revokedAt: null } }),
          tx.webhookEndpoint.count(),
          tx.syncRun.findFirst({
            where: { finishedAt: { not: null } },
            orderBy: { finishedAt: 'desc' },
            select: { finishedAt: true },
          }),
          tx.apiConnector.findMany({
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
              id: true,
              name: true,
              status: true,
              lastRunAt: true,
              lastSuccessAt: true,
              consecutiveFailures: true,
            },
          }),
          tx.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: {
              actor: { select: { firstName: true, lastName: true, email: true } },
            },
          }),
        ]);

        return {
          counts: {
            products,
            services,
            faqs,
            connectors,
            apiKeys,
            webhookEndpoints,
          },
          lastSyncAt: lastSync?.finishedAt?.toISOString() ?? null,
          connectorStatus: connectorRows.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            lastRunAt: c.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
            consecutiveFailures: c.consecutiveFailures,
          })),
          recentAudits: auditRows.map((a) => {
            const actorName =
              a.actor && (a.actor.firstName || a.actor.lastName)
                ? `${a.actor.firstName ?? ''} ${a.actor.lastName ?? ''}`.trim()
                : null;
            return {
              id: a.id,
              action: a.action,
              entityType: a.entityType,
              entityId: a.entityId,
              actorName,
              actorEmail: a.actor?.email ?? null,
              createdAt: a.createdAt.toISOString(),
            };
          }),
        };
      });

      await redis.setex(cacheKey(orgId), CACHE_TTL_SECONDS, JSON.stringify(data)).catch(() => {});
      return { data };
    },
  );

  // ---------- GET /dashboard/ai-usage -------------------------------------
  // Today's AI token usage for the active org. Powers the small "AI
  // budget remaining" widget on /dashboard. Returns 0% used + unlimited
  // = true for super-admin-operated orgs so the bar reads "Unlimited".
  r.get(
    '/dashboard/ai-usage',
    {
      schema: {
        tags: ['dashboard'],
        summary: "Today's AI token usage for the current org.",
        response: {
          200: itemEnvelopeSchema(
            z.object({
              used: z.number().int().nonnegative(),
              limit: z.number().int().nonnegative(),
              unlimited: z.boolean(),
              percentUsed: z.number().int().min(0).max(100),
              estCostUsd: z.number().nonnegative(),
              // Tenant-facing message quota (used + cap + %). The widget shows
              // ONLY these + percentages — never tokens or money (those are
              // admin-only, on the tenant details page).
              messagesUsed: z.number().int().nonnegative(),
              messageCap: z.number().int().nonnegative().nullable(),
              messagePct: z.number().int().min(0).max(100).nullable(),
              // Every enforced limit the tenant can hit (the things that "stop"
              // when full): plan messages/broadcasts/imports + product/service/
              // member/api-key/webhook caps. Lets the dashboard show ALL limits
              // and warn before any of them is reached.
              quotas: z.array(
                z.object({
                  key: z.string(),
                  label: z.string(),
                  monthly: z.boolean(),
                  used: z.number().int().nonnegative(),
                  cap: z.number().int().nullable(),
                  pct: z.number().int().min(0).max(100).nullable(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const { readDailyTokenUsage } = await import('../../lib/openai.js');
      const { readAiMessageUsage } = await import('../../lib/ai-messages.js');
      // Tenant-facing usage is the MONTHLY AI-MESSAGE allowance (1 message = 1
      // bot reply / voice turn). Tokens/cost stay admin-only — kept in the
      // response shape but never rendered by the tenant widget/banner.
      const { getOrgQuotas } = await import('../../lib/billing.js');
      const tokenData = await readDailyTokenUsage(orgId);
      const ai = await readAiMessageUsage(orgId);
      // Every enforced limit the tenant can hit (plan messages/broadcasts/
      // imports + catalog/member/key caps) so the dashboard shows them all.
      const { quotas } = await app.tenant(req, (tx) => getOrgQuotas(tx as never, orgId));
      const base = {
        used: tokenData.used,
        limit: tokenData.limit,
        estCostUsd: tokenData.estCostUsd,
        unlimited: ai.unlimited,
        percentUsed: ai.percentUsed,
        messagesUsed: ai.used,
        messageCap: ai.cap,
        messagePct: ai.unlimited ? null : ai.percentUsed,
        quotas: quotas.map((q) => ({
          key: q.key,
          label: q.label,
          monthly: q.monthly,
          used: q.used,
          cap: q.cap,
          pct: q.pct,
        })),
      };
      // NOTE: do NOT force-unlimited just because the VIEWER is an super-admin.
      // Whether an org is metered is a property of the ORG (isOrgUnlimited →
      // unlimited only if the org has an active admin member, e.g. HQ),
      // already reflected in `ai.unlimited`. Forcing it on the viewer made every
      // tenant the admin opened (controlling a tenant) read "Unlimited" even
      // though their bot is really capped.
      return { data: base };
    },
  );

  // ============================================================
  //   Per-widget endpoints (one per dashboard widget, real data)
  // ============================================================

  // ---------- GET /dashboard/widgets/kpi ----------------------------------
  // KPI strip — products / services / FAQs / contacts with derived
  // subtext (missing-data counts, weekly-new contacts, etc).
  r.get(
    '/dashboard/widgets/kpi',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Counts + derived subtext for the dashboard KPI strip.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              products: z.object({ total: z.number().int(), incomplete: z.number().int() }),
              services: z.object({ total: z.number().int(), incomplete: z.number().int() }),
              faqs: z.object({ total: z.number().int() }),
              contacts: z.object({ total: z.number().int(), newThisWeek: z.number().int() }),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [
          productsTotal,
          productsIncomplete,
          servicesTotal,
          servicesIncomplete,
          faqsTotal,
          contactsTotal,
          contactsNewThisWeek,
        ] = await Promise.all([
          tx.product.count({ where: { deletedAt: null } }),
          // "Incomplete" = missing a price OR no images.
          tx.product.count({
            where: {
              deletedAt: null,
              OR: [{ priceMinor: null }, { images: { none: {} } }],
            },
          }),
          tx.service.count({ where: { deletedAt: null } }),
          tx.service.count({
            where: { deletedAt: null, OR: [{ description: null }, { basePriceMinor: null }] },
          }),
          tx.fAQ.count({ where: { visibility: 'public' } }),
          tx.contact.count(),
          tx.contact.count({ where: { createdAt: { gte: oneWeekAgo } } }),
        ]);
        return {
          products: { total: productsTotal, incomplete: productsIncomplete },
          services: { total: servicesTotal, incomplete: servicesIncomplete },
          faqs: { total: faqsTotal },
          contacts: { total: contactsTotal, newThisWeek: contactsNewThisWeek },
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/kpi/incomplete-services ---------------
  // Drill-down behind the Services KPI tile's "N missing details" subtext.
  // Uses the exact same rule the KPI count uses (no description AND/OR no
  // base price) so the list length matches the badge, then returns the
  // actual rows — lazily, only when the operator opens the hint — so the
  // dashboard can say *which* services to fix and *what* each one lacks.
  r.get(
    '/dashboard/widgets/kpi/incomplete-services',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Services missing a description and/or base price (KPI drill-down).',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              services: z.array(
                z.object({
                  id: uuidSchema,
                  name: z.string(),
                  missing: z.array(z.enum(['description', 'price'])),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const rows = await tx.service.findMany({
          where: { deletedAt: null, OR: [{ description: null }, { basePriceMinor: null }] },
          select: { id: true, name: true, description: true, basePriceMinor: true },
          orderBy: { name: 'asc' },
          take: 100,
        });
        const services = rows.map((s) => ({
          id: s.id,
          name: s.name,
          missing: [
            ...(s.description == null ? (['description'] as const) : []),
            ...(s.basePriceMinor == null ? (['price'] as const) : []),
          ],
        }));
        return { services };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/inbox-snapshot ------------------------
  // Open / unassigned / awaiting-reply counts + a rough avg first-response.
  // Avg first-response is approximated as the median over the last 50
  // resolved threads — close enough for an at-a-glance widget without
  // needing a separate aggregation table.
  r.get(
    '/dashboard/widgets/inbox-snapshot',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Live inbox snapshot for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              openThreads: z.number().int(),
              unassigned: z.number().int(),
              awaitingReply: z.number().int(),
              avgFirstResponseSeconds: z.number().int().nullable(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const [openThreads, unassigned] = await Promise.all([
          tx.whatsAppThread.count({ where: { status: 'open' } }),
          tx.whatsAppThread.count({ where: { status: 'open', assignedToUserId: null } }),
        ]);

        // "Awaiting reply" = open threads whose most-recent message is
        // inbound (customer talked last). Hard to express in Prisma
        // count without an N+1, so a single raw query.
        const awaiting = (await tx.$queryRawUnsafe(`
          SELECT COUNT(*)::int AS count FROM whatsapp_threads t
          WHERE t.status = 'open'
            AND t.organization_id = current_setting('app.current_org_id')::uuid
            AND EXISTS (
              SELECT 1 FROM whatsapp_messages m
              WHERE m.thread_id = t.id
                AND m.direction = 'inbound'
                AND m.received_at = (
                  SELECT MAX(received_at) FROM whatsapp_messages m2 WHERE m2.thread_id = t.id
                )
            )
        `)) as { count: number }[];
        const awaitingReply = awaiting[0]?.count ?? 0;

        // First-response time per thread, sampled over the last 50
        // threads with at least one outbound. Median is robust to a
        // single sleepy night-shift skewing the mean.
        const samples = (await tx.$queryRawUnsafe(`
          WITH first_msgs AS (
            SELECT
              t.id AS thread_id,
              (SELECT MIN(m.received_at) FROM whatsapp_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound') AS first_in,
              (SELECT MIN(m.received_at) FROM whatsapp_messages m WHERE m.thread_id = t.id AND m.direction = 'outbound') AS first_out
            FROM whatsapp_threads t
            WHERE t.organization_id = current_setting('app.current_org_id')::uuid
            ORDER BY t.last_message_at DESC
            LIMIT 50
          )
          SELECT EXTRACT(EPOCH FROM (first_out - first_in))::int AS seconds
          FROM first_msgs
          WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
        `)) as { seconds: number }[];
        const sorted = samples.map((s) => s.seconds).sort((a, b) => a - b);
        const avgFirstResponseSeconds = sorted.length === 0
          ? null
          : sorted[Math.floor(sorted.length / 2)] ?? null;

        return { openThreads, unassigned, awaitingReply, avgFirstResponseSeconds };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/bot-performance ----------------------
  // Today (in account timezone — UTC for v1; revisit when we add
  // per-org TZ to BotConfig). Auto-resolved = bot outbound messages
  // that did NOT end in an escalation in the same thread today.
  r.get(
    '/dashboard/widgets/bot-performance',
    {
      schema: {
        tags: ['dashboard'],
        summary: "Today's bot KPIs for the dashboard widget.",
        response: {
          200: itemEnvelopeSchema(
            z.object({
              autoResolvedPercent: z.number().int().min(0).max(100),
              botHandledMessages: z.number().int(),
              handedToHuman: z.number().int(),
              topFaq: z.string().nullable(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);

        // Bot-handled = outbound messages today where rawPayload.sentBy='bot'.
        // Escalated = threads whose status flipped to 'escalated' today
        // (proxied by counting threads currently 'escalated' whose
        // updatedAt is today — close enough; a thread can only escalate
        // once per active session).
        const [botHandled, escalatedToday, allBotThreads] = await Promise.all([
          tx.whatsAppMessage.count({
            where: {
              direction: 'outbound',
              receivedAt: { gte: startOfDay },
              rawPayload: { path: ['sentBy'], equals: 'bot' },
            },
          }),
          tx.whatsAppThread.count({
            where: { status: 'escalated', updatedAt: { gte: startOfDay } },
          }),
          // Threads the bot replied in today. Used as the denominator
          // for auto-resolved %.
          tx.whatsAppThread.count({
            where: {
              messages: {
                some: {
                  direction: 'outbound',
                  receivedAt: { gte: startOfDay },
                  rawPayload: { path: ['sentBy'], equals: 'bot' },
                },
              },
            },
          }),
        ]);

        const autoResolvedPercent =
          allBotThreads === 0
            ? 0
            : Math.max(
                0,
                Math.min(100, Math.round(((allBotThreads - escalatedToday) / allBotThreads) * 100)),
              );

        // Top FAQ today — derived heuristically: pick the FAQ whose
        // question text most commonly substring-matches inbound message
        // bodies today. Cheap for the small FAQ counts each tenant has
        // (1-50). Returns NULL when no inbound matched any FAQ.
        const faqs = await tx.fAQ.findMany({
          where: { visibility: 'public' },
          select: { id: true, question: true },
        });
        let topFaq: string | null = null;
        if (faqs.length > 0) {
          const inbound = await tx.whatsAppMessage.findMany({
            where: { direction: 'inbound', receivedAt: { gte: startOfDay }, body: { not: null } },
            select: { body: true },
            take: 500,
          });
          const counts = new Map<string, number>();
          for (const m of inbound) {
            const body = (m.body ?? '').toLowerCase();
            for (const f of faqs) {
              const q = f.question.toLowerCase();
              if (q.length < 4) continue;
              if (body.includes(q.slice(0, Math.min(20, q.length)))) {
                counts.set(f.question, (counts.get(f.question) ?? 0) + 1);
              }
            }
          }
          let best = 0;
          for (const [q, c] of counts) {
            if (c > best) {
              best = c;
              topFaq = q;
            }
          }
        }

        return {
          autoResolvedPercent,
          botHandledMessages: botHandled,
          handedToHuman: escalatedToday,
          topFaq,
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/outreach -----------------------------
  // Most-recent live (sending/paused) broadcast — or null when nothing
  // is in flight. Counters come from the broadcast row directly: the
  // send worker and webhook handler keep them in sync.
  r.get(
    '/dashboard/widgets/outreach',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Active broadcast campaign for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              active: z
                .object({
                  id: uuidSchema,
                  name: z.string(),
                  status: z.string(),
                  sent: z.number().int(),
                  delivered: z.number().int(),
                  read: z.number().int(),
                })
                .nullable(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const live = await tx.broadcast.findFirst({
          where: { status: { in: ['sending', 'paused'] } },
          orderBy: { startedAt: 'desc' },
          select: {
            id: true,
            name: true,
            status: true,
            sentCount: true,
            deliveredCount: true,
            readCount: true,
          },
        });
        if (!live) return { active: null };
        return {
          active: {
            id: live.id,
            name: live.name,
            status: live.status,
            sent: live.sentCount,
            delivered: live.deliveredCount,
            read: live.readCount,
          },
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/connections-sync ---------------------
  // Last sync + WhatsApp template approval counts + webhook health.
  // Health is derived: any endpoint with >0 consecutive failures
  // counts as degraded; >=5 consecutive failures = failing.
  r.get(
    '/dashboard/widgets/connections-sync',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Connections / sync health for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              lastSyncIso: z.string().datetime().nullable(),
              templates: z.object({ approved: z.number().int(), pending: z.number().int() }),
              webhooks: z.enum(['healthy', 'degraded', 'failing']),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const [lastSync, approved, pending, endpoints] = await Promise.all([
          tx.syncRun.findFirst({
            where: { finishedAt: { not: null } },
            orderBy: { finishedAt: 'desc' },
            select: { finishedAt: true },
          }),
          tx.whatsAppTemplate.count({ where: { status: 'approved' } }),
          tx.whatsAppTemplate.count({ where: { status: 'pending' } }),
          tx.webhookEndpoint.findMany({
            select: { consecutiveFailures: true, isActive: true },
          }),
        ]);
        let webhooks: 'healthy' | 'degraded' | 'failing' = 'healthy';
        const failing = endpoints.some((e) => e.consecutiveFailures >= 5 || !e.isActive);
        const degraded = endpoints.some((e) => e.consecutiveFailures > 0);
        if (failing) webhooks = 'failing';
        else if (degraded) webhooks = 'degraded';
        return {
          lastSyncIso: lastSync?.finishedAt?.toISOString() ?? null,
          templates: { approved, pending },
          webhooks,
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/onboarding ---------------------------
  // Checklist progress. Each step is "done" when the underlying
  // condition holds — there's no explicit per-step completed flag, so
  // we derive from the actual config.
  r.get(
    '/dashboard/widgets/onboarding',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Onboarding checklist progress for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              steps: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  href: z.string(),
                  completed: z.boolean(),
                }),
              ),
              complete: z.boolean(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const [channel, products, services, botConfig, businessInfo, faqs, members, invites] =
          await Promise.all([
            tx.whatsAppChannel.findFirst({
              where: { isPrimary: true },
              select: { isActive: true, accessToken: true, phoneNumberId: true },
            }),
            tx.product.count({ where: { deletedAt: null } }),
            tx.service.count({ where: { deletedAt: null } }),
            tx.botConfig.findFirst({
              select: { deployedAt: true, updatedAt: true, createdAt: true },
            }),
            tx.businessInfo.findFirst({
              select: { legalName: true, about: true, operatingHours: true },
            }),
            tx.fAQ.count(),
            tx.membership.count(),
            tx.invitation.count(),
          ]);

        const connectWaDone =
          !!channel && channel.isActive && !!channel.accessToken && !!channel.phoneNumberId;
        const addCatalogDone = products > 0 || services > 0;
        // "Business info" = the profile has real content (name/about/hours) OR
        // at least one FAQ exists — either one gives the bot something to say.
        const businessInfoDone =
          (!!businessInfo &&
            (!!businessInfo.legalName || !!businessInfo.about || !!businessInfo.operatingHours)) ||
          faqs > 0;
        // "Train bot" = bot config has been edited at least once
        // (operator opened /bot and saved). updatedAt > createdAt + 5s
        // is a good-enough proxy that the seed row wasn't merely
        // auto-created.
        const trainBotDone =
          !!botConfig &&
          botConfig.updatedAt.getTime() - botConfig.createdAt.getTime() > 5_000;
        const goLiveDone = !!botConfig?.deployedAt;
        // Counts EVER-invited, not currently-pending: the point is "you have
        // brought your team in", which a revoked-then-accepted history still
        // satisfies.
        const inviteTeamDone = members > 1 || invites > 0;

        const steps = [
          { id: 'connect-wa', label: 'Connect WhatsApp', href: '/whatsapp', completed: connectWaDone },
          { id: 'add-catalog', label: 'Add catalog', href: '/products', completed: addCatalogDone },
          { id: 'business-info', label: 'Add business info & FAQs', href: '/business-info', completed: businessInfoDone },
          { id: 'train-bot', label: 'Train bot', href: '/bot', completed: trainBotDone },
          { id: 'go-live', label: 'Go live', href: '/bot', completed: goLiveDone },
          { id: 'invite-team', label: 'Invite your team', href: '/members', completed: inviteTeamDone },
        ];
        return { steps, complete: steps.every((s) => s.completed) };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/recent-activity ----------------------
  // Latest 5 audit log entries. Mirrors what dashboard/summary's
  // recentAudits returns; broken out so the widget can poll its own
  // cadence (and so we can later add per-event icons / actor avatar
  // without touching the summary contract).
  r.get(
    '/dashboard/widgets/recent-activity',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Last 5 audit-log events for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              events: z.array(
                z.object({
                  id: uuidSchema,
                  kind: z.string(),
                  description: z.string(),
                  at: z.string().datetime(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const rows = await tx.auditLog.findMany({
          // Don't surface HQ-only or super-admin-access events (an admin
          // controlling the workspace) in the tenant's activity feed.
          where: {
            NOT: {
              action: {
                in: ['integration_credentials_set', 'hq_admin_accessed', 'hq_admin_exited'],
              } as never,
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, action: true, entityType: true, createdAt: true },
        });
        return {
          events: rows.map((a) => ({
            id: a.id,
            kind: a.action,
            description: humaniseAction(a.action, a.entityType),
            at: a.createdAt.toISOString(),
          })),
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/sales --------------------------------
  // Orders + revenue over the last 7 days. "Order" = a captured cart in a
  // real state ('new' | 'confirmed' | 'completed') — drafts and cancelled
  // carts are excluded. Revenue is reported in the org's dominant currency
  // (the currency carrying the most orders); AOV is revenue ÷ those orders.
  const ORDER_STATES = ['new', 'confirmed', 'completed'];
  r.get(
    '/dashboard/widgets/sales',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Orders + revenue (last 7 days) for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              currency: z.string(),
              orders7d: z.number().int(),
              ordersToday: z.number().int(),
              revenue7dMinor: z.number().int(),
              paid7d: z.number().int(),
              aovMinor: z.number().int(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        const [byCurrency, ordersToday, paid7d] = await Promise.all([
          tx.cart.groupBy({
            by: ['currency'],
            where: { status: { in: ORDER_STATES }, createdAt: { gte: weekAgo } },
            _sum: { totalMinor: true },
            _count: { _all: true },
          }),
          tx.cart.count({ where: { status: { in: ORDER_STATES }, createdAt: { gte: startOfDay } } }),
          tx.cart.count({ where: { paidAt: { not: null, gte: weekAgo } } }),
        ]);
        // Dominant currency = the one carrying the most orders. Revenue/AOV
        // are single-currency (mixing minor units across currencies would be
        // meaningless); the order count stays currency-agnostic.
        let dom = byCurrency[0] ?? null;
        for (const g of byCurrency) {
          if (g._count._all > (dom?._count._all ?? 0)) dom = g;
        }
        const orders7d = byCurrency.reduce((s, g) => s + g._count._all, 0);
        const revenue7dMinor = Number(dom?._sum.totalMinor ?? 0);
        const domOrders = dom?._count._all ?? 0;
        const aovMinor = domOrders > 0 ? Math.round(revenue7dMinor / domOrders) : 0;
        return {
          currency: dom?.currency ?? 'USD',
          orders7d,
          ordersToday,
          revenue7dMinor,
          paid7d,
          aovMinor,
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/conversion-funnel --------------------
  // Last-7-day funnel: conversations → carts started → orders placed →
  // orders paid. Each stage is a strict subset of the one before, so the
  // web layer can render drop-off percentages without a second query.
  r.get(
    '/dashboard/widgets/conversion-funnel',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Chats → carts → orders → paid funnel (last 7 days).',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              conversations: z.number().int(),
              cartsStarted: z.number().int(),
              ordersPlaced: z.number().int(),
              ordersPaid: z.number().int(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [conversations, cartsStarted, ordersPlaced, ordersPaid] = await Promise.all([
          tx.whatsAppThread.count({ where: { createdAt: { gte: weekAgo } } }),
          tx.cart.count({ where: { createdAt: { gte: weekAgo } } }),
          tx.cart.count({ where: { status: { in: ORDER_STATES }, createdAt: { gte: weekAgo } } }),
          tx.cart.count({ where: { paidAt: { not: null, gte: weekAgo } } }),
        ]);
        return { conversations, cartsStarted, ordersPlaced, ordersPaid };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/channel-mix --------------------------
  // Conversations per channel over the last 7 days + voice-call volume.
  // Lets a tenant see where their traffic actually comes from (WhatsApp vs
  // Messenger vs Instagram vs phone).
  r.get(
    '/dashboard/widgets/channel-mix',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Conversations per channel + voice calls (last 7 days).',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              channels: z.array(
                z.object({ channel: z.string(), conversations: z.number().int() }),
              ),
              voiceCalls: z.number().int(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [grp, voiceCalls] = await Promise.all([
          tx.whatsAppThread.groupBy({
            by: ['channel'],
            where: { createdAt: { gte: weekAgo } },
            _count: { _all: true },
          }),
          tx.voiceCall.count({ where: { startedAt: { gte: weekAgo } } }),
        ]);
        const channels = grp
          .map((g) => ({ channel: g.channel, conversations: g._count._all }))
          .sort((a, b) => b.conversations - a.conversations);
        return { channels, voiceCalls };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/orders-by-channel --------------------
  // Orders + revenue broken out by the cart's origin channel (whatsapp /
  // messenger / instagram / voice) over the last 7 days. "Order" = a captured
  // cart in a real state ('new' | 'confirmed' | 'completed'); drafts +
  // cancelled are excluded (same rule as the sales widget). Revenue is summed
  // per channel in minor units — the web layer formats with the dominant
  // currency (mixing currencies in one bar would be meaningless, but a single
  // org is almost always single-currency, so this stays honest in practice).
  r.get(
    '/dashboard/widgets/orders-by-channel',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Orders + revenue by channel (last 7 days) for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              currency: z.string(),
              channels: z.array(
                z.object({
                  channel: z.string(),
                  orders: z.number().int(),
                  revenueMinor: z.number().int(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [grp, byCurrency] = await Promise.all([
          tx.cart.groupBy({
            by: ['channel'],
            where: { status: { in: ORDER_STATES }, createdAt: { gte: weekAgo } },
            _sum: { totalMinor: true },
            _count: { _all: true },
          }),
          // Dominant currency for display (the one carrying the most orders).
          tx.cart.groupBy({
            by: ['currency'],
            where: { status: { in: ORDER_STATES }, createdAt: { gte: weekAgo } },
            _count: { _all: true },
          }),
        ]);
        let dom = byCurrency[0] ?? null;
        for (const g of byCurrency) {
          if (g._count._all > (dom?._count._all ?? 0)) dom = g;
        }
        const channels = grp
          .map((g) => ({
            channel: g.channel,
            orders: g._count._all,
            revenueMinor: Number(g._sum.totalMinor ?? 0),
          }))
          .sort((a, b) => b.orders - a.orders);
        return { currency: dom?.currency ?? 'USD', channels };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/audience -----------------------------
  // Contact-list health + compliance: total, new this week, opted-out, and
  // operator-blocked. The web layer derives the opt-out rate. Soft-deleted
  // contacts are excluded from every count.
  r.get(
    '/dashboard/widgets/audience',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Audience size + opt-out / block compliance for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              total: z.number().int(),
              newThisWeek: z.number().int(),
              optedOut: z.number().int(),
              blocked: z.number().int(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [total, newThisWeek, optedOut, blocked] = await Promise.all([
          tx.contact.count({ where: { deletedAt: null } }),
          tx.contact.count({ where: { deletedAt: null, createdAt: { gte: weekAgo } } }),
          tx.contact.count({ where: { deletedAt: null, optedOutAt: { not: null } } }),
          tx.contact.count({ where: { deletedAt: null, blockedAt: { not: null } } }),
        ]);
        return { total, newThisWeek, optedOut, blocked };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/reply-quality ------------------------
  // Tenant-safe view of the AI provenance audit trail: how many bot replies
  // in the last 7 days carried a hallucination flag. Raw SQL so we can ask
  // Postgres for the JSONB array length directly rather than pulling rows.
  r.get(
    '/dashboard/widgets/reply-quality',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Flagged bot replies (last 7 days) for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({ total: z.number().int(), flagged: z.number().int() }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const rows = (await tx.$queryRawUnsafe(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE jsonb_typeof(hallucinations) = 'array'
                AND jsonb_array_length(hallucinations) > 0
            )::int AS flagged
          FROM message_provenances
          WHERE organization_id = current_setting('app.current_org_id')::uuid
            AND created_at >= now() - interval '7 days'
        `)) as { total: number; flagged: number }[];
        return { total: rows[0]?.total ?? 0, flagged: rows[0]?.flagged ?? 0 };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/voice --------------------------------
  // Phone voicebot volume + outcomes over the last 7 days. Returns zeros
  // (not an error) for tenants without a phone line so the widget can still
  // be added and shows an empty state.
  r.get(
    '/dashboard/widgets/voice',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Voice-call volume + outcomes (last 7 days) for the dashboard widget.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              total: z.number().int(),
              completed: z.number().int(),
              handoff: z.number().int(),
              dropped: z.number().int(),
              inProgress: z.number().int(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const grp = await tx.voiceCall.groupBy({
          by: ['outcome'],
          where: { startedAt: { gte: weekAgo } },
          _count: { _all: true },
        });
        const m = new Map(grp.map((g) => [g.outcome, g._count._all]));
        return {
          total: grp.reduce((s, g) => s + g._count._all, 0),
          completed: m.get('completed') ?? 0,
          handoff: m.get('handoff') ?? 0,
          dropped: m.get('dropped') ?? 0,
          inProgress: m.get('in_progress') ?? 0,
        };
      });
      return { data };
    },
  );

  // ============================================================
  //   /me/dashboard-layout — per-user, cross-device layout persist
  // ============================================================

  const layoutSchema = z.object({
    widgets: z.array(z.string().min(1).max(64)).max(50),
  });

  // ---------- GET /me/dashboard-layout ------------------------------------
  r.get(
    '/me/dashboard-layout',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Current user’s saved dashboard widget layout.',
        response: { 200: itemEnvelopeSchema(layoutSchema.nullable()) },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const row = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId }, select: { dashboardLayout: true } }),
      );
      const stored = row?.dashboardLayout as { widgets?: unknown } | null;
      if (!stored || !Array.isArray(stored.widgets)) return { data: null };
      const widgets = stored.widgets.filter((w): w is string => typeof w === 'string');
      return { data: { widgets } };
    },
  );

  // ---------- PUT /me/dashboard-layout ------------------------------------
  r.put(
    '/me/dashboard-layout',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Persist the current user’s dashboard widget layout.',
        body: layoutSchema,
        response: { 200: itemEnvelopeSchema(layoutSchema) },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      // Body is already validated + narrowed by the Zod type provider.
      const body = req.body as { widgets: string[] };
      await withRlsBypass((tx) =>
        tx.user.update({
          where: { id: userId },
          data: { dashboardLayout: { widgets: body.widgets } },
        }),
      );
      return { data: { widgets: body.widgets } };
    },
  );

  // ---------- GET /dashboard/widgets/overview -----------------------------
  // The sandbox-style hero KPIs + a 7-day conversations series for the bar
  // chart. Everything here is the tenant's LIVE data (not the demo numbers):
  // conversations = threads, reply time = median first-response, orders =
  // captured carts, AI-handled = bot-only threads that never escalated.
  r.get(
    '/dashboard/widgets/overview',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Hero KPIs (conversations, reply time, orders, AI-handled) + 7-day series.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              conversations7d: z.number().int(),
              conversationsDeltaPct: z.number().int().nullable(),
              medianReplySeconds: z.number().int().nullable(),
              orders7d: z.number().int(),
              ordersToday: z.number().int(),
              aiHandledPercent: z.number().int(),
              humanPercent: z.number().int(),
              byDay: z.array(z.object({ label: z.string(), count: z.number().int() })),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const now = Date.now();
        const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        // Conversations "this week" = the SAME 7 UTC days as the chart bars
        // (today-6 … today), so the KPI equals the sum of the bars exactly. The
        // delta compares to the 7 UTC days before that.
        const nowD = new Date();
        const weekStart = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() - 6));
        const prevWeekStart = new Date(weekStart.getTime() - 7 * 86400000);

        const [convPrev, orders7d, ordersToday, botThreads7d, escalated7d] = await Promise.all([
          tx.whatsAppThread.count({ where: { createdAt: { gte: prevWeekStart, lt: weekStart } } }),
          tx.cart.count({ where: { status: { in: ORDER_STATES }, createdAt: { gte: weekAgo } } }),
          tx.cart.count({ where: { status: { in: ORDER_STATES }, createdAt: { gte: startOfDay } } }),
          tx.whatsAppThread.count({
            where: {
              messages: {
                some: {
                  direction: 'outbound',
                  receivedAt: { gte: weekAgo },
                  rawPayload: { path: ['sentBy'], equals: 'bot' },
                },
              },
            },
          }),
          tx.whatsAppThread.count({ where: { status: 'escalated', updatedAt: { gte: weekAgo } } }),
        ]);

        // Median first-response time over the last 50 threads (robust to a
        // single sleepy night). Same shape as the inbox-snapshot widget.
        const samples = (await tx.$queryRawUnsafe(`
          WITH first_msgs AS (
            SELECT
              t.id AS thread_id,
              (SELECT MIN(m.received_at) FROM whatsapp_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound') AS first_in,
              (SELECT MIN(m.received_at) FROM whatsapp_messages m WHERE m.thread_id = t.id AND m.direction = 'outbound') AS first_out
            FROM whatsapp_threads t
            WHERE t.organization_id = current_setting('app.current_org_id')::uuid
            ORDER BY t.last_message_at DESC
            LIMIT 50
          )
          SELECT EXTRACT(EPOCH FROM (first_out - first_in))::int AS seconds
          FROM first_msgs
          WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
        `)) as { seconds: number }[];
        const sorted = samples.map((s) => s.seconds).sort((a, b) => a - b);
        const medianReplySeconds =
          sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)] ?? null;

        // Conversations per UTC day over the last 7 days for the bar chart.
        const byDayRows = (await tx.$queryRawUnsafe(`
          SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
          FROM whatsapp_threads
          WHERE organization_id = current_setting('app.current_org_id')::uuid
            AND created_at >= now() - interval '7 days'
          GROUP BY 1
        `)) as { day: string; count: number }[];
        const counts = new Map(byDayRows.map((r) => [r.day, r.count]));
        const today = new Date();
        const byDay: { label: string; count: number }[] = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
          byDay.push({
            label: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
            count: counts.get(d.toISOString().slice(0, 10)) ?? 0,
          });
        }

        // Equal to the chart total by construction (same 7 UTC days).
        const conversations7d = byDay.reduce((s, x) => s + x.count, 0);
        const conversationsDeltaPct =
          convPrev === 0 ? null : Math.round(((conversations7d - convPrev) / convPrev) * 100);
        const aiHandledPercent =
          botThreads7d === 0
            ? 0
            : Math.max(0, Math.min(100, Math.round(((botThreads7d - escalated7d) / botThreads7d) * 100)));
        const humanPercent = botThreads7d === 0 ? 0 : Math.max(0, 100 - aiHandledPercent);

        return {
          conversations7d,
          conversationsDeltaPct,
          medianReplySeconds,
          orders7d,
          ordersToday,
          aiHandledPercent,
          humanPercent,
          byDay,
        };
      });
      return { data };
    },
  );

  // ---------- GET /dashboard/widgets/bookings-week ------------------------
  // This week's bookings (Mon–Sun) grouped by day for the dashboard calendar,
  // rendered in the tenant's timezone.
  r.get(
    '/dashboard/widgets/bookings-week',
    {
      schema: {
        tags: ['dashboard'],
        summary: "This week's bookings grouped by day (tenant timezone).",
        response: {
          200: itemEnvelopeSchema(
            z.object({
              total: z.number().int(),
              days: z.array(
                z.object({
                  label: z.string(),
                  dayNum: z.number().int(),
                  isToday: z.boolean(),
                  items: z.array(
                    z.object({
                      time: z.string(),
                      title: z.string(),
                      subtitle: z.string().nullable(),
                      status: z.string(),
                    }),
                  ),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const data = await app.tenant(req, async (tx) => {
        const biz = await tx.businessInfo.findFirst({ select: { timezone: true } });
        const tz = biz?.timezone || 'UTC';
        const now = new Date();
        const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
        const localTime = (d: Date) =>
          new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
        const weekdayShort = (d: Date) =>
          new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);

        // Monday of the current week, in tz. Anchor on today's local date +
        // weekday, then do date-only arithmetic at UTC midnight (labels only).
        const todayKey = localDate(now);
        const wdIdx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayShort(now));
        const mondayMs = new Date(todayKey + 'T00:00:00Z').getTime() - (wdIdx < 0 ? 0 : wdIdx) * 86400000;

        const days = Array.from({ length: 7 }, (_, j) => {
          const d = new Date(mondayMs + j * 86400000);
          const key = d.toISOString().slice(0, 10);
          return {
            key,
            label: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
            dayNum: d.getUTCDate(),
            isToday: key === todayKey,
            items: [] as { time: string; title: string; subtitle: string | null; status: string }[],
          };
        });
        const dayByKey = new Map(days.map((d) => [d.key, d]));

        // Generous UTC window covering the local week whatever the offset.
        const rows = await tx.booking.findMany({
          where: { appointmentAt: { gte: new Date(mondayMs - 86400000), lt: new Date(mondayMs + 9 * 86400000) } },
          orderBy: { appointmentAt: 'asc' },
          select: { appointmentAt: true, customerName: true, fields: true, notes: true, status: true },
        });

        let total = 0;
        for (const b of rows) {
          if (!b.appointmentAt) continue;
          const day = dayByKey.get(localDate(b.appointmentAt));
          if (!day) continue;
          const title = bookingTitle(b.fields, b.notes, b.customerName);
          day.items.push({
            time: localTime(b.appointmentAt),
            title,
            subtitle: b.customerName && b.customerName !== title ? b.customerName : null,
            status: b.status,
          });
          total += 1;
        }

        return { total, days: days.map(({ key: _key, ...rest }) => rest) };
      });
      return { data };
    },
  );
}

// Map raw audit_log.action strings to human-readable phrases for the
// Recent activity widget. Falls back to a "Title-Case the action" so
// new event types still render OK without code changes.
function humaniseAction(action: string, entityType: string | null): string {
  const map: Record<string, string> = {
    product_updated: 'Product updated',
    product_created: 'Product added',
    service_updated: 'Service updated',
    service_created: 'Service added',
    login_succeeded: 'Login succeeded',
    business_info_updated: 'Business info updated',
    broadcast_sent: 'Broadcast sent',
    bot_deployed: 'Bot deployed',
    bot_undeployed: 'Bot rolled back',
    faq_updated: 'FAQ updated',
    faq_created: 'FAQ added',
    policy_updated: 'Policy updated',
  };
  if (map[action]) return map[action];
  const phrase = action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return entityType ? `${phrase} (${entityType})` : phrase;
}

// Best-effort title for a booking on the dashboard calendar: the booked
// subject from the frozen form fields (service/class/table/…), else the first
// meaningful field, else the notes, else the customer's name.
function bookingTitle(fields: unknown, notes: string | null, customerName: string | null): string {
  const list = Array.isArray(fields)
    ? (fields as { key?: string; label?: string; value?: unknown }[])
    : [];
  const SUBJECT = /(service|appointment|reason|type|session|class|event|tour|table|party|package|treatment)/i;
  const SKIP = /(name|phone|email|date|time|when|number|note)/i;
  for (const f of list) {
    const tag = `${f?.key ?? ''} ${f?.label ?? ''}`;
    if (SUBJECT.test(tag) && f?.value) return String(f.value).slice(0, 60);
  }
  for (const f of list) {
    const tag = `${f?.key ?? ''} ${f?.label ?? ''}`;
    if (!SKIP.test(tag) && f?.value) return String(f.value).slice(0, 60);
  }
  if (notes && notes.trim()) return notes.trim().split('\n')[0]!.slice(0, 60);
  return customerName || 'Booking';
}
