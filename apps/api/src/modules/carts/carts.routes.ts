import {
  CART_STATUSES,
  type CartItemInput,
  cartItemInputSchema,
  cartListQuerySchema,
  cartSchema,
  createCartBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  updateCartBodySchema,
  updateCartItemBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import type { Prisma } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ApiErrorCode } from '@platform/shared';
import { createNotification } from '../../lib/notifications.js';
import { emitWebhookEvent } from '../../lib/webhooks.js';
import { decodeCursor, encodeCursor } from '../catalog/shared.js';

type CartRow = Awaited<ReturnType<NonNullable<Prisma.TransactionClient['cart']['findFirst']>>>;
type CartItemRow = Awaited<
  ReturnType<NonNullable<Prisma.TransactionClient['cartItem']['findFirst']>>
>;

function serializeItem(it: NonNullable<CartItemRow>) {
  return {
    id: it.id,
    productId: it.productId,
    serviceId: it.serviceId,
    variantId: it.variantId,
    sku: it.sku,
    name: it.name,
    variantLabel: it.variantLabel,
    quantity: it.quantity,
    // BigInt columns -> Number for the DTO (safe: cart values << 2^53).
    unitPriceMinor: Number(it.unitPriceMinor),
    lineTotalMinor: Number(it.lineTotalMinor),
    notes: it.notes,
    needsPricing: it.needsPricing ?? false,
    createdAt: it.createdAt.toISOString(),
  };
}

