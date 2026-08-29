import {
  ApiErrorCode,
  attachImageBodySchema,
  bulkDeleteProductsBodySchema,
  bulkUpdateProductsBodySchema,
  createProductBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  productListItemSchema,
  productListQuerySchema,
  productSchema,
  reorderImagesBodySchema,
  setVariantsBodySchema,
  successSchema,
  updateProductBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Prisma } from '../../lib/db.js';
import { recordAudit } from '../../lib/audit.js';
import { capCheck } from '../../lib/billing.js';
import { prisma as rootPrisma } from '../../lib/db.js';
import { embedProductAndStore } from '../../lib/embedding.js';
import { conflict, notFound } from '../../lib/errors.js';
import { invalidateReadCache } from '../../lib/read-cache.js';
import { recordRevision } from '../../lib/versioning.js';
import { emitWebhookEvent } from '../../lib/webhooks.js';
import { decodeCursor, encodeCursor, resolveAssetUrl, slugify } from './shared.js';

const SORT_ORDERS: Record<string, Prisma.ProductOrderByWithRelationInput[]> = {
  created_desc: [{ createdAt: 'desc' }, { id: 'desc' }],
  created_asc: [{ createdAt: 'asc' }, { id: 'asc' }],
  name_asc: [{ name: 'asc' }, { id: 'asc' }],
  name_desc: [{ name: 'desc' }, { id: 'desc' }],
  price_asc: [{ priceMinor: 'asc' }, { id: 'asc' }],
  price_desc: [{ priceMinor: 'desc' }, { id: 'desc' }],
};

