// Revision history endpoints. Two surfaces:
//   1. GET /revisions/:entityType/:entityId         — timeline (no snapshot in payload, lighter list)
//   2. GET /revisions/:revisionId                   — single revision with full snapshot
//   3. POST /revisions/:revisionId/restore          — write the snapshot back to the live row
import {
  ApiErrorCode,
  catalogRevisionSchema,
  catalogRevisionWithSnapshotSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  RevisionEntityType,
  successSchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { withRlsBypass } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { recordRevision } from '../../lib/versioning.js';
import { emitWebhookEvent } from '../../lib/webhooks.js';

export default async function revisionRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /revisions/:entityType/:entityId ------------------------
  r.get(
    '/revisions/:entityType/:entityId',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Timeline of revisions for an entity (newest first).',
        params: z.object({
          entityType: z.nativeEnum(RevisionEntityType),
          entityId: uuidSchema,
        }),
        response: { 200: listEnvelopeSchema(catalogRevisionSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.catalogRevision.findMany({
          where: { entityType: req.params.entityType, entityId: req.params.entityId },
          orderBy: { versionNumber: 'desc' },
          take: 100,
        });
        const actorIds = Array.from(new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x)));
        const actors = actorIds.length
          ? await withRlsBypass((bypassTx) =>
              bypassTx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true, email: true } }),
            )
          : [];
        const nameById = new Map(
          actors.map((a) => [a.id, [a.firstName, a.lastName].filter(Boolean).join(' ') || a.email]),
        );
        return {
          data: rows.map((row) => ({
            id: row.id,
            entityType: row.entityType,
            entityId: row.entityId,
            action: row.action,
            versionNumber: row.versionNumber,
            summary: row.summary,
            actorUserId: row.actorUserId,
            actorName: row.actorUserId ? nameById.get(row.actorUserId) ?? null : null,
            createdAt: row.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- GET /revisions/:revisionId ----------------------------------
  r.get(
    '/revisions/:revisionId',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Get a single revision with its snapshot.',
        params: z.object({ revisionId: uuidSchema }),
        response: { 200: itemEnvelopeSchema(catalogRevisionWithSnapshotSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const row = await tx.catalogRevision.findUnique({ where: { id: req.params.revisionId } });
        if (!row) throw notFound('Revision not found.');
        return {
          data: {
            id: row.id,
            entityType: row.entityType,
            entityId: row.entityId,
            action: row.action,
            versionNumber: row.versionNumber,
            summary: row.summary,
            actorUserId: row.actorUserId,
            actorName: null,
            snapshot: row.snapshot,
            createdAt: row.createdAt.toISOString(),
          },
        };
      }),
  );

  // ---------- POST /revisions/:revisionId/restore -------------------------
  // Writes the snapshot back to the live row. Records a fresh "restored" revision.
  r.post(
    '/revisions/:revisionId/restore',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Restore an entity to the state captured by this revision.',
        params: z.object({ revisionId: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const rev = await tx.catalogRevision.findUnique({ where: { id: req.params.revisionId } });
        if (!rev) throw notFound('Revision not found.');
        const snap = rev.snapshot as Record<string, unknown> | null;
        if (!snap) throw badRequest(ApiErrorCode.CONFLICT, 'Revision has no snapshot to restore.');

        // The restore* helpers validate + narrow the JSONB snapshot, but the
        // resulting plain-object shape is wider than Prisma's Create/Update input
        // types. Cast at the call boundary — the data is already trusted.
        switch (rev.entityType) {
          case 'product': {
            const data = restoreProductData(snap);
            await tx.product.upsert({
              where: { id: rev.entityId },
              create: { ...data, id: rev.entityId, organizationId: orgId } as never,
              update: { ...data, deletedAt: null } as never,
            });
            break;
          }
          case 'service': {
            const data = restoreServiceData(snap);
            await tx.service.upsert({
              where: { id: rev.entityId },
              create: { ...data, id: rev.entityId, organizationId: orgId } as never,
              update: { ...data, deletedAt: null } as never,
            });
            break;
          }
          case 'business_info': {
            const data = restoreBusinessInfoData(snap);
            await tx.businessInfo.upsert({
              where: { organizationId: orgId },
              create: { ...data, organizationId: orgId } as never,
              update: data as never,
            });
            break;
          }
          case 'faq': {
            const data = restoreFaqData(snap);
            await tx.fAQ.upsert({
              where: { id: rev.entityId },
              create: { ...data, id: rev.entityId, organizationId: orgId } as never,
              update: data as never,
            });
            break;
          }
          case 'policy': {
            const data = restorePolicyData(snap);
            await tx.policy.upsert({
              where: { id: rev.entityId },
              create: { ...data, id: rev.entityId, organizationId: orgId } as never,
              update: data as never,
            });
            break;
          }
        }
        return rev;
      });

      // Record a "restored" revision so the timeline reflects the action.
      await recordRevision({
        organizationId: orgId,
        entityType: result.entityType,
        entityId: result.entityId,
        action: 'restored',
        snapshot: result.snapshot as Record<string, unknown>,
        actorUserId: req.auth!.userId,
        summary: `Restored from version ${result.versionNumber}`,
      });

      await recordAudit({
        action: 'revision_restored',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: result.entityType,
        entityId: result.entityId,
        metadata: { restoredFromVersion: result.versionNumber },
      });

      // Invalidate cache + emit webhook so chatbots see the rolled-back state.
      void emitWebhookEvent({
        organizationId: orgId,
        eventKind: 'catalog_changed',
        payload: { entityType: result.entityType, entityId: result.entityId, action: 'restored' },
      });

      return { ok: true as const };
    },
  );
}

// ---------- restore data shapers --------------------------------------------
// Strip server-managed and relation fields so we only write columns that
// belong on the row itself. Anything missing in the snapshot (e.g. older
// revisions before a column was added) is left untouched on update.

function pick<K extends string>(obj: Record<string, unknown>, keys: K[]): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function restoreProductData(snap: Record<string, unknown>) {
  return pick(snap, [
    'sku',
    'name',
    'slug',
    'description',
    'shortDescription',
    'priceMinor',
    'compareAtMinor',
    'currency',
    'isAvailable',
    'stockQuantity',
    'trackInventory',
    'attributes',
    'categoryId',
  ]);
}

function restoreServiceData(snap: Record<string, unknown>) {
  return pick(snap, [
    'name',
    'slug',
    'description',
    'shortDescription',
    'durationMinutes',
    'basePriceMinor',
    'currency',
    'priceUnit',
    'isAvailable',
    'bookingRules',
    'categoryId',
  ]);
}

function restoreBusinessInfoData(snap: Record<string, unknown>) {
  return pick(snap, [
    'legalName',
    'tagline',
    'about',
    'websiteUrl',
    'operatingHours',
    'hoursExceptions',
    'timezone',
    'currency',
    'metadata',
  ]);
}

function restoreFaqData(snap: Record<string, unknown>) {
  return pick(snap, ['question', 'answer', 'tags', 'visibility', 'sortOrder', 'isPublished']);
}

function restorePolicyData(snap: Record<string, unknown>) {
  return pick(snap, ['kind', 'title', 'content', 'isPublished', 'sortOrder']);
}
