// Phase 3 §5.1.4 — branding (white-label), Meta onboarding stepper,
// client-facing analytics. Bundled in one module because the surface is
// small per feature and they're all tenant-authed and read/write the
// same models the existing routes already touch.
import { promises as dns } from 'node:dns';

import { listEnvelopeSchema, itemEnvelopeSchema, successSchema, uuidSchema } from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { env } from '../../lib/env.js';

// Resolve a hostname's CNAME chain and report whether any link points at
// our `CUSTOM_CNAME_TARGET`. We accept exact match or a same-suffix match
// so trailing dots / subdomain redirections both work.
async function verifyCnameTarget(
  hostname: string,
): Promise<{ ok: boolean; resolved: string[]; error?: string }> {
  const target = env.CUSTOM_CNAME_TARGET.toLowerCase().replace(/\.$/, '');
  try {
    const records = await dns.resolveCname(hostname);
    const resolved = records.map((r) => r.toLowerCase().replace(/\.$/, ''));
    const ok = resolved.some((r) => r === target);
    return { ok, resolved, error: ok ? undefined : `expected CNAME → ${target}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return { ok: false, resolved: [], error: `DNS ${code}` };
  }
}

const META_STEPS: { key: string; title: string; description: string }[] = [
  {
    key: 'business_account',
    title: 'Create / log in to a Meta Business account',
    description: 'business.facebook.com — fill legal name, website, business email, address.',
  },
  {
    key: 'create_app',
    title: 'Create a Meta app with WhatsApp product',
    description: 'developers.facebook.com/apps → Business app type → add WhatsApp under Products.',
  },
  {
    key: 'phone_number',
    title: 'Add your business phone number',
    description: 'Number must NOT currently be on the consumer WhatsApp app.',
  },
  {
    key: 'verify_number',
    title: 'Verify the number via SMS or voice',
    description: 'Meta sends a 6-digit code; enter it in the dashboard.',
  },
  {
    key: 'system_user_token',
    title: 'Mint a permanent System User access token',
    description:
      'Business Settings → Users → System Users → New → assign WhatsApp Business Account → generate token.',
  },
  {
    key: 'paste_credentials',
    title: 'Paste credentials into ALIGNED',
    description: 'WhatsApp page in this portal — WABA ID, phone number ID, app secret, access token.',
  },
  {
    key: 'business_verification',
    title: 'Submit business verification',
    description: 'Business Settings → Security Center → Business Verification (3–10 business days).',
  },
];

export default async function saasRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ===================================================================
  // §5.1.4 White-label / branding
  // ===================================================================

  r.get(
    '/branding',
    {
      schema: {
        tags: ['saas'],
        summary: 'Get the org branding config (auto-creates a stub).',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        let row = await tx.brandingConfig.findUnique({ where: { organizationId: orgId } });
        if (!row) row = await tx.brandingConfig.create({ data: { organizationId: orgId } });
        // Resolve a public/signed URL when a logo asset is attached.
        let logoUrl: string | null = null;
        if (row.logoAssetId) {
          const asset = await tx.asset.findUnique({ where: { id: row.logoAssetId } });
          if (asset) {
            const { resolveAssetUrl } = await import('../catalog/shared.js');
            logoUrl = await resolveAssetUrl(asset.storageKey);
          }
        }
        return {
          data: {
            id: row.id,
            logoAssetId: row.logoAssetId,
            logoUrl,
            accentColor: row.accentColor,
            customCname: row.customCname,
            cnameStatus: row.cnameStatus,
            cnameVerifiedAt: row.cnameVerifiedAt?.toISOString() ?? null,
            cnameLastCheckAt: row.cnameLastCheckAt?.toISOString() ?? null,
            cnameError: row.cnameError,
            cnameTarget: env.CUSTOM_CNAME_TARGET,
            footerText: row.footerText,
            updatedAt: row.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  r.put(
    '/branding',
    {
      schema: {
        tags: ['saas'],
        summary: 'Update the org branding (logo, accent colour, custom CNAME).',
        body: z.object({
          logoAssetId: uuidSchema.nullable().optional(),
          accentColor: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex like #0070C9.')
            .nullable()
            .optional(),
          customCname: z
            .string()
            .trim()
            .max(253)
            .regex(/^[a-z0-9.-]+$/i, 'Use a domain like inbox.example.com.')
            .nullable()
            .optional(),
          footerText: z.string().trim().max(500).nullable().optional(),
        }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing =
          (await tx.brandingConfig.findUnique({ where: { organizationId: orgId } })) ??
          (await tx.brandingConfig.create({ data: { organizationId: orgId } }));

        // Reset CNAME state when the value changes. Setting to null clears
        // the row entirely; setting to a new domain drops to 'pending' so
        // Caddy stops issuing certs for the old hostname immediately.
        const cnameChange =
          req.body.customCname !== undefined && req.body.customCname !== existing.customCname;
        const cnameReset = cnameChange
          ? req.body.customCname
            ? {
                cnameStatus: 'pending' as const,
                cnameVerifiedAt: null,
                cnameLastCheckAt: null,
                cnameError: null,
              }
            : {
                cnameStatus: null,
                cnameVerifiedAt: null,
                cnameLastCheckAt: null,
                cnameError: null,
              }
          : {};

        const updated = await tx.brandingConfig.update({
          where: { id: existing.id },
          data: {
            logoAssetId: req.body.logoAssetId === undefined ? undefined : req.body.logoAssetId,
            accentColor: req.body.accentColor === undefined ? undefined : req.body.accentColor,
            customCname: req.body.customCname === undefined ? undefined : req.body.customCname,
            footerText: req.body.footerText === undefined ? undefined : req.body.footerText,
            ...cnameReset,
          },
        });
        return {
          data: {
            id: updated.id,
            logoAssetId: updated.logoAssetId,
            accentColor: updated.accentColor,
            customCname: updated.customCname,
            cnameStatus: updated.cnameStatus,
            cnameVerifiedAt: updated.cnameVerifiedAt?.toISOString() ?? null,
            cnameError: updated.cnameError,
            footerText: updated.footerText,
            updatedAt: updated.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // Verify the CNAME row by hitting public DNS. Caller-triggered (the
  // settings page exposes a "Verify now" button) so we can keep the API
  // simple and let the operator retry until DNS propagates.
  r.post(
    '/branding/cname/verify',
    {
      schema: { tags: ['saas'], summary: 'Re-check the configured custom CNAME via public DNS.' },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const row = await app.tenant(req, async (tx) =>
        tx.brandingConfig.findUnique({ where: { organizationId: orgId } }),
      );
      if (!row?.customCname) {
        reply.code(400);
        return { ok: false as const, message: 'No CNAME set.' };
      }
      const result = await verifyCnameTarget(row.customCname);
      const now = new Date();
      await app.tenant(req, async (tx) =>
        tx.brandingConfig.update({
          where: { id: row.id },
          data: {
            cnameStatus: result.ok ? 'verified' : 'failed',
            cnameVerifiedAt: result.ok ? now : row.cnameVerifiedAt,
            cnameLastCheckAt: now,
            cnameError: result.ok ? null : result.error ?? 'verification failed',
          },
        }),
      );
      return {
        ok: result.ok,
        status: result.ok ? ('verified' as const) : ('failed' as const),
        target: env.CUSTOM_CNAME_TARGET,
        resolved: result.resolved,
        error: result.ok ? null : result.error ?? 'verification failed',
      };
    },
  );

  // -----------------------------------------------------------------
  // Caddy on-demand-TLS ask endpoint. Caddy hits this once per
  // hostname before issuing a cert; only verified CNAMEs return 200.
  //
  // Public (unauthenticated). RLS bypass via the raw prisma client +
  // a single indexed lookup. Keep this lean — Caddy waits on it.
  // -----------------------------------------------------------------
  r.get(
    '/caddy/ask',
    {
      schema: {
        tags: ['saas'],
        summary: 'Caddy on-demand TLS guard. Returns 200 only for verified custom CNAMEs.',
        querystring: z.object({ domain: z.string().min(1).max(253) }),
      },
      // No auth — Caddy talks to this on the local network.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const domain = req.query.domain.trim().toLowerCase();
      // Always allow our own apex/api domains so the on-demand path is
      // a no-op for the platform's own certs (Caddy still uses ACME for
      // them via the static site blocks in Caddyfile, but this guard
      // shouldn't accidentally reject them if mis-configured).
      try {
        const apiHost = new URL(env.API_PUBLIC_URL).hostname.toLowerCase();
        const webHost = new URL(env.WEB_PUBLIC_URL).hostname.toLowerCase();
        if (domain === apiHost || domain === webHost) {
          reply.code(200);
          return { ok: true };
        }
      } catch {
        /* fall through */
      }
      const row = await withRlsBypass((tx) =>
        tx.brandingConfig.findFirst({
          where: { customCname: domain, cnameStatus: 'verified' },
          select: { id: true },
        }),
      );
      if (!row) {
        reply.code(404);
        return { ok: false };
      }
      reply.code(200);
      return { ok: true };
    },
  );

  // ===================================================================
  // §5.1.2 Meta verification — guided stepper
  // ===================================================================

  r.get(
    '/onboarding/meta',
    {
      schema: {
        tags: ['saas'],
        summary: 'List Meta onboarding steps + completion state per org.',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const states = await tx.metaOnboardingStep.findMany({});
        const map = new Map(states.map((s) => [s.stepKey, s]));
        return {
          data: META_STEPS.map((s) => {
            const state = map.get(s.key);
            return {
              key: s.key,
              title: s.title,
              description: s.description,
              completedAt: state?.completedAt?.toISOString() ?? null,
              notes: state?.notes ?? null,
            };
          }),
        };
      }),
  );

  r.post(
    '/onboarding/meta/:key',
    {
      schema: {
        tags: ['saas'],
        summary: 'Mark a Meta onboarding step complete (or uncomplete).',
        params: z.object({ key: z.string().min(1) }),
        body: z.object({ done: z.boolean(), notes: z.string().trim().max(2000).optional() }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const orgId = req.auth!.organizationId;
        await tx.metaOnboardingStep.upsert({
          where: { organizationId_stepKey: { organizationId: orgId, stepKey: req.params.key } },
          create: {
            organizationId: orgId,
            stepKey: req.params.key,
            completedAt: req.body.done ? new Date() : null,
            notes: req.body.notes ?? null,
          },
          update: {
            completedAt: req.body.done ? new Date() : null,
            notes: req.body.notes === undefined ? undefined : req.body.notes,
          },
        });
        return { ok: true as const };
      }),
  );

  // ===================================================================
  // §5.1.4 Client-facing analytics
  // ===================================================================

  r.get(
    '/analytics',
    {
      schema: {
        tags: ['saas'],
        summary: 'Client-facing analytics: message volume, bot resolution, response time, top queries.',
        querystring: z.object({
          window: z.enum(['24h', '7d', '30d', '90d']).default('7d'),
        }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const win = req.query.window;
        const now = new Date();
        const since = new Date(
          now.getTime() -
            (win === '24h' ? 24 * 3600e3 : win === '7d' ? 7 * 86400e3 : win === '30d' ? 30 * 86400e3 : 90 * 86400e3),
        );

        const [allMessages, threads, handoffNotes, topInboundRaw] = await Promise.all([
          tx.whatsAppMessage.findMany({
            where: { receivedAt: { gte: since } },
            select: { direction: true, body: true, receivedAt: true, threadId: true },
            orderBy: { receivedAt: 'asc' },
          }),
          tx.whatsAppThread.findMany({
            where: { lastMessageAt: { gte: since } },
            select: { id: true, status: true, assignedToUserId: true, inboundCount: true, outboundCount: true },
          }),
          // Handoff notes are an indicator that the bot escalated.
          tx.whatsAppNote.count({
            where: { createdAt: { gte: since }, body: { contains: 'Bot escalated' } },
          }),
          tx.whatsAppMessage.findMany({
            where: { direction: 'inbound', receivedAt: { gte: since }, body: { not: null } },
            select: { body: true },
            take: 1000,
            orderBy: { receivedAt: 'desc' },
          }),
        ]);

        // Volume per day.
        const buckets = new Map<string, { date: string; inbound: number; outbound: number }>();
        for (const m of allMessages) {
          const d = m.receivedAt.toISOString().slice(0, 10);
          const b = buckets.get(d) ?? { date: d, inbound: 0, outbound: 0 };
          if (m.direction === 'inbound') b.inbound += 1;
          else b.outbound += 1;
          buckets.set(d, b);
        }
        const volume = [...buckets.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

        // Bot resolution rate: thread is "bot-resolved" if it had inbound
        // + outbound messages and was never escalated (no handoff note,
        // status not 'escalated' or 'pending'). We approximate by status.
        const totalThreads = threads.length;
        const resolvedThreads = threads.filter(
          (t) => t.status === 'resolved' || (t.status === 'open' && !t.assignedToUserId && t.outboundCount > 0),
        ).length;
        const resolutionRate = totalThreads > 0 ? resolvedThreads / totalThreads : 0;

        // Avg response time (ms): for each inbound message, find the next
        // outbound on the same thread and measure the gap.
        let respCount = 0;
        let respTotalMs = 0;
        const byThread = new Map<string, { direction: string; t: number; body: string | null }[]>();
        for (const m of allMessages) {
          if (!m.threadId) continue;
          const arr = byThread.get(m.threadId) ?? [];
          arr.push({ direction: m.direction, t: m.receivedAt.getTime(), body: m.body });
          byThread.set(m.threadId, arr);
        }
        for (const arr of byThread.values()) {
          for (let i = 0; i < arr.length; i++) {
            if (arr[i]!.direction === 'inbound') {
              const next = arr.slice(i + 1).find((x) => x.direction === 'outbound');
              if (next) {
                respTotalMs += next.t - arr[i]!.t;
                respCount += 1;
              }
            }
          }
        }
        const avgResponseSeconds = respCount > 0 ? Math.round(respTotalMs / respCount / 1000) : null;

        // Top queries — naive TF on inbound bodies (cheap clustering).
        const wordCounts = new Map<string, number>();
        const stop = new Set([
          'the','and','for','you','your','have','is','are','to','a','i','of','do','can','what','how','when','this','that','it','in','on','at','my','me','we','please','hi','hello',
        ]);
        for (const m of topInboundRaw) {
          const body = (m.body ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
          for (const w of body.split(/\s+/).filter((w) => w.length >= 4 && !stop.has(w))) {
            wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
          }
        }
        const topQueries = [...wordCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([word, count]) => ({ word, count }));

        // Top messages — full inbound messages ranked by repetition.
        // Customers frequently ask the same thing (e.g. "how much?",
        // "where are you located?"), so the literal duplicates are
        // useful to surface what FAQs/KB entries are missing. Cheap
        // exact-string aggregation; case + whitespace folded.
        const messageCounts = new Map<string, number>();
        for (const m of topInboundRaw) {
          const norm = (m.body ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
          if (norm.length < 3) continue;
          messageCounts.set(norm, (messageCounts.get(norm) ?? 0) + 1);
        }
        const topMessages = [...messageCounts.entries()]
          .filter(([, c]) => c >= 2) // ignore one-offs — they're not "top"
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([message, count]) => ({ message, count }));

        // Top products + services asked about — token-overlap match
        // between each inbound message and the catalog, not a literal
        // substring of the full product name. Customers say "do you
        // have laptops?" or "show me dell", not the full SKU.
        //
        // Scoring: tokenize the product/service name and the message
        // into lowercase alphanumeric words of length >= 3, dropping
        // English stop words. A product counts as "asked about" when:
        //   - any of its tokens of length >= 5 appears in the message
        //     (model names / brand / distinctive nouns), OR
        //   - at least 2 shorter tokens overlap (covers short brand +
        //     category combinations like "lg tv"), OR
        //   - the message contains the literal SKU.
        // This keeps generic single-word matches ("phone") from
        // exploding noise while still surfacing real product
        // interest.
        const STOP = new Set([
          'the','and','for','you','your','have','is','are','to','a','i','of','do','can','what','how','when','this','that','it','in','on','at','my','me','we','please','hi','hello','with','will','any','about','need','want','price','cost','available','tell','show','give','send','from','they','their','some','one','get',
        ]);
        function tokenize(s: string): string[] {
          return s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !STOP.has(w));
        }

        const [allProducts, allServices] = await Promise.all([
          tx.product.findMany({
            where: { deletedAt: null },
            select: { id: true, name: true, sku: true },
          }),
          tx.service.findMany({
            where: { deletedAt: null },
            select: { id: true, name: true },
          }),
        ]);

        // Pre-tokenize the catalog once.
        const productTokens = allProducts.map((p) => ({
          ...p,
          tokens: tokenize(p.name ?? ''),
          skuLower: (p.sku ?? '').toLowerCase(),
        }));
        const serviceTokens = allServices.map((s) => ({
          ...s,
          tokens: tokenize(s.name ?? ''),
        }));

        const productHits = new Map<string, { name: string; sku: string; count: number }>();
        const serviceHits = new Map<string, { name: string; count: number }>();
        for (const m of topInboundRaw) {
          const body = (m.body ?? '').toLowerCase();
          if (!body) continue;
          const msgTokens = new Set(tokenize(body));
          for (const p of productTokens) {
            const skuHit = p.skuLower && body.includes(p.skuLower);
            // Tokens of length >= 5 are distinctive — one match is enough.
            const distinctiveHit = p.tokens.some(
              (t) => t.length >= 5 && msgTokens.has(t),
            );
            // Short-token overlap — need at least 2 to count.
            const shortOverlap = p.tokens.filter((t) => t.length < 5 && msgTokens.has(t)).length;
            if (skuHit || distinctiveHit || shortOverlap >= 2) {
              const existing = productHits.get(p.id) ?? { name: p.name, sku: p.sku, count: 0 };
              existing.count += 1;
              productHits.set(p.id, existing);
            }
          }
          for (const s of serviceTokens) {
            const distinctiveHit = s.tokens.some(
              (t) => t.length >= 5 && msgTokens.has(t),
            );
            const shortOverlap = s.tokens.filter((t) => t.length < 5 && msgTokens.has(t)).length;
            if (distinctiveHit || shortOverlap >= 2) {
              const existing = serviceHits.get(s.id) ?? { name: s.name, count: 0 };
              existing.count += 1;
              serviceHits.set(s.id, existing);
            }
          }
        }
        const topProducts = [...productHits.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 10)
          .map(([id, v]) => ({ id, name: v.name, sku: v.sku, count: v.count }));
        const topServices = [...serviceHits.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 10)
          .map(([id, v]) => ({ id, name: v.name, count: v.count }));

        // ===== F9 (roadmap 2026-08-26) — reporting analytics v2 =============
        // AI vs human replies + containment. sentBy='bot' marks every bot
        // send (fast-path, quick-button, feedback included); anything else
        // outbound is a human (operator replies, template sends).
        const [botReplies, humanTouchedThreads] = await Promise.all([
          tx.whatsAppMessage.count({
            where: {
              direction: 'outbound',
              receivedAt: { gte: since },
              rawPayload: { path: ['sentBy'], equals: 'bot' },
            },
          }),
          tx.whatsAppMessage.findMany({
            where: {
              direction: 'outbound',
              receivedAt: { gte: since },
              NOT: { rawPayload: { path: ['sentBy'], equals: 'bot' } },
              threadId: { not: null },
            },
            select: { threadId: true },
            distinct: ['threadId'],
          }),
        ]);
        const outboundTotal = allMessages.filter((m) => m.direction === 'outbound').length;
        const threadsWithReplies = threads.filter((t) => t.outboundCount > 0).length;
        const humanTouchedInWindow = new Set(humanTouchedThreads.map((r) => r.threadId)).size;
        const aiOnlyThreads = Math.max(0, threadsWithReplies - humanTouchedInWindow);

        // CSAT (F2 data) — overall + the ai/human/mixed handler split.
        const feedbackRows = await tx.conversationFeedback.findMany({
          where: { askedAt: { gte: since } },
          select: { rating: true, handlerMix: true, respondedAt: true },
        });
        const csatByMix = ['ai', 'human', 'mixed'].map((mix) => {
          const rows = feedbackRows.filter((f) => f.handlerMix === mix && f.rating != null);
          const avg = rows.length
            ? rows.reduce((sum, f) => sum + (f.rating ?? 0), 0) / rows.length
            : null;
          return { mix, count: rows.length, avgRating: avg === null ? null : Number(avg.toFixed(2)) };
        });
        const ratedRows = feedbackRows.filter((f) => f.rating != null);
        const csat = {
          asked: feedbackRows.length,
          responded: ratedRows.length,
          avgRating: ratedRows.length
            ? Number((ratedRows.reduce((sum, f) => sum + (f.rating ?? 0), 0) / ratedRows.length).toFixed(2))
            : null,
          byMix: csatByMix,
        };

        // Team — per-agent workload + CSAT on threads they own. Visibility
        // (owner decision 2026-08-26): admins see every agent; editors/
        // viewers see ONLY their own row — filtered here, not in the UI.
        const isOrgAdmin = req.auth!.role === 'admin' || req.auth!.isSuperAdmin;
        const memberships = await tx.membership.findMany({
          where: {
            isActive: true,
            ...(isOrgAdmin ? {} : { userId: req.auth!.userId }),
          },
          select: {
            userId: true,
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        });
        const team = await Promise.all(
          memberships.map(async (m) => {
            const [assignedActive, resolvedInWindow, memberCsat] = await Promise.all([
              tx.whatsAppThread.count({
                where: {
                  assignedToUserId: m.userId,
                  status: { in: ['open', 'pending', 'escalated'] as never },
                },
              }),
              tx.whatsAppThread.count({
                where: {
                  assignedToUserId: m.userId,
                  status: 'resolved' as never,
                  lastMessageAt: { gte: since },
                },
              }),
              tx.conversationFeedback.findMany({
                where: {
                  askedAt: { gte: since },
                  rating: { not: null },
                  thread: { assignedToUserId: m.userId },
                },
                select: { rating: true },
              }),
            ]);
            const csatAvg = memberCsat.length
              ? Number(
                  (memberCsat.reduce((sum, f) => sum + (f.rating ?? 0), 0) / memberCsat.length).toFixed(2),
                )
              : null;
            return {
              userId: m.userId,
              name:
                [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') ||
                m.user.email.split('@')[0]!,
              assignedActive,
              resolvedInWindow,
              csatCount: memberCsat.length,
              csatAvg,
            };
          }),
        );

        // Sales — orders + bookings by channel in the window. Cart money is
        // BigInt (LBP overflow) — Number() only at serialization.
        const [cartRows, bookingRows] = await Promise.all([
          tx.cart.groupBy({
            by: ['channel'],
            where: { createdAt: { gte: since }, status: { notIn: ['draft', 'cancelled'] as never } },
            _count: { _all: true },
            _sum: { totalMinor: true },
          }),
          tx.booking.groupBy({
            by: ['channel'],
            where: { createdAt: { gte: since } },
            _count: { _all: true },
          }),
        ]);
        const sales = {
          orders: cartRows.map((r) => ({
            channel: r.channel ?? 'whatsapp',
            count: r._count._all,
            totalMinor: Number(r._sum.totalMinor ?? 0),
          })),
          bookings: bookingRows.map((r) => ({
            channel: (r.channel as string | null) ?? 'whatsapp',
            count: r._count._all,
          })),
        };

        return {
          data: {
            window: win,
            volume,
            totals: {
              inbound: allMessages.filter((m) => m.direction === 'inbound').length,
              outbound: allMessages.filter((m) => m.direction === 'outbound').length,
              threads: totalThreads,
            },
            botResolution: {
              resolutionRate: Number(resolutionRate.toFixed(3)),
              handoffs: handoffNotes,
            },
            avgResponseSeconds,
            topQueries,
            topMessages,
            topProducts,
            topServices,
            // F9 — reporting v2 sections.
            aiVsHuman: { botReplies, humanReplies: Math.max(0, outboundTotal - botReplies) },
            containment: {
              threadsWithReplies,
              aiOnlyThreads,
              rate:
                threadsWithReplies > 0
                  ? Number((aiOnlyThreads / threadsWithReplies).toFixed(3))
                  : null,
            },
            csat,
            team,
            sales,
          },
        };
      }),
  );
}
