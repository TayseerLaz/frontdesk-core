// Organisation-level self-serve operations:
//   - GET /organization/export → an Org Admin downloads a JSON archive of
//     EVERY entity in their org: products, services, business info, FAQs,
//     policies, members, invites, audit log, API keys (id + scopes only),
//     webhook endpoints, connectors, WhatsApp channel + messages.
//   - DELETE /organization → Right-to-be-forgotten / self-served churn.
//     Refused if other orgs would be left without an admin (the user might
//     be the last admin in another org). Cascades through Prisma + RLS.
//
// Both endpoints are tenant-scoped via the standard `app.tenant` (RLS) and
// require the Org Admin role. Cross-tenant access (ALIGNED super-admin) is
// served by the existing /hq/orgs/:id DELETE.
import { ApiErrorCode, successSchema } from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { recordAudit } from '../../lib/audit.js';
import { withRlsBypass } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';

// M-10 — cap every otherwise-unbounded findMany in the SYNCHRONOUS export so a
// large-catalog tenant can't spike heap and trip the under-pressure plugin
// (which would 503 EVERY tenant). 10k rows/section sits far above any real
// tenant; the async POST /exports path remains the recommended one for huge
// orgs. When a section hits the cap the archive carries `truncated: true` and a
// `truncatedSections` list, so a partial download is never silent.
const MAX_EXPORT_ROWS = 10_000;

// Allow-list audit metadata keys when bundling — same approach as the
// per-user export. Keeps stray secrets/error traces out of the archive.
const SAFE_AUDIT_KEYS = new Set([
  'entityKind',
  'from',
  'to',
  'role',
  'name',
  'slug',
  'scopes',
  'url',
  'eventKind',
  'event',
  'action',
  'reason',
  'membershipId',
  'invitationId',
  'kind',
  'fieldsTouched',
  'isActive',
]);
function sanitiseMeta(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] =
      SAFE_AUDIT_KEYS.has(k) && (v == null || ['string', 'number', 'boolean'].includes(typeof v))
        ? v
        : '[redacted]';
  }
  return out;
}

