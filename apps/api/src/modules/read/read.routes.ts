// Chatbot Read API. Authenticated by X-Api-Key (per-org), cached in
// Redis with 60s fresh / 5min stale TTL, and invalidated on any catalog write
// (see lib/webhooks.ts → invalidateReadCache).
//
// All endpoints scope queries by the API key's organizationId via withTenant
// (RLS enforced as a backstop).
import {
  ApiErrorCode,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  readApiBusinessInfoSchema,
  readApiFaqSchema,
  readApiPolicySchema,
  readApiProductSchema,
  readApiQuerySchema,
  readApiSearchHitSchema,
  readApiServiceSchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withTenant } from '../../lib/db.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { readCacheGet, readCacheSet } from '../../lib/read-cache.js';
import { resolveAssetUrl, stripHtmlForBot } from '../catalog/shared.js';

// Helper: cache-aware loader. Hits Redis first; on miss, runs `loader` and stores.
// Sets `x-cache: HIT|STALE|MISS` on the reply so clients (and e2e tests) can
// verify cache behavior deterministically.
async function cached<T>(
  orgId: string,
  endpoint: string,
  query: Record<string, unknown> | null,
  loader: () => Promise<T>,
  reply?: { header: (name: string, value: string) => unknown },
): Promise<T> {
  const hit = await readCacheGet<T>(orgId, endpoint, query);
  if (hit && !hit.stale) {
    reply?.header('x-cache', 'HIT');
    return hit.value;
  }
  const value = await loader();
  await readCacheSet(orgId, endpoint, query, value);
  reply?.header('x-cache', hit?.stale ? 'STALE' : 'MISS');
  return value;
}

function requireScope(req: FastifyRequest, scope: string) {
  if (!req.apiKey?.scopes.includes(scope)) {
    throw forbidden(ApiErrorCode.ROLE_INSUFFICIENT, `API key missing required scope: ${scope}`);
  }
}

