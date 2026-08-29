import { z } from 'zod';

import { DayOfWeek, PriceUnit } from '../enums/catalog.js';
import { slugSchema, uuidSchema } from './common.js';

const moneyMinor = z.number().int().nonnegative();
const currency3 = z.string().length(3).regex(/^[A-Z]{3}$/);

export const servicePricingTierSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  priceMinor: moneyMinor,
  currency: currency3,
  priceUnit: z.nativeEnum(PriceUnit),
  features: z.array(z.string()),
  sortOrder: z.number().int(),
});
export type ServicePricingTier = z.infer<typeof servicePricingTierSchema>;

export const availabilityWindowSchema = z.object({
  id: uuidSchema,
  dayOfWeek: z.nativeEnum(DayOfWeek),
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
  effectiveFrom: z.string().datetime().nullable(),
  effectiveUntil: z.string().datetime().nullable(),
});
export type AvailabilityWindow = z.infer<typeof availabilityWindowSchema>;

export const serviceSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  description: z.string().nullable(),
  shortDescription: z.string().nullable(),
  durationMinutes: z.number().int().nonnegative().nullable(),
  basePriceMinor: moneyMinor.nullable(),
  currency: currency3,
  priceUnit: z.nativeEnum(PriceUnit),
  isAvailable: z.boolean(),
  bookingRules: z.record(z.string(), z.unknown()).nullable(),
  categoryId: uuidSchema.nullable(),
  categoryName: z.string().nullable(),
  pricingTiers: z.array(servicePricingTierSchema),
  availability: z.array(availabilityWindowSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Service = z.infer<typeof serviceSchema>;

export const serviceListItemSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  shortDescription: z.string().nullable(),
  basePriceMinor: moneyMinor.nullable(),
  currency: currency3,
  priceUnit: z.nativeEnum(PriceUnit),
  durationMinutes: z.number().int().nullable(),
  isAvailable: z.boolean(),
  categoryName: z.string().nullable(),
  tierCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ServiceListItem = z.infer<typeof serviceListItemSchema>;

export const serviceListQuerySchema = z.object({
  q: z.string().trim().optional(),
  categoryId: uuidSchema.optional(),
  isAvailable: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  sort: z.enum(['created_desc', 'created_asc', 'name_asc', 'name_desc']).default('created_desc'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const createServiceBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugSchema.optional(),
  description: z.string().max(20000).optional().nullable(),
  shortDescription: z.string().max(500).optional().nullable(),
  durationMinutes: z.number().int().nonnegative().nullable().optional(),
  basePriceMinor: moneyMinor.nullable().optional(),
  currency: currency3.optional(),
  priceUnit: z.nativeEnum(PriceUnit).optional(),
  isAvailable: z.boolean().optional(),
  bookingRules: z.record(z.string(), z.unknown()).optional(),
  categoryId: uuidSchema.nullable().optional(),
});
export type CreateServiceBody = z.infer<typeof createServiceBodySchema>;

export const updateServiceBodySchema = createServiceBodySchema.partial();
export type UpdateServiceBody = z.infer<typeof updateServiceBodySchema>;

export const upsertPricingTierBodySchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  priceMinor: moneyMinor,
  currency: currency3.optional(),
  priceUnit: z.nativeEnum(PriceUnit).optional(),
  features: z.array(z.string().max(200)).max(50).default([]),
  sortOrder: z.number().int().optional(),
});

export const setPricingTiersBodySchema = z.object({
  tiers: z.array(upsertPricingTierBodySchema),
});

export const upsertAvailabilityBodySchema = z.object({
  id: uuidSchema.optional(),
  dayOfWeek: z.nativeEnum(DayOfWeek),
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
  effectiveFrom: z.string().datetime().nullable().optional(),
  effectiveUntil: z.string().datetime().nullable().optional(),
}).refine((v) => v.startMinute < v.endMinute, 'startMinute must be before endMinute');

export const setAvailabilityBodySchema = z.object({
  windows: z.array(upsertAvailabilityBodySchema),
});

// Bulk soft-delete services. Mirrors the products endpoint — accepts
// either an explicit ID list or `all: true` to wipe every non-deleted
// service in the org.
export const bulkDeleteServicesBodySchema = z
  .object({
    ids: z.array(uuidSchema).min(1).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.ids?.length) !== Boolean(v.all), {
    message: 'Provide either `ids` or `all: true`, not both.',
  });
export type BulkDeleteServicesBody = z.infer<typeof bulkDeleteServicesBodySchema>;
