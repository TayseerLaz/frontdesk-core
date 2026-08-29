// Mirror of apps/worker/src/jobs/shared-upsert.ts, kept in the API so
// the per-row retry endpoint can re-validate and upsert without crossing
// app boundaries. If you change the worker's schemas, change them here
// too — otherwise edits made from the import detail page will use a
// different validator than the original bulk run.
import type { ImportEntityKind, PrismaClient } from '@platform/db';
import { z, ZodError } from 'zod';

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

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export type ImportUpsertError = { path: string; message: string };

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
      const upserted = await tx.product.upsert({
        where: { organizationId_sku: { organizationId, sku: data.sku } },
        create: {
          organizationId,
          sku: data.sku,
          name: data.name,
          slug: slugify(data.name),
          shortDescription: data.shortDescription ?? null,
          description: data.description ?? null,
          priceMinor: data.priceMinor ?? null,
          currency: data.currency ?? 'USD',
          isAvailable: data.isAvailable ?? true,
          stockQuantity: data.stockQuantity ?? null,
          categoryId,
        },
        update: {
          name: data.name,
          slug: slugify(data.name),
          shortDescription: data.shortDescription ?? null,
          description: data.description ?? null,
          priceMinor: data.priceMinor ?? null,
          currency: data.currency ?? 'USD',
          isAvailable: data.isAvailable ?? true,
          stockQuantity: data.stockQuantity ?? null,
          categoryId,
          deletedAt: null,
        },
      });
      return upserted.id;
    }
    case 'service': {
      const data = serviceSchema.parse(raw);
      const categoryId = await resolveCategoryId(tx, organizationId, data.categorySlug ?? null);
      const slug = slugify(data.name);
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
          currency: data.currency ?? 'USD',
          priceUnit: (data.priceUnit ?? 'flat') as never,
          isAvailable: data.isAvailable ?? true,
          categoryId,
        },
        update: {
          name: data.name,
          shortDescription: data.shortDescription ?? null,
          description: data.description ?? null,
          durationMinutes: data.durationMinutes ?? null,
          basePriceMinor: data.basePriceMinor ?? null,
          currency: data.currency ?? 'USD',
          priceUnit: (data.priceUnit ?? 'flat') as never,
          isAvailable: data.isAvailable ?? true,
          categoryId,
          deletedAt: null,
        },
      });
      return upserted.id;
    }
    case 'faq': {
      const data = faqSchema.parse(raw);
      const upserted = await tx.fAQ.create({
        data: {
          organizationId,
          question: data.question,
          answer: data.answer,
          visibility: (data.visibility ?? 'public') as never,
          tags: data.tags,
        },
      });
      return upserted.id;
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
          legalName: data.legalName ?? null,
          tagline: data.tagline ?? null,
          about: data.about ?? null,
          websiteUrl: data.websiteUrl ?? null,
          timezone: data.timezone ?? undefined,
          currency: data.currency ?? undefined,
        },
      });
      return upserted.id;
    }
  }
}

export function zodErrorToImportErrors(err: ZodError): ImportUpsertError[] {
  return err.issues.map((iss) => ({
    path: iss.path.join('.') || '_',
    message: iss.message,
  }));
}

export { ZodError };
