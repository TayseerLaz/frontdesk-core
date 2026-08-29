import { z } from 'zod';

import { slugSchema, uuidSchema } from './common.js';

const moneyMinor = z.number().int().nonnegative().nullable();
const currency3 = z.string().length(3).regex(/^[A-Z]{3}$/);
// Read responses serialize whatever is in the DB. Historic crawler /
// import paths produced slugs that violate the strict slugSchema (too
// long, trailing hyphen). Strict validation belongs on user input
// (create / update); the read path must not reject existing rows.
const slugRead = z.string();

export const productImageSchema = z.object({
  id: uuidSchema,
  assetId: uuidSchema,
  url: z.string().url(),
  altText: z.string().nullable(),
  sortOrder: z.number().int(),
  isPrimary: z.boolean(),
});
export type ProductImage = z.infer<typeof productImageSchema>;

export const productVariantSchema = z.object({
  id: uuidSchema,
  sku: z.string(),
  name: z.string(),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  priceMinor: z.number().int().nonnegative().nullable(),
  stockQuantity: z.number().int().nonnegative().nullable(),
  isAvailable: z.boolean(),
  sortOrder: z.number().int(),
});
export type ProductVariant = z.infer<typeof productVariantSchema>;

export const productSchema = z.object({
  id: uuidSchema,
  sku: z.string(),
  name: z.string(),
  slug: slugRead,
  description: z.string().nullable(),
  shortDescription: z.string().nullable(),
  priceMinor: moneyMinor,
  compareAtMinor: moneyMinor,
  currency: currency3,
  isAvailable: z.boolean(),
  stockQuantity: z.number().int().nonnegative().nullable(),
  trackInventory: z.boolean(),
  attributes: z.record(z.string(), z.unknown()).nullable(),
  categoryId: uuidSchema.nullable(),
  categoryName: z.string().nullable(),
  images: z.array(productImageSchema),
  variants: z.array(productVariantSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Product = z.infer<typeof productSchema>;

export const productListItemSchema = z.object({
  id: uuidSchema,
  sku: z.string(),
  name: z.string(),
  slug: slugRead,
  shortDescription: z.string().nullable(),
  priceMinor: moneyMinor,
  // For Alinia real-estate mirror rows, priceMinor is intentionally NULL and
  // the human-readable price is derived from `attributes` (rent/sale-aware).
  // Null for native products (they use priceMinor). Optional for back-compat.
  priceLabel: z.string().nullable().optional(),
  currency: currency3,
  isAvailable: z.boolean(),
  stockQuantity: z.number().int().nonnegative().nullable(),
  primaryImageUrl: z.string().url().nullable(),
  categoryId: uuidSchema.nullable(),
  categoryName: z.string().nullable(),
  variantCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProductListItem = z.infer<typeof productListItemSchema>;

export const productListQuerySchema = z.object({
  q: z.string().trim().optional(),
  categoryId: uuidSchema.optional(),
  isAvailable: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  minPriceMinor: z.coerce.number().int().nonnegative().optional(),
  maxPriceMinor: z.coerce.number().int().nonnegative().optional(),
  sort: z
    .enum(['created_desc', 'created_asc', 'name_asc', 'name_desc', 'price_asc', 'price_desc'])
    .default('created_desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

export const createProductBodySchema = z.object({
  sku: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  slug: slugSchema.optional(),
  description: z.string().max(20000).optional().nullable(),
  shortDescription: z.string().max(500).optional().nullable(),
  priceMinor: moneyMinor.optional(),
  compareAtMinor: moneyMinor.optional(),
  currency: currency3.optional(),
  isAvailable: z.boolean().optional(),
  stockQuantity: z.number().int().nonnegative().nullable().optional(),
  trackInventory: z.boolean().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  categoryId: uuidSchema.nullable().optional(),
});
export type CreateProductBody = z.infer<typeof createProductBodySchema>;

export const updateProductBodySchema = createProductBodySchema.partial();
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;

export const upsertVariantBodySchema = z.object({
  id: uuidSchema.optional(),
  sku: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  priceMinor: z.number().int().nonnegative().nullable().optional(),
  stockQuantity: z.number().int().nonnegative().nullable().optional(),
  isAvailable: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export type UpsertVariantBody = z.infer<typeof upsertVariantBodySchema>;

export const setVariantsBodySchema = z.object({
  variants: z.array(upsertVariantBodySchema),
});

export const attachImageBodySchema = z.object({
  assetId: uuidSchema,
  altText: z.string().max(200).optional(),
  sortOrder: z.number().int().optional(),
  isPrimary: z.boolean().optional(),
});
export type AttachImageBody = z.infer<typeof attachImageBodySchema>;

export const reorderImagesBodySchema = z.object({
  order: z.array(z.object({ id: uuidSchema, sortOrder: z.number().int() })).min(1),
});

export const bulkUpdateProductsBodySchema = z.object({
  ids: z.array(uuidSchema).min(1).max(500),
  isAvailable: z.boolean().optional(),
  categoryId: uuidSchema.nullable().optional(),
});
export type BulkUpdateProductsBody = z.infer<typeof bulkUpdateProductsBodySchema>;

// Bulk soft-delete. Accepts a list of IDs OR `all: true` to wipe every
// non-deleted row in the org. The `all` shorthand lets the UI offer a
// real "delete every product" affordance without first paginating
// through hundreds of IDs.
export const bulkDeleteProductsBodySchema = z
  .object({
    ids: z.array(uuidSchema).min(1).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.ids?.length) !== Boolean(v.all), {
    message: 'Provide either `ids` or `all: true`, not both.',
  });
export type BulkDeleteProductsBody = z.infer<typeof bulkDeleteProductsBodySchema>;