export default async function orgRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /organization/export ----------------------------------
  r.get(
    '/organization/export',
    {
      schema: {
        tags: ['organization'],
        summary: 'Download a JSON archive of every entity in the current organisation.',
      },
      // 2/hour per org admin — exports are large and bandwidth-expensive.
      config: {
        rateLimit: {
          max: 2,
          timeWindow: '1 hour',
          keyGenerator: (req: { auth?: { organizationId?: string }; ip: string }) =>
            req.auth?.organizationId ?? req.ip,
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;

      const archive = await app.tenant(req, async (tx) => {
        const [
          org,
          memberships,
          invitations,
          apiKeys,
          webhookEndpoints,
          connectors,
          products,
          services,
          businessInfo,
          locations,
          contacts,
          faqs,
          policies,
          categories,
          whatsappChannel,
          whatsappMessages,
          auditEntries,
        ] = await Promise.all([
          tx.organization.findUnique({ where: { id: orgId } }),
          tx.membership.findMany({
            take: MAX_EXPORT_ROWS,
            include: { user: { select: { email: true, firstName: true, lastName: true } } },
          }),
          tx.invitation.findMany({ take: MAX_EXPORT_ROWS }),
          tx.apiKey.findMany({
            take: MAX_EXPORT_ROWS,
            select: { id: true, name: true, scopes: true, createdAt: true, revokedAt: true, lastUsedAt: true },
          }),
          tx.webhookEndpoint.findMany({
            take: MAX_EXPORT_ROWS,
            select: { id: true, url: true, description: true, eventKinds: true, isActive: true, createdAt: true },
          }),
          tx.apiConnector.findMany({
            take: MAX_EXPORT_ROWS,
            select: {
              id: true,
              name: true,
              entityKind: true,
              endpointUrl: true,
              authKind: true,
              status: true,
              scheduleCron: true,
              createdAt: true,
            },
          }),
          tx.product.findMany({
            where: { deletedAt: null },
            take: MAX_EXPORT_ROWS,
            include: { variants: true, images: { include: { asset: true } } },
          }),
          tx.service.findMany({
            where: { deletedAt: null },
            take: MAX_EXPORT_ROWS,
            include: { pricingTiers: true, availability: true },
          }),
          tx.businessInfo.findUnique({ where: { organizationId: orgId } }),
          tx.location.findMany({ take: MAX_EXPORT_ROWS }),
          tx.contactChannel.findMany({ take: MAX_EXPORT_ROWS }),
          tx.fAQ.findMany({ take: MAX_EXPORT_ROWS }),
          tx.policy.findMany({ take: MAX_EXPORT_ROWS }),
          tx.category.findMany({ take: MAX_EXPORT_ROWS }),
          tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
          tx.whatsAppMessage.findMany({ orderBy: { receivedAt: 'desc' }, take: 5000 }),
          tx.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: 5000,
            include: { actor: { select: { email: true, firstName: true, lastName: true } } },
          }),
        ]);

        // Flag any section that hit its row cap so the download is never a
        // silent partial. whatsappMessages/auditEntries carry their own 5000
        // cap; the rest use MAX_EXPORT_ROWS.
        const truncatedSections: string[] = [];
        const capped: Array<[string, { length: number }, number]> = [
          ['memberships', memberships, MAX_EXPORT_ROWS],
          ['invitations', invitations, MAX_EXPORT_ROWS],
          ['apiKeys', apiKeys, MAX_EXPORT_ROWS],
          ['webhookEndpoints', webhookEndpoints, MAX_EXPORT_ROWS],
          ['connectors', connectors, MAX_EXPORT_ROWS],
          ['products', products, MAX_EXPORT_ROWS],
          ['services', services, MAX_EXPORT_ROWS],
          ['locations', locations, MAX_EXPORT_ROWS],
          ['contacts', contacts, MAX_EXPORT_ROWS],
          ['faqs', faqs, MAX_EXPORT_ROWS],
          ['policies', policies, MAX_EXPORT_ROWS],
          ['categories', categories, MAX_EXPORT_ROWS],
          ['whatsappMessages', whatsappMessages, 5000],
          ['auditEntries', auditEntries, 5000],
        ];
        for (const [name, rows, cap] of capped) {
          if (rows.length >= cap) truncatedSections.push(name);
        }
        if (truncatedSections.length > 0) {
          req.log.warn(
            { orgId, truncatedSections },
            '[org-export] synchronous export truncated a section at its row cap — recommend POST /exports',
          );
        }

        return {
          exportedAt: new Date().toISOString(),
          exportVersion: 1,
          truncated: truncatedSections.length > 0,
          truncatedSections,
          organization: org,
          // Members: include user email but never password hash.
          memberships: memberships.map((m) => ({
            id: m.id,
            role: m.role,
            isActive: m.isActive,
            joinedAt: m.createdAt.toISOString(),
            user: {
              email: m.user.email,
              firstName: m.user.firstName,
              lastName: m.user.lastName,
            },
          })),
          invitations,
          // API keys: id + name + scopes — no prefix, no secret hash.
          apiKeys,
          webhookEndpoints,
          connectors,
          catalog: {
            categories,
            products: products.map((p) => ({
              ...p,
              images: p.images.map((i) => ({
                id: i.id,
                isPrimary: i.isPrimary,
                sortOrder: i.sortOrder,
                storageKey: i.asset.storageKey,
                contentType: i.asset.contentType,
              })),
            })),
            services,
          },
          businessInfo: { profile: businessInfo, locations, contacts, faqs, policies },
          // WhatsApp: omit appSecret + accessToken (still in the DB, just
          // not in the export — same model as API key prefix).
          whatsapp: whatsappChannel
            ? {
                wabaId: whatsappChannel.wabaId,
                phoneNumberId: whatsappChannel.phoneNumberId,
                displayPhoneNumber: whatsappChannel.displayPhoneNumber,
                appId: whatsappChannel.appId,
                businessName: whatsappChannel.businessName,
                businessEmail: whatsappChannel.businessEmail,
                businessAbout: whatsappChannel.businessAbout,
                businessAddress: whatsappChannel.businessAddress,
                greetingMessage: whatsappChannel.greetingMessage,
                isActive: whatsappChannel.isActive,
                lastVerifiedAt: whatsappChannel.lastVerifiedAt?.toISOString() ?? null,
              }
            : null,
          whatsappMessages: whatsappMessages.map((m) => ({
            id: m.id,
            direction: m.direction,
            metaMessageId: m.metaMessageId,
            fromNumber: m.fromNumber,
            toNumber: m.toNumber,
            messageType: m.messageType,
            body: m.body,
            receivedAt: m.receivedAt.toISOString(),
          })),
          auditEntries: auditEntries.map((a) => ({
            id: a.id,
            action: a.action,
            entityType: a.entityType,
            entityId: a.entityId,
            actorEmail: a.actor?.email ?? null,
            metadata: sanitiseMeta(a.metadata),
            createdAt: a.createdAt.toISOString(),
          })),
        };
      });

      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'organization',
        entityId: orgId,
        metadata: { event: 'organization_export_downloaded' },
      });

      const filename = `aligned-org-${orgId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
      reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(JSON.stringify(archive, null, 2));
    },
  );

  // ---------- DELETE /organization (RTBF / self-churn) ------------------
  // Hard-deletes the org. Cascades through every tenant-scoped table via
  // Prisma's onDelete:Cascade. Refused if any *other* org would lose its
  // last admin as a side effect (e.g. a user who only admins one other org
  // alongside this one). Refused for ALIGNED super-admins because their
  // workspace is platform-critical — they should use cross-tenant tools.
  r.delete(
    '/organization',
    {
      schema: {
        tags: ['organization'],
        summary: 'Permanently delete the current organisation and all its data (RTBF).',
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;

      await withRlsBypass(async (tx) => {
        // Refuse to delete an org that hosts ALIGNED super-admin members —
        // they likely belong to the platform-operator tenant.
        const superAdminCount = await tx.user.count({
          where: { isSuperAdmin: true, memberships: { some: { organizationId: orgId } } },
        });
        if (superAdminCount > 0) {
          throw badRequest(
            ApiErrorCode.CONFLICT,
            'This organisation contains ALIGNED super-admin members and cannot be self-deleted.',
          );
        }

        // Per-org advisory lock so concurrent calls serialise.
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          `aligned:org-delete:${orgId}`,
        );

        // For every member of this org, check whether they admin OTHER orgs
        // and, if so, whether removing this membership would leave any of
        // those orgs without an admin. This catches an edge case where the
        // user shares admins with another org via cross-membership.
        const members = await tx.membership.findMany({
          where: { organizationId: orgId, role: 'admin', isActive: true },
          select: { userId: true },
        });
        for (const m of members) {
          const otherAdminMemberships = await tx.membership.findMany({
            where: {
              userId: m.userId,
              role: 'admin',
              isActive: true,
              organizationId: { not: orgId },
            },
            select: { organizationId: true },
          });
          for (const other of otherAdminMemberships) {
            const otherAdminCount = await tx.membership.count({
              where: {
                organizationId: other.organizationId,
                role: 'admin',
                isActive: true,
                userId: { not: m.userId },
              },
            });
            if (otherAdminCount === 0) {
              throw badRequest(
                ApiErrorCode.CONFLICT,
                'A member of this organisation is the last admin of another organisation — transfer admin there first.',
              );
            }
          }
        }

        // Audit BEFORE the cascade — once the org is gone, the audit_log
        // entry's organizationId FK will be set to null by ON DELETE
        // SET NULL but we want the record to exist.
        await tx.auditLog.create({
          data: {
            organizationId: orgId,
            actorUserId: req.auth!.userId,
            action: 'org_suspended', // closest existing enum value; 'org_deleted' isn't in AuditAction
            entityType: 'organization',
            entityId: orgId,
            metadata: { event: 'organization_self_deleted' } as never,
          },
        });

        // Cascade hits memberships, sessions, invitations, products,
        // services, business info, FAQs, policies, assets, audit_logs (set
        // null), api_keys, webhook_endpoints, connectors, sync_runs,
        // import_jobs, catalog_revisions, notifications, whatsapp_channel,
        // whatsapp_messages — all via Prisma onDelete:Cascade.
        await tx.organization.delete({ where: { id: orgId } });
      });

      return { ok: true as const };
    },
  );
}
