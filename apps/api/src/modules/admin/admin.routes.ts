// ALIGNED super-admin endpoints. Always run with RLS bypass since they
// inspect / manage data across tenants. Gated by `requireSuperAdmin`.
import {
  adminCreateTenantBodySchema,
  adminCreateTenantResponseSchema,
  adminListLeadsQuerySchema,
  adminListOrgsQuerySchema,
  adminUpdateLeadBodySchema,
  adminUpdateOrgBodySchema,
  ApiErrorCode,
  createInvitationBodySchema,
  DEFAULT_META_COST_MICROS,
  DEFAULT_PRICE_MICROS,
  ORG_FEATURE_KEYS,
  ORG_FEATURE_DEFAULT_DISABLED,
  itemEnvelopeSchema,
  leadSchema,
  EXPORT_SECTION_KEYS,
  listEnvelopeSchema,
  organizationSchema,
  successSchema,
  uuidSchema,
  usdToMicros,
  walletAdjustBodySchema,
  walletSetPriceBodySchema,
  walletThresholdBodySchema,
  walletTopUpBodySchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { runAdminCopilot, isCopilotConfigured } from '../../lib/admin-copilot.js';
import { recordAudit } from '../../lib/audit.js';
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from '../../lib/cookies.js';
import { generateTempPassword, hashPassword } from '../../lib/crypto.js';
import { prisma, withRlsBypass } from '../../lib/db.js';
import * as wallet from '../../lib/wallet.js';
import { sendEmail, tenantProvisionedTemplate } from '../../lib/email.js';
import { env } from '../../lib/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import {
  getDataExportQueue,
  getImportQueue,
  getSyncQueue,
  getWebhookQueue,
} from '../../lib/queues.js';
import { getRedis } from '../../lib/redis.js';
import { presignGetUrl } from '../../lib/storage.js';
import { createInvitation, issueSession } from '../auth/auth.service.js';

