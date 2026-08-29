// Shared validators + upserter used by both the CSV import worker and the
// connector sync worker. Keeping them together guarantees identical behaviour
// for the same target entity, regardless of source.
import type { ImportEntityKind, PrismaClient } from '@platform/db';

import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', 'TRUE', 'FALSE', '1', '0'])])
  .transform((v) => (typeof v === 'boolean' ? v : ['true', 'TRUE', '1'].includes(v as string)));

const intish = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)])
  .nullable()
  .optional();

export const productSchema = z.object({
  sku: z.string().trim().min(1),
  name: z.string().trim().min(1),
  shortDescription: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  priceMinor: intish,
  currency: z.string().length(3).optional(),
  isAvailable: boolish.optional(),
  stockQuantity: intish,
  categorySlug: z.string().trim().optional().nullable(),
});

export const serviceSchema = z.object({
  name: z.string().trim().min(1),
  shortDescription: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  durationMinutes: intish,
  basePriceMinor: intish,
  currency: z.string().length(3).optional(),
  priceUnit: z.enum(['flat', 'per_hour', 'per_day', 'per_session', 'per_unit']).optional(),
  isAvailable: boolish.optional(),
  categorySlug: z.string().trim().optional().nullable(),
});

export const faqSchema = z.object({
  question: z.string().trim().min(1),
  answer: z.string().trim().min(1),
  visibility: z.enum(['public', 'private']).optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) =>
      v === undefined ? [] : Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean),
    ),
});

export const businessInfoSchema = z.object({
  legalName: z.string().optional().nullable(),
  tagline: z.string().optional().nullable(),
  about: z.string().optional().nullable(),
  websiteUrl: z.string().url().optional().nullable(),
  timezone: z.string().optional(),
  currency: z.string().length(3).optional(),
});

async function resolveCategoryId(
  tx: PrismaClient,
  organizationId: string,
  slug: string | null | undefined,
): Promise<string | null> {
  if (!slug) return null;
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleanSlug) return null;
  const existing = await tx.category.findUnique({
    where: { organizationId_slug: { organizationId, slug: cleanSlug } },
  });
  if (existing) return existing.id;
  return (await tx.category.create({ data: { organizationId, slug: cleanSlug, name: slug } })).id;
}

/**
 * The org's single source of truth for currency (BusinessInfo.currency).
 * Used as the default when an imported row omits a currency, so bulk
 * imports inherit the shop's currency instead of hardcoding 'USD'.
 */
async function resolveOrgCurrency(
  tx: PrismaClient,
  organizationId: string,
): Promise<string> {
  const info = await tx.businessInfo.findUnique({
    where: { organizationId },
    select: { currency: true },
  });
  return info?.currency || 'USD';
}

export async function upsertOne(
  tx: PrismaClient,
  organizationId: string,
  kind: ImportEntityKind,
  raw: Record<string, unknown>,
): Promise<string> {
  switch (kind) {
    case 'product': {
      const data = productSchema.parse(raw);
      const categoryId = await resolveCategoryId(tx, organizationId, data.categorySlug ?? null);
      // Currency is org-level (BusinessInfo.currency). When the CSV omits it,
      // inherit the org default rather than hardcoding 'USD' — otherwise a
      // bulk import into a KWD/EUR shop silently writes dollar rows that later
      // render with a '$'.
      const orgCurrency = await resolveOrgCurrency(tx, organizationId);
      const baseSlug =
        data.name
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 48) || data.sku.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48);
      // slug is unique per org. Multiple products can share a name (e.g. Shopify
      // bundles), so resolve a free slug \u2014 base, then base-2, base-3, \u2026 \u2014
      // ignoring this SKU's own existing row (so re-imports don't drift).
      let slug = baseSlug;
      for (let n = 2; n < 200; n++) {
        const clash = await tx.product.findFirst({
          where: { organizationId, slug, sku: { not: data.sku } },
          select: { id: true },
        });
        if (!clash) break;
        slug = `${baseSlug.slice(0, 44)}-${n}`;
      }
      const upserted = await tx.product.upsert({
        where: { organizationId_sku: { organizationId, sku: data.sku } },
        create: {
          organizationId,
          sku: data.sku,
          name: data.name,
          slug,
          shortDescription: data.shortDescription ?? null,
          description: data.description ?? null,
          priceMinor: data.priceMinor ?? null,
          currency: data.currency ?? orgCurrency,
          isAvailable: data.isAvailable ?? true,
          stockQuantity: data.stockQuantity ?? null,
          categoryId,
        },
        update: {
          name: data.name,
          shortDescription: data.shortDescription ?? undefined,
          description: data.description ?? undefined,
          priceMinor: data.priceMinor ?? undefined,
          currency: data.currency ?? undefined,
          isAvailable: data.isAvailable ?? undefined,
          stockQuantity: data.stockQuantity ?? undefined,
          categoryId,
          deletedAt: null,
        },
      });
      return upserted.id;
    }
    case 'service': {
      const data = serviceSchema.parse(raw);
      const categoryId = await resolveCategoryId(tx, organizationId, data.categorySlug ?? null);
      const orgCurrency = await resolveOrgCurrency(tx, organizationId);
      const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
      const upserted = await tx.service.upsert({
        where: { organizationId_slug: { organizationId, slug } },
        create: {
          organizationId,
          name: data.name,
          slug,
          shortDescription: data.shortDescription ?? null,
          description: data.description ?? null,
          durationMinutes: data.durationMinutes ?? null,
          basePriceMinor: data.basePriceMinor ?? null,
          currency: data.currency ?? orgCurrency,
          priceUnit: data.priceUnit ?? 'flat',
          isAvailable: data.isAvailable ?? true,
          categoryId,
        },
        update: {
          name: data.name,
          shortDescription: data.shortDescription ?? undefined,
          description: data.description ?? undefined,
          durationMinutes: data.durationMinutes ?? undefined,
          basePriceMinor: data.basePriceMinor ?? undefined,
          currency: data.currency ?? undefined,
          priceUnit: data.priceUnit ?? undefined,
          isAvailable: data.isAvailable ?? undefined,
          categoryId,
          deletedAt: null,
        },
      });
      return upserted.id;
    }
    case 'faq': {
      const data = faqSchema.parse(raw);
      const created = await tx.fAQ.create({
        data: {
          organizationId,
          question: data.question,
          answer: data.answer,
          visibility: data.visibility ?? 'public',
          tags: data.tags,
        },
      });
      return created.id;
    }
    case 'business_info': {
      const data = businessInfoSchema.parse(raw);
      const upserted = await tx.businessInfo.upsert({
        where: { organizationId },
        create: {
          organizationId,
          legalName: data.legalName ?? null,
          tagline: data.tagline ?? null,
          about: data.about ?? null,
          websiteUrl: data.websiteUrl ?? null,
          timezone: data.timezone ?? 'UTC',
          currency: data.currency ?? 'USD',
        },
        update: {
          legalName: data.legalName ?? undefined,
          tagline: data.tagline ?? undefined,
          about: data.about ?? undefined,
          websiteUrl: data.websiteUrl ?? undefined,
          timezone: data.timezone ?? undefined,
          currency: data.currency ?? undefined,
        },
      });
      return upserted.id;
    }
  }
}
