// Lightweight DTOs for the chatbot read API.
// Intentionally minimal compared to portal DTOs — chatbots care about
// "what's the price?" not "who created this?".
import { z } from 'zod';

import { uuidSchema } from './common.js';

const currency3 = z.string().length(3);

export const readApiProductSchema = z.object({
  id: uuidSchema,
  sku: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  shortDescription: z.string().nullable(),
  priceMinor: z.number().int().nonnegative().nullable(),
  // Real-estate (Alinia) listings keep price in `attributes`, so priceMinor is
  // null for them; priceLabel is the human-readable, rent/sale-aware price.
  priceLabel: z.string().nullable().optional(),
  currency: currency3,
  available: z.boolean(),
  categoryName: z.string().nullable(),
  imageUrl: z.string().url().nullable(),
  variants: z.array(
    z.object({
      sku: z.string(),
      name: z.string(),
      options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      priceMinor: z.number().int().nullable(),
      available: z.boolean(),
    }),
  ),
});
export type ReadApiProduct = z.infer<typeof readApiProductSchema>;

export const readApiServiceSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  shortDescription: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  basePriceMinor: z.number().int().nullable(),
  currency: currency3,
  priceUnit: z.string(),
  available: z.boolean(),
  categoryName: z.string().nullable(),
  pricingTiers: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable(),
      priceMinor: z.number().int(),
      currency: currency3,
      priceUnit: z.string(),
      features: z.array(z.string()),
    }),
  ),
  availability: z.array(
    z.object({
      dayOfWeek: z.string(),
      startMinute: z.number().int(),
      endMinute: z.number().int(),
    }),
  ),
});
export type ReadApiService = z.infer<typeof readApiServiceSchema>;

export const readApiBusinessInfoSchema = z.object({
  legalName: z.string().nullable(),
  tagline: z.string().nullable(),
  about: z.string().nullable(),
  websiteUrl: z.string().url().nullable(),
  timezone: z.string(),
  currency: currency3,
  operatingHours: z.record(z.string(), z.array(z.object({ open: z.string(), close: z.string() }))).nullable(),
  locations: z.array(
    z.object({
      name: z.string(),
      address: z.string().nullable(),
      city: z.string().nullable(),
      country: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      isPrimary: z.boolean(),
    }),
  ),
  contacts: z.array(z.object({ kind: z.string(), label: z.string().nullable(), value: z.string() })),
});
export type ReadApiBusinessInfo = z.infer<typeof readApiBusinessInfoSchema>;

export const readApiFaqSchema = z.object({
  id: uuidSchema,
  question: z.string(),
  answer: z.string(),
  tags: z.array(z.string()),
});
export type ReadApiFaq = z.infer<typeof readApiFaqSchema>;

export const readApiPolicySchema = z.object({
  kind: z.string(),
  title: z.string(),
  content: z.string(),
});
export type ReadApiPolicy = z.infer<typeof readApiPolicySchema>;

export const readApiSearchHitSchema = z.object({
  type: z.enum(['product', 'service', 'faq']),
  id: uuidSchema,
  title: z.string(),
  snippet: z.string().nullable(),
  url: z.string().nullable(),
});
export type ReadApiSearchHit = z.infer<typeof readApiSearchHitSchema>;

export const readApiQuerySchema = z.object({
  q: z.string().trim().optional(),
  category: z.string().optional(),
  available: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