export default async function productRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /products -----------------------------------------------
  r.get(
    '/products',
    {
      schema: {
        tags: ['catalog'],
        summary: 'List products with search, filter, and cursor pagination.',
        querystring: productListQuerySchema,
        response: { 200: listEnvelopeSchema(productListItemSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const where: Prisma.ProductWhereInput = {
          deletedAt: null,
          ...(q.categoryId ? { categoryId: q.categoryId } : {}),
          ...(q.isAvailable !== undefined ? { isAvailable: q.isAvailable } : {}),
          ...(q.minPriceMinor !== undefined || q.maxPriceMinor !== undefined
            ? {
                priceMinor: {
                  ...(q.minPriceMinor !== undefined ? { gte: q.minPriceMinor } : {}),
                  ...(q.maxPriceMinor !== undefined ? { lte: q.maxPriceMinor } : {}),
                },
              }
            : {}),
          ...(q.q
            ? {
                OR: [
                  { name: { contains: q.q, mode: 'insensitive' } },
                  { sku: { contains: q.q, mode: 'insensitive' } },
                  { searchText: { contains: q.q.toLowerCase() } },
                ],
              }
            : {}),
        };
        const cursor = decodeCursor<{ id: string }>(q.cursor);
        // Fetch a page + the total count in parallel so the UI can render
        // "N products" / "Showing X of N" without an extra round trip.
        // Currency is a single source of truth at the org level
        // (BusinessInfo.currency) — the per-product `currency` column is a
        // denormalized default that drifts (seed/import write "USD", and a
        // later business-info currency change never backfills it). Always
        // report the org currency so prices don't render as "$" on a
        // KWD/EUR/etc. catalog.
        const [products, total, orgInfo] = await Promise.all([
          tx.product.findMany({
            where,
            orderBy: SORT_ORDERS[q.sort],
            include: {
              category: { select: { id: true, name: true } },
              images: { orderBy: { sortOrder: 'asc' }, take: 1, include: { asset: true } },
              _count: { select: { variants: true } },
            },
            take: q.limit + 1,
            ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
          }),
          tx.product.count({ where }),
          tx.businessInfo.findUnique({
            where: { organizationId: req.auth!.organizationId },
            select: { currency: true },
          }),
        ]);
        const orgCurrency = orgInfo?.currency || 'USD';
        const hasMore = products.length > q.limit;
        const page = hasMore ? products.slice(0, q.limit) : products;
        const data = await Promise.all(
          page.map(async (p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            slug: p.slug,
            shortDescription: p.shortDescription,
            priceMinor: p.priceMinor,
            currency: orgCurrency,
            isAvailable: p.isAvailable,
            stockQuantity: p.stockQuantity,
            primaryImageUrl: p.images[0] ? await resolveAssetUrl(p.images[0].asset.storageKey) : null,
            categoryId: p.categoryId,
            categoryName: p.category?.name ?? null,
            variantCount: p._count.variants,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          })),
        );
        return {
          data,
          nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
          total,
        };
      });
    },
  );

  // ---------- POST /products ----------------------------------------------
  r.post(
    '/products',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Create a product.',
        body: createProductBodySchema,
        response: { 201: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        await capCheck(tx as never, orgId, 'product', {
          actorIsSuperAdmin: req.auth!.isSuperAdmin,
        });
        const slug = req.body.slug ?? slugify(req.body.name);
        const dupes = await tx.product.findFirst({
          where: { OR: [{ sku: req.body.sku }, { slug }], deletedAt: null },
        });
        if (dupes) throw conflict('A product with that SKU or slug already exists.');

        // Currency is now a single source of truth at the org level — read
        // it off BusinessInfo and ignore any client-supplied currency. This
        // prevents operators from accidentally mixing USD products into a
        // KWD-default catalog and breaking the cart math.
        const orgInfo = await tx.businessInfo.findUnique({
          where: { organizationId: orgId },
          select: { currency: true },
        });
        const orgCurrency = orgInfo?.currency || 'USD';

        const created = await tx.product.create({
          data: {
            organizationId: orgId,
            sku: req.body.sku,
            name: req.body.name,
            slug,
            description: req.body.description ?? null,
            shortDescription: req.body.shortDescription ?? null,
            priceMinor: req.body.priceMinor ?? null,
            compareAtMinor: req.body.compareAtMinor ?? null,
            currency: orgCurrency,
            isAvailable: req.body.isAvailable ?? true,
            stockQuantity: req.body.stockQuantity ?? null,
            trackInventory: req.body.trackInventory ?? false,
            // Prisma's InputJsonValue type is recursive and rejects a
            // plain Record<string, unknown>; cast through `never` so the
            // value passes the JSON column type-check at compile time.
            // (Runtime is unchanged — Prisma serialises Record/objects to JSON.)
            attributes: (req.body.attributes ?? undefined) as never,
            categoryId: req.body.categoryId ?? null,
          },
        });
        await recordAudit({
          action: 'product_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'product',
          entityId: created.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'product_created',
          payload: { id: created.id, sku: created.sku, name: created.name },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'product',
          entityId: created.id,
          action: 'created',
          snapshot: created as unknown as Record<string, unknown>,
          actorUserId: req.auth!.userId,
          summary: `Created "${created.name}"`,
        });
        // Phase 2 Step 3 — fire-and-forget embed so the new product is
        // discoverable by the bot pipeline immediately. Failure here is
        // benign: the bot-engine top-K ranker treats missing embeddings
        // as "include as filler" so nothing is silently hidden.
        void embedProductAndStore(rootPrisma, created.id).catch((err) =>
          req.log.warn({ err: err instanceof Error ? err.message : err, productId: created.id }, '[embed] product embed-on-create failed'),
        );
        reply.code(201);
        return { data: await loadProduct(tx, created.id) };
      });
    },
  );

  // ---------- GET /products/:id -------------------------------------------
  r.get(
    '/products/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Get one product.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const product = await loadProduct(tx, req.params.id);
        return { data: product };
      });
    },
  );

  // ---------- PATCH /products/:id -----------------------------------------
  r.patch(
    '/products/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Update a product.',
        params: z.object({ id: uuidSchema }),
        body: updateProductBodySchema,
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.product.findUnique({ where: { id: req.params.id } });
        if (!existing || existing.deletedAt) throw notFound('Product not found.');

        const updates: Prisma.ProductUpdateInput = {
          name: req.body.name ?? undefined,
          slug: req.body.slug ?? undefined,
          sku: req.body.sku ?? undefined,
          description: req.body.description === undefined ? undefined : req.body.description,
          shortDescription: req.body.shortDescription === undefined ? undefined : req.body.shortDescription,
          priceMinor: req.body.priceMinor === undefined ? undefined : req.body.priceMinor,
          compareAtMinor: req.body.compareAtMinor === undefined ? undefined : req.body.compareAtMinor,
          // Currency is locked to the org-level BusinessInfo.currency.
          // Ignore any client-supplied currency on PATCH — operators
          // change currency on /business-info, never per-product.
          isAvailable: req.body.isAvailable ?? undefined,
          stockQuantity: req.body.stockQuantity === undefined ? undefined : req.body.stockQuantity,
          trackInventory: req.body.trackInventory ?? undefined,
          attributes: req.body.attributes === undefined ? undefined : (req.body.attributes as Prisma.InputJsonValue),
          ...(req.body.categoryId === undefined
            ? {}
            : req.body.categoryId === null
              ? { category: { disconnect: true } }
              : { category: { connect: { id: req.body.categoryId } } }),
        };

        const updated = await tx.product.update({ where: { id: existing.id }, data: updates });
        await recordAudit({
          action: 'product_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'product',
          entityId: existing.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'product_updated',
          payload: { id: existing.id, sku: existing.sku },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'product',
          entityId: existing.id,
          action: 'updated',
          snapshot: updated as unknown as Record<string, unknown>,
          actorUserId: req.auth!.userId,
        });
        // Phase 2 Step 3 — re-embed if name or shortDescription changed.
        // embedProductAndStore() compares the canonical hash internally
        // and no-ops when the row is unchanged, so this is safe even for
        // patches that only touch price / stock / availability.
        if (req.body.name !== undefined || req.body.shortDescription !== undefined) {
          void embedProductAndStore(rootPrisma, existing.id).catch((err) =>
            req.log.warn({ err: err instanceof Error ? err.message : err, productId: existing.id }, '[embed] product embed-on-update failed'),
          );
        }
        return { data: await loadProduct(tx, existing.id) };
      });
    },
  );

  // ---------- DELETE /products/:id ----------------------------------------
  r.delete(
    '/products/:id',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Soft-delete a product.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.product.findUnique({ where: { id: req.params.id } });
        if (!existing || existing.deletedAt) throw notFound('Product not found.');
        // Append a tombstone marker to sku/slug so the user can recreate a
        // product with the original identifiers — the unique constraint
        // covers soft-deleted rows too.
        const tombstone = `__deleted-${Date.now().toString(36)}`;
        await tx.product.update({
          where: { id: existing.id },
          data: {
            deletedAt: new Date(),
            sku: `${existing.sku}${tombstone}`,
            slug: `${existing.slug}${tombstone}`,
          },
        });
        await recordAudit({
          action: 'product_deleted',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'product',
          entityId: existing.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'product_deleted',
          payload: { id: existing.id, sku: existing.sku },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'product',
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

  // ---------- PUT /products/:id/variants ----------------------------------
  r.put(
    '/products/:id/variants',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Replace the variant set for a product (idempotent upsert).',
        params: z.object({ id: uuidSchema }),
        body: setVariantsBodySchema,
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const product = await tx.product.findUnique({ where: { id: req.params.id } });
        if (!product || product.deletedAt) throw notFound('Product not found.');

        const incomingIds = new Set(
          req.body.variants.filter((v) => v.id).map((v) => v.id as string),
        );
        // Delete variants not in the incoming set.
        await tx.productVariant.deleteMany({
          where: { productId: product.id, id: { notIn: Array.from(incomingIds) } },
        });
        // Upsert each incoming variant.
        for (const [idx, v] of req.body.variants.entries()) {
          if (v.id) {
            await tx.productVariant.update({
              where: { id: v.id },
              data: {
                sku: v.sku,
                name: v.name,
                options: v.options as Prisma.InputJsonValue,
                priceMinor: v.priceMinor ?? null,
                stockQuantity: v.stockQuantity ?? null,
                isAvailable: v.isAvailable ?? true,
                sortOrder: v.sortOrder ?? idx,
              },
            });
          } else {
            await tx.productVariant.create({
              data: {
                organizationId: orgId,
                productId: product.id,
                sku: v.sku,
                name: v.name,
                options: v.options as Prisma.InputJsonValue,
                priceMinor: v.priceMinor ?? null,
                stockQuantity: v.stockQuantity ?? null,
                isAvailable: v.isAvailable ?? true,
                sortOrder: v.sortOrder ?? idx,
              },
            });
          }
        }
        const data = await loadProduct(tx, product.id);
        // Variants affect read-API product payloads — invalidate the cache (F).
        void invalidateReadCache(orgId);
        return { data };
      });
    },
  );

  // ---------- POST /products/:id/images -----------------------------------
  r.post(
    '/products/:id/images',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Attach an uploaded asset to a product as an image.',
        params: z.object({ id: uuidSchema }),
        body: attachImageBodySchema,
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const product = await tx.product.findUnique({ where: { id: req.params.id } });
        if (!product || product.deletedAt) throw notFound('Product not found.');
        const asset = await tx.asset.findUnique({ where: { id: req.body.assetId } });
        if (!asset) throw notFound('Asset not found.');
        if (asset.kind !== 'image') throw conflict('Asset is not an image.');

        if (req.body.isPrimary) {
          await tx.productImage.updateMany({ where: { productId: product.id }, data: { isPrimary: false } });
        }
        await tx.productImage.create({
          data: {
            organizationId: orgId,
            productId: product.id,
            assetId: asset.id,
            altText: req.body.altText ?? null,
            sortOrder: req.body.sortOrder ?? 0,
            isPrimary: req.body.isPrimary ?? false,
          },
        });
        const data = await loadProduct(tx, product.id);
        void invalidateReadCache(orgId); // images appear in read-API payloads
        return { data };
      });
    },
  );

  // ---------- DELETE /products/:id/images/:imageId ------------------------
  r.delete(
    '/products/:id/images/:imageId',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Detach an image from a product (asset is kept).',
        params: z.object({ id: uuidSchema, imageId: uuidSchema }),
        response: { 200: itemEnvelopeSchema(productSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        await tx.productImage.deleteMany({
          where: { id: req.params.imageId, productId: req.params.id },
        });
        const data = await loadProduct(tx, req.params.id);
        void invalidateReadCache(req.auth!.organizationId);
        return { data };
      });
    },
  );

  // ---------- POST /products/:id/images/reorder ---------------------------
  r.post(
    '/products/:id/images/reorder',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Reorder a product\'s images.',
        params: z.object({ id: uuidSchema }),
        body: reorderImagesBodySchema,
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        await Promise.all(
          req.body.order.map((o) =>
            tx.productImage.updateMany({
              where: { id: o.id, productId: req.params.id },
              data: { sortOrder: o.sortOrder },
            }),
          ),
        );
        void invalidateReadCache(req.auth!.organizationId); // image order is read-visible
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /products/bulk-delete ----------------------------------
  // Soft-deletes many products in one round trip. Accepts either an
  // explicit ID list (max 500) or `all: true` to delete every active
  // product in the org. The `all` shorthand exists for the "delete every
  // product" admin affordance — RLS still scopes the updateMany to the
  // current org, so there's no cross-tenant blast radius.
  r.post(
    '/products/bulk-delete',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Soft-delete many products at once (or every product when all=true).',
        body: bulkDeleteProductsBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ deleted: z.number().int() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const where = req.body.all
          ? { deletedAt: null }
          : { id: { in: req.body.ids ?? [] }, deletedAt: null };
        const result = await tx.product.updateMany({
          where,
          data: { deletedAt: new Date(), isAvailable: false },
        });
        await recordAudit({
          action: 'product_deleted',
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

  // ---------- POST /products/bulk-update ----------------------------------
  r.post(
    '/products/bulk-update',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Update fields on many products at once (availability / category).',
        body: bulkUpdateProductsBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ updated: z.number().int() })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const result = await tx.product.updateMany({
          where: { id: { in: req.body.ids }, deletedAt: null },
          data: {
            ...(req.body.isAvailable !== undefined ? { isAvailable: req.body.isAvailable } : {}),
            ...(req.body.categoryId !== undefined ? { categoryId: req.body.categoryId } : {}),
          },
        });
        void invalidateReadCache(req.auth!.organizationId);
        return { data: { updated: result.count } };
      });
    },
  );
}

