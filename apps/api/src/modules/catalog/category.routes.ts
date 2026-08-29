import {
  ApiErrorCode,
  bulkDeleteCategoriesBodySchema,
  categorySchema,
  createCategoryBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  reorderCategoriesBodySchema,
  successSchema,
  updateCategoryBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { invalidateReadCache } from '../../lib/read-cache.js';
import { slugify } from './shared.js';

export default async function categoryRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /categories ---------------------------------------------
  r.get(
    '/categories',
    {
      schema: {
        tags: ['catalog'],
        summary: 'List categories (flat, ordered by parent + sortOrder).',
        response: { 200: listEnvelopeSchema(categorySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const rows = await tx.category.findMany({
          orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
          // Compute live product counts per category in a single query
          // so the listing page can show "N products" without a
          // per-row follow-up. Excludes soft-deleted rows so the
          // number matches what the operator sees on /products.
          include: {
            _count: {
              select: {
                products: { where: { deletedAt: null } },
                services: { where: { deletedAt: null } },
              },
            },
          },
        });
        return {
          data: rows.map((c) => ({
            id: c.id,
            parentId: c.parentId,
            name: c.name,
            slug: c.slug,
            description: c.description,
            sortOrder: c.sortOrder,
            isActive: c.isActive,
            productCount: c._count.products,
            serviceCount: c._count.services,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      });
    },
  );

  // ---------- POST /categories --------------------------------------------
  r.post(
    '/categories',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Create a category.',
        body: createCategoryBodySchema,
        response: { 201: itemEnvelopeSchema(categorySchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      return app.tenant(req, async (tx) => {
        const slug = req.body.slug ?? slugify(req.body.name);
        const existing = await tx.category.findUnique({
          where: { organizationId_slug: { organizationId: req.auth!.organizationId, slug } },
        });
        if (existing) throw conflict('A category with that slug already exists.');

        const c = await tx.category.create({
          data: {
            organizationId: req.auth!.organizationId,
            name: req.body.name,
            slug,
            parentId: req.body.parentId ?? null,
            description: req.body.description ?? null,
            sortOrder: req.body.sortOrder ?? 0,
          },
        });
        // Category names ride along in read-API product payloads.
        void invalidateReadCache(req.auth!.organizationId);
        await recordAudit({
          action: 'category_created',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'category',
          entityId: c.id,
        });
        reply.code(201);
        return {
          data: {
            id: c.id,
            parentId: c.parentId,
            name: c.name,
            slug: c.slug,
            description: c.description,
            sortOrder: c.sortOrder,
            isActive: c.isActive,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- PATCH /categories/:id ---------------------------------------
  r.patch(
    '/categories/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Update a category.',
        params: z.object({ id: uuidSchema }),
        body: updateCategoryBodySchema,
        response: { 200: itemEnvelopeSchema(categorySchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const existing = await tx.category.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Category not found.');
        if (req.body.parentId === existing.id) {
          throw conflict('A category cannot be its own parent.');
        }
        const c = await tx.category.update({
          where: { id: req.params.id },
          data: {
            name: req.body.name ?? undefined,
            slug: req.body.slug ?? undefined,
            parentId: req.body.parentId === undefined ? undefined : req.body.parentId,
            description: req.body.description === undefined ? undefined : req.body.description,
            sortOrder: req.body.sortOrder ?? undefined,
            isActive: req.body.isActive ?? undefined,
          },
        });
        void invalidateReadCache(req.auth!.organizationId);
        await recordAudit({
          action: 'category_updated',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'category',
          entityId: c.id,
        });
        return {
          data: {
            id: c.id,
            parentId: c.parentId,
            name: c.name,
            slug: c.slug,
            description: c.description,
            sortOrder: c.sortOrder,
            isActive: c.isActive,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- POST /categories/bulk-delete --------------------------------
  // Deletes many categories in one round trip. Three modes:
  //   ids:       explicit list (max 500)
  //   all:       wipe every category in the org
  //   emptyOnly: wipe only categories with zero products + zero services
  // Products / services that referenced any deleted row get their
  // categoryId NULL'd by Prisma's onDelete: SetNull — no data is lost
  // beyond the link.
  r.post(
    '/categories/bulk-delete',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Delete many categories at once (selected / all / empty-only).',
        body: bulkDeleteCategoriesBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ deleted: z.number().int() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        let where: { id?: { in: string[] } } | object;
        if (req.body.all) {
          where = {};
        } else if (req.body.emptyOnly) {
          // "Empty" = no non-deleted products + no non-deleted services
          // currently linked. Compute the set of categories that DO have
          // at least one link, then delete everything else. Cheaper than
          // a complex correlated subquery + still small (categories per
          // tenant are O(100) in practice).
          const linked = new Set<string>();
          const [p, s] = await Promise.all([
            tx.product.findMany({
              where: { categoryId: { not: null }, deletedAt: null },
              select: { categoryId: true },
              distinct: ['categoryId'],
            }),
            tx.service.findMany({
              where: { categoryId: { not: null }, deletedAt: null },
              select: { categoryId: true },
              distinct: ['categoryId'],
            }),
          ]);
          for (const r of p) if (r.categoryId) linked.add(r.categoryId);
          for (const r of s) if (r.categoryId) linked.add(r.categoryId);
          const empty = await tx.category.findMany({
            where: linked.size > 0 ? { id: { notIn: Array.from(linked) } } : {},
            select: { id: true },
          });
          where = { id: { in: empty.map((c) => c.id) } };
        } else {
          where = { id: { in: req.body.ids ?? [] } };
        }
        const result = await tx.category.deleteMany({ where });
        void invalidateReadCache(req.auth!.organizationId);
        await recordAudit({
          action: 'category_deleted',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          metadata: {
            bulk: true,
            mode: req.body.all ? 'all' : req.body.emptyOnly ? 'emptyOnly' : 'selected',
            count: result.count,
          },
        });
        return { data: { deleted: result.count } };
      });
    },
  );

  // ---------- DELETE /categories/:id --------------------------------------
  r.delete(
    '/categories/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Delete a category. Products/services keep their data; categoryId is cleared.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const existing = await tx.category.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Category not found.');
        await tx.category.delete({ where: { id: existing.id } });
        void invalidateReadCache(req.auth!.organizationId);
        await recordAudit({
          action: 'category_deleted',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'category',
          entityId: existing.id,
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /categories/reorder ------------------------------------
  r.post(
    '/categories/reorder',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Bulk update sortOrder on a list of categories.',
        body: reorderCategoriesBodySchema,
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        await Promise.all(
          req.body.order.map((o) =>
            tx.category.updateMany({
              where: { id: o.id, organizationId: req.auth!.organizationId },
              data: { sortOrder: o.sortOrder },
            }),
          ),
        );
        void invalidateReadCache(req.auth!.organizationId);
        return { ok: true as const };
      });
    },
  );
}