export default async function readApiRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /v1/read/products ---------------------------------------
  r.get(
    '/read/products',
    {
      schema: {
        tags: ['chatbot-read'],
        summary: 'List active products. Cached 60s; invalidated on writes.',
        querystring: readApiQuerySchema,
        response: { 200: listEnvelopeSchema(readApiProductSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'read:catalog');
      const orgId = req.apiKey!.organizationId;
      const q = req.query;
      return cached(orgId, 'products', q as Record<string, unknown>, async () => {
        return withTenant(orgId, async (tx) => {
          const rows = await tx.product.findMany({
            where: {
              deletedAt: null,
              ...(q.available === undefined ? {} : { isAvailable: q.available }),
              ...(q.q
                ? {
                    OR: [
                      { name: { contains: q.q, mode: 'insensitive' } },
                      { sku: { contains: q.q, mode: 'insensitive' } },
                      { searchText: { contains: q.q.toLowerCase() } },
                    ],
                  }
                : {}),
              ...(q.category
                ? { category: { slug: { equals: q.category.toLowerCase() } } }
                : {}),
            },
            orderBy: [{ name: 'asc' }],
            take: q.limit,
            include: {
              category: { select: { name: true } },
              images: { orderBy: { sortOrder: 'asc' }, take: 1, include: { asset: true } },
              variants: { orderBy: { sortOrder: 'asc' } },
            },
          });
          const data = await Promise.all(
            rows.map(async (p) => ({
              id: p.id,
              sku: p.sku,
              name: p.name,
              slug: p.slug,
              description: stripHtmlForBot(p.description),
              shortDescription: stripHtmlForBot(p.shortDescription),
              priceMinor: p.priceMinor,
              currency: p.currency,
              available: p.isAvailable,
              categoryName: p.category?.name ?? null,
              imageUrl: p.images[0] ? await resolveAssetUrl(p.images[0].asset.storageKey) : null,
              variants: p.variants.map((v) => ({
                sku: v.sku,
                name: v.name,
                options: (v.options ?? {}) as Record<string, string | number | boolean>,
                priceMinor: v.priceMinor,
                available: v.isAvailable,
              })),
            })),
          );
          return { data, nextCursor: null };
        });
      }, reply);
    },
  );

  // ---------- GET /v1/read/products/:id -----------------------------------
  r.get(
    '/read/products/:id',
    {
      schema: {
        tags: ['chatbot-read'],
        summary: 'Get a single product.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(readApiProductSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'read:catalog');
      const orgId = req.apiKey!.organizationId;
      return cached(orgId, `products:${req.params.id}`, null, async () => {
        return withTenant(orgId, async (tx) => {
          const p = await tx.product.findFirst({
            where: { id: req.params.id, deletedAt: null },
            include: {
              category: { select: { name: true } },
              images: { orderBy: { sortOrder: 'asc' }, take: 1, include: { asset: true } },
              variants: { orderBy: { sortOrder: 'asc' } },
            },
          });
          if (!p) throw notFound('Product not found.');
          return {
            data: {
              id: p.id,
              sku: p.sku,
              name: p.name,
              slug: p.slug,
              description: stripHtmlForBot(p.description),
              shortDescription: stripHtmlForBot(p.shortDescription),
              priceMinor: p.priceMinor,
              currency: p.currency,
              available: p.isAvailable,
              categoryName: p.category?.name ?? null,
              imageUrl: p.images[0] ? await resolveAssetUrl(p.images[0].asset.storageKey) : null,
              variants: p.variants.map((v) => ({
                sku: v.sku,
                name: v.name,
                options: (v.options ?? {}) as Record<string, string | number | boolean>,
                priceMinor: v.priceMinor,
                available: v.isAvailable,
              })),
            },
          };
        });
      }, reply);
    },
  );

  // ---------- GET /v1/read/services ---------------------------------------
  r.get(
    '/read/services',
    {
      schema: {
        tags: ['chatbot-read'],
        summary: 'List active services.',
        querystring: readApiQuerySchema,
        response: { 200: listEnvelopeSchema(readApiServiceSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'read:catalog');
      const orgId = req.apiKey!.organizationId;
      const q = req.query;
      return cached(orgId, 'services', q as Record<string, unknown>, async () => {
        return withTenant(orgId, async (tx) => {
          const rows = await tx.service.findMany({
            where: {
              deletedAt: null,
              ...(q.available === undefined ? {} : { isAvailable: q.available }),
              ...(q.q
                ? {
                    OR: [
                      { name: { contains: q.q, mode: 'insensitive' } },
                      { searchText: { contains: q.q.toLowerCase() } },
                    ],
                  }
                : {}),
              ...(q.category
                ? { category: { slug: { equals: q.category.toLowerCase() } } }
                : {}),
            },
            orderBy: [{ name: 'asc' }],
            take: q.limit,
            include: {
              category: { select: { name: true } },
              pricingTiers: { orderBy: { sortOrder: 'asc' } },
              availability: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
            },
          });
          return {
            data: rows.map((s) => ({
              id: s.id,
              slug: s.slug,
              name: s.name,
              description: stripHtmlForBot(s.description),
              shortDescription: stripHtmlForBot(s.shortDescription),
              durationMinutes: s.durationMinutes,
              basePriceMinor: s.basePriceMinor,
              currency: s.currency,
              priceUnit: s.priceUnit,
              available: s.isAvailable,
              categoryName: s.category?.name ?? null,
              pricingTiers: s.pricingTiers.map((t) => ({
                name: t.name,
                description: stripHtmlForBot(t.description),
                priceMinor: t.priceMinor,
                currency: t.currency,
                priceUnit: t.priceUnit,
                features: t.features,
              })),
              availability: s.availability.map((a) => ({
                dayOfWeek: a.dayOfWeek,
                startMinute: a.startMinute,
                endMinute: a.endMinute,
              })),
            })),
            nextCursor: null,
          };
        });
      }, reply);
    },
  );

  // ---------- GET /v1/read/services/:id -----------------------------------
  r.get(
    '/read/services/:id',
    {
      schema: {
        tags: ['chatbot-read'],
        summary: 'Get a single service.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(readApiServiceSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'read:catalog');
      const orgId = req.apiKey!.organizationId;
      return cached(orgId, `services:${req.params.id}`, null, async () =>
        withTenant(orgId, async (tx) => {
          const s = await tx.service.findFirst({
            where: { id: req.params.id, deletedAt: null },
            include: {
              category: { select: { name: true } },
              pricingTiers: { orderBy: { sortOrder: 'asc' } },
              availability: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
            },
          });
          if (!s) throw notFound('Service not found.');
          return {
            data: {
              id: s.id,
              slug: s.slug,
              name: s.name,
              description: stripHtmlForBot(s.description),
              shortDescription: stripHtmlForBot(s.shortDescription),
              durationMinutes: s.durationMinutes,
              basePriceMinor: s.basePriceMinor,
              currency: s.currency,
              priceUnit: s.priceUnit,
              available: s.isAvailable,
              categoryName: s.category?.name ?? null,
              pricingTiers: s.pricingTiers.map((t) => ({
                name: t.name,
                description: stripHtmlForBot(t.description),
                priceMinor: t.priceMinor,
                currency: t.currency,
                priceUnit: t.priceUnit,
                features: t.features,
              })),
              availability: s.availability.map((a) => ({
                dayOfWeek: a.dayOfWeek,
                startMinute: a.startMinute,
                endMinute: a.endMinute,
              })),
            },
          };
        }), reply);
    },
  );

  // ---------- GET /v1/read/business-info ----------------------------------
  r.get(
    '/read/business-info',
    {
      schema: {
        tags: ['chatbot-read'],
        summary: 'Get business info (profile, hours, locations, contacts).',
        response: { 200: itemEnvelopeSchema(readApiBusinessInfoSchema.nullable()) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'read:business-info');
      const orgId = req.apiKey!.organizationId;
      return cached(orgId, 'business-info', null, async () =>
        withTenant(orgId, async (tx) => {
          const info = await tx.businessInfo.findUnique({ where: { organizationId: orgId } });
          if (!info) return { data: null };
          const [locations, contacts] = await Promise.all([
            tx.location.findMany({ orderBy: { sortOrder: 'asc' } }),
            tx.contactChannel.findMany({ orderBy: { sortOrder: 'asc' } }),
          ]);
          return {
            data: {
              legalName: info.legalName,
              tagline: info.tagline,
              about: stripHtmlForBot(info.about),
              websiteUrl: info.websiteUrl,
              timezone: info.timezone,
              currency: info.currency,
              operatingHours: (info.operatingHours ?? null) as never,
              locations: locations.map((l) => ({
                name: l.name,
                address: [l.addressLine1, l.addressLine2].filter(Boolean).join(', ') || null,
                city: l.city,
                country: l.country,
                phone: l.phone,
                email: l.email,
                isPrimary: l.isPrimary,
              })),
              contacts: contacts.map((c) => ({ kind: c.kind, label: c.label, value: c.value })),
            },
          };
        }), reply);
    },
  );

  // ---------- GET /v1/read/faqs -------------------------------------------
  r.get(
    '/read/faqs',
    {
      schema: {
        tags: ['chatbot-read'],
        summary: 'List published, public FAQs.',
        querystring: readApiQuerySchema,
        response: { 200: listEnvelopeSchema(readApiFaqSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'read:faqs');
      const orgId = req.apiKey!.organizationId;
      const q = req.query;
      return cached(orgId, 'faqs', q as Record<string, unknown>, async () =>
        withTenant(orgId, async (tx) => {
          const rows = await tx.fAQ.findMany({
            where: {
              isPublished: true,
              visibility: 'public',
              ...(q.q
                ? {
                    OR: [
                      { question: { contains: q.q, mode: 'insensitive' } },
                      { searchText: { contains: q.q.toLowerCase() } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            take: q.limit,
          });
          return {
            data: rows.map((f) => ({
              id: f.id,
              question: f.question,
              answer: stripHtmlForBot(f.answer) ?? '',
              tags: f.tags,
            })),
            nextCursor: null,
          };
        }), reply);
    },
  );

  // ---------- GET /v1/read/policies ---------------------------------------
  r.get(
    '/read/policies',
    {
      schema: {
        tags: ['chatbot-read'],
        summary: 'List published policies (return, shipping, etc.).',
        response: { 200: listEnvelopeSchema(readApiPolicySchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'read:business-info');
      const orgId = req.apiKey!.organizationId;
      return cached(orgId, 'policies', null, async () =>
        withTenant(orgId, async (tx) => {
          const rows = await tx.policy.findMany({
            where: { isPublished: true },
            orderBy: { sortOrder: 'asc' },
          });
          return {
            data: rows.map((p) => ({ kind: p.kind, title: p.title, content: stripHtmlForBot(p.content) ?? '' })),
            nextCursor: null,
          };
        }), reply);
    },
  );

  // ---------- GET /v1/read/search -----------------------------------------
  r.get(
    '/read/search',
    {
      schema: {
        tags: ['chatbot-read'],
        summary: 'Cross-entity search across products, services, and FAQs.',
        querystring: z.object({ q: z.string().trim().min(1), limit: z.coerce.number().int().min(1).max(50).default(10) }),
        response: { 200: listEnvelopeSchema(readApiSearchHitSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'read:catalog');
      const orgId = req.apiKey!.organizationId;
      const q = req.query.q.toLowerCase();
      return cached(orgId, 'search', { q, limit: req.query.limit }, async () =>
        withTenant(orgId, async (tx) => {
          const [products, services, faqs] = await Promise.all([
            tx.product.findMany({
              where: {
                deletedAt: null,
                isAvailable: true,
                OR: [
                  { name: { contains: req.query.q, mode: 'insensitive' } },
                  { searchText: { contains: q } },
                ],
              },
              take: req.query.limit,
              orderBy: { name: 'asc' },
            }),
            tx.service.findMany({
              where: {
                deletedAt: null,
                isAvailable: true,
                OR: [
                  { name: { contains: req.query.q, mode: 'insensitive' } },
                  { searchText: { contains: q } },
                ],
              },
              take: req.query.limit,
              orderBy: { name: 'asc' },
            }),
            tx.fAQ.findMany({
              where: {
                isPublished: true,
                visibility: 'public',
                OR: [
                  { question: { contains: req.query.q, mode: 'insensitive' } },
                  { searchText: { contains: q } },
                ],
              },
              take: req.query.limit,
              orderBy: { sortOrder: 'asc' },
            }),
          ]);
          return {
            data: [
              ...products.map((p) => ({
                type: 'product' as const,
                id: p.id,
                title: p.name,
                snippet: stripHtmlForBot(p.shortDescription),
                url: null,
              })),
              ...services.map((s) => ({
                type: 'service' as const,
                id: s.id,
                title: s.name,
                snippet: stripHtmlForBot(s.shortDescription),
                url: null,
              })),
              ...faqs.map((f) => ({
                type: 'faq' as const,
                id: f.id,
                title: f.question,
                snippet: (stripHtmlForBot(f.answer) ?? '').slice(0, 200),
                url: null,
              })),
            ].slice(0, req.query.limit),
            nextCursor: null,
          };
        }), reply);
    },
  );
}