// ---------- helpers ---------------------------------------------------------
async function loadProduct(tx: Prisma.TransactionClient, id: string) {
  const p = await tx.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true } },
      images: { orderBy: { sortOrder: 'asc' }, include: { asset: true } },
      variants: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!p) throw notFound('Product not found.');
  // Currency is org-level (BusinessInfo.currency) — see the list handler.
  // Report it instead of the drift-prone per-product column.
  const orgInfo = await tx.businessInfo.findUnique({
    where: { organizationId: p.organizationId },
    select: { currency: true },
  });
  const orgCurrency = orgInfo?.currency || 'USD';
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    slug: p.slug,
    description: p.description,
    shortDescription: p.shortDescription,
    priceMinor: p.priceMinor,
    compareAtMinor: p.compareAtMinor,
    currency: orgCurrency,
    isAvailable: p.isAvailable,
    // Stock is nonnegative in the API; Shopify oversold rows go negative, so
    // clamp a negative count to null ("unknown") rather than 500 on validation.
    stockQuantity: p.stockQuantity != null && p.stockQuantity < 0 ? null : p.stockQuantity,
    trackInventory: p.trackInventory,
    attributes: (p.attributes ?? null) as Record<string, unknown> | null,
    categoryId: p.categoryId,
    categoryName: p.category?.name ?? null,
    images: await Promise.all(
      p.images.map(async (img) => ({
        id: img.id,
        assetId: img.assetId,
        url: await resolveAssetUrl(img.asset.storageKey),
        altText: img.altText,
        sortOrder: img.sortOrder,
        isPrimary: img.isPrimary,
      })),
    ),
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      // options is a key→value map. Tolerate legacy/imported rows that stored
      // it as an array (e.g. ["M","L"]) by mapping to { "Option 1": "M", … } so
      // the detail endpoint never 500s on response validation.
      options: Array.isArray(v.options)
        ? Object.fromEntries(
            (v.options as unknown[]).map((val, i) => [`Option ${i + 1}`, val as string | number | boolean]),
          )
        : ((v.options as Record<string, string | number | boolean>) ?? {}),
      priceMinor: v.priceMinor != null && v.priceMinor < 0 ? null : v.priceMinor,
      stockQuantity: v.stockQuantity != null && v.stockQuantity < 0 ? null : v.stockQuantity,
      isAvailable: v.isAvailable,
      sortOrder: v.sortOrder,
    })),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
