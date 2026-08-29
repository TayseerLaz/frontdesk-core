import { z } from 'zod';

// The sections a scraped Shopify store splits into. Mirrors the
// ShopifyStagedSection enum in the Prisma schema. (No 'service' — Shopify has
// no services concept; everything sellable is a product.)
export const SHOPIFY_SECTIONS = [
  'product',
  'contact',
  'business_info',
  'policy',
  'faq',
  'location',
] as const;
export type ShopifySection = (typeof SHOPIFY_SECTIONS)[number];

export const SHOPIFY_STAGED_STATUSES = ['pending', 'approved', 'rejected', 'imported'] as const;
export type ShopifyStagedStatus = (typeof SHOPIFY_STAGED_STATUSES)[number];

// Upsert body for the connection. Credentials (accessToken, apiSecret) are
// write-only — send '' to clear, omit to leave unchanged; never returned.
export const upsertShopifyConnectionBodySchema = z.object({
  // Permanent myshopify domain. Accepts an optional https:// + trailing slash;
  // the API normalizes to the bare "xxx.myshopify.com".
  storeDomain: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .refine((v) => /(^|\/\/)[a-z0-9][a-z0-9-]*\.myshopify\.com\/?$/i.test(v.trim()), {
      message: 'Must be your permanent *.myshopify.com domain',
    })
    .optional(),
  accessToken: z.string().trim().max(4000).optional(),
  apiSecret: z.string().trim().max(2000).optional(),
  autoSyncEnabled: z.boolean().optional(),
});
export type UpsertShopifyConnectionBody = z.infer<typeof upsertShopifyConnectionBodySchema>;

// Per-(section,status) staged counts, e.g. { product: { pending: 27, ... } }.
export const shopifyStagedCountsSchema = z.record(
  z.string(),
  z.record(z.string(), z.number()),
);

export const shopifyScrapeRunSchema = z.object({
  id: z.string(),
  phase: z.string(),
  trigger: z.string(),
  status: z.string(),
  productsFound: z.number(),
  contactsFound: z.number(),
  otherFound: z.number(),
  recordsImported: z.number(),
  recordsFailed: z.number(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ShopifyScrapeRunDto = z.infer<typeof shopifyScrapeRunSchema>;

// Connection DTO — non-secret config + has* booleans + staged counts + latest run.
export const shopifyConnectionSchema = z.object({
  connected: z.boolean(),
  storeDomain: z.string().nullable(),
  status: z.string().nullable(),
  shopName: z.string().nullable(),
  shopCurrency: z.string().nullable(),
  hasAccessToken: z.boolean(),
  hasApiSecret: z.boolean(),
  autoSyncEnabled: z.boolean(),
  lastVerifyStatus: z.string().nullable(),
  lastScrapeAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  webhookRegisteredAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  stagedCounts: shopifyStagedCountsSchema,
  latestRun: shopifyScrapeRunSchema.nullable(),
});
export type ShopifyConnectionDto = z.infer<typeof shopifyConnectionSchema>;

// A single staged item awaiting review.
export const shopifyStagedItemSchema = z.object({
  id: z.string(),
  section: z.enum(SHOPIFY_SECTIONS),
  externalId: z.string(),
  title: z.string(),
  status: z.enum(SHOPIFY_STAGED_STATUSES),
  // Normalized preview payload (shape varies by section).
  normalized: z.unknown(),
  resultEntityId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
});
export type ShopifyStagedItemDto = z.infer<typeof shopifyStagedItemSchema>;

export const shopifyStagedListQuerySchema = z.object({
  section: z.enum(SHOPIFY_SECTIONS).optional(),
  status: z.enum(SHOPIFY_STAGED_STATUSES).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type ShopifyStagedListQuery = z.infer<typeof shopifyStagedListQuerySchema>;

// Approve/reject a set of staged items by id.
export const shopifyStagedIdsBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000),
});
export type ShopifyStagedIdsBody = z.infer<typeof shopifyStagedIdsBodySchema>;

// Approve every pending item in a section (or all sections when omitted).
export const shopifyApproveAllBodySchema = z.object({
  section: z.enum(SHOPIFY_SECTIONS).optional(),
});
export type ShopifyApproveAllBody = z.infer<typeof shopifyApproveAllBodySchema>;
