import { z } from 'zod';

import { shopFormFieldSchema } from './business-info.js';
import { uuidSchema } from './common.js';

// Cart status flow (Phase 1, simple): new → confirmed → completed,
// with `cancelled` as a terminal escape hatch from any earlier state.
// `draft` is the in-progress state the bot maintains as the customer
// adds items via WhatsApp. Promoted to `new` when the customer
// confirms (the [CART:] marker fires). Drafts are filtered out of the
// default Orders list — operators opt in via `?status=draft`.
export const CART_STATUSES = ['draft', 'new', 'confirmed', 'completed', 'cancelled'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

// One CartItem row. Snapshot of name / sku / variantLabel travels with
// the cart so deleted catalog rows don't break historical orders.
export const cartItemSchema = z.object({
  id: uuidSchema,
  productId: uuidSchema.nullable(),
  serviceId: uuidSchema.nullable(),
  variantId: uuidSchema.nullable(),
  sku: z.string().nullable(),
  name: z.string(),
  variantLabel: z.string().nullable(),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
  lineTotalMinor: z.number().int().nonnegative(),
  notes: z.string().nullable(),
  // Voice orders: a spoken item that didn't resolve to a catalog product lands
  // on the order at price 0 with this flag set, for the operator to price.
  // Optional + defaulted so older clients / non-voice carts stay valid.
  needsPricing: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type CartItemDto = z.infer<typeof cartItemSchema>;

// Frozen snapshot of the shopForm.fields[] answers — same loose value
// type as Booking.fields so the bot can emit strings, numbers, or
// booleans without us bouncing the request.
export const cartFieldAnswerSchema = shopFormFieldSchema.extend({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).nullable().default(null),
});
export type CartFieldAnswer = z.infer<typeof cartFieldAnswerSchema>;

export const cartSchema = z.object({
  id: uuidSchema,
  threadId: uuidSchema.nullable(),
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  fields: z.array(cartFieldAnswerSchema),
  items: z.array(cartItemSchema),
  subtotalMinor: z.number().int().nonnegative(),
  deliveryMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  currency: z.string(),
  status: z.enum(CART_STATUSES),
  notes: z.string().nullable(),
  itemsCount: z.number().int().nonnegative(),
  // Origin channel: 'whatsapp' | 'messenger' | 'instagram' | 'voice'. Defaulted
  // so older clients (and carts created before the column existed) stay valid.
  channel: z.string().default('whatsapp'),
  // For voice carts: the phone line the order came in on + its display name
  // (so the UI can show "via <line>"). Null for non-voice / when unresolved.
  phoneIntegrationId: uuidSchema.nullable().default(null),
  phoneIntegrationName: z.string().nullable().default(null),
  // Payment confirmation (F-04). paymentStatus: null = no online payment,
  // 'pending' = link issued, 'paid' = gateway webhook confirmed.
  paymentProvider: z.string().nullable(),
  paymentStatus: z.string().nullable(),
  paidAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CartDto = z.infer<typeof cartSchema>;

export const cartListQuerySchema = z.object({
  status: z.enum(CART_STATUSES).optional(),
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type CartListQuery = z.infer<typeof cartListQuerySchema>;

// Items can be created manually from the dashboard OR by the bot via
// the [CART: ...] marker. Either way the catalog row references are
// optional — for ad-hoc lines we just need a name + price.
export const cartItemInputSchema = z.object({
  productId: uuidSchema.nullable().optional(),
  serviceId: uuidSchema.nullable().optional(),
  variantId: uuidSchema.nullable().optional(),
  sku: z.string().trim().max(80).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  variantLabel: z.string().trim().max(120).nullable().optional(),
  quantity: z.number().int().positive().max(999).default(1),
  unitPriceMinor: z.number().int().nonnegative(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type CartItemInput = z.infer<typeof cartItemInputSchema>;

export const createCartBodySchema = z.object({
  threadId: uuidSchema.nullable().optional(),
  customerPhone: z.string().trim().min(3).max(40),
  customerName: z.string().trim().max(200).nullable().optional(),
  fields: z.array(cartFieldAnswerSchema).max(40).default([]),
  items: z.array(cartItemInputSchema).min(1).max(100),
  // Override the org-default delivery fee for this cart if needed.
  deliveryMinor: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
  status: z.enum(CART_STATUSES).optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type CreateCartBody = z.infer<typeof createCartBodySchema>;

export const updateCartBodySchema = z.object({
  customerName: z.string().trim().max(200).nullable().optional(),
  fields: z.array(cartFieldAnswerSchema).max(40).optional(),
  status: z.enum(CART_STATUSES).optional(),
  notes: z.string().max(2000).nullable().optional(),
  deliveryMinor: z.number().int().nonnegative().optional(),
});
export type UpdateCartBody = z.infer<typeof updateCartBodySchema>;

export const updateCartItemBodySchema = z.object({
  quantity: z.number().int().positive().max(999).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  unitPriceMinor: z.number().int().nonnegative().optional(),
});
export type UpdateCartItemBody = z.infer<typeof updateCartItemBodySchema>;