// Derives a URL-safe slug from a human org name. Strips diacritics,
// non-ASCII letters, collapses whitespace + punctuation into hyphens,
// trims trailing hyphens, lowercases. Caller must still de-dupe against
// existing slugs.
function slugifyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export default async function adminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /hq/orgs -------------------------------------
  r.get(
    '/hq/orgs',
    {
      schema: {
        tags: ['admin'],
        summary: 'List all organisations across the platform.',
        querystring: adminListOrgsQuerySchema,
        response: {
          200: listEnvelopeSchema(
            organizationSchema.extend({
              memberCount: z.number().int(),
              productCount: z.number().int(),
              serviceCount: z.number().int(),
              // Broadcast messages actually sent (≈ users reached) + AI usage
              // (total tokens and exact USD cost) — admin-only metrics.
              broadcastMessages: z.number().int(),
              // Billable 24h template conversations (day-bucket approx) + their
              // estimated cost — powers the dashboard broadcast-costs table.
              billableConversations: z.number().int(),
              broadcastCostUsd: z.number(),
              aiTokens: z.number().int(),
              aiCostUsd: z.number(),
              // Per-model cost breakdown (Claude / OpenAI / Groq each priced
              // differently) so the table can show a total + hover detail.
              aiCostBreakdown: z.array(
                z.object({ model: z.string(), tokens: z.number().int(), usd: z.number() }),
              ),
              // Manual monthly payment (USD) — null until an admin sets it.
              monthlyPaidUsd: z.number().nullable(),
              lastActivityAt: z.string().datetime().nullable(),
              // Per-tenant AI tier surfaced on the admin list so the
              // tenants table at /hq can render a colored
              // badge per row + sort by plan.
              aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']),
              // ALIGNED-admin per-tenant access control: disabled feature keys.
              disabledFeatures: z.array(z.string()),
              // Primary WhatsApp display number (null if none connected).
              whatsappNumber: z.string().nullable(),
              // Login "firewall": true when a member is currently locked out
              // (too many failed logins). Drives the glowing lock + Unlock.
              locked: z.boolean(),
              lockedMembers: z.number().int(),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgs = await withRlsBypass(async (tx) => {
        const where = {
          ...(req.query.status ? { status: req.query.status } : {}),
          ...(req.query.q
            ? {
                OR: [
                  { name: { contains: req.query.q, mode: 'insensitive' as const } },
                  { slug: { contains: req.query.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        };
        const rows = await tx.organization.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        });
        const { tokensToUsd, whatsappMessageCostUsd } = await import('../../lib/ai-pricing.js');
        // Billable WhatsApp conversations per org — Meta bills once per 24h
        // template conversation per user. One grouped query for all orgs;
        // the 24h window is approximated by a calendar-day bucket (the exact
        // greedy-24h count lives on the per-tenant billing page).
        const convRows = await tx.$queryRawUnsafe<
          { organization_id: string; conversations: bigint }[]
        >(
          `SELECT organization_id, COUNT(*)::bigint AS conversations FROM (
             SELECT organization_id, phone_e164, date_trunc('day', sent_at) AS d
             FROM broadcast_recipients
             WHERE sent_at IS NOT NULL
             GROUP BY organization_id, phone_e164, date_trunc('day', sent_at)
           ) t GROUP BY organization_id`,
        );
        const convByOrg = new Map(
          convRows.map((r) => [r.organization_id, Number(r.conversations)]),
        );
        return Promise.all(
          rows.map(async (o) => {
            const [memberCount, lockedMembers, productCount, serviceCount, lastAudit, wa, bcAgg, aiGroups] =
              await Promise.all([
                tx.membership.count({ where: { organizationId: o.id, isActive: true } }),
                // Members whose account is currently locked out (failed-login firewall).
                tx.membership.count({
                  where: {
                    organizationId: o.id,
                    isActive: true,
                    user: { lockedUntil: { gt: new Date() } },
                  },
                }),
                tx.product.count({ where: { organizationId: o.id, deletedAt: null } }),
                tx.service.count({ where: { organizationId: o.id, deletedAt: null } }),
                tx.auditLog.findFirst({
                  where: { organizationId: o.id },
                  orderBy: { createdAt: 'desc' },
                  select: { createdAt: true },
                }),
                // Primary number first; fall back to any connected number.
                tx.whatsAppChannel.findFirst({
                  where: { organizationId: o.id, displayPhoneNumber: { not: null } },
                  orderBy: { isPrimary: 'desc' },
                  select: { displayPhoneNumber: true },
                }),
                // Total broadcast messages actually sent across all campaigns.
                tx.broadcast.aggregate({
                  where: { organizationId: o.id },
                  _sum: { sentCount: true },
                }),
                // AI token usage grouped by model so we can price each correctly.
                tx.messageProvenance.groupBy({
                  by: ['model'],
                  where: { organizationId: o.id },
                  _sum: { promptTokens: true, completionTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
                }),
              ]);
            let aiTokens = 0;
            let aiCostUsd = 0;
            const aiCostBreakdown: { model: string; tokens: number; usd: number }[] = [];
            for (const g of aiGroups) {
              const pt = g._sum.promptTokens ?? 0;
              const ct = g._sum.completionTokens ?? 0;
              const usd = tokensToUsd(g.model, pt, ct, g._sum.cacheReadTokens ?? 0, g._sum.cacheWriteTokens ?? 0);
              aiTokens += pt + ct;
              aiCostUsd += usd;
              aiCostBreakdown.push({ model: g.model, tokens: pt + ct, usd: Number(usd.toFixed(4)) });
            }
            aiCostBreakdown.sort((a, b) => b.usd - a.usd);
            return {
              id: o.id,
              slug: o.slug,
              name: o.name,
              status: o.status,
              createdAt: o.createdAt.toISOString(),
              updatedAt: o.updatedAt.toISOString(),
              memberCount,
              productCount,
              serviceCount,
              broadcastMessages: bcAgg._sum.sentCount ?? 0,
              billableConversations: convByOrg.get(o.id) ?? 0,
              broadcastCostUsd: Number(whatsappMessageCostUsd(convByOrg.get(o.id) ?? 0).toFixed(2)),
              aiTokens,
              aiCostUsd: Number(aiCostUsd.toFixed(4)),
              aiCostBreakdown,
              monthlyPaidUsd: (o as { monthlyPaidUsd?: number | null }).monthlyPaidUsd ?? null,
              lastActivityAt: lastAudit?.createdAt.toISOString() ?? null,
              aiPlan: (o as { aiPlan?: 'basic' | 'middle' | 'max' | 'ultra' }).aiPlan ?? 'basic',
              disabledFeatures:
                (o as { disabledFeatures?: string[] }).disabledFeatures ?? [],
              whatsappNumber: wa?.displayPhoneNumber ?? null,
              locked: lockedMembers > 0,
              lockedMembers,
            };
          }),
        );
      });
      return { data: orgs, nextCursor: null };
    },
  );

  // ---------- POST /hq/orgs/:id/unlock -------------------------
  // Reset the login "firewall" for a tenant: clear the failed-login lockout on
  // EVERY member so they can sign in again. Aligned-admin only.
  r.post(
    '/hq/orgs/:id/unlock',
    {
      schema: {
        tags: ['admin'],
        summary: "Clear the failed-login lockout for all of a tenant's members so they can sign in.",
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(z.object({ unlocked: z.number().int() })) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const unlocked = await withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
        if (!org) throw notFound('Organisation not found.');
        const memberships = await tx.membership.findMany({
          where: { organizationId: orgId },
          select: { userId: true },
        });
        const userIds = [...new Set(memberships.map((m) => m.userId))];
        if (userIds.length === 0) return 0;
        // Clear the lock + reset the failed-attempt counter (the "firewall").
        const res = await tx.user.updateMany({
          where: {
            id: { in: userIds },
            OR: [{ lockedUntil: { not: null } }, { failedLoginAttempts: { gt: 0 } }],
          },
          data: { lockedUntil: null, failedLoginAttempts: 0 },
        });
        return res.count;
      });
      await recordAudit({
        action: 'user_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'login_lockout_cleared', usersUnlocked: unlocked },
      });
      return { data: { unlocked } };
    },
  );

  // ---------- POST /hq/orgs ------------------------------------
  // Provision a tenant on the customer's behalf. Skips email verification
  // (we're vouching for them) and optionally emails the new admin their
  // login + temporary password.
  r.post(
    '/hq/orgs',
    {
      schema: {
        tags: ['admin'],
        summary: 'Create a new tenant + admin user (skips email verify).',
        body: adminCreateTenantBodySchema,
        response: { 201: adminCreateTenantResponseSchema },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      const body = req.body;
      // Resolve slug: explicit value takes priority, else derived from name.
      // Append a numeric suffix if the candidate collides with an existing org.
      let candidate = body.organizationSlug?.trim().toLowerCase() || slugifyName(body.organizationName);
      if (!candidate) throw conflict('Organization name produces an empty slug.');

      const result = await withRlsBypass(async (tx) => {
        const existingUser = await tx.user.findUnique({ where: { email: body.adminEmail } });
        if (existingUser) throw conflict('A user with this email already exists.');

        // Ensure slug is unique. Loop with `-2`, `-3`, ... suffixes until
        // we find an open one. Bounded at 50 to avoid infinite loops on a
        // pathologically common name.
        let slug = candidate;
        for (let n = 2; n < 50; n++) {
          const taken = await tx.organization.findUnique({ where: { slug } });
          if (!taken) break;
          slug = `${candidate}-${n}`;
        }

        const password = body.adminPassword ?? generateTempPassword();
        const passwordHash = await hashPassword(password);

        // Opt-in features (e.g. Shopify) always start DISABLED on a new org —
        // an ALIGNED admin turns them on per-tenant later from the features
        // panel. (Absence from disabledFeatures can't distinguish "enable me"
        // from a non-UI client that doesn't know the key, so we force them off.)
        const organization = await tx.organization.create({
          data: {
            slug,
            name: body.organizationName,
            status: 'active',
            aiPlan: body.aiPlan ?? 'basic',
            disabledFeatures: Array.from(
              new Set([...(body.disabledFeatures ?? []), ...ORG_FEATURE_DEFAULT_DISABLED]),
            ),
            // undefined => column default (2000); explicit null => Unlimited.
            ...(body.monthlyAiMessageCap !== undefined
              ? { monthlyAiMessageCap: body.monthlyAiMessageCap }
              : {}),
          },
        });
        const admin = await tx.user.create({
          data: {
            email: body.adminEmail,
            passwordHash,
            firstName: body.adminFirstName,
            lastName: body.adminLastName || null,
            // Operator-provisioned ⇒ skip the verify-email flow.
            emailVerifiedAt: new Date(),
            status: 'active',
          },
        });
        await tx.membership.create({
          data: {
            userId: admin.id,
            organizationId: organization.id,
            role: 'admin',
            isActive: true,
          },
        });

        // Bootstrap a subscription on the requested plan (default `free`)
        // so usage caps + the billing UI render correctly from the get-go.
        const planCode = body.planCode ?? 'free';
        const plan = await tx.plan.findUnique({ where: { code: planCode } });
        if (plan) {
          await tx.subscription.create({
            data: {
              organizationId: organization.id,
              planId: plan.id,
              status: 'trialing',
            },
          });
        }

        await recordAudit({
          action: 'org_created',
          organizationId: organization.id,
          actorUserId: req.auth!.userId,
          metadata: { provisionedByAdmin: true, planCode },
        });
        await recordAudit({
          action: 'user_created',
          organizationId: organization.id,
          actorUserId: req.auth!.userId,
          entityType: 'user',
          entityId: admin.id,
          metadata: { provisionedByAdmin: true },
        });

        return { organization, admin, generatedPassword: body.adminPassword ? null : password };
      });

      // WhatsApp wallet — set up after the tx (the wallet engine uses the owner
      // connection). Price first, then an optional starting balance (a top-up
      // auto-enables metering); otherwise honour the explicit metering flag.
      try {
        const orgId = result.organization.id;
        if (body.walletPricePerMessageUsd != null) {
          await wallet.setPrice(orgId, usdToMicros(body.walletPricePerMessageUsd));
        }
        if (body.walletInitialTopUpUsd && body.walletInitialTopUpUsd > 0) {
          await wallet.topUp(
            orgId,
            usdToMicros(body.walletInitialTopUpUsd),
            req.auth!.userId,
            'Initial balance on provisioning',
          );
        } else if (body.walletMeteringEnabled) {
          await wallet.setMetering(orgId, true);
        }
      } catch (err) {
        req.log.error({ err }, '[admin] wallet provisioning failed (non-fatal)');
      }

      // Email — outside the tx. Failure logs but doesn't roll back the
      // provision; operator can resend or reset password from the UI.
      let welcomeEmailSent = false;
      if (body.sendWelcomeEmail) {
        const tpl = tenantProvisionedTemplate({
          firstName: body.adminFirstName,
          organizationName: result.organization.name,
          email: result.admin.email,
          password: result.generatedPassword ?? body.adminPassword ?? '',
          loginUrl: `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/login`,
        });
        try {
          await sendEmail({ to: result.admin.email, ...tpl });
          welcomeEmailSent = true;
        } catch (err) {
          req.log.warn({ err }, '[admin] tenant welcome email failed');
        }
      }

      reply.code(201);
      return {
        data: {
          organization: {
            id: result.organization.id,
            slug: result.organization.slug,
            name: result.organization.name,
            status: result.organization.status,
            createdAt: result.organization.createdAt.toISOString(),
            updatedAt: result.organization.updatedAt.toISOString(),
          },
          admin: {
            id: result.admin.id,
            email: result.admin.email,
            firstName: result.admin.firstName,
            lastName: result.admin.lastName,
          },
          generatedPassword: result.generatedPassword,
          welcomeEmailSent,
        },
      };
    },
  );

  // ---------- PATCH /hq/orgs/:id -------------------------------
  r.patch(
    '/hq/orgs/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Suspend / re-activate / rename an organisation.',
        params: z.object({ id: uuidSchema }),
        body: adminUpdateOrgBodySchema,
        response: { 200: itemEnvelopeSchema(organizationSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const updated = await withRlsBypass((tx) =>
        tx.organization.update({
          where: { id: req.params.id },
          data: {
            status: req.body.status ?? undefined,
            name: req.body.name ?? undefined,
          },
        }),
      );
      if (req.body.status === 'suspended') {
        await recordAudit({
          action: 'org_suspended',
          organizationId: updated.id,
          actorUserId: req.auth!.userId,
        });
      }
      return {
        data: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          status: updated.status,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      };
    },
  );

  // ---------- DELETE /hq/orgs/:id ------------------------------
  r.delete(
    '/hq/orgs/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Hard-delete an organisation and all its data.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const target = await withRlsBypass((tx) => tx.organization.findUnique({ where: { id: req.params.id } }));
      if (!target) throw notFound('Organisation not found.');
      await withRlsBypass((tx) => tx.organization.delete({ where: { id: target.id } }));
      // organizationId is intentionally omitted — the org row (and any FK from
      // audit_logs) is gone; the deleted org's identity lives in entityId/metadata.
      await recordAudit({
        action: 'org_deleted',
        actorUserId: req.auth!.userId,
        entityType: 'organization',
        entityId: target.id,
        metadata: { slug: target.slug, name: target.name },
      });
      return { ok: true as const };
    },
  );

  // ---------- GET /hq/orgs/:id/details -------------------------
  // Drill-down for a single tenant. Returns the metadata an ALIGNED
  // admin needs to understand or troubleshoot the account — members
  // with email + role + last-login + 2FA status, WhatsApp channel
  // health, custom-domain status, recent audit log. Passwords are
  // bcrypt-hashed at rest by design — they are NOT recoverable here
  // (or anywhere). For lockouts, use /users/:id/reset-link below.
  r.get(
    '/hq/orgs/:id/details',
    {
      schema: {
        tags: ['admin'],
        summary: 'Full details for one organisation: members + channel + recent activity.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              id: uuidSchema,
              name: z.string(),
              slug: z.string(),
              status: z.string(),
              createdAt: z.string().datetime(),
              members: z.array(
                z.object({
                  userId: uuidSchema,
                  email: z.string(),
                  firstName: z.string().nullable(),
                  lastName: z.string().nullable(),
                  role: z.string(),
                  isActive: z.boolean(),
                  status: z.string(),
                  emailVerified: z.boolean(),
                  totpEnabled: z.boolean(),
                  lastLoginAt: z.string().datetime().nullable(),
                  failedLoginAttempts: z.number().int(),
                  lockedUntil: z.string().datetime().nullable(),
                  joinedAt: z.string().datetime(),
                }),
              ),
              whatsappChannel: z
                .object({
                  displayPhoneNumber: z.string().nullable(),
                  phoneNumberId: z.string().nullable(),
                  isActive: z.boolean(),
                  isPrimary: z.boolean(),
                })
                .nullable(),
              counts: z.object({
                products: z.number().int(),
                services: z.number().int(),
                faqs: z.number().int(),
                apiKeys: z.number().int(),
                webhooks: z.number().int(),
              }),
              recentAuditLog: z.array(
                z.object({
                  action: z.string(),
                  actorEmail: z.string().nullable(),
                  ipAddress: z.string().nullable(),
                  createdAt: z.string().datetime(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) =>
      withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: req.params.id } });
        if (!org) throw notFound('Organisation not found.');

        const memberships = await tx.membership.findMany({
          where: { organizationId: org.id },
          orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                status: true,
                emailVerifiedAt: true,
                totpEnabled: true,
                lastLoginAt: true,
                failedLoginAttempts: true,
                lockedUntil: true,
              },
            },
          },
        });

        const channel = await tx.whatsAppChannel.findFirst({
          where: { organizationId: org.id, isPrimary: true },
          select: {
            displayPhoneNumber: true,
            phoneNumberId: true,
            isActive: true,
            isPrimary: true,
          },
        });

        const [productCount, serviceCount, faqCount, apiKeyCount, webhookCount] = await Promise.all([
          tx.product.count({ where: { organizationId: org.id, deletedAt: null } }),
          tx.service.count({ where: { organizationId: org.id, deletedAt: null } }),
          tx.fAQ.count({ where: { organizationId: org.id } }),
          tx.apiKey.count({ where: { organizationId: org.id, revokedAt: null } }),
          tx.webhookEndpoint.count({ where: { organizationId: org.id } }),
        ]);

        const audit = await tx.auditLog.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            actor: { select: { email: true } },
          },
        });

        return {
          data: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            status: org.status,
            createdAt: org.createdAt.toISOString(),
            members: memberships.map((m) => ({
              userId: m.user.id,
              email: m.user.email,
              firstName: m.user.firstName,
              lastName: m.user.lastName,
              role: m.role,
              isActive: m.isActive,
              status: m.user.status,
              emailVerified: !!m.user.emailVerifiedAt,
              totpEnabled: m.user.totpEnabled,
              lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
              failedLoginAttempts: m.user.failedLoginAttempts,
              lockedUntil: m.user.lockedUntil?.toISOString() ?? null,
              joinedAt: m.createdAt.toISOString(),
            })),
            whatsappChannel: channel,
            counts: {
              products: productCount,
              services: serviceCount,
              faqs: faqCount,
              apiKeys: apiKeyCount,
              webhooks: webhookCount,
            },
            recentAuditLog: audit.map((a) => ({
              action: String(a.action),
              actorEmail: a.actor?.email ?? null,
              ipAddress: a.ipAddress ? String(a.ipAddress) : null,
              createdAt: a.createdAt.toISOString(),
            })),
          },
        };
      }),
  );

  // ---------- PATCH /hq/users/:id ------------------------------
  // ALIGNED-admin can update a tenant member's email after the fact —
  // common ask when a customer changes jobs / email providers / asks for
  // a typo to be fixed. Constraints:
  //   • new email must be a syntactically valid address
  //   • email is globally unique (citext) → 409 if it's already in use
  //   • change forces re-verification: emailVerifiedAt is cleared and the
  //     standard verify-email flow can fire from the portal. This stops
  //     a typo'd email becoming a working login without the new mailbox
  //     ever being proven.
  //   • all sessions revoked so the OLD email stops working immediately
  //   • audited on both the user and the org so the action is traceable
  r.patch(
    '/hq/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: "Update a tenant member's email (admin convenience). Forces re-verification.",
        params: z.object({ id: uuidSchema }),
        body: z.object({
          email: z.string().email().max(254),
        }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              userId: uuidSchema,
              email: z.string(),
              emailVerifiedAt: z.string().datetime().nullable(),
              sessionsRevoked: z.number().int(),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const newEmail = req.body.email.trim().toLowerCase();
      const result = await withRlsBypass(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: req.params.id } });
        if (!user) throw notFound('User not found.');
        if (user.email.toLowerCase() === newEmail) {
          return {
            userId: user.id,
            email: user.email,
            emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
            sessionsRevoked: 0,
            unchanged: true,
            previousEmail: user.email,
          };
        }
        const taken = await tx.user.findUnique({ where: { email: newEmail } });
        if (taken) throw conflict('That email is already in use by another account.');
        const previousEmail = user.email;
        const updated = await tx.user.update({
          where: { id: user.id },
          data: {
            email: newEmail,
            // Force re-verification of the new mailbox. The user can
            // request a fresh verify-email link from the portal, or the
            // ALIGNED admin can issue a reset-link (which lets them in
            // without email verification per the existing login gate
            // logic — reset implies control of the new email).
            emailVerifiedAt: null,
            emailVerificationTokenHash: null,
            emailVerificationExpiresAt: null,
          },
        });
        // Revoke every live session so the OLD-email login stops working
        // and any open browser tab gets bounced to /login on next refresh.
        const sessions = await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return {
          userId: updated.id,
          email: updated.email,
          emailVerifiedAt: updated.emailVerifiedAt?.toISOString() ?? null,
          sessionsRevoked: sessions.count,
          unchanged: false,
          previousEmail,
        };
      });

      if (!result.unchanged) {
        // Audit on the user. Find the user's primary org for the
        // organizationId field (best-effort — if the user has no
        // memberships, leave it null and the entry still lands).
        const primaryMembership = await withRlsBypass((tx) =>
          tx.membership.findFirst({
            where: { userId: result.userId, isActive: true },
            orderBy: { createdAt: 'asc' },
            select: { organizationId: true },
          }),
        );
        await recordAudit({
          action: 'user_updated',
          actorUserId: req.auth!.userId,
          organizationId: primaryMembership?.organizationId,
          entityType: 'user',
          entityId: result.userId,
          metadata: {
            event: 'aligned_admin_email_change',
            previousEmail: result.previousEmail,
            newEmail: result.email,
            sessionsRevoked: result.sessionsRevoked,
          },
        });
      }

      return {
        data: {
          userId: result.userId,
          email: result.email,
          emailVerifiedAt: result.emailVerifiedAt,
          sessionsRevoked: result.sessionsRevoked,
        },
      };
    },
  );

  // ---------- POST /hq/users/:id/reset-link ---------------------
  // ALIGNED-admin convenience: generate a one-time, short-TTL password
  // reset link for any tenant member and return the URL. The admin then
  // DMs it to the customer (Slack / WhatsApp / email).
  //
  // 10-minute TTL because the admin-issued path is high-touch — the
  // operator generates the URL, sends it to a known customer over a
  // synchronous channel, and the customer acts on it immediately. A
  // longer window would just sit around as a credential to be leaked.
  //
  // We use the EXACT same token shape as /auth/forgot-password — the
  // /reset-password page on the portal already validates these. Token
  // is hashed at rest; only the plaintext URL returned here can
  // actually reset the password.
  //
  // We do NOT show the customer's current password. Passwords are
  // bcrypt-hashed; the platform never has the plaintext.
  const ADMIN_RESET_TTL_MS = 10 * 60 * 1000;
  r.post(
    '/hq/users/:id/reset-link',
    {
      schema: {
        tags: ['admin'],
        summary: 'Generate a 10-minute password-reset URL for any user (admin convenience).',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              userEmail: z.string(),
              resetUrl: z.string().url(),
              expiresAt: z.string().datetime(),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { generateOpaqueToken, hashToken } = await import('../../lib/crypto.js');
      const expiresAt = new Date(Date.now() + ADMIN_RESET_TTL_MS);
      const result = await withRlsBypass(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: req.params.id } });
        if (!user) throw notFound('User not found.');
        const token = generateOpaqueToken();
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordResetTokenHash: hashToken(token),
            passwordResetExpiresAt: expiresAt,
          },
        });
        return { email: user.email, token };
      });
      await recordAudit({
        action: 'password_reset_requested',
        actorUserId: req.auth!.userId,
        entityType: 'user',
        entityId: req.params.id,
        metadata: { event: 'aligned_admin_issued_reset_link', userEmail: result.email },
      });
      return {
        data: {
          userEmail: result.email,
          resetUrl: `${env.WEB_PUBLIC_URL}/reset-password?token=${result.token}`,
          expiresAt: expiresAt.toISOString(),
        },
      };
    },
  );

  // ---------- POST /hq/orgs/:id/impersonate --------------------
  // ALIGNED-admin "Control" action: issue a brand-new session bound to
  // the target org so the admin can browse + edit the tenant's data
  // exactly as one of its own admins would. The previous session is
  // revoked so navigation is unambiguous, and the action is recorded in
  // the audit log on the target org.
  //
  // Membership is NOT required — that's the whole point. getSessionContext
  // synthesises a virtual 'admin' role for ALIGNED admins that don't have
  // a membership row, so the rest of the app behaves normally.
  r.post(
    '/hq/orgs/:id/impersonate',
    {
      schema: {
        tags: ['admin'],
        summary: 'Mint a session for the target org so the admin can control it.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              accessToken: z.string(),
              expiresAt: z.string().datetime(),
              organizationId: uuidSchema,
              organizationSlug: z.string(),
              organizationName: z.string(),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      const target = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: req.params.id } }),
      );
      if (!target) throw notFound('Organisation not found.');
      if (target.status !== 'active') {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'This organisation is not active. Reactivate it first, then try Control again.',
        );
      }

      // Revoke the current session so the admin never has two open at
      // once (the new one is for the target org, so the old is stale).
      if (req.auth?.sessionId) {
        await withRlsBypass((tx) =>
          tx.session.update({
            where: { id: req.auth!.sessionId },
            data: { revokedAt: new Date() },
          }),
        );
      }

      const meta = {
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      };
      const tokens = await issueSession({
        userId: req.auth!.userId,
        organizationId: target.id,
        role: 'admin',
        isSuperAdmin: true,
        meta,
        // Sprint 1 H-3 — mark the session as impersonation so refreshSession
        // allows the no-membership admin-role synthesis to continue working.
        isImpersonation: true,
      });

      reply.setCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, refreshCookieOptions());

      // Transparent to the tenant: a clearly-labeled entry in THEIR audit log
      // (the reader redacts the HQ email, showing only the HQ username).
      await recordAudit({
        action: 'aligned_admin_accessed',
        organizationId: target.id,
        actorUserId: req.auth!.userId,
        entityType: 'organization',
        entityId: target.id,
        metadata: {
          target_org_slug: target.slug,
          target_org_name: target.name,
        },
      });

      return {
        data: {
          accessToken: tokens.accessToken,
          // issueSession returns a Date; the Zod schema expects ISO string.
          expiresAt:
            tokens.expiresAt instanceof Date
              ? tokens.expiresAt.toISOString()
              : (tokens.expiresAt as unknown as string),
          organizationId: target.id,
          organizationSlug: target.slug,
          organizationName: target.name,
        },
      };
    },
  );

  // ---------- GET /hq/users ------------------------------------
  // Every user across every tenant, with their org membership(s). Answers
  // "where are the N total users" — the dashboard counts distinct User rows,
  // which can exceed the sum of per-org members (multi-org users, HQ admins,
  // inactive memberships, or users with no membership at all).
  r.get(
    '/hq/users',
    {
      schema: {
        tags: ['admin'],
        summary: 'All users across every tenant (ALIGNED admins only).',
        response: {
          200: listEnvelopeSchema(
            z.object({
              id: uuidSchema,
              name: z.string().nullable(),
              email: z.string(),
              status: z.string(),
              emailVerified: z.boolean(),
              isSuperAdmin: z.boolean(),
              createdAt: z.string().datetime(),
              memberships: z.array(
                z.object({
                  organizationName: z.string().nullable(),
                  organizationSlug: z.string().nullable(),
                  role: z.string(),
                  isActive: z.boolean(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async () => {
      const users = await withRlsBypass((tx) =>
        tx.user.findMany({
          orderBy: { createdAt: 'desc' },
          include: {
            memberships: {
              include: { organization: { select: { name: true, slug: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
        }),
      );
      return {
        data: users.map((u) => ({
          id: u.id,
          name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null,
          email: u.email,
          status: u.status,
          emailVerified: u.emailVerifiedAt !== null,
          isSuperAdmin: u.isSuperAdmin,
          createdAt: u.createdAt.toISOString(),
          memberships: u.memberships.map((m) => ({
            organizationName: m.organization?.name ?? null,
            organizationSlug: m.organization?.slug ?? null,
            role: m.role,
            isActive: m.isActive,
          })),
        })),
        nextCursor: null,
      };
    },
  );

  // ---------- GET /hq/users/:id --------------------------------
  // One user with full info: org memberships + their recent activity (audit
  // entries where they were the actor, across every tenant).
  r.get(
    '/hq/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'One user with memberships + recent activity (ALIGNED admins only).',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              id: uuidSchema,
              firstName: z.string().nullable(),
              lastName: z.string().nullable(),
              name: z.string().nullable(),
              email: z.string(),
              status: z.string(),
              emailVerified: z.boolean(),
              isSuperAdmin: z.boolean(),
              createdAt: z.string().datetime(),
              memberships: z.array(
                z.object({
                  organizationId: uuidSchema,
                  organizationName: z.string().nullable(),
                  organizationSlug: z.string().nullable(),
                  role: z.string(),
                  isActive: z.boolean(),
                }),
              ),
              activity: z.array(
                z.object({
                  id: uuidSchema,
                  action: z.string(),
                  entityType: z.string().nullable(),
                  organizationName: z.string().nullable(),
                  createdAt: z.string().datetime(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { id } = req.params;
      return withRlsBypass(async (tx) => {
        const u = await tx.user.findUnique({
          where: { id },
          include: {
            memberships: {
              include: { organization: { select: { name: true, slug: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
        if (!u) throw notFound('User not found.');
        const activity = await tx.auditLog.findMany({
          where: { actorUserId: id },
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { organization: { select: { name: true } } },
        });
        return {
          data: {
            id: u.id,
            firstName: u.firstName,
            lastName: u.lastName,
            name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null,
            email: u.email,
            status: u.status,
            emailVerified: u.emailVerifiedAt !== null,
            isSuperAdmin: u.isSuperAdmin,
            createdAt: u.createdAt.toISOString(),
            memberships: u.memberships.map((m) => ({
              organizationId: m.organizationId,
              organizationName: m.organization?.name ?? null,
              organizationSlug: m.organization?.slug ?? null,
              role: m.role,
              isActive: m.isActive,
            })),
            activity: activity.map((a) => ({
              id: a.id,
              action: a.action,
              entityType: a.entityType,
              organizationName: a.organization?.name ?? null,
              createdAt: a.createdAt.toISOString(),
            })),
          },
        };
      });
    },
  );

  // ---------- PATCH /hq/users/:id ------------------------------
  // Edit a user from the HQ users console: name, account status, email-verified
  // flag, and HQ-admin grant. Guards against self-lockout.
  r.patch(
    '/hq/users/:id/account',
    {
      schema: {
        tags: ['admin'],
        summary: 'Edit a user (ALIGNED admins only).',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          firstName: z.string().trim().max(100).nullable().optional(),
          lastName: z.string().trim().max(100).nullable().optional(),
          status: z.enum(['active', 'disabled']).optional(),
          emailVerified: z.boolean().optional(),
          isSuperAdmin: z.boolean().optional(),
        }),
        response: { 200: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      const actorId = req.auth!.userId;
      // Don't let an admin lock themselves out from this very console.
      if (id === actorId && (b.status === 'disabled' || b.isSuperAdmin === false)) {
        throw conflict('You cannot disable or remove HQ-admin from your own account here.');
      }
      await withRlsBypass(async (tx) => {
        const exists = await tx.user.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw notFound('User not found.');
        await tx.user.update({
          where: { id },
          data: {
            ...(b.firstName !== undefined ? { firstName: b.firstName } : {}),
            ...(b.lastName !== undefined ? { lastName: b.lastName } : {}),
            ...(b.status !== undefined ? { status: b.status } : {}),
            ...(b.emailVerified !== undefined
              ? { emailVerifiedAt: b.emailVerified ? new Date() : null }
              : {}),
            ...(b.isSuperAdmin !== undefined ? { isSuperAdmin: b.isSuperAdmin } : {}),
          },
        });
      });
      await recordAudit({
        action: 'user_updated',
        actorUserId: actorId,
        entityType: 'user',
        entityId: id,
        metadata: { fields: Object.keys(b), via: 'hq_users_console' },
      });
      return { data: { id } };
    },
  );

  // ---------- POST /hq/users/:id/link-org ----------------------
  // Add the user as a member of another tenant (or update their role there).
  r.post(
    '/hq/users/:id/link-org',
    {
      schema: {
        tags: ['admin'],
        summary: 'Link a user to another organization (ALIGNED admins only).',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          organizationId: uuidSchema,
          role: z.enum(['admin', 'editor', 'viewer']),
        }),
        response: { 200: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { id } = req.params;
      const { organizationId, role } = req.body;
      await withRlsBypass(async (tx) => {
        const u = await tx.user.findUnique({ where: { id }, select: { id: true } });
        if (!u) throw notFound('User not found.');
        const org = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { id: true },
        });
        if (!org) throw notFound('Organization not found.');
        await tx.membership.upsert({
          where: { organizationId_userId: { organizationId, userId: id } },
          create: { organizationId, userId: id, role, isActive: true },
          update: { role, isActive: true },
        });
      });
      await recordAudit({
        action: 'user_role_changed',
        organizationId,
        actorUserId: req.auth!.userId,
        entityType: 'membership',
        entityId: id,
        metadata: { via: 'hq_link_org', role },
      });
      return { data: { id } };
    },
  );

  // ---------- DELETE /hq/users/:id -----------------------------
  // Delete an account: drop all memberships, anonymize the email (freeing it
  // for reuse), disable login, and revoke every session. Mirrors the soft-
  // delete the members module does when a user loses their last membership.
  r.delete(
    '/hq/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Delete (anonymize) a user account (ALIGNED admins only).',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { id } = req.params;
      if (id === req.auth!.userId) throw conflict('You cannot delete your own account.');
      await withRlsBypass(async (tx) => {
        const u = await tx.user.findUnique({ where: { id }, select: { id: true } });
        if (!u) throw notFound('User not found.');
        await tx.membership.deleteMany({ where: { userId: id } });
        await tx.user.update({
          where: { id },
          data: {
            email: `removed+${id}@deleted.invalid`,
            status: 'disabled',
            passwordHash: '!',
            isSuperAdmin: false,
            firstName: null,
            lastName: null,
            emailVerifiedAt: null,
            emailVerificationTokenHash: null,
            passwordResetTokenHash: null,
            totpEnabled: false,
            totpSecret: null,
            sessions: {
              updateMany: { where: { revokedAt: null }, data: { revokedAt: new Date() } },
            },
          },
        });
      });
      await recordAudit({
        action: 'user_removed',
        actorUserId: req.auth!.userId,
        entityType: 'user',
        entityId: id,
        metadata: { via: 'hq_users_console' },
      });
      return { data: { id } };
    },
  );

  // ---------- PATCH /hq/orgs/:id/billing -----------------------
  // Set the manual monthly payment (USD) for a tenant — powers Billing & overview.
  r.patch(
    '/hq/orgs/:id/billing',
    {
      schema: {
        tags: ['admin'],
        summary: 'Set a tenant’s manual monthly payment (ALIGNED admins only).',
        params: z.object({ id: uuidSchema }),
        body: z.object({ monthlyPaidUsd: z.number().min(0).nullable() }),
        response: { 200: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { id } = req.params;
      await withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id }, select: { id: true } });
        if (!org) throw notFound('Organization not found.');
        await tx.organization.update({
          where: { id },
          data: { monthlyPaidUsd: req.body.monthlyPaidUsd } as never,
        });
      });
      return { data: { id } };
    },
  );

  // ---------- GET /hq/orgs/:id/overview ------------------------
  // Full per-tenant cost & usage breakdown for a time range — powers the
  // dedicated Billing & overview PAGE. Every cost source: AI tokens (per model),
  // voice transcription, Wasabi storage, WhatsApp messaging/broadcasts.
  // Time-ranged metrics use [from,to]; storage + counts + numbers are snapshots.
  r.get(
    '/hq/orgs/:id/overview',
    {
      schema: {
        tags: ['admin'],
        summary: 'Per-tenant cost & usage breakdown for a date range.',
        params: z.object({ id: uuidSchema }),
        querystring: z.object({
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              org: z.object({
                id: uuidSchema,
                name: z.string(),
                slug: z.string(),
                status: z.string(),
                aiPlan: z.string(),
                monthlyPaidUsd: z.number().nullable(),
                createdAt: z.string().datetime(),
                disabledFeatures: z.array(z.string()),
              }),
              range: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
              ai: z.object({
                tokens: z.number().int(),
                costUsd: z.number(),
                byModel: z.array(
                  z.object({ model: z.string(), tokens: z.number().int(), usd: z.number() }),
                ),
              }),
              transcription: z.object({
                enabled: z.boolean(),
                count: z.number().int(),
                voiceNotesTotal: z.number().int(),
                costUsd: z.number(),
              }),
              storage: z.object({
                totalBytes: z.number(),
                objectCount: z.number().int(),
                addedBytes: z.number(),
                monthlyCostUsd: z.number(),
              }),
              whatsapp: z.object({
                numbers: z.number().int(),
                broadcasts: z.number().int(),
                broadcastMessages: z.number().int(),
                billableConversations: z.number().int(),
                outboundMessages: z.number().int(),
                inboundMessages: z.number().int(),
                costUsd: z.number(),
              }),
              counts: z.object({
                members: z.number().int(),
                products: z.number().int(),
                services: z.number().int(),
                contacts: z.number().int(),
              }),
              totals: z.object({
                estimatedCostUsd: z.number(),
                monthlyPaidUsd: z.number().nullable(),
              }),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { id } = req.params;
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const from = req.query.from
        ? new Date(req.query.from)
        : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const inRange = { gte: from, lte: to };

      const { tokensToUsd, transcriptionCostUsd, whatsappMessageCostUsd, storageCostUsd } =
        await import('../../lib/ai-pricing.js');

      const data = await withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({
          where: { id },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            createdAt: true,
            monthlyPaidUsd: true,
            aiPlan: true,
            disabledFeatures: true,
          } as never,
        });
        if (!org) throw notFound('Organization not found.');
        const o = org as unknown as {
          id: string;
          name: string;
          slug: string;
          status: string;
          createdAt: Date;
          monthlyPaidUsd: number | null;
          aiPlan: string | null;
          disabledFeatures: string[] | null;
        };

        const [
          aiGroups,
          transcribedCount,
          voiceNotesTotal,
          storageAll,
          storageAdded,
          bcAgg,
          broadcastsCount,
          outboundMessages,
          inboundMessages,
          numbers,
          members,
          products,
          services,
          contacts,
          recipientSends,
          templateSends,
        ] = await Promise.all([
          tx.messageProvenance.groupBy({
            by: ['model'],
            where: { organizationId: id, createdAt: inRange },
            _sum: { promptTokens: true, completionTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
          }),
          tx.whatsAppMessage.count({
            where: {
              organizationId: id,
              direction: 'inbound',
              messageType: { in: ['audio', 'voice'] },
              body: { startsWith: '🎙' },
              receivedAt: inRange,
            },
          }),
          tx.whatsAppMessage.count({
            where: {
              organizationId: id,
              direction: 'inbound',
              messageType: { in: ['audio', 'voice'] },
              receivedAt: inRange,
            },
          }),
          tx.asset.aggregate({ where: { organizationId: id }, _sum: { byteSize: true }, _count: true }),
          tx.asset.aggregate({
            where: { organizationId: id, createdAt: inRange },
            _sum: { byteSize: true },
          }),
          tx.broadcast.aggregate({
            where: { organizationId: id, createdAt: inRange },
            _sum: { sentCount: true },
          }),
          tx.broadcast.count({ where: { organizationId: id, createdAt: inRange } }),
          tx.whatsAppMessage.count({
            where: { organizationId: id, direction: 'outbound', receivedAt: inRange },
          }),
          tx.whatsAppMessage.count({
            where: { organizationId: id, direction: 'inbound', receivedAt: inRange },
          }),
          tx.whatsAppChannel.count({ where: { organizationId: id } }),
          tx.membership.count({ where: { organizationId: id, isActive: true } }),
          tx.product.count({ where: { organizationId: id, deletedAt: null } }),
          tx.service.count({ where: { organizationId: id, deletedAt: null } }),
          tx.contact.count({ where: { organizationId: id } }),
          // Template-initiated sends for billable-conversation counting. Broadcast
          // recipients (the bulk) + any standalone template messages. sentAt/
          // receivedAt in range; we group per phone into 24h windows below.
          tx.broadcastRecipient.findMany({
            where: { organizationId: id, sentAt: inRange },
            select: { phoneE164: true, sentAt: true },
            take: 200_000,
          }),
          tx.whatsAppMessage.findMany({
            where: {
              organizationId: id,
              direction: 'outbound',
              messageType: 'template',
              receivedAt: inRange,
            },
            select: { receivedAt: true, thread: { select: { customerPhone: true } } },
            take: 200_000,
          }),
        ]);

        // Billable WhatsApp conversations: Meta charges once per 24h conversation
        // a template opens with a user; everything inside that window (and inbound)
        // is free. So we group every template send per phone into greedy 24h
        // windows and count the windows — NOT raw message volume.
        const sendsByPhone = new Map<string, number[]>();
        const addSend = (phone: string | null | undefined, at: Date | null | undefined) => {
          if (!phone || !at) return;
          // Normalise to digits only — BroadcastRecipient stores "96170…" while
          // a thread's customerPhone may be "+96170…"; without this the same
          // user counts twice (broadcast row + mirrored template message).
          const key = phone.replace(/\D/g, '');
          if (!key) return;
          const arr = sendsByPhone.get(key);
          if (arr) arr.push(at.getTime());
          else sendsByPhone.set(key, [at.getTime()]);
        };
        for (const r of recipientSends) addSend(r.phoneE164, r.sentAt);
        for (const m of templateSends) addSend(m.thread?.customerPhone, m.receivedAt);
        let billableConversations = 0;
        for (const times of sendsByPhone.values()) {
          times.sort((a, b) => a - b);
          let windowEnd = -Infinity;
          for (const ts of times) {
            if (ts >= windowEnd) {
              billableConversations += 1;
              windowEnd = ts + 24 * 60 * 60 * 1000;
            }
          }
        }

        let aiTokens = 0;
        let aiCostUsd = 0;
        const byModel: { model: string; tokens: number; usd: number }[] = [];
        for (const g of aiGroups) {
          const pt = g._sum.promptTokens ?? 0;
          const ct = g._sum.completionTokens ?? 0;
          const usd = tokensToUsd(g.model, pt, ct, g._sum.cacheReadTokens ?? 0, g._sum.cacheWriteTokens ?? 0);
          aiTokens += pt + ct;
          aiCostUsd += usd;
          byModel.push({ model: g.model, tokens: pt + ct, usd: Number(usd.toFixed(4)) });
        }
        byModel.sort((a, b) => b.usd - a.usd);

        const totalBytes = storageAll._sum.byteSize ?? 0;
        const addedBytes = storageAdded._sum.byteSize ?? 0;
        const broadcastMessages = bcAgg._sum.sentCount ?? 0;

        const transcriptionEnabled = !(o.disabledFeatures ?? []).includes('voice_transcription');
        const transcriptionUsd = transcriptionCostUsd(transcribedCount);
        // Meta bills per 24h template conversation, not per message → price the
        // billable conversation count.
        const whatsappUsd = whatsappMessageCostUsd(billableConversations);
        const storageMonthlyUsd = storageCostUsd(totalBytes);
        const estimatedCostUsd =
          aiCostUsd + transcriptionUsd + whatsappUsd + storageMonthlyUsd;

        return {
          org: {
            id: o.id,
            name: o.name,
            slug: o.slug,
            status: o.status,
            aiPlan: o.aiPlan ?? 'basic',
            monthlyPaidUsd: o.monthlyPaidUsd ?? null,
            createdAt: o.createdAt.toISOString(),
            disabledFeatures: o.disabledFeatures ?? [],
          },
          range: { from: from.toISOString(), to: to.toISOString() },
          ai: { tokens: aiTokens, costUsd: Number(aiCostUsd.toFixed(4)), byModel },
          transcription: {
            enabled: transcriptionEnabled,
            count: transcribedCount,
            voiceNotesTotal,
            costUsd: Number(transcriptionUsd.toFixed(4)),
          },
          storage: {
            totalBytes,
            objectCount: storageAll._count,
            addedBytes,
            monthlyCostUsd: Number(storageMonthlyUsd.toFixed(4)),
          },
          whatsapp: {
            numbers,
            broadcasts: broadcastsCount,
            broadcastMessages,
            billableConversations,
            outboundMessages,
            inboundMessages,
            costUsd: Number(whatsappUsd.toFixed(4)),
          },
          counts: { members, products, services, contacts },
          totals: {
            estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
            monthlyPaidUsd: o.monthlyPaidUsd ?? null,
          },
        };
      });

      return { data };
    },
  );

  // ---------- GET /hq/system -----------------------------------
  // System health snapshot. Exact numbers (queue depth, redis info) are pulled live.
  r.get(
    '/hq/system',
    {
      schema: {
        tags: ['admin'],
        summary: 'Live system health snapshot for ALIGNED operators.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              orgs: z.object({ active: z.number(), suspended: z.number(), deleted: z.number() }),
              users: z.object({ total: z.number(), pending: z.number(), disabled: z.number() }),
              queues: z.object({
                import: z.object({ waiting: z.number(), active: z.number(), failed: z.number() }),
                sync: z.object({ waiting: z.number(), active: z.number(), failed: z.number() }),
                webhook: z.object({ waiting: z.number(), active: z.number(), failed: z.number() }),
              }),
              redis: z.object({ connected: z.boolean(), opsPerSec: z.number().nullable() }),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async () => {
      const [orgsActive, orgsSuspended, orgsDeleted, usersTotal, usersPending, usersDisabled] = await withRlsBypass(
        (tx) =>
          Promise.all([
            tx.organization.count({ where: { status: 'active' } }),
            tx.organization.count({ where: { status: 'suspended' } }),
            tx.organization.count({ where: { status: 'deleted' } }),
            tx.user.count(),
            tx.user.count({ where: { status: 'pending' } }),
            tx.user.count({ where: { status: 'disabled' } }),
          ]),
      );

      const [importCounts, syncCounts, webhookCounts] = await Promise.all([
        getImportQueue().getJobCounts(),
        getSyncQueue().getJobCounts(),
        getWebhookQueue().getJobCounts(),
      ]);

      const redis = getRedis();
      let connected = true;
      let opsPerSec: number | null = null;
      try {
        const info = await redis.info('stats');
        const m = info.match(/instantaneous_ops_per_sec:(\d+)/);
        opsPerSec = m && m[1] ? Number(m[1]) : null;
      } catch {
        connected = false;
      }

      return {
        data: {
          orgs: { active: orgsActive, suspended: orgsSuspended, deleted: orgsDeleted },
          users: { total: usersTotal, pending: usersPending, disabled: usersDisabled },
          queues: {
            // BullMQ's getJobCounts() types each bucket as `number | undefined`
            // even though it always returns 0 when the bucket has no jobs.
            // Coerce to 0 to satisfy the strict z.number() response schema.
            import: {
              waiting: importCounts.waiting ?? 0,
              active: importCounts.active ?? 0,
              failed: importCounts.failed ?? 0,
            },
            sync: {
              waiting: syncCounts.waiting ?? 0,
              active: syncCounts.active ?? 0,
              failed: syncCounts.failed ?? 0,
            },
            webhook: {
              waiting: webhookCounts.waiting ?? 0,
              active: webhookCounts.active ?? 0,
              failed: webhookCounts.failed ?? 0,
            },
          },
          redis: { connected, opsPerSec },
        },
      };
    },
  );

  // ---------- Bot eval dashboard (WS3) ------------------------------------
  // Read-only surface over the eval_runs table. Runs are produced by the eval
  // harness's `--persist` flag (pre-deploy / manual runs against prod); this
  // endpoint never executes the engine — it just reports the latest verdicts.
  const evalTenantRowSchema = z.object({
    org: z.string(),
    total: z.number(),
    retrievalScored: z.number(),
    retrievalHits: z.number(),
    deterministicPass: z.number(),
    judgeScored: z.number(),
    judgePass: z.number(),
    overallPass: z.number(),
  });
  const evalScenarioResultSchema = z.object({
    key: z.string(),
    dialect: z.string().nullish(),
    reply: z.string(),
    candidateSkus: z.array(z.string()),
    retrieval: z.object({
      hit: z.boolean(),
      found: z.array(z.string()),
      missing: z.array(z.string()),
      expected: z.number(),
    }),
    bestRank: z.number().nullable(),
    deterministic: z.object({ passed: z.boolean(), failures: z.array(z.string()) }),
    judge: z.object({ pass: z.boolean(), critique: z.string() }).nullish(),
    model: z.string().nullish(),
  });
  const evalSummarySchema = evalTenantRowSchema.extend({
    results: z.array(evalScenarioResultSchema),
  });
  const evalRunBaseSchema = z.object({
    id: z.string(),
    trigger: z.string(),
    mode: z.string(),
    threshold: z.number(),
    passed: z.boolean(),
    tenantCount: z.number(),
    passedCount: z.number(),
    gitSha: z.string().nullable(),
    note: z.string().nullable(),
    durationMs: z.number().nullable(),
    createdAt: z.string(),
  });

  // GET /hq/eval/runs — recent runs (compact per-tenant rollup only,
  // no per-scenario results, so the list stays light).
  r.get(
    '/hq/eval/runs',
    {
      schema: {
        tags: ['admin'],
        summary: 'Recent bot-eval runs (WS3), newest first.',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
        response: {
          200: listEnvelopeSchema(evalRunBaseSchema.extend({ tenants: z.array(evalTenantRowSchema) })),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const rows = await withRlsBypass((tx) =>
        tx.evalRun.findMany({ orderBy: { createdAt: 'desc' }, take: req.query.limit }),
      );
      return {
        data: rows.map((row) => {
          const summaries = (row.summaries as unknown as Array<z.infer<typeof evalSummarySchema>>) ?? [];
          return {
            id: row.id,
            trigger: row.trigger,
            mode: row.mode,
            threshold: row.threshold,
            passed: row.passed,
            tenantCount: row.tenantCount,
            passedCount: row.passedCount,
            gitSha: row.gitSha,
            note: row.note,
            durationMs: row.durationMs,
            createdAt: row.createdAt.toISOString(),
            tenants: summaries.map((s) => ({
              org: s.org,
              total: s.total,
              retrievalScored: s.retrievalScored,
              retrievalHits: s.retrievalHits,
              deterministicPass: s.deterministicPass,
              judgeScored: s.judgeScored,
              judgePass: s.judgePass,
              overallPass: s.overallPass,
            })),
          };
        }),
        nextCursor: null,
      };
    },
  );

  // GET /hq/eval/runs/:id — one run in full (per-scenario results).
  r.get(
    '/hq/eval/runs/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'One bot-eval run with full per-scenario results.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(evalRunBaseSchema.extend({ summaries: z.array(evalSummarySchema) })),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const row = await withRlsBypass((tx) =>
        tx.evalRun.findUnique({ where: { id: req.params.id } }),
      );
      if (!row) throw notFound('Eval run not found.');
      return {
        data: {
          id: row.id,
          trigger: row.trigger,
          mode: row.mode,
          threshold: row.threshold,
          passed: row.passed,
          tenantCount: row.tenantCount,
          passedCount: row.passedCount,
          gitSha: row.gitSha,
          note: row.note,
          durationMs: row.durationMs,
          createdAt: row.createdAt.toISOString(),
          summaries: (row.summaries as unknown as Array<z.infer<typeof evalSummarySchema>>) ?? [],
        },
      };
    },
  );

  // ---------- GET /hq/traffic ----------------------------------
  // Live traffic snapshot parsed from the API's own /metrics endpoint.
  // Returns cumulative counters since the process started — for a real
  // historical chart, scrape /metrics into Prometheus externally.
  r.get(
    '/hq/traffic',
    {
      schema: {
        tags: ['admin'],
        summary: 'Parsed snapshot of the API process’s Prometheus counters.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              totalRequests: z.number(),
              byStatusClass: z.object({
                '2xx': z.number(),
                '3xx': z.number(),
                '4xx': z.number(),
                '5xx': z.number(),
                other: z.number(),
              }),
              errorRate: z.number(),
              uptimeSeconds: z.number(),
              processStartTime: z.string().datetime().nullable(),
              topRoutes: z.array(
                z.object({ route: z.string(), method: z.string(), count: z.number() }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async () => {
      // Fetch our own /metrics. The metrics endpoint runs in-process so
      // localhost is always safe here. Use the validated `env.API_PORT`
      // rather than raw process.env so a runtime mutation cannot redirect.
      let text = '';
      try {
        const r = await fetch(`http://127.0.0.1:${env.API_PORT}/metrics`, {
          signal: AbortSignal.timeout(2000),
        });
        text = await r.text();
      } catch {
        // Fall through with empty text — zeros will be returned.
      }

      const buckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
      const byRoute = new Map<string, { method: string; count: number }>();
      let totalRequests = 0;
      let processStartTimeSec: number | null = null;

      for (const line of text.split('\n')) {
        if (line.startsWith('#') || !line.trim()) continue;
        if (line.startsWith('process_start_time_seconds')) {
          const m = line.match(/\s([\d.e+-]+)$/);
          if (m) processStartTimeSec = Number(m[1]);
          continue;
        }
        if (line.startsWith('http_requests_total{')) {
          const labelMatch = line.match(/\{([^}]+)\}\s+([\d.e+-]+)/);
          if (!labelMatch) continue;
          const labelStr = labelMatch[1] ?? '';
          const value = Number(labelMatch[2]);
          if (!Number.isFinite(value)) continue;

          const labels: Record<string, string> = {};
          for (const pair of labelStr.split(',')) {
            const [k, v] = pair.split('=');
            if (k && v) labels[k.trim()] = v.replace(/^"|"$/g, '');
          }
          const status = labels.status ?? '';
          const method = labels.method ?? 'GET';
          const route = labels.route ?? '?';
          const statusDigit = status.charAt(0);
          const bucket =
            statusDigit === '2'
              ? '2xx'
              : statusDigit === '3'
                ? '3xx'
                : statusDigit === '4'
                  ? '4xx'
                  : statusDigit === '5'
                    ? '5xx'
                    : 'other';
          buckets[bucket as keyof typeof buckets] += value;
          totalRequests += value;

          const key = `${method} ${route}`;
          const existing = byRoute.get(key);
          if (existing) existing.count += value;
          else byRoute.set(key, { method, count: value });
        }
      }

      const topRoutes = [...byRoute.entries()]
        .map(([key, v]) => ({ route: key.split(' ').slice(1).join(' '), method: v.method, count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const errorRate = totalRequests > 0 ? buckets['5xx'] / totalRequests : 0;
      const uptimeSeconds = processStartTimeSec
        ? Math.max(0, Math.floor(Date.now() / 1000 - processStartTimeSec))
        : 0;

      return {
        data: {
          totalRequests,
          byStatusClass: buckets,
          errorRate,
          uptimeSeconds,
          processStartTime: processStartTimeSec ? new Date(processStartTimeSec * 1000).toISOString() : null,
          topRoutes,
        },
      };
    },
  );

  // ---------- GET /hq/uptime -----------------------------------
  // Proxies a read-only snapshot from UptimeRobot. Returns `{ configured:
  // false }` when the env keys are missing — UI hides the tile in that
  // case. We proxy (rather than calling UptimeRobot from the browser) so
  // the API key never leaves the server.
  r.get(
    '/hq/uptime',
    {
      schema: {
        tags: ['admin'],
        summary: 'Uptime snapshot proxied from UptimeRobot (if configured).',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              configured: z.boolean(),
              monitors: z.array(
                z.object({
                  id: z.number(),
                  name: z.string(),
                  url: z.string(),
                  status: z.string(),
                  uptimeRatio: z.number().nullable(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async () => {
      if (!env.UPTIMEROBOT_API_KEY) {
        return { data: { configured: false, monitors: [] } };
      }
      const params = new URLSearchParams({
        api_key: env.UPTIMEROBOT_API_KEY,
        format: 'json',
        custom_uptime_ratios: '1-7-30', // 24h / 7d / 30d
        logs: '0',
      });
      if (env.UPTIMEROBOT_MONITOR_IDS) {
        params.set('monitors', env.UPTIMEROBOT_MONITOR_IDS);
      }
      try {
        const res = await fetch('https://api.uptimerobot.com/v2/getMonitors', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cache-Control': 'no-cache',
          },
          body: params.toString(),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return { data: { configured: true, monitors: [] } };
        }
        const body = (await res.json()) as {
          stat?: string;
          monitors?: {
            id: number;
            friendly_name?: string;
            url?: string;
            status?: number;
            custom_uptime_ratio?: string;
          }[];
        };
        // UptimeRobot status code mapping → human labels.
        const statusLabel = (n: number | undefined) =>
          n === 2 ? 'up' : n === 8 ? 'seems_down' : n === 9 ? 'down' : n === 0 ? 'paused' : 'unknown';
        const monitors = (body.monitors ?? []).map((m) => {
          const firstRatio = m.custom_uptime_ratio?.split('-')[0];
          const ratio = firstRatio ? Number(firstRatio) : null;
          return {
            id: m.id,
            name: m.friendly_name ?? `Monitor ${m.id}`,
            url: m.url ?? '',
            status: statusLabel(m.status),
            uptimeRatio: ratio != null && Number.isFinite(ratio) ? ratio : null,
          };
        });
        return { data: { configured: true, monitors } };
      } catch {
        return { data: { configured: true, monitors: [] } };
      }
    },
  );

  // ---------- GET /hq/self-uptime ----------------------------
  // Reads the worker's self-uptime probe ZSET and computes 24h / 7d
  // availability + p95 latency. NOT a substitute for external monitoring
  // — the worker can't observe the VM being entirely down. Surfaced
  // alongside (or in absence of) the UptimeRobot tile.
  r.get(
    '/hq/self-uptime',
    {
      schema: {
        tags: ['admin'],
        summary: 'Worker-process self-probe of the API /health endpoint.',
      },
      preHandler: [app.requireSuperAdmin],
    },
    async () => {
      const redis = getRedis();
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const cutoff7d = now - 7 * day;
      const cutoff24h = now - day;

      // ZSET members are formatted "<ts>:<ok>:<status>:<latency>".
      let raw: string[] = [];
      try {
        raw = await redis.zrangebyscore('uptime:api', cutoff7d, now);
      } catch {
        raw = [];
      }
      const samples = raw
        .map((m) => {
          const [tsStr, okStr, statusStr, latencyStr] = m.split(':');
          return {
            ts: Number(tsStr),
            ok: okStr === '1',
            status: Number(statusStr),
            latency: Number(latencyStr),
          };
        })
        .filter((s) => Number.isFinite(s.ts));

      function uptimePct(since: number) {
        const slice = samples.filter((s) => s.ts >= since);
        if (slice.length === 0) return null;
        const ok = slice.filter((s) => s.ok).length;
        return Number(((ok / slice.length) * 100).toFixed(3));
      }
      function p95Latency(since: number) {
        const slice = samples.filter((s) => s.ts >= since && Number.isFinite(s.latency));
        if (slice.length === 0) return null;
        const sorted = [...slice].sort((a, b) => a.latency - b.latency);
        return sorted[Math.floor(sorted.length * 0.95)]?.latency ?? null;
      }

      return {
        data: {
          configured: samples.length > 0,
          window7dPct: uptimePct(cutoff7d),
          window24hPct: uptimePct(cutoff24h),
          p95Latency24h: p95Latency(cutoff24h),
          totalSamples: samples.length,
          oldestSample: samples[0]?.ts ?? null,
          newestSample: samples[samples.length - 1]?.ts ?? null,
        },
      };
    },
  );

  // ---------- GET /hq/debug/thread/:id --------------------------
  // One-shot diagnostic for "the thread shows X in / Y out but /messages
  // returns nothing". Compares thread.customerPhone against the actual
  // message rows + orphan rows in the same org, so we can see whether
  // messages are landing under a different threadId, with NULL threadId,
  // or in a different organizationId entirely.
  r.get(
    '/hq/debug/thread/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'Cross-tenant diagnostic for one whatsapp_thread row.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      return withRlsBypass(async (tx) => {
        const thread = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          select: {
            id: true,
            organizationId: true,
            customerPhone: true,
            customerName: true,
            customerWhatsappName: true,
            inboundCount: true,
            outboundCount: true,
            lastMessageAt: true,
            createdAt: true,
            status: true,
          },
        });
        if (!thread) throw notFound('Thread not found.');
        const phone = thread.customerPhone;
        const phoneNoPlus = phone.replace(/^\+/, '');
        const phonePlus = phone.startsWith('+') ? phone : `+${phone}`;

        const [
          linkedToThis,
          sameOrgSamePhoneFrom,
          sameOrgSamePhoneTo,
          orphans,
          siblingThreads,
          sampleMessagesByPhone,
        ] = await Promise.all([
          tx.whatsAppMessage.count({ where: { threadId: thread.id } }),
          tx.whatsAppMessage.count({
            where: {
              organizationId: thread.organizationId,
              OR: [{ fromNumber: phone }, { fromNumber: phoneNoPlus }, { fromNumber: phonePlus }],
            },
          }),
          tx.whatsAppMessage.count({
            where: {
              organizationId: thread.organizationId,
              OR: [{ toNumber: phone }, { toNumber: phoneNoPlus }, { toNumber: phonePlus }],
            },
          }),
          tx.whatsAppMessage.count({
            where: {
              organizationId: thread.organizationId,
              threadId: null,
              OR: [
                { fromNumber: phone },
                { fromNumber: phoneNoPlus },
                { fromNumber: phonePlus },
                { toNumber: phone },
                { toNumber: phoneNoPlus },
                { toNumber: phonePlus },
              ],
            },
          }),
          tx.whatsAppThread.findMany({
            where: {
              organizationId: thread.organizationId,
              id: { not: thread.id },
              OR: [
                { customerPhone: phone },
                { customerPhone: phoneNoPlus },
                { customerPhone: phonePlus },
              ],
            },
            select: { id: true, customerPhone: true, inboundCount: true, outboundCount: true },
          }),
          tx.whatsAppMessage.findMany({
            where: {
              organizationId: thread.organizationId,
              OR: [
                { fromNumber: phone },
                { fromNumber: phoneNoPlus },
                { fromNumber: phonePlus },
                { toNumber: phone },
                { toNumber: phoneNoPlus },
                { toNumber: phonePlus },
              ],
            },
            orderBy: { receivedAt: 'desc' },
            take: 10,
            select: {
              id: true,
              direction: true,
              threadId: true,
              fromNumber: true,
              toNumber: true,
              receivedAt: true,
              messageType: true,
              body: true,
            },
          }),
        ]);

        return {
          data: {
            thread,
            counts: {
              linkedToThis,
              sameOrgSamePhoneFrom,
              sameOrgSamePhoneTo,
              orphans,
            },
            siblingThreads,
            sampleMessagesByPhone: sampleMessagesByPhone.map((m) => ({
              ...m,
              body: m.body ? m.body.slice(0, 80) : null,
            })),
          },
        };
      });
    },
  );

  // ---------- POST /hq/queues/:queue/drain-failed ---------------
  // Clears all failed jobs on a queue. Useful for wiping out orphan repeatable
  // jobs that reference deleted orgs (they re-fire forever otherwise).
  r.post(
    '/hq/queues/:queue/drain-failed',
    {
      schema: {
        tags: ['admin'],
        summary: 'Remove all failed jobs from a BullMQ queue.',
        params: z.object({ queue: z.enum(['import', 'sync', 'webhook']) }),
        response: { 200: itemEnvelopeSchema(z.object({ removed: z.number() })) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const q =
        req.params.queue === 'import'
          ? getImportQueue()
          : req.params.queue === 'sync'
            ? getSyncQueue()
            : getWebhookQueue();
      // BullMQ `clean(grace, limit, status)` — grace 0 = clear everything.
      const removedIds = await q.clean(0, 10_000, 'failed');
      return { data: { removed: removedIds.length } };
    },
  );

  // ---------- GET /hq/provenance --------------------------------
  // Phase 8 / 1.4 — cross-tenant browser of every persisted bot reply
  // provenance row. Filters: organizationId, flagged (boolean), since/until
  // (ISO), cursor pagination. Returns lightweight summary rows; click into
  // one to hit /inbox/messages/:id/provenance for the full body.
  r.get(
    '/hq/provenance',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — list of every bot-reply provenance row across all tenants.',
        querystring: z.object({
          organizationId: z.string().uuid().optional(),
          flagged: z.enum(['true', 'false']).optional(),
          since: z.string().datetime().optional(),
          until: z.string().datetime().optional(),
          cursor: z.string().uuid().optional(),
          take: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { organizationId, flagged, since, until, cursor, take } = req.query;
      const rows = await withRlsBypass(async (tx) => {
        // Build raw WHERE clauses — Prisma's query API can't easily
        // express jsonb_array_length, and we need it for the flagged
        // filter anyway. Safe because every input is type-checked by Zod.
        const wheres: string[] = ['1=1'];
        const vals: unknown[] = [];
        let i = 1;
        if (organizationId) {
          wheres.push(`p.organization_id = $${i++}::uuid`);
          vals.push(organizationId);
        }
        if (since) {
          wheres.push(`p.created_at >= $${i++}::timestamptz`);
          vals.push(since);
        }
        if (until) {
          wheres.push(`p.created_at <= $${i++}::timestamptz`);
          vals.push(until);
        }
        if (flagged === 'true') {
          wheres.push(`jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) > 0`);
        } else if (flagged === 'false') {
          wheres.push(`jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) = 0`);
        }
        if (cursor) {
          // Cursor = the id of the LAST row from previous page. Combined
          // with created_at DESC ordering this gives a stable forward
          // pagination as long as no row's created_at changes (it never does).
          wheres.push(
            `(p.created_at, p.id) < (SELECT created_at, id FROM message_provenances WHERE id = $${i++}::uuid)`,
          );
          vals.push(cursor);
        }
        const sql = `
          SELECT
            p.id, p.message_id, p.organization_id, p.created_at,
            p.model, p.latency_ms, p.prompt_tokens, p.completion_tokens,
            jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) AS halluc_count,
            jsonb_array_length(COALESCE(p.citations, '[]'::jsonb))      AS cit_count,
            m.body, m.message_type, m.thread_id,
            o.name AS org_name, o.slug AS org_slug
          FROM message_provenances p
          JOIN organizations o ON o.id = p.organization_id
          LEFT JOIN whatsapp_messages m ON m.id = p.message_id
          WHERE ${wheres.join(' AND ')}
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $${i}
        `;
        vals.push(take + 1);
        return tx.$queryRawUnsafe<
          {
            id: string;
            message_id: string;
            organization_id: string;
            created_at: Date;
            model: string;
            latency_ms: number;
            prompt_tokens: number;
            completion_tokens: number;
            halluc_count: number;
            cit_count: number;
            body: string | null;
            message_type: string | null;
            thread_id: string | null;
            org_name: string;
            org_slug: string;
          }[]
        >(sql, ...vals);
      });
      const hasMore = rows.length > take;
      const trimmed = hasMore ? rows.slice(0, take) : rows;
      return {
        data: trimmed.map((r) => ({
          provenanceId: r.id,
          messageId: r.message_id,
          organizationId: r.organization_id,
          organizationName: r.org_name,
          organizationSlug: r.org_slug,
          messageBody: r.body ? r.body.slice(0, 200) : null,
          messageType: r.message_type,
          threadId: r.thread_id,
          createdAt: r.created_at.toISOString(),
          hallucinationCount: Number(r.halluc_count),
          citationCount: Number(r.cit_count),
          model: r.model,
          promptTokens: r.prompt_tokens,
          completionTokens: r.completion_tokens,
          latencyMs: r.latency_ms,
        })),
        nextCursor: hasMore ? trimmed[trimmed.length - 1]!.id : null,
      };
    },
  );

  // ---------- GET /hq/provenance/suppressions ------------------
  // Phase 8 / 1.7 — list every suppression row visible to an ALIGNED
  // admin: GLOBAL rows + every tenant's per-org rows. The UI groups
  // them by scope.
  r.get(
    '/hq/provenance/suppressions',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — list all provenance suppression rows (global + per-org).',
        querystring: z.object({
          scope: z.enum(['all', 'global', 'org']).default('all'),
          organizationId: z.string().uuid().optional(),
        }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const rows = await withRlsBypass(async (tx) => {
        return tx.provenanceSuppression.findMany({
          where: {
            ...(req.query.scope === 'global' ? { organizationId: null } : {}),
            ...(req.query.scope === 'org' ? { NOT: { organizationId: null } } : {}),
            ...(req.query.organizationId ? { organizationId: req.query.organizationId } : {}),
          },
          orderBy: [{ organizationId: 'asc' }, { createdAt: 'desc' }],
          include: {
            organization: { select: { id: true, name: true, slug: true } },
            createdBy: { select: { email: true, firstName: true, lastName: true } },
          },
          take: 500,
        });
      });
      return {
        data: rows.map((r) => ({
          id: r.id,
          phrase: r.phrase,
          note: r.note,
          scope: r.organizationId === null ? ('global' as const) : ('org' as const),
          organizationId: r.organizationId,
          organizationName: r.organization?.name ?? null,
          organizationSlug: r.organization?.slug ?? null,
          createdByEmail: r.createdBy?.email ?? null,
          createdByName: r.createdBy
            ? [r.createdBy.firstName, r.createdBy.lastName].filter(Boolean).join(' ') ||
              null
            : null,
          createdAt: r.createdAt.toISOString(),
          matchesCount: r.matchesCount,
          lastMatchedAt: r.lastMatchedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  // ---------- POST /hq/provenance/suppressions ----------------
  // Manually add a suppression — global or for a specific org.
  r.post(
    '/hq/provenance/suppressions',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — manually add a suppression row.',
        body: z.object({
          phrase: z.string().trim().min(1).max(200),
          note: z.string().trim().max(500).optional(),
          scope: z.enum(['global', 'org']),
          organizationId: z.string().uuid().optional(),
        }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      if (req.body.scope === 'org' && !req.body.organizationId) {
        reply.code(400);
        return {
          error: {
            code: ApiErrorCode.VALIDATION_ERROR,
            message: 'organizationId required when scope=org',
          },
        };
      }
      const { normalisePhraseForSuppression } = await import(
        '../../lib/provenance-scanner.js'
      );
      const phrase = normalisePhraseForSuppression(req.body.phrase);
      if (phrase.length === 0) {
        reply.code(400);
        return {
          error: {
            code: ApiErrorCode.VALIDATION_ERROR,
            message: 'Phrase normalises to empty',
          },
        };
      }
      const orgId = req.body.scope === 'global' ? null : req.body.organizationId!;
      const created = await withRlsBypass(async (tx) => {
        const existing = await tx.provenanceSuppression.findFirst({
          where: { organizationId: orgId, phrase },
          select: { id: true },
        });
        if (existing) return { id: existing.id, alreadyExists: true };
        const row = await tx.provenanceSuppression.create({
          data: {
            organizationId: orgId,
            phrase,
            note: req.body.note ?? null,
            createdByUserId: req.auth!.userId,
          },
          select: { id: true },
        });
        return { id: row.id, alreadyExists: false };
      });
      return { data: created };
    },
  );

  // ---------- DELETE /hq/provenance/suppressions/:id ----------
  r.delete(
    '/hq/provenance/suppressions/:id',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — remove a suppression row.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      await withRlsBypass((tx) =>
        tx.provenanceSuppression.delete({ where: { id: req.params.id } }),
      );
      return { ok: true as const };
    },
  );

  // ---------- POST /hq/provenance/suppressions/:id/promote ----
  // Promote a per-org row to global by clearing organization_id. If a
  // global row with the same phrase already exists, the per-org row is
  // just deleted (the global one already covers everyone).
  r.post(
    '/hq/provenance/suppressions/:id/promote-global',
    {
      schema: {
        tags: ['admin'],
        summary: 'ALIGNED-admin only — promote a per-org suppression to global.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      const result = await withRlsBypass(async (tx) => {
        const row = await tx.provenanceSuppression.findUnique({
          where: { id: req.params.id },
          select: { id: true, phrase: true, organizationId: true },
        });
        if (!row) return { error: 'not_found' as const };
        if (row.organizationId === null) {
          return { error: 'already_global' as const };
        }
        const existingGlobal = await tx.provenanceSuppression.findFirst({
          where: { organizationId: null, phrase: row.phrase },
          select: { id: true },
        });
        if (existingGlobal) {
          // Already covered globally — just delete the per-org duplicate.
          await tx.provenanceSuppression.delete({ where: { id: row.id } });
          return { ok: true, promotedId: existingGlobal.id, alreadyExisted: true };
        }
        const promoted = await tx.provenanceSuppression.update({
          where: { id: row.id },
          data: { organizationId: null },
          select: { id: true },
        });
        return { ok: true, promotedId: promoted.id, alreadyExisted: false };
      });
      if ('error' in result) {
        reply.code(result.error === 'not_found' ? 404 : 400);
        return {
          error: {
            code:
              result.error === 'not_found'
                ? ApiErrorCode.NOT_FOUND
                : ApiErrorCode.VALIDATION_ERROR,
            message: result.error,
          },
        };
      }
      return { data: { promotedId: result.promotedId, alreadyExisted: result.alreadyExisted } };
    },
  );

  // ============================================================
  //   AI plan + usage — per-tenant tier + cost roll-up
  // ============================================================

  // ---------- GET /hq/orgs/:id/broadcasts --------------------
  // A tenant's broadcasts with messages-sent + recipient counts, so HQ can see
  // (per the org's detail profile) how much each tenant has broadcast.
  r.get(
    '/hq/orgs/:id/broadcasts',
    {
      schema: {
        tags: ['admin'],
        summary: "A tenant's broadcasts with messages-sent + recipient counts.",
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              totals: z.object({
                broadcasts: z.number().int(),
                recipients: z.number().int(),
                sent: z.number().int(),
              }),
              broadcasts: z.array(
                z.object({
                  id: uuidSchema,
                  name: z.string(),
                  status: z.string(),
                  totalRecipients: z.number().int(),
                  sentCount: z.number().int(),
                  deliveredCount: z.number().int(),
                  readCount: z.number().int(),
                  createdAt: z.string(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      return withRlsBypass(async (tx) => {
        const rows = await tx.broadcast.findMany({
          where: { organizationId: orgId },
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: {
            id: true,
            name: true,
            status: true,
            totalRecipients: true,
            sentCount: true,
            deliveredCount: true,
            readCount: true,
            createdAt: true,
          },
        });
        const totals = rows.reduce(
          (acc, b) => {
            acc.recipients += b.totalRecipients;
            acc.sent += b.sentCount;
            return acc;
          },
          { broadcasts: rows.length, recipients: 0, sent: 0 },
        );
        return {
          data: {
            totals,
            broadcasts: rows.map((b) => ({ ...b, createdAt: b.createdAt.toISOString() })),
          },
        };
      });
    },
  );

  // ---------- GET /hq/orgs/:id/ai-usage ----------------------
  // Token + USD usage rolled up per day/week/month. Reads
  // MessageProvenance rows (one per bot reply) for the org, groups by
  // day, costs each row at the rate of the model that actually ran
  // (via CHAT_PRICING in lib/ai-pricing.ts). Heavy-ish query for orgs
  // with millions of bot replies; bounded by `since` so the typical
  // 30-day window stays cheap.
  r.get(
    '/hq/orgs/:id/ai-usage',
    {
      schema: {
        tags: ['admin'],
        summary: 'Per-tenant AI token + USD usage rolled up per day / week / month.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']),
              // Monthly AI-MESSAGE allowance — the enforced, tenant-facing cap
              // (1 message = 1 bot reply / voice turn). null cap = unlimited.
              aiMessages: z.object({
                used: z.number().int(),
                cap: z.number().int().nullable(),
                unlimited: z.boolean(),
                percentUsed: z.number().int(),
              }),
              today: z.object({
                tokens: z.number().int(),
                inputTokens: z.number().int(),
                outputTokens: z.number().int(),
                usd: z.number(),
                replies: z.number().int(),
              }),
              thisWeek: z.object({
                tokens: z.number().int(),
                inputTokens: z.number().int(),
                outputTokens: z.number().int(),
                usd: z.number(),
                replies: z.number().int(),
              }),
              thisMonth: z.object({
                tokens: z.number().int(),
                inputTokens: z.number().int(),
                outputTokens: z.number().int(),
                usd: z.number(),
                replies: z.number().int(),
              }),
              // Last 30 days broken out per day, oldest first. Lets the
              // admin UI render a sparkline / bar chart cheaply.
              dailySeries: z.array(
                z.object({
                  date: z.string(), // YYYY-MM-DD UTC
                  tokens: z.number().int(),
                  usd: z.number(),
                  replies: z.number().int(),
                }),
              ),
              // Per-model breakdown over the last 30 days — surfaces
              // when an org is split across the basic-tier fallback
              // chain (groq + gpt-4o-mini) vs the plan they're actually
              // on. Useful for diagnosing "why did my bill spike?".
              byModel: z.array(
                z.object({
                  model: z.string(),
                  tokens: z.number().int(),
                  usd: z.number(),
                  replies: z.number().int(),
                }),
              ),
              // Subscription plan + per-quota usage/caps/percentage so the
              // admin sees BOTH money (USD above) and quota % in one place.
              planCode: z.string(),
              quotas: z.array(
                z.object({
                  key: z.string(),
                  label: z.string(),
                  monthly: z.boolean(),
                  used: z.number().int(),
                  cap: z.number().int().nullable(),
                  pct: z.number().int().nullable(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { costUsdWithCache } = await import('../../lib/ai-pricing.js');
      const { getOrgQuotas } = await import('../../lib/billing.js');
      const orgId = req.params.id;
      const now = new Date();
      const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const sevenDaysAgo = new Date(startOfTodayUtc.getTime() - 6 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(startOfTodayUtc.getTime() - 29 * 24 * 60 * 60 * 1000);
      const startOfMonthUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true, aiPlan: true } }),
      );
      if (!org) throw notFound('Organization not found');

      // Pull every provenance row inside the 30-day window in one
      // query — small payload (just model + token counts + createdAt),
      // big enough window that we can derive today / this-week / this-
      // month + per-day series from a single fetch.
      const rows = await withRlsBypass((tx) =>
        tx.messageProvenance.findMany({
          where: { organizationId: orgId, createdAt: { gte: thirtyDaysAgo } },
          select: {
            model: true,
            promptTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            completionTokens: true,
            createdAt: true,
          },
        }),
      );

      type Bucket = {
        tokens: number;
        inputTokens: number;
        outputTokens: number;
        usd: number;
        replies: number;
      };
      const empty = (): Bucket => ({
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        usd: 0,
        replies: 0,
      });
      const today = empty();
      const thisWeek = empty();
      const thisMonth = empty();
      const byDay = new Map<string, Bucket>();
      const byModel = new Map<string, Bucket>();

      for (let i = 0; i < 30; i += 1) {
        const d = new Date(startOfTodayUtc.getTime() - (29 - i) * 24 * 60 * 60 * 1000);
        byDay.set(d.toISOString().slice(0, 10), empty());
      }

      for (const row of rows) {
        const usd = costUsdWithCache(
          row.model,
          row.promptTokens,
          row.completionTokens,
          row.cacheReadTokens,
          row.cacheWriteTokens,
        );
        const total = row.promptTokens + row.completionTokens;
        const day = row.createdAt.toISOString().slice(0, 10);

        const bumpInto = (b: Bucket) => {
          b.tokens += total;
          b.inputTokens += row.promptTokens;
          b.outputTokens += row.completionTokens;
          b.usd += usd;
          b.replies += 1;
        };

        if (row.createdAt >= startOfTodayUtc) bumpInto(today);
        if (row.createdAt >= sevenDaysAgo) bumpInto(thisWeek);
        if (row.createdAt >= startOfMonthUtc) bumpInto(thisMonth);

        const dayBucket = byDay.get(day);
        if (dayBucket) bumpInto(dayBucket);

        const modelBucket = byModel.get(row.model) ?? empty();
        bumpInto(modelBucket);
        byModel.set(row.model, modelBucket);
      }

      const dailySeries = Array.from(byDay.entries()).map(([date, b]) => ({
        date,
        tokens: b.tokens,
        usd: Number(b.usd.toFixed(4)),
        replies: b.replies,
      }));

      const byModelArr = Array.from(byModel.entries())
        .map(([model, b]) => ({
          model,
          tokens: b.tokens,
          usd: Number(b.usd.toFixed(4)),
          replies: b.replies,
        }))
        .sort((a, b) => b.usd - a.usd);

      const round = (b: Bucket) => ({
        tokens: b.tokens,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        usd: Number(b.usd.toFixed(4)),
        replies: b.replies,
      });

      const { planCode, quotas } = await withRlsBypass((tx) => getOrgQuotas(tx as never, orgId));
      const { readAiMessageUsage } = await import('../../lib/ai-messages.js');
      const aiMessages = await readAiMessageUsage(orgId);

      return {
        data: {
          aiPlan: (org as { aiPlan?: 'basic' | 'middle' | 'max' | 'ultra' }).aiPlan ?? 'basic',
          aiMessages,
          today: round(today),
          thisWeek: round(thisWeek),
          thisMonth: round(thisMonth),
          dailySeries,
          byModel: byModelArr,
          planCode,
          quotas,
        },
      };
    },
  );

  // ---------- PUT /hq/orgs/:id/ai-plan -----------------------
  // Admin changes a tenant's AI tier. Persisted on Organization.aiPlan;
  // the chat dispatch reads it on next reply (within ~30s — the
  // in-process plan cache expires that quickly, see lib/openai.ts).
  r.put(
    '/hq/orgs/:id/ai-plan',
    {
      schema: {
        tags: ['admin'],
        summary: 'Change a tenant\'s AI plan (basic / middle / max).',
        params: z.object({ id: uuidSchema }),
        body: z.object({ aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']) }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              id: uuidSchema,
              aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const next = req.body.aiPlan;
      const updated = await withRlsBypass(async (tx) => {
        const existing = await tx.organization.findUnique({
          where: { id: orgId },
          select: { id: true, aiPlan: true },
        });
        if (!existing) return null;
        const prev = (existing as { aiPlan?: 'basic' | 'middle' | 'max' | 'ultra' }).aiPlan ?? 'basic';
        if (prev === next) {
          return { id: existing.id, aiPlan: prev, prev, changed: false };
        }
        const row = await tx.organization.update({
          where: { id: orgId },
          data: { aiPlan: next },
          select: { id: true, aiPlan: true },
        });
        const newPlan = (row as { aiPlan?: 'basic' | 'middle' | 'max' | 'ultra' }).aiPlan ?? next;
        return { id: row.id, aiPlan: newPlan, prev, changed: true };
      });
      if (!updated) throw notFound('Organization not found');
      if (updated.changed) {
        // recordAudit opens its own tx (with RLS bypass) — call it
        // after the org update commits so audit + state stay aligned.
        await recordAudit({
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          action: 'ai_plan_changed',
          entityType: 'organization',
          entityId: orgId,
          metadata: { from: updated.prev, to: next },
        });
      }
      return { data: { id: updated.id, aiPlan: updated.aiPlan } };
    },
  );

  // ---------- PUT /hq/orgs/:id/ai-message-cap ----------------
  // ALIGNED-admin sets a tenant's MONTHLY AI-MESSAGE allowance (1 message = 1
  // bot reply / voice turn). cap = null -> Unlimited (no metering).
  r.put(
    '/hq/orgs/:id/ai-message-cap',
    {
      schema: {
        tags: ['admin'],
        summary: "Set a tenant's monthly AI-message allowance (null = unlimited).",
        params: z.object({ id: uuidSchema }),
        body: z.object({ cap: z.number().int().min(0).max(10_000_000).nullable() }),
        response: {
          200: itemEnvelopeSchema(
            z.object({ id: uuidSchema, monthlyAiMessageCap: z.number().int().nullable() }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const cap = req.body.cap;
      const updated = await withRlsBypass(async (tx) => {
        const existing = await tx.organization.findUnique({
          where: { id: orgId },
          select: { id: true },
        });
        if (!existing) return null;
        return tx.organization.update({
          where: { id: orgId },
          data: { monthlyAiMessageCap: cap },
          select: { id: true, monthlyAiMessageCap: true },
        });
      });
      if (!updated) throw notFound('Organization not found');
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'ai_plan_changed',
        entityType: 'organization',
        entityId: orgId,
        metadata: { monthlyAiMessageCap: cap },
      });
      return { data: { id: updated.id, monthlyAiMessageCap: updated.monthlyAiMessageCap } };
    },
  );

  // ---------- GET /hq/orgs/:id/ai-compiled-prompt ------------
  // Compile the tenant's ACTUAL bot system prompt — the same string the bot
  // sends to the LLM — WITHOUT calling the model (compileOnly). Because it runs
  // the real assembler in bot-engine.ts, any code change to the prompt (rules,
  // scope-lock, catalog packing) shows up here automatically, for every tenant.
  // Also returns the current admin-only addendum + a few size stats.
  r.get(
    '/hq/orgs/:id/ai-compiled-prompt',
    {
      schema: {
        tags: ['admin'],
        summary: "Compile the tenant's live bot system prompt (no LLM call) + the admin addendum.",
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              compiledPrompt: z.string(),
              adminSystemPromptAppend: z.string().nullable(),
              promptChars: z.number().int(),
              productCount: z.number().int(),
              serviceCount: z.number().int(),
              faqCount: z.number().int(),
              hasBotConfig: z.boolean(),
              deployed: z.boolean(),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const { gatherBotData, buildBotResponse } = await import('../../lib/bot-engine.js');
      const result = await withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
        if (!org) return null;
        // gatherBotData filters every query by organizationId explicitly, so it
        // returns the right tenant's data even under the RLS-bypass tx.
        const data = await gatherBotData(tx as never, orgId);
        const built = await buildBotResponse({
          organizationId: orgId,
          userMessage: '(prompt preview — no customer message)',
          data,
          // Preview the WhatsApp variant (primary channel) for a canonical view.
          channelLabel: 'WhatsApp',
          compileOnly: true,
        });
        return {
          compiledPrompt: built.inputs.systemPrompt,
          adminSystemPromptAppend: data.config?.adminSystemPromptAppend ?? null,
          productCount: data.products.length,
          serviceCount: data.services.length,
          faqCount: data.faqs.length,
          hasBotConfig: !!data.config,
          deployed: false as boolean,
        };
      });
      if (!result) throw notFound('Organization not found');
      // deployedAt is on BotConfig — a quick separate read keeps gatherBotData's
      // shape untouched.
      const cfg = await withRlsBypass((tx) =>
        tx.botConfig.findUnique({ where: { organizationId: orgId }, select: { deployedAt: true } }),
      );
      return {
        data: {
          ...result,
          deployed: !!cfg?.deployedAt,
          promptChars: result.compiledPrompt.length,
        },
      };
    },
  );

  // ---------- PUT /hq/orgs/:id/ai-prompt-append --------------
  // Set the ALIGNED-admin-only prompt addendum for this tenant. It is injected
  // VERBATIM into the bot's system prompt (after core rules, before catalog) on
  // every reply — chat + voice. Empty/whitespace clears it. Tenants can neither
  // see nor edit this (it's not in the /bot routes' DTO or body schema).
  r.put(
    '/hq/orgs/:id/ai-prompt-append',
    {
      schema: {
        tags: ['admin'],
        summary: "Set the ALIGNED-admin-only bot system-prompt addendum for a tenant.",
        params: z.object({ id: uuidSchema }),
        body: z.object({ adminSystemPromptAppend: z.string().max(8000).nullable() }),
        response: {
          200: itemEnvelopeSchema(
            z.object({ id: uuidSchema, adminSystemPromptAppend: z.string().nullable() }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const raw = req.body.adminSystemPromptAppend;
      const value = raw && raw.trim() ? raw.trim() : null;
      const updated = await withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
        if (!org) return null;
        // BotConfig is 1:1 with org — upsert so a tenant that never opened /bot
        // still gets the addendum (the bot materialises the rest of config).
        const row = await tx.botConfig.upsert({
          where: { organizationId: orgId },
          create: { organizationId: orgId, adminSystemPromptAppend: value },
          update: { adminSystemPromptAppend: value },
          select: { organizationId: true, adminSystemPromptAppend: true },
        });
        return row;
      });
      if (!updated) throw notFound('Organization not found');
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'bot_prompt_updated',
        entityType: 'bot_config',
        entityId: orgId,
        metadata: { set: value !== null, chars: value?.length ?? 0 },
      });
      return {
        data: { id: updated.organizationId, adminSystemPromptAppend: updated.adminSystemPromptAppend },
      };
    },
  );

  // ======================================================================
  // Tenant wallet & metered WhatsApp billing (docs/wallet-billing-plan.md)
  // ======================================================================

  const walletDtoSchema = z.object({
    organizationId: uuidSchema,
    meteringEnabled: z.boolean(),
    availableMicros: z.number(),
    heldMicros: z.number(),
    pricePerMessageMicros: z.number(),
    metaCostMicros: z.number(),
    lowBalanceThresholdMicros: z.number(),
    lifetimeToppedUpMicros: z.number(),
    lifetimeSpentMicros: z.number(),
    lifetimeMessages: z.number(),
    marginPerMessageMicros: z.number(),
    marginPct: z.number(),
    lifetimeMarginMicros: z.number(),
    alertThresholds: z.array(z.number()),
    pctUsed: z.number(),
    alertLevel: z.enum(['ok', 'alert', 'empty']),
  });

  function walletDto(orgId: string, w: wallet.Wallet | null) {
    const price = w?.pricePerMessageMicros ?? DEFAULT_PRICE_MICROS;
    const metaCost = w?.metaCostMicros ?? DEFAULT_META_COST_MICROS;
    const margin = price - metaCost;
    const spent = w?.lifetimeSpentMicros ?? 0;
    const msgs = w?.lifetimeMessages ?? 0;
    const alert = wallet.walletAlertState(w);
    return {
      organizationId: orgId,
      meteringEnabled: w?.meteringEnabled ?? false,
      availableMicros: w?.availableMicros ?? 0,
      heldMicros: w?.heldMicros ?? 0,
      pricePerMessageMicros: price,
      metaCostMicros: metaCost,
      lowBalanceThresholdMicros: w?.lowBalanceThresholdMicros ?? 0,
      lifetimeToppedUpMicros: w?.lifetimeToppedUpMicros ?? 0,
      lifetimeSpentMicros: spent,
      lifetimeMessages: msgs,
      marginPerMessageMicros: margin,
      marginPct: price > 0 ? Math.round((margin / price) * 1000) / 10 : 0,
      // Our gross margin so far = messages billed × (price − Meta cost).
      lifetimeMarginMicros: msgs * margin,
      alertThresholds: w?.alertThresholds ?? [80, 100],
      pctUsed: alert.pctUsed,
      alertLevel: alert.level,
    };
  }

  // ---------- GET /hq/orgs/:id/wallet ------------------------
  r.get(
    '/hq/orgs/:id/wallet',
    {
      schema: {
        tags: ['admin'],
        summary: "A tenant's wallet: balance, price, margin, metering switch.",
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(walletDtoSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: req.params.id }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');
      const w = await wallet.getWallet(req.params.id);
      return { data: walletDto(req.params.id, w) };
    },
  );

  // ---------- PUT /hq/orgs/:id/wallet/price ------------------
  r.put(
    '/hq/orgs/:id/wallet/price',
    {
      schema: {
        tags: ['admin'],
        summary: "Set a tenant's per-message price (USD, floor $0.0375).",
        params: z.object({ id: uuidSchema }),
        body: walletSetPriceBodySchema,
        response: { 200: itemEnvelopeSchema(walletDtoSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');
      const w = await wallet.setPrice(orgId, usdToMicros(req.body.priceUsd));
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'wallet_price_changed',
        entityType: 'tenant_wallet',
        entityId: orgId,
        metadata: { pricePerMessageMicros: w.pricePerMessageMicros },
      });
      return { data: walletDto(orgId, w) };
    },
  );

  // ---------- POST /hq/orgs/:id/wallet/topup ----------------
  r.post(
    '/hq/orgs/:id/wallet/topup',
    {
      schema: {
        tags: ['admin'],
        summary: 'Credit a tenant wallet (USD). Auto-enables metering.',
        params: z.object({ id: uuidSchema }),
        body: walletTopUpBodySchema,
        response: { 200: itemEnvelopeSchema(walletDtoSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');
      const micros = usdToMicros(req.body.amountUsd);
      const w = await wallet.topUp(orgId, micros, req.auth!.userId, req.body.note);
      await wallet.rearmLowBalance(orgId);
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'wallet_topped_up',
        entityType: 'tenant_wallet',
        entityId: orgId,
        metadata: { amountMicros: micros, note: req.body.note ?? null },
      });
      return { data: walletDto(orgId, w) };
    },
  );

  // ---------- POST /hq/orgs/:id/wallet/adjust ---------------
  r.post(
    '/hq/orgs/:id/wallet/adjust',
    {
      schema: {
        tags: ['admin'],
        summary: 'Manual ± balance adjustment (USD, signed). Clamps at 0.',
        params: z.object({ id: uuidSchema }),
        body: walletAdjustBodySchema,
        response: { 200: itemEnvelopeSchema(walletDtoSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');
      const micros = usdToMicros(req.body.amountUsd);
      const w = await wallet.adjust(orgId, micros, req.auth!.userId, req.body.note);
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'wallet_adjusted',
        entityType: 'tenant_wallet',
        entityId: orgId,
        metadata: { amountMicros: micros, note: req.body.note ?? null },
      });
      return { data: walletDto(orgId, w) };
    },
  );

  // ---------- PUT /hq/orgs/:id/wallet/metering --------------
  r.put(
    '/hq/orgs/:id/wallet/metering',
    {
      schema: {
        tags: ['admin'],
        summary: 'Turn the send gate on/off without moving money.',
        params: z.object({ id: uuidSchema }),
        body: z.object({ enabled: z.boolean() }),
        response: { 200: itemEnvelopeSchema(walletDtoSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');
      const w = await wallet.setMetering(orgId, req.body.enabled);
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'wallet_metering_toggled',
        entityType: 'tenant_wallet',
        entityId: orgId,
        metadata: { meteringEnabled: req.body.enabled },
      });
      return { data: walletDto(orgId, w) };
    },
  );

  // ---------- PUT /hq/orgs/:id/wallet/threshold -------------
  r.put(
    '/hq/orgs/:id/wallet/threshold',
    {
      schema: {
        tags: ['admin'],
        summary: 'Set the low-balance alert threshold (USD).',
        params: z.object({ id: uuidSchema }),
        body: walletThresholdBodySchema,
        response: { 200: itemEnvelopeSchema(walletDtoSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');
      const w = await wallet.setLowBalanceThreshold(orgId, usdToMicros(req.body.lowBalanceUsd));
      await recordAudit({
        action: 'wallet_thresholds_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'low_balance_threshold_set', lowBalanceUsd: req.body.lowBalanceUsd },
      });
      return { data: walletDto(orgId, w) };
    },
  );

  // ---------- PUT /hq/orgs/:id/wallet/alert-thresholds ------
  // Which balance-depletion %s (of 50/75/80/90/100) alert this tenant.
  r.put(
    '/hq/orgs/:id/wallet/alert-thresholds',
    {
      schema: {
        tags: ['admin'],
        summary: 'Set the balance-depletion % alert thresholds (50/75/80/90/100).',
        params: z.object({ id: uuidSchema }),
        body: z.object({ thresholds: z.array(z.number().int().min(1).max(100)).max(5) }),
        response: { 200: itemEnvelopeSchema(walletDtoSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');
      const w = await wallet.setAlertThresholds(orgId, req.body.thresholds);
      await recordAudit({
        action: 'wallet_thresholds_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'alert_thresholds_set', thresholds: req.body.thresholds },
      });
      return { data: walletDto(orgId, w) };
    },
  );

  // ---------- POST /hq/orgs/:id/members --------------------
  // ALIGNED admin invites a teammate into a specific tenant (email + role).
  // Reuses the standard invitation flow (sends the invite email + audits).
  r.post(
    '/hq/orgs/:id/members',
    {
      schema: {
        tags: ['admin'],
        summary: 'Invite a member into a tenant (email + role).',
        params: z.object({ id: uuidSchema }),
        body: createInvitationBodySchema,
        response: {
          201: itemEnvelopeSchema(
            z.object({
              id: uuidSchema,
              email: z.string(),
              role: z.string(),
              status: z.string(),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      const orgId = req.params.id;
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');
      const invite = await createInvitation({
        organizationId: orgId,
        email: req.body.email,
        role: req.body.role,
        invitedById: req.auth!.userId,
        meta: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
      });
      reply.code(201);
      return {
        data: { id: invite.id, email: invite.email, role: invite.role, status: invite.status },
      };
    },
  );

  // ---------- PATCH /hq/orgs/:id/members/:userId/email ------
  // Change a member's login email. Enforces global uniqueness; keeps it
  // verified (admin-managed) and revokes active sessions so the change takes.
  r.patch(
    '/hq/orgs/:id/members/:userId/email',
    {
      schema: {
        tags: ['admin'],
        summary: "Change a tenant member's email.",
        params: z.object({ id: uuidSchema, userId: uuidSchema }),
        body: z.object({ email: z.string().trim().toLowerCase().email() }),
        response: { 200: itemEnvelopeSchema(z.object({ userId: uuidSchema, email: z.string() })) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { id: orgId, userId } = req.params;
      const email = req.body.email;
      const result = await withRlsBypass(async (tx) => {
        const membership = await tx.membership.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId } },
        });
        if (!membership) return { error: 'not_member' as const };
        const clash = await tx.user.findFirst({ where: { email, id: { not: userId } }, select: { id: true } });
        if (clash) return { error: 'email_taken' as const };
        const user = await tx.user.update({
          where: { id: userId },
          data: { email, emailVerifiedAt: new Date() },
          select: { id: true, email: true },
        });
        await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        return { user };
      });
      if (result.error === 'not_member') throw notFound('User is not a member of this organization.');
      if (result.error === 'email_taken') throw conflict('That email is already in use.');
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'user_updated',
        entityType: 'user',
        entityId: userId,
        metadata: { changed: 'email', email },
      });
      return { data: { userId: result.user!.id, email: result.user!.email } };
    },
  );

  // ---------- POST /hq/orgs/:id/members/:userId/reset-password
  // Set a fresh temporary password, revoke sessions, return it ONCE for the
  // admin to hand over. (The tenant can change it from Settings afterward.)
  r.post(
    '/hq/orgs/:id/members/:userId/reset-password',
    {
      schema: {
        tags: ['admin'],
        summary: "Reset a tenant member's password to a new temporary one.",
        params: z.object({ id: uuidSchema, userId: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(z.object({ userId: uuidSchema, password: z.string() })),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { id: orgId, userId } = req.params;
      const password = generateTempPassword();
      const passwordHash = await hashPassword(password);
      const ok = await withRlsBypass(async (tx) => {
        const membership = await tx.membership.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId } },
        });
        if (!membership) return false;
        await tx.user.update({ where: { id: userId }, data: { passwordHash } });
        await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        return true;
      });
      if (!ok) throw notFound('User is not a member of this organization.');
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'password_changed',
        entityType: 'user',
        entityId: userId,
        metadata: { by: 'aligned_admin' },
      });
      return { data: { userId, password } };
    },
  );

  // ---------- GET /hq/whatsapp-margin ----------------------
  // Cross-tenant WhatsApp message economics: what tenants paid (revenue), our
  // Meta cost, and the profit — in total and per tenant.
  r.get(
    '/hq/whatsapp-margin',
    {
      schema: {
        tags: ['admin'],
        summary: 'Total + per-tenant WhatsApp message revenue, Meta cost, and profit.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              totals: z.object({
                messages: z.number(),
                revenueMicros: z.number(),
                metaCostMicros: z.number(),
                profitMicros: z.number(),
              }),
              tenants: z.array(
                z.object({
                  orgId: uuidSchema,
                  name: z.string(),
                  slug: z.string(),
                  messages: z.number(),
                  revenueMicros: z.number(),
                  metaCostMicros: z.number(),
                  profitMicros: z.number(),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async () => {
      const rows = await prisma.$queryRaw<
        { id: string; name: string; slug: string; messages: number; revenue: bigint; meta_cost: bigint; profit: bigint }[]
      >`
        SELECT o.id, o.name, o.slug,
               w.lifetime_messages AS messages,
               w.lifetime_spent_micros AS revenue,
               (w.lifetime_messages::bigint * w.meta_cost_micros) AS meta_cost,
               (w.lifetime_spent_micros - w.lifetime_messages::bigint * w.meta_cost_micros) AS profit
          FROM tenant_wallets w
          JOIN organizations o ON o.id = w.organization_id
         WHERE o.status <> 'deleted'
         ORDER BY profit DESC`;
      const tenants = rows.map((r) => ({
        orgId: r.id,
        name: r.name,
        slug: r.slug,
        messages: Number(r.messages),
        revenueMicros: Number(r.revenue),
        metaCostMicros: Number(r.meta_cost),
        profitMicros: Number(r.profit),
      }));
      const totals = tenants.reduce(
        (a, t) => ({
          messages: a.messages + t.messages,
          revenueMicros: a.revenueMicros + t.revenueMicros,
          metaCostMicros: a.metaCostMicros + t.metaCostMicros,
          profitMicros: a.profitMicros + t.profitMicros,
        }),
        { messages: 0, revenueMicros: 0, metaCostMicros: 0, profitMicros: 0 },
      );
      return { data: { totals, tenants } };
    },
  );

  // ---------- GET /hq/orgs/:id/wallet/ledger ----------------
  r.get(
    '/hq/orgs/:id/wallet/ledger',
    {
      schema: {
        tags: ['admin'],
        summary: "A tenant's wallet ledger (top-ups, holds, settles, releases).",
        params: z.object({ id: uuidSchema }),
        querystring: z.object({
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                id: uuidSchema,
                kind: z.string(),
                amountMicros: z.number(),
                availableAfterMicros: z.number(),
                heldAfterMicros: z.number(),
                broadcastId: z.string().nullable(),
                note: z.string().nullable(),
                actorName: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const { cursor, limit } = req.query;
      const rows = await prisma.walletLedger.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const actorIds = [...new Set(page.map((x) => x.actorUserId).filter(Boolean))] as string[];
      const actors = actorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : [];
      const actorName = new Map(
        actors.map((a) => [a.id, `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() || a.email]),
      );
      return {
        data: page.map((x) => ({
          id: x.id,
          kind: x.kind,
          amountMicros: Number(x.amountMicros),
          availableAfterMicros: Number(x.availableAfter),
          heldAfterMicros: Number(x.heldAfter),
          broadcastId: x.broadcastId,
          note: x.note,
          actorName: x.actorUserId ? (actorName.get(x.actorUserId) ?? null) : null,
          createdAt: x.createdAt.toISOString(),
        })),
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
      };
    },
  );

  // ---------- PUT /hq/orgs/:id/plan --------------------------
  // ALIGNED-admin changes a tenant's SUBSCRIPTION plan (free/starter/…), which
  // drives the quota caps (messages, broadcasts, products, …). Distinct from
  // ai-plan (the AI model tier). Upserts the Subscription row by plan code.
  r.put(
    '/hq/orgs/:id/plan',
    {
      schema: {
        tags: ['admin'],
        summary: "Change a tenant's subscription plan (quota caps) by plan code.",
        params: z.object({ id: uuidSchema }),
        body: z.object({ planCode: z.string().trim().min(1).max(40) }),
        response: {
          200: itemEnvelopeSchema(z.object({ id: uuidSchema, planCode: z.string() })),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const planCode = req.body.planCode;
      const result = await withRlsBypass(async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
        if (!org) return null;
        const plan = await tx.plan.findFirst({ where: { code: planCode }, select: { id: true, code: true } });
        if (!plan) return { notFoundPlan: true as const };
        // Upsert the subscription onto the new plan (keep status/trial intact).
        await tx.subscription.upsert({
          where: { organizationId: orgId },
          create: { organizationId: orgId, planId: plan.id, status: 'trialing' },
          update: { planId: plan.id },
        });
        return { code: plan.code };
      });
      if (!result) throw notFound('Organization not found');
      if ('notFoundPlan' in result) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, `Unknown plan code: ${planCode}`);
      }
      // Cap caches are read live (resolveOrgPlan), nothing to flush.
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'org_plan_changed',
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'subscription_plan_changed', planCode: result.code },
      });
      return { data: { id: orgId, planCode: result.code } };
    },
  );

  // ---------- POST /hq/support/chat --------------------------
  // ALIGNED HQ AI copilot. Streams a plain-text token stream (read with a
  // fetch ReadableStream on the client). Tool-calls live tenant data. Admin-only.
  r.post(
    '/hq/support/chat',
    {
      schema: {
        tags: ['admin'],
        summary: 'Streaming ALIGNED HQ AI copilot (plain-text token stream).',
        body: z.object({
          messages: z
            .array(
              z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string().trim().min(1).max(8000),
              }),
            )
            .min(1)
            .max(40),
        }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      const origin = (req.headers.origin as string | undefined) ?? '';
      const allowed = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
      const allowOrigin = allowed.includes(origin) ? origin : allowed[0] ?? '*';
      reply.raw.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
      });
      if (!isCopilotConfigured()) {
        reply.raw.write('The AI copilot is not configured on this deployment (missing OpenAI key).');
        reply.raw.end();
        return reply;
      }
      try {
        for await (const delta of runAdminCopilot(req.body.messages)) {
          reply.raw.write(delta);
        }
      } catch (err) {
        req.log.error({ err }, '[admin-copilot] stream failed');
        try {
          reply.raw.write('\n\n_Sorry — something went wrong generating that answer._');
        } catch {
          /* socket closed */
        }
      }
      try {
        reply.raw.end();
      } catch {
        /* noop */
      }
      return reply;
    },
  );

  // ---------- PUT /hq/orgs/:id/features ----------------------
  // ALIGNED-admin sets which features a tenant can access. The keys here are
  // DISABLED: their portal pages are hidden + route-guarded, and 'ai' turns off
  // the bot's auto-reply (manual social-media handler). Validated against the
  // shared ORG_FEATURES registry so unknown keys are rejected.
  r.put(
    '/hq/orgs/:id/features',
    {
      schema: {
        tags: ['admin'],
        summary: 'Set a tenant\'s disabled features (page/AI access control).',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          // Sanity bound only — must stay above ORG_FEATURE_KEYS.length or the
          // "Save access" button 400s when every feature is turned off. See org.ts.
          disabledFeatures: z.array(z.enum(ORG_FEATURE_KEYS as [string, ...string[]])).max(40),
        }),
        response: {
          200: itemEnvelopeSchema(
            z.object({ id: uuidSchema, disabledFeatures: z.array(z.string()) }),
          ),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const orgId = req.params.id;
      const next = Array.from(new Set(req.body.disabledFeatures));
      // Self-lockout guard: an admin can't change access on an org they belong
      // to (their own admin account stays fixed — can't disable their own pages
      // or hand themselves a restricted view).
      const ownMembership = await withRlsBypass((tx) =>
        tx.membership.findFirst({
          where: { organizationId: orgId, userId: req.auth!.userId },
          select: { id: true },
        }),
      );
      if (ownMembership) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'You cannot change access on an organisation you belong to (e.g. your own admin account).',
        );
      }
      const row = await withRlsBypass(async (tx) => {
        const existing = await tx.organization.findUnique({
          where: { id: orgId },
          select: { id: true, disabledFeatures: true },
        });
        if (!existing) return null;
        return tx.organization.update({
          where: { id: orgId },
          data: { disabledFeatures: next },
          select: { id: true, disabledFeatures: true },
        });
      });
      if (!row) throw notFound('Organization not found');
      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'org_features_changed',
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'features_changed', disabledFeatures: next },
      });
      return { data: { id: row.id, disabledFeatures: row.disabledFeatures } };
    },
  );

  // ---------- ALIGNED-admin: export ANY org's data -----------------------
  // ALIGNED admins can export a tenant's full data bundle at any time, even
  // when the tenant's own self-service 'exports' feature is turned off. Reuses
  // the same BullMQ worker + DataExport rows as the self-service flow; the
  // admin downloads from this panel (the worker's email link is tenant-only).
  const adminExportSchema = z.object({
    id: uuidSchema,
    status: z.enum(['pending', 'running', 'succeeded', 'failed']),
    fileSizeBytes: z.number().int().nullable(),
    errorMessage: z.string().nullable(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  });

  r.get(
    '/hq/orgs/:id/exports',
    {
      schema: {
        tags: ['admin'],
        summary: "List a tenant's recent data exports.",
        params: z.object({ id: uuidSchema }),
        response: { 200: listEnvelopeSchema(adminExportSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const rows = await withRlsBypass((tx) =>
        tx.dataExport.findMany({
          where: { organizationId: req.params.id },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
      );
      return {
        data: rows.map((e) => ({
          id: e.id,
          status: e.status as 'pending' | 'running' | 'succeeded' | 'failed',
          fileSizeBytes: e.fileSizeBytes,
          errorMessage: e.errorMessage,
          startedAt: e.startedAt?.toISOString() ?? null,
          finishedAt: e.finishedAt?.toISOString() ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
        nextCursor: null,
      };
    },
  );

  r.post(
    '/hq/orgs/:id/export',
    {
      schema: {
        tags: ['admin'],
        summary: "Trigger a data export for any tenant (bypasses the tenant's feature toggle). Optional `sections` picks which datasets to include; empty/omitted = everything.",
        params: z.object({ id: uuidSchema }),
        body: z
          .object({
            sections: z.array(z.string().min(1).max(60)).max(50).optional(),
            format: z.enum(['csv', 'pdf']).optional(),
            layout: z.enum(['combined', 'separate']).optional(),
          })
          .optional(),
        response: { 201: itemEnvelopeSchema(adminExportSchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      const orgId = req.params.id;
      // Dedupe + normalise the requested sections. Empty = full export.
      const sections = Array.from(new Set(req.body?.sections ?? [])).filter((s) =>
        EXPORT_SECTION_KEYS.includes(s),
      );
      const format = req.body?.format === 'pdf' ? 'pdf' : 'csv';
      const layout = req.body?.layout === 'separate' ? 'separate' : 'combined';
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { id: true } }),
      );
      if (!org) throw notFound('Organization not found');

      // Don't pile up exports — refuse if one is already in flight.
      const inflight = await withRlsBypass((tx) =>
        tx.dataExport.findFirst({
          where: { organizationId: orgId, status: { in: ['pending', 'running'] } },
        }),
      );
      if (inflight) {
        throw badRequest(
          ApiErrorCode.CONFLICT,
          'An export is already in progress for this organisation.',
        );
      }

      const admin = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: req.auth!.userId }, select: { email: true } }),
      );

      const created = await withRlsBypass((tx) =>
        tx.dataExport.create({
          data: {
            organizationId: orgId,
            requestedByUserId: req.auth!.userId,
            status: 'pending',
            sections,
            format,
            layout,
          },
        }),
      );

      await getDataExportQueue().add(
        'data-export',
        {
          organizationId: orgId,
          requestedByUserId: req.auth!.userId,
          requestedByEmail: admin?.email ?? env.EMAIL_FROM,
          exportId: created.id,
          sections,
          format,
          layout,
        },
        {
          attempts: 1,
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      );

      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'org_data_exported',
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'admin_data_export_requested', exportId: created.id },
      });

      reply.code(201);
      return {
        data: {
          id: created.id,
          status: 'pending' as const,
          fileSizeBytes: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          createdAt: created.createdAt.toISOString(),
        },
      };
    },
  );

  r.get(
    '/hq/orgs/:id/exports/:exportId/download',
    {
      schema: {
        tags: ['admin'],
        summary: 'Get a short-lived signed download URL for a tenant export.',
        params: z.object({ id: uuidSchema, exportId: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(z.object({ url: z.string().url(), expiresInSeconds: z.number() })),
        },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const row = await withRlsBypass((tx) =>
        tx.dataExport.findFirst({
          where: { id: req.params.exportId, organizationId: req.params.id },
        }),
      );
      if (!row) throw notFound('Export not found.');
      if (row.status !== 'succeeded' || !row.storageKey) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Export is not ready for download.');
      }
      const url = await presignGetUrl(row.storageKey);
      return { data: { url, expiresInSeconds: 900 } };
    },
  );

}
