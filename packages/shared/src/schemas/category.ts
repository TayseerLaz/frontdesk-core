import { z } from 'zod';

import { slugSchema, uuidSchema } from './common.js';

export const categorySchema = z.object({
  id: uuidSchema,
  parentId: uuidSchema.nullable(),
  name: z.string(),
  slug: slugSchema,
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  // Optional product / service counts — populated by GET /categories
  // so the listing page can show "N products / M services" per row
  // without a follow-up request. Detail endpoints don't have to set
  // these.
  productCount: z.number().int().nonnegative().optional(),
  serviceCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Category = z.infer<typeof categorySchema>;

export const categoryTreeNodeSchema: z.ZodType<Category & { children: unknown[] }> = z.lazy(() =>
  categorySchema.extend({ children: z.array(categoryTreeNodeSchema) }),
);

export const createCategoryBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  parentId: uuidSchema.nullable().optional(),
  description: z.string().max(2000).optional(),
  sortOrder: z.number().int().optional(),
});
export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

export const updateCategoryBodySchema = createCategoryBodySchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;

export const reorderCategoriesBodySchema = z.object({
  order: z.array(z.object({ id: uuidSchema, sortOrder: z.number().int() })).min(1),
});
export type ReorderCategoriesBody = z.infer<typeof reorderCategoriesBodySchema>;

// Bulk delete categories. Exactly one of:
//   ids       — explicit list (max 500)
//   all       — wipe every category in the org
//   emptyOnly — wipe only categories with zero products + zero services
// Products / services that referenced a deleted category have their
// categoryId set to NULL (Prisma onDelete: SetNull).
export const bulkDeleteCategoriesBodySchema = z
  .object({
    ids: z.array(uuidSchema).min(1).max(500).optional(),
    all: z.boolean().optional(),
    emptyOnly: z.boolean().optional(),
  })
  .refine(
    (v) =>
      [Boolean(v.ids?.length), Boolean(v.all), Boolean(v.emptyOnly)].filter(Boolean).length === 1,
    { message: 'Provide exactly one of `ids`, `all: true`, or `emptyOnly: true`.' },
  );
export type BulkDeleteCategoriesBody = z.infer<typeof bulkDeleteCategoriesBodySchema>;
