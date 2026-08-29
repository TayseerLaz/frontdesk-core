// Audit log reader routes. Tenant-scoped view powers /audit-log in the
// portal; admin-scoped view powers the cross-tenant tab in /hq.
//
// Filters supported on both endpoints: entityType, action, actorEmail,
// from/to date range. Results are paginated with an opaque cursor (ISO
// timestamp of the last-seen row) — no counts (would be expensive on a
// table that grows per write).
import { decryptJsonSecret } from '@platform/db';
import {
  listEnvelopeSchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';

const auditEntrySchema = z.object({
  id: uuidSchema,
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: uuidSchema.nullable(),
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

const adminAuditEntrySchema = auditEntrySchema.extend({
  organizationId: uuidSchema.nullable(),
  organizationName: z.string().nullable(),
  organizationSlug: z.string().nullable(),
});

const listQuerySchema = z.object({
  entityType: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  actorEmail: z.string().trim().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(), // ISO timestamp from previous page's last row
});

export default async function auditRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /audit-log ---------------------------------------------
  // Client-scoped: returns only the current org's events (RLS enforced via
  // app.tenant). Any authenticated member may read.
  r.get(
    '/audit-log',
    {
      schema: {
        tags: ['audit'],
        summary: 'List audit log entries for the current organization.',
        querystring: listQuerySchema,
        response: { 200: listEnvelopeSchema(auditEntrySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const rows = await tx.auditLog.findMany({
          where: {
            // Hidden from the tenant's own activity: integration credentials
            // (ALIGNED-HQ-only), and ALIGNED-HQ access events (an admin
            // controlling the workspace) — the tenant shouldn't see those.
            NOT: {
              action: {
                in: ['integration_credentials_set', 'aligned_admin_accessed', 'aligned_admin_exited'],
              } as never,
            },
            ...(q.entityType ? { entityType: q.entityType } : {}),
            ...(q.action ? { action: q.action as never } : {}),
            ...(q.actorEmail
              ? { actor: { email: { contains: q.actorEmail, mode: 'insensitive' as const } } }
              : {}),
            ...(q.from || q.to
              ? {
                  createdAt: {
                    ...(q.from ? { gte: new Date(q.from) } : {}),
                    ...(q.to ? { lte: new Date(q.to) } : {}),
                  },
                }
              : {}),
            ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: q.limit + 1, // fetch one extra to detect next-cursor
          include: { actor: { select: { firstName: true, lastName: true, email: true } } },
        });

        const hasMore = rows.length > q.limit;
        const page = hasMore ? rows.slice(0, q.limit) : rows;
        const nextCursor = hasMore ? page[page.length - 1]?.createdAt.toISOString() ?? null : null;

        return {
          data: page.map((a) => {
            const actorName =
              a.actor && (a.actor.firstName || a.actor.lastName)
                ? `${a.actor.firstName ?? ''} ${a.actor.lastName ?? ''}`.trim()
                : null;
            // ALIGNED-HQ access entries are transparent to the tenant, but show
            // only the HQ username — never expose the HQ employee's email.
            const isHqAccess =
              a.action === 'aligned_admin_accessed' || a.action === 'aligned_admin_exited';
            return {
              id: a.id,
              action: a.action,
              entityType: a.entityType,
              entityId: a.entityId,
              actorName: isHqAccess ? (actorName ?? 'ALIGNED HQ') : actorName,
              actorEmail: isHqAccess ? null : (a.actor?.email ?? null),
              metadata: (a.metadata ?? null) as Record<string, unknown> | null,
              createdAt: a.createdAt.toISOString(),
            };
          }),
          nextCursor,
        };
      });
    },
  );

  // ---------- GET /hq/audit-log -------------------------------
  // Cross-tenant: ALIGNED staff only. Same filters + an extra org_id / name
  // column for triage across many tenants.
  r.get(
    '/hq/audit-log',
    {
      schema: {
        tags: ['admin'],
        summary: 'Cross-tenant audit log (ALIGNED super-admins only).',
        querystring: listQuerySchema.extend({
          organizationId: uuidSchema.optional(),
        }),
        response: { 200: listEnvelopeSchema(adminAuditEntrySchema) },
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const q = req.query;
      return withRlsBypass(async (tx) => {
        const rows = await tx.auditLog.findMany({
          where: {
            ...(q.organizationId ? { organizationId: q.organizationId } : {}),
            ...(q.entityType ? { entityType: q.entityType } : {}),
            ...(q.action ? { action: q.action as never } : {}),
            ...(q.actorEmail
              ? { actor: { email: { contains: q.actorEmail, mode: 'insensitive' as const } } }
              : {}),
            ...(q.from || q.to
              ? {
                  createdAt: {
                    ...(q.from ? { gte: new Date(q.from) } : {}),
                    ...(q.to ? { lte: new Date(q.to) } : {}),
                  },
                }
              : {}),
            ...(q.cursor ? { createdAt: { lt: new Date(q.cursor) } } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: q.limit + 1,
          include: {
            actor: { select: { firstName: true, lastName: true, email: true } },
            organization: { select: { name: true, slug: true } },
          },
        });

        const hasMore = rows.length > q.limit;
        const page = hasMore ? rows.slice(0, q.limit) : rows;
        const nextCursor = hasMore ? page[page.length - 1]?.createdAt.toISOString() ?? null : null;

        return {
          data: page.map((a) => ({
            id: a.id,
            organizationId: a.organizationId,
            organizationName: a.organization?.name ?? null,
            organizationSlug: a.organization?.slug ?? null,
            action: a.action,
            entityType: a.entityType,
            entityId: a.entityId,
            actorName:
              a.actor && (a.actor.firstName || a.actor.lastName)
                ? `${a.actor.firstName ?? ''} ${a.actor.lastName ?? ''}`.trim()
                : null,
            actorEmail: a.actor?.email ?? null,
            // For integration-credential rows, decrypt the stored creds so HQ
            // can see exactly what the tenant entered (this endpoint is
            // requireSuperAdmin-only; the tenant view never returns these).
            metadata: ((): Record<string, unknown> | null => {
              const m = (a.metadata ?? null) as Record<string, unknown> | null;
              if (m && a.action === 'integration_credentials_set' && typeof m.credentialsEnc === 'string') {
                let credentials: unknown = null;
                try {
                  credentials = decryptJsonSecret(m.credentialsEnc as string);
                } catch {
                  credentials = '<unable to decrypt>';
                }
                const { credentialsEnc: _omit, ...rest } = m;
                return { ...rest, credentials };
              }
              return m;
            })(),
            createdAt: a.createdAt.toISOString(),
          })),
          nextCursor,
        };
      });
    },
  );
}
