import {
  ApiErrorCode,
  bulkDeleteServicesBodySchema,
  createServiceBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  serviceListItemSchema,
  serviceListQuerySchema,
  serviceSchema,
  setAvailabilityBodySchema,
  setPricingTiersBodySchema,
  successSchema,
  updateServiceBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Prisma } from '../../lib/db.js';
import { prisma as rootPrisma } from '../../lib/db.js';
import { embedServiceAndStore } from '../../lib/embedding.js';
import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { invalidateReadCache } from '../../lib/read-cache.js';
import { recordRevision } from '../../lib/versioning.js';
import { emitWebhookEvent } from '../../lib/webhooks.js';
import { decodeCursor, encodeCursor, slugify } from './shared.js';

const SORT_ORDERS: Record<string, Prisma.ServiceOrderByWithRelationInput[]> = {
  created_desc: [{ createdAt: 'desc' }, { id: 'desc' }],
  created_asc: [{ createdAt: 'asc' }, { id: 'asc' }],
  name_asc: [{ name: 'asc' }, { id: 'asc' }],
  name_desc: [{ name: 'desc' }, { id: 'desc' }],
};

export default async function serviceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /services -----------------------------------------------
  r.get(
    '/services',
    {
      schema: {
        tags: ['catalog'],
        summary: 'List services with search, filter, and cursor pagination.',
        querystring: serviceListQuerySchema,
        response: { 200: listEnvelopeSchema(serviceListItemSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const where: Prisma.ServiceWhereInput = {
          deletedAt: null,
          ...(q.categoryId ? { categoryId: q.categoryId } : {}),
          ...(q.isAvailable !== undefined ? { isAvailable: q.isAvailable } : {}),
          ...(q.q
            ? {
                OR: [
                  { name: { contains: q.q, mode: 'insensitive' } },
                  { searchText: { contains: q.q.toLowerCase() } },
                ],
              }
            : {}),
        };
        const cursor = decodeCursor<{ id: string }>(q.cursor);
        // Page + total count in parallel so the UI can render "N services"
        // + "Showing X of N" without a second round trip.
        const [services, total] = await Promise.all([
          tx.service.findMany({
            where,
            orderBy: SORT_ORDERS[q.sort],
            include: {
              category: { select: { id: true, name: true } },
              _count: { select: { pricingTiers: true } },
            },
            take: q.limit + 1,
            ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
          }),
          tx.service.count({ where }),
        ]);
        const hasMore = services.length > q.limit;
        const page = hasMore ? services.slice(0, q.limit) : services;
        return {
          data: page.map((s) => ({
            id: s.id,
            slug: s.slug,
            name: s.name,
            shortDescription: s.shortDescription,
            basePriceMinor: s.basePriceMinor,
            currency: s.currency,
            priceUnit: s.priceUnit,
            durationMinutes: s.durationMinutes,
            isAvailable: s.isAvailable,
            categoryName: s.category?.name ?? null,
            tierCount: s._count.pricingTiers,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
          })),
          nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
          total,
        };
      });
    },
  );

  // ---------- POST /services ----------------------------------------------
  r.post(
    '/services',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Create a service.',
        body: createServiceBodySchema,
        response: { 201: itemEnvelopeSchema(serviceSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const slug = req.body.slug ?? slugify(req.body.name);
        const dupe = await tx.service.findFirst({ where: { slug, deletedAt: null } });
        if (dupe) throw conflict('A service with that slug already exists.');

        // Lock service currency to the org-level BusinessInfo.currency.
        // Same rule as products — no per-service currency override.
        const orgInfo = await tx.businessInfo.findUnique({
          where: { organizationId: orgId },
          select: { currency: true },
        });
        const orgCurrency = orgInfo?.currency || 'USD';

        const created = await tx.service.create({
          data: {
            organizationId: orgId,
            name: req.body.name,
            slug,
            description: req.body.description ?? null,
            shortDescription: req.body.shortDescription ?? null,
            durationMinutes: req.body.durationMinutes ?? null,
            basePriceMinor: req.body.basePriceMinor ?? null,
            currency: orgCurrency,
            priceUnit: req.body.priceUnit ?? 'flat',
            isAvailable: req.body.isAvailable ?? true,
            bookingRules: (req.body.bookingRules ?? undefined) as Prisma.InputJsonValue | undefined,
            categoryId: req.body.categoryId ?? null,
          },
        });
        await recordAudit({
          action: 'service_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'service',
          entityId: created.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'service_created',
          payload: { id: created.id, name: created.name, slug: created.slug },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'service',
          entityId: created.id,
          action: 'created',
          snapshot: created as unknown as Record<string, unknown>,
          actorUserId: req.auth!.userId,
          summary: `Created "${created.name}"`,
        });
        // Embed so the bot's top-K service ranker can find it immediately.
        // Fire-and-forget; the backfill tick is the backstop.
        void embedServiceAndStore(rootPrisma, created.id).catch((err) =>
          req.log.warn({ err: err instanceof Error ? err.message : err, serviceId: created.id }, '[embed] service embed-on-create failed'),
        );
        reply.code(201);
        return { data: await loadService(tx, created.id) };
      });
    },
  );

  // ---------- GET /services/:id -------------------------------------------
  r.get(
    '/services/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Get one service.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(serviceSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => ({ data: await loadService(tx, req.params.id) }));
    },
  );

  // ---------- PATCH /services/:id -----------------------------------------
  r.patch(
    '/services/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Update a service.',
        params: z.object({ id: uuidSchema }),
        body: updateServiceBodySchema,
        response: { 200: itemEnvelopeSchema(serviceSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.service.findUnique({ where: { id: req.params.id } });
        if (!existing || existing.deletedAt) throw notFound('Service not found.');

        await tx.service.update({
          where: { id: existing.id },
          data: {
            name: req.body.name ?? undefined,
            slug: req.body.slug ?? undefined,
            description: req.body.description === undefined ? undefined : req.body.description,
            shortDescription:
              req.body.shortDescription === undefined ? undefined : req.body.shortDescription,
            durationMinutes:
              req.body.durationMinutes === undefined ? undefined : req.body.durationMinutes,
            basePriceMinor: req.body.basePriceMinor === undefined ? undefined : req.body.basePriceMinor,
            // Currency is locked to the org-level BusinessInfo.currency.
            // Ignore any client-supplied currency on PATCH.
            priceUnit: req.body.priceUnit ?? undefined,
            isAvailable: req.body.isAvailable ?? undefined,
            bookingRules:
              req.body.bookingRules === undefined
                ? undefined
                : (req.body.bookingRules as Prisma.InputJsonValue),
            ...(req.body.categoryId === undefined
              ? {}
              : req.body.categoryId === null
                ? { category: { disconnect: true } }
                : { category: { connect: { id: req.body.categoryId } } }),
          },
        });
        await recordAudit({
          action: 'service_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'service',
          entityId: existing.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'service_updated',
          payload: { id: existing.id, slug: existing.slug },
        });
        const refreshed = await tx.service.findUnique({ where: { id: existing.id } });
        if (refreshed) {
          void recordRevision({
            organizationId: orgId,
            entityType: 'service',
            entityId: existing.id,
            action: 'updated',
            snapshot: refreshed as unknown as Record<string, unknown>,
            actorUserId: req.auth!.userId,
          });
        }
        // Re-embed when the embed text (name / short description) changed.
        // embedServiceAndStore no-ops via the stored hash when unchanged.
        if (req.body.name !== undefined || req.body.shortDescription !== undefined) {
          void embedServiceAndStore(rootPrisma, existing.id).catch((err) =>
            req.log.warn({ err: err instanceof Error ? err.message : err, serviceId: existing.id }, '[embed] service embed-on-update failed'),
          );
        }
        return { data: await loadService(tx, existing.id) };
      });
    },
  );

  // ---------- DELETE /services/:id ----------------------------------------
  r.delete(
    '/services/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Soft-delete a service.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.service.findUnique({ where: { id: req.params.id } });
        if (!existing || existing.deletedAt) throw notFound('Service not found.');
        // Append a tombstone marker so the slug can be reused after deletion.
        const tombstone = `__deleted-${Date.now().toString(36)}`;
        await tx.service.update({
          where: { id: existing.id },
          data: {
            deletedAt: new Date(),
            slug: `${existing.slug}${tombstone}`,
          },
        });
        await recordAudit({
          action: 'service_deleted',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'service',
          entityId: existing.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'service_deleted',
          payload: { id: existing.id, slug: existing.slug },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'service',
          entityId: existing.id,
          action: 'deleted',
          snapshot: existing as unknown as Record<string, unknown>,
          actorUserId: req.auth!.userId,
          summary: `Deleted "${existing.name}"`,
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- PUT /services/:id/pricing-tiers -----------------------------
  r.put(
    '/services/:id/pricing-tiers',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Replace the pricing tier set for a service.',
        params: z.object({ id: uuidSchema }),
        body: setPricingTiersBodySchema,
        response: { 200: itemEnvelopeSchema(serviceSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const service = await tx.service.findUnique({ where: { id: req.params.id } });
        if (!service || service.deletedAt) throw notFound('Service not found.');

        const incomingIds = new Set(req.body.tiers.filter((t) => t.id).map((t) => t.id as string));
        await tx.servicePricingTier.deleteMany({
          where: { serviceId: service.id, id: { notIn: Array.from(incomingIds) } },
        });
        for (const [idx, t] of req.body.tiers.entries()) {
          if (t.id) {
            await tx.servicePricingTier.update({
              where: { id: t.id },
              data: {
                name: t.name,
                description: t.description ?? null,
                priceMinor: t.priceMinor,
                currency: t.currency ?? service.currency,
                priceUnit: t.priceUnit ?? service.priceUnit,
                features: t.features ?? [],
                sortOrder: t.sortOrder ?? idx,
              },
            });
          } else {
            await tx.servicePricingTier.create({
              data: {
                organizationId: orgId,
                serviceId: service.id,
                name: t.name,
                description: t.description ?? null,
                priceMinor: t.priceMinor,
                currency: t.currency ?? service.currency,
                priceUnit: t.priceUnit ?? service.priceUnit,
                features: t.features ?? [],
                sortOrder: t.sortOrder ?? idx,
              },
            });
          }
        }
        const data = await loadService(tx, service.id);
        void invalidateReadCache(req.auth!.organizationId); // tiers are read-visible
        return { data };
      });
    },
  );

  // ---------- PUT /services/:id/availability ------------------------------
  r.put(
    '/services/:id/availability',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Replace the weekly availability windows for a service.',
        params: z.object({ id: uuidSchema }),
        body: setAvailabilityBodySchema,
        response: { 200: itemEnvelopeSchema(serviceSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const service = await tx.service.findUnique({ where: { id: req.params.id } });
        if (!service || service.deletedAt) throw notFound('Service not found.');

        await tx.availabilityWindow.deleteMany({ where: { serviceId: service.id } });
        if (req.body.windows.length > 0) {
          await tx.availabilityWindow.createMany({
            data: req.body.windows.map((w) => ({
              organizationId: orgId,
              serviceId: service.id,
              dayOfWeek: w.dayOfWeek,
              startMinute: w.startMinute,
              endMinute: w.endMinute,
              effectiveFrom: w.effectiveFrom ? new Date(w.effectiveFrom) : null,
              effectiveUntil: w.effectiveUntil ? new Date(w.effectiveUntil) : null,
            })),
          });
        }
        const data = await loadService(tx, service.id);
        void invalidateReadCache(req.auth!.organizationId); // availability is read-visible
        return { data };
      });
    },
  );

  // ---------- POST /services/bulk-delete ----------------------------------
  // Soft-deletes many services in one call. Mirrors /products/bulk-delete:
  // accepts either an explicit ID list (max 500) or `all: true` to wipe
  // every active service in the org. RLS keeps the scope per-tenant.
  r.post(
    '/services/bulk-delete',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Soft-delete many services at once (or every service when all=true).',
        body: bulkDeleteServicesBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ deleted: z.number().int() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const where = req.body.all
          ? { deletedAt: null }
          : { id: { in: req.body.ids ?? [] }, deletedAt: null };
        const result = await tx.service.updateMany({
          where,
          data: { deletedAt: new Date(), isAvailable: false },
        });
        await recordAudit({
          action: 'service_deleted',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          metadata: {
            bulk: true,
            mode: req.body.all ? 'all' : 'selected',
            count: result.count,
          },
        });
        void invalidateReadCache(req.auth!.organizationId);
        return { data: { deleted: result.count } };
      });
    },
  );
}

async function loadService(tx: Prisma.TransactionClient, id: string) {
  const s = await tx.service.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true } },
      pricingTiers: { orderBy: { sortOrder: 'asc' } },
      availability: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
    },
  });
  if (!s) throw notFound('Service not found.');
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    shortDescription: s.shortDescription,
    durationMinutes: s.durationMinutes,
    basePriceMinor: s.basePriceMinor,
    currency: s.currency,
    priceUnit: s.priceUnit,
    isAvailable: s.isAvailable,
    bookingRules: (s.bookingRules ?? null) as Record<string, unknown> | null,
    categoryId: s.categoryId,
    categoryName: s.category?.name ?? null,
    pricingTiers: s.pricingTiers.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      priceMinor: t.priceMinor,
      currency: t.currency,
      priceUnit: t.priceUnit,
      features: t.features,
      sortOrder: t.sortOrder,
    })),
    availability: s.availability.map((a) => ({
      id: a.id,
      dayOfWeek: a.dayOfWeek,
      startMinute: a.startMinute,
      endMinute: a.endMinute,
      effectiveFrom: a.effectiveFrom?.toISOString() ?? null,
      effectiveUntil: a.effectiveUntil?.toISOString() ?? null,
    })),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