function serializeCart(
  c: NonNullable<CartRow>,
  items: NonNullable<CartItemRow>[],
  // Display name for the cart's originating phone line, when known (voice).
  phoneIntegrationName: string | null = null,
) {
  return {
    id: c.id,
    threadId: c.threadId,
    customerPhone: c.customerPhone,
    customerName: c.customerName,
    fields: (Array.isArray(c.fields) ? c.fields : []) as never,
    items: items.map(serializeItem),
    subtotalMinor: Number(c.subtotalMinor),
    deliveryMinor: Number(c.deliveryMinor),
    totalMinor: Number(c.totalMinor),
    currency: c.currency,
    status: c.status as (typeof CART_STATUSES)[number],
    notes: c.notes,
    itemsCount: c.itemsCount,
    channel: c.channel ?? 'whatsapp',
    phoneIntegrationId: c.phoneIntegrationId,
    phoneIntegrationName,
    paymentProvider: c.paymentProvider,
    paymentStatus: c.paymentStatus,
    paidAt: c.paidAt ? c.paidAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// Compute cart-level totals from the items + a delivery fee. Subtotals are
// always recomputed from the items so we never drift; the caller passes the
// delivery the operator (or shopForm) configured.
function totals(
  items: { quantity: number; unitPriceMinor: number | bigint }[],
  deliveryMinor: number,
) {
  // Arithmetic stays in JS number (safe up to 2^53 ≫ any real cart). BigInt
  // columns are normalised on read; callers BigInt() the result on write.
  const subtotalMinor = items.reduce((acc, it) => acc + it.quantity * Number(it.unitPriceMinor), 0);
  return {
    subtotalMinor,
    deliveryMinor,
    totalMinor: subtotalMinor + deliveryMinor,
    itemsCount: items.reduce((acc, it) => acc + it.quantity, 0),
  };
}

/** number -> BigInt for the cart's BigInt money columns (defensive round). */
const toBig = (n: number | bigint): bigint => BigInt(Math.round(Number(n)));

export default async function cartsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /carts -----------------------------------------------
  r.get(
    '/carts',
    {
      schema: {
        tags: ['carts'],
        summary: 'List carts with optional status filter, search, cursor pagination.',
        querystring: cartListQuerySchema,
        response: { 200: listEnvelopeSchema(cartSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const where: Prisma.CartWhereInput = {
          // Default list excludes 'draft' rows — those are in-progress
          // carts the bot is still building. Operators opt in via
          // ?status=draft to see them (used for abandoned-cart recovery).
          ...(q.status
            ? { status: q.status }
            : { status: { not: 'draft' } }),
          ...(q.q
            ? {
                OR: [
                  { customerPhone: { contains: q.q, mode: 'insensitive' } },
                  { customerName: { contains: q.q, mode: 'insensitive' } },
                  { notes: { contains: q.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        };
        const cursor = decodeCursor<{ id: string }>(q.cursor);
        const rows = await tx.cart.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.limit + 1,
          ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
        });
        const hasMore = rows.length > q.limit;
        const page = hasMore ? rows.slice(0, q.limit) : rows;
        // Items for the visible page only (avoid an N+1 with includes).
        const ids = page.map((c) => c.id);
        const allItems = ids.length
          ? await tx.cartItem.findMany({
              where: { cartId: { in: ids } },
              orderBy: { createdAt: 'asc' },
            })
          : [];
        const byCart = new Map<string, NonNullable<CartItemRow>[]>();
        for (const it of allItems) {
          const arr = byCart.get(it.cartId) ?? [];
          arr.push(it);
          byCart.set(it.cartId, arr);
        }
        // Resolve originating phone-line names for voice carts on this page.
        const lineIds = Array.from(
          new Set(page.map((c) => c.phoneIntegrationId).filter((id): id is string => !!id)),
        );
        const lineNames = lineIds.length
          ? new Map(
              (
                await tx.phoneIntegration.findMany({
                  where: { id: { in: lineIds } },
                  select: { id: true, name: true },
                })
              ).map((l) => [l.id, l.name]),
            )
          : new Map<string, string>();
        return {
          data: page.map((c) =>
            serializeCart(
              c,
              byCart.get(c.id) ?? [],
              c.phoneIntegrationId ? lineNames.get(c.phoneIntegrationId) ?? null : null,
            ),
          ),
          nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
        };
      });
    },
  );

  // ---------- GET /carts/:id -------------------------------------------
  r.get(
    '/carts/:id',
    {
      schema: {
        tags: ['carts'],
        summary: 'Get a single cart with its line items.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(cartSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const c = await tx.cart.findUnique({ where: { id: req.params.id } });
        if (!c) throw notFound('Cart not found.');
        const items = await tx.cartItem.findMany({
          where: { cartId: c.id },
          orderBy: { createdAt: 'asc' },
        });
        const line = c.phoneIntegrationId
          ? await tx.phoneIntegration.findFirst({
              where: { id: c.phoneIntegrationId },
              select: { name: true },
            })
          : null;
        return { data: serializeCart(c, items, line?.name ?? null) };
      });
    },
  );

  // ---------- POST /carts ----------------------------------------------
  // Manual creation from the dashboard (e.g. phone-order taken by staff).
  // The bot's [CART: ...] marker calls this same code path via the receiver.
  r.post(
    '/carts',
    {
      schema: {
        tags: ['carts'],
        summary: 'Create a cart with one or more items.',
        body: createCartBodySchema,
        response: { 201: itemEnvelopeSchema(cartSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      // Determine delivery fee — body overrides shopForm.deliveryFeeMinor;
      // shopForm.freeDeliveryAboveMinor zeros the fee if the subtotal
      // crosses the free-delivery threshold.
      const result = await app.tenant(req, async (tx) => {
        const biz = await tx.businessInfo.findUnique({ where: { organizationId: orgId } });
        const shopForm =
          biz && biz.shopForm && typeof biz.shopForm === 'object'
            ? (biz.shopForm as {
                minOrderMinor?: number | null;
                deliveryFeeMinor?: number | null;
                freeDeliveryAboveMinor?: number | null;
              })
            : null;
        const items: CartItemInput[] = req.body.items;
        // Always recompute the subtotal — never trust client-side totals.
        const provisionalSubtotal = items.reduce((s, it) => s + it.quantity * it.unitPriceMinor, 0);

        if (shopForm?.minOrderMinor != null && provisionalSubtotal < shopForm.minOrderMinor) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            `Order below minimum (${(provisionalSubtotal / 1000).toFixed(3)} < ${(shopForm.minOrderMinor / 1000).toFixed(3)}).`,
          );
        }
        const baseDelivery = req.body.deliveryMinor ?? shopForm?.deliveryFeeMinor ?? 0;
        const deliveryMinor =
          shopForm?.freeDeliveryAboveMinor != null &&
          provisionalSubtotal >= shopForm.freeDeliveryAboveMinor
            ? 0
            : baseDelivery ?? 0;
        const computed = totals(items, deliveryMinor);
        const currency =
          req.body.currency ?? biz?.currency ?? 'USD';

        const c = await tx.cart.create({
          data: {
            organizationId: orgId,
            threadId: req.body.threadId ?? null,
            customerPhone: req.body.customerPhone,
            customerName: req.body.customerName ?? null,
            fields: req.body.fields as unknown as Prisma.InputJsonValue,
            subtotalMinor: toBig(computed.subtotalMinor),
            deliveryMinor: toBig(computed.deliveryMinor),
            totalMinor: toBig(computed.totalMinor),
            itemsCount: computed.itemsCount,
            currency,
            status: req.body.status ?? 'new',
            notes: req.body.notes ?? null,
            items: {
              createMany: {
                data: items.map((it) => ({
                  organizationId: orgId,
                  productId: it.productId ?? null,
                  serviceId: it.serviceId ?? null,
                  variantId: it.variantId ?? null,
                  sku: it.sku ?? null,
                  name: it.name,
                  variantLabel: it.variantLabel ?? null,
                  quantity: it.quantity,
                  unitPriceMinor: toBig(it.unitPriceMinor),
                  lineTotalMinor: toBig(it.quantity * Number(it.unitPriceMinor)),
                  notes: it.notes ?? null,
                })),
              },
            },
          },
        });
        const created = await tx.cartItem.findMany({
          where: { cartId: c.id },
          orderBy: { createdAt: 'asc' },
        });
        return { cart: c, items: created };
      });

      await recordAudit({
        action: 'cart_created',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'cart',
        entityId: result.cart.id,
      });
      void emitWebhookEvent({
        organizationId: orgId,
        eventKind: 'cart_created',
        payload: {
          id: result.cart.id,
          customerPhone: result.cart.customerPhone,
          totalMinor: Number(result.cart.totalMinor),
          currency: result.cart.currency,
          itemsCount: result.cart.itemsCount,
        },
      });
      void createNotification({
        organizationId: orgId,
        kind: 'cart_received',
        severity: 'info',
        title: `New cart · ${result.cart.itemsCount} item${result.cart.itemsCount === 1 ? '' : 's'}`,
        body: `${result.cart.customerName ?? result.cart.customerPhone} · ${Number(result.cart.totalMinor) / (result.cart.currency === 'KWD' || result.cart.currency === 'BHD' || result.cart.currency === 'OMR' || result.cart.currency === 'JOD' ? 1000 : 100)} ${result.cart.currency}`,
        link: `/cart`,
        entityType: 'cart',
        entityId: result.cart.id,
      });
      reply.code(201);
      return { data: serializeCart(result.cart, result.items) };
    },
  );

  // ---------- PATCH /carts/:id -----------------------------------------
  r.patch(
    '/carts/:id',
    {
      schema: {
        tags: ['carts'],
        summary: 'Update cart status / customer name / notes / delivery fee.',
        params: z.object({ id: uuidSchema }),
        body: updateCartBodySchema,
        response: { 200: itemEnvelopeSchema(cartSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.cart.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Cart not found.');

        // If the operator overrides the delivery fee, recompute total. Work in
        // JS number; BigInt() at the write.
        let deliveryMinor = Number(existing.deliveryMinor);
        let totalMinor = Number(existing.totalMinor);
        if (req.body.deliveryMinor !== undefined) {
          deliveryMinor = req.body.deliveryMinor;
          totalMinor = Number(existing.subtotalMinor) + deliveryMinor;
        }

        const updated = await tx.cart.update({
          where: { id: existing.id },
          data: {
            customerName: req.body.customerName === undefined ? undefined : req.body.customerName,
            fields:
              req.body.fields === undefined
                ? undefined
                : (req.body.fields as unknown as Prisma.InputJsonValue),
            status: req.body.status === undefined ? undefined : req.body.status,
            notes: req.body.notes === undefined ? undefined : req.body.notes,
            deliveryMinor: req.body.deliveryMinor === undefined ? undefined : toBig(deliveryMinor),
            totalMinor: req.body.deliveryMinor === undefined ? undefined : toBig(totalMinor),
          },
        });
        const items = await tx.cartItem.findMany({
          where: { cartId: updated.id },
          orderBy: { createdAt: 'asc' },
        });
        return { existing, updated, items };
      });

      await recordAudit({
        action: 'cart_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'cart',
        entityId: result.updated.id,
      });
      if (req.body.status && req.body.status !== result.existing.status) {
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'cart_status_changed',
          payload: {
            id: result.updated.id,
            from: result.existing.status,
            to: req.body.status,
          },
        });
      }
      return { data: serializeCart(result.updated, result.items) };
    },
  );

  // ---------- DELETE /carts/:id ----------------------------------------
  r.delete(
    '/carts/:id',
    {
      schema: {
        tags: ['carts'],
        summary: 'Delete a cart and its items.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      await app.tenant(req, async (tx) => {
        const existing = await tx.cart.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Cart not found.');
        await tx.cart.delete({ where: { id: existing.id } });
      });
      await recordAudit({
        action: 'cart_deleted',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'cart',
        entityId: req.params.id,
      });
      return { ok: true as const };
    },
  );

  // ---------- POST /carts/:id/items ------------------------------------
  // Adds a single line item to an existing cart. Recomputes totals.
  r.post(
    '/carts/:id/items',
    {
      schema: {
        tags: ['carts'],
        summary: 'Append a line item to a cart.',
        params: z.object({ id: uuidSchema }),
        body: cartItemInputSchema,
        response: { 201: itemEnvelopeSchema(cartSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const c = await tx.cart.findUnique({ where: { id: req.params.id } });
        if (!c) throw notFound('Cart not found.');
        const lineTotal = req.body.quantity * req.body.unitPriceMinor;
        await tx.cartItem.create({
          data: {
            organizationId: orgId,
            cartId: c.id,
            productId: req.body.productId ?? null,
            serviceId: req.body.serviceId ?? null,
            variantId: req.body.variantId ?? null,
            sku: req.body.sku ?? null,
            name: req.body.name,
            variantLabel: req.body.variantLabel ?? null,
            quantity: req.body.quantity,
            unitPriceMinor: toBig(req.body.unitPriceMinor),
            lineTotalMinor: toBig(lineTotal),
            notes: req.body.notes ?? null,
          },
        });
        const items = await tx.cartItem.findMany({
          where: { cartId: c.id },
          orderBy: { createdAt: 'asc' },
        });
        const computed = totals(items, Number(c.deliveryMinor));
        const updated = await tx.cart.update({
          where: { id: c.id },
          data: {
            subtotalMinor: toBig(computed.subtotalMinor),
            totalMinor: toBig(computed.totalMinor),
            itemsCount: computed.itemsCount,
          },
        });
        return { cart: updated, items };
      });
      void emitWebhookEvent({
        organizationId: orgId,
        eventKind: 'cart_item_added',
        payload: { id: result.cart.id, totalMinor: Number(result.cart.totalMinor) },
      });
      reply.code(201);
      return { data: serializeCart(result.cart, result.items) };
    },
  );

  // ---------- PATCH /carts/:id/items/:itemId ---------------------------
  r.patch(
    '/carts/:id/items/:itemId',
    {
      schema: {
        tags: ['carts'],
        summary: 'Update a line item (quantity / price / notes). Recomputes totals.',
        params: z.object({ id: uuidSchema, itemId: uuidSchema }),
        body: updateCartItemBodySchema,
        response: { 200: itemEnvelopeSchema(cartSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const it = await tx.cartItem.findFirst({
          where: { id: req.params.itemId, cartId: req.params.id },
        });
        if (!it) throw notFound('Line item not found.');
        const quantity = req.body.quantity ?? it.quantity;
        const unitPriceMinor = Number(req.body.unitPriceMinor ?? it.unitPriceMinor);
        await tx.cartItem.update({
          where: { id: it.id },
          data: {
            quantity,
            unitPriceMinor: toBig(unitPriceMinor),
            lineTotalMinor: toBig(quantity * unitPriceMinor),
            notes: req.body.notes === undefined ? undefined : req.body.notes,
          },
        });
        const c = await tx.cart.findUnique({ where: { id: req.params.id } });
        if (!c) throw notFound('Cart not found.');
        const items = await tx.cartItem.findMany({
          where: { cartId: c.id },
          orderBy: { createdAt: 'asc' },
        });
        const computed = totals(items, Number(c.deliveryMinor));
        const updated = await tx.cart.update({
          where: { id: c.id },
          data: {
            subtotalMinor: toBig(computed.subtotalMinor),
            totalMinor: toBig(computed.totalMinor),
            itemsCount: computed.itemsCount,
          },
        });
        return { cart: updated, items };
      });
      void orgId;
      return { data: serializeCart(result.cart, result.items) };
    },
  );

  // ---------- DELETE /carts/:id/items/:itemId --------------------------
  r.delete(
    '/carts/:id/items/:itemId',
    {
      schema: {
        tags: ['carts'],
        summary: 'Remove a line item and recompute totals.',
        params: z.object({ id: uuidSchema, itemId: uuidSchema }),
        response: { 200: itemEnvelopeSchema(cartSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const it = await tx.cartItem.findFirst({
          where: { id: req.params.itemId, cartId: req.params.id },
        });
        if (!it) throw notFound('Line item not found.');
        await tx.cartItem.delete({ where: { id: it.id } });
        const c = await tx.cart.findUnique({ where: { id: req.params.id } });
        if (!c) throw notFound('Cart not found.');
        const items = await tx.cartItem.findMany({
          where: { cartId: c.id },
          orderBy: { createdAt: 'asc' },
        });
        const computed = totals(items, Number(c.deliveryMinor));
        const updated = await tx.cart.update({
          where: { id: c.id },
          data: {
            subtotalMinor: toBig(computed.subtotalMinor),
            totalMinor: toBig(computed.totalMinor),
            itemsCount: computed.itemsCount,
          },
        });
        return { data: serializeCart(updated, items) };
      });
    },
  );
}
