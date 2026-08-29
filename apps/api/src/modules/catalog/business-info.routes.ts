import {
  ApiErrorCode,
  businessInfoSchema,
  contactChannelSchema,
  createFaqBodySchema,
  faqSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  locationSchema,
  policySchema,
  reorderFaqsBodySchema,
  successSchema,
  updateFaqBodySchema,
  upsertBusinessInfoBodySchema,
  upsertContactChannelBodySchema,
  upsertLocationBodySchema,
  upsertPolicyBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Prisma } from '../../lib/db.js';
import { prisma as rootPrisma } from '../../lib/db.js';
import { embedFaqAndStore } from '../../lib/embedding.js';
import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { invalidateReadCache } from '../../lib/read-cache.js';
import { recordRevision } from '../../lib/versioning.js';
import { emitWebhookEvent } from '../../lib/webhooks.js';

export default async function businessInfoRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /business-info ------------------------------------------
  r.get(
    '/business-info',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Get business info for the active organization (returns null if not yet set).',
        response: { 200: itemEnvelopeSchema(businessInfoSchema.nullable()) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const info = await tx.businessInfo.findUnique({
          where: { organizationId: req.auth!.organizationId },
        });
        if (!info) return { data: null };
        return {
          data: {
            id: info.id,
            legalName: info.legalName,
            tagline: info.tagline,
            about: info.about,
            websiteUrl: info.websiteUrl,
            operatingHours: (info.operatingHours ?? null) as never,
            hoursExceptions: (info.hoursExceptions ?? null) as never,
            timezone: info.timezone,
            currency: info.currency,
            metadata: (info.metadata ?? null) as Record<string, unknown> | null,
            bookingForm: (info.bookingForm ?? null) as never,
            shopForm: (info.shopForm ?? null) as never,
            updatedAt: info.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- PUT /business-info ------------------------------------------
  r.put(
    '/business-info',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Upsert business info.',
        body: upsertBusinessInfoBodySchema,
        response: { 200: itemEnvelopeSchema(businessInfoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const updated = await tx.businessInfo.upsert({
          where: { organizationId: orgId },
          create: {
            organizationId: orgId,
            legalName: req.body.legalName ?? null,
            tagline: req.body.tagline ?? null,
            about: req.body.about ?? null,
            websiteUrl: req.body.websiteUrl ?? null,
            operatingHours: (req.body.operatingHours ?? undefined) as Prisma.InputJsonValue | undefined,
            hoursExceptions: (req.body.hoursExceptions ?? undefined) as Prisma.InputJsonValue | undefined,
            timezone: req.body.timezone ?? 'UTC',
            currency: req.body.currency ?? 'USD',
            metadata: (req.body.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
            bookingForm: (req.body.bookingForm ?? undefined) as Prisma.InputJsonValue | undefined,
            shopForm: (req.body.shopForm ?? undefined) as Prisma.InputJsonValue | undefined,
          },
          update: {
            legalName: req.body.legalName === undefined ? undefined : req.body.legalName,
            tagline: req.body.tagline === undefined ? undefined : req.body.tagline,
            about: req.body.about === undefined ? undefined : req.body.about,
            websiteUrl: req.body.websiteUrl === undefined ? undefined : req.body.websiteUrl,
            operatingHours:
              req.body.operatingHours === undefined
                ? undefined
                : (req.body.operatingHours as Prisma.InputJsonValue),
            hoursExceptions:
              req.body.hoursExceptions === undefined
                ? undefined
                : (req.body.hoursExceptions as Prisma.InputJsonValue),
            timezone: req.body.timezone ?? undefined,
            currency: req.body.currency ?? undefined,
            metadata:
              req.body.metadata === undefined ? undefined : (req.body.metadata as Prisma.InputJsonValue),
            bookingForm:
              req.body.bookingForm === undefined
                ? undefined
                : (req.body.bookingForm as Prisma.InputJsonValue),
            shopForm:
              req.body.shopForm === undefined
                ? undefined
                : (req.body.shopForm as Prisma.InputJsonValue),
          },
        });
        // Currency is org-level (single source of truth). Catalog rows
        // (products, services, pricing tiers) carry a denormalized
        // `currency` column that several read paths trust directly — the
        // chatbot read API and the bot engine among them. When the org
        // currency changes here, propagate it so prices never render in a
        // stale currency (the "$820,000.00 on a KWD shop" class of bug).
        if (req.body.currency != null) {
          await Promise.all([
            tx.product.updateMany({
              where: { organizationId: orgId },
              data: { currency: req.body.currency },
            }),
            tx.service.updateMany({
              where: { organizationId: orgId },
              data: { currency: req.body.currency },
            }),
            tx.servicePricingTier.updateMany({
              where: { organizationId: orgId },
              data: { currency: req.body.currency },
            }),
          ]);
        }
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'business_info',
          entityId: updated.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'business_info_updated',
          payload: { id: updated.id },
        });
        void recordRevision({
          organizationId: orgId,
          entityType: 'business_info',
          entityId: updated.id,
          action: 'updated',
          snapshot: updated as unknown as Record<string, unknown>,
          actorUserId: req.auth!.userId,
        });
        return {
          data: {
            id: updated.id,
            legalName: updated.legalName,
            tagline: updated.tagline,
            about: updated.about,
            websiteUrl: updated.websiteUrl,
            operatingHours: (updated.operatingHours ?? null) as never,
            hoursExceptions: (updated.hoursExceptions ?? null) as never,
            timezone: updated.timezone,
            currency: updated.currency,
            metadata: (updated.metadata ?? null) as Record<string, unknown> | null,
            bookingForm: (updated.bookingForm ?? null) as never,
            shopForm: (updated.shopForm ?? null) as never,
            updatedAt: updated.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- locations ---------------------------------------------------
  r.get(
    '/business-info/locations',
    {
      schema: {
        tags: ['business-info'],
        summary: 'List locations.',
        response: { 200: listEnvelopeSchema(locationSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.location.findMany({ orderBy: { sortOrder: 'asc' } });
        return {
          data: rows.map((l) => ({
            id: l.id,
            name: l.name,
            addressLine1: l.addressLine1,
            addressLine2: l.addressLine2,
            city: l.city,
            region: l.region,
            postalCode: l.postalCode,
            country: l.country,
            latitude: l.latitude ? Number(l.latitude) : null,
            longitude: l.longitude ? Number(l.longitude) : null,
            phone: l.phone,
            email: l.email,
            isPrimary: l.isPrimary,
            sortOrder: l.sortOrder,
          })),
          nextCursor: null,
        };
      }),
  );

  r.post(
    '/business-info/locations',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Create a location.',
        body: upsertLocationBodySchema,
        response: { 201: itemEnvelopeSchema(locationSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        if (req.body.isPrimary) {
          await tx.location.updateMany({ where: {}, data: { isPrimary: false } });
        }
        const last = await tx.location.findFirst({ orderBy: { sortOrder: 'desc' } });
        const l = await tx.location.create({
          data: {
            organizationId: orgId,
            name: req.body.name,
            addressLine1: req.body.addressLine1 ?? null,
            addressLine2: req.body.addressLine2 ?? null,
            city: req.body.city ?? null,
            region: req.body.region ?? null,
            postalCode: req.body.postalCode ?? null,
            country: req.body.country ?? null,
            latitude: req.body.latitude ?? null,
            longitude: req.body.longitude ?? null,
            phone: req.body.phone ?? null,
            email: req.body.email ?? null,
            isPrimary: req.body.isPrimary ?? false,
            sortOrder: (last?.sortOrder ?? -1) + 1,
          },
        });
        reply.code(201);
        void invalidateReadCache(req.auth!.organizationId); // locations are in read payload
        return {
          data: {
            id: l.id,
            name: l.name,
            addressLine1: l.addressLine1,
            addressLine2: l.addressLine2,
            city: l.city,
            region: l.region,
            postalCode: l.postalCode,
            country: l.country,
            latitude: l.latitude ? Number(l.latitude) : null,
            longitude: l.longitude ? Number(l.longitude) : null,
            phone: l.phone,
            email: l.email,
            isPrimary: l.isPrimary,
            sortOrder: l.sortOrder,
          },
        };
      });
    },
  );

  r.patch(
    '/business-info/locations/:id',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Update a location.',
        params: z.object({ id: uuidSchema }),
        body: upsertLocationBodySchema.partial(),
        response: { 200: itemEnvelopeSchema(locationSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const existing = await tx.location.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Location not found.');
        if (req.body.isPrimary) {
          await tx.location.updateMany({ where: { NOT: { id: existing.id } }, data: { isPrimary: false } });
        }
        const l = await tx.location.update({
          where: { id: existing.id },
          data: {
            name: req.body.name ?? undefined,
            addressLine1: req.body.addressLine1 === undefined ? undefined : req.body.addressLine1,
            addressLine2: req.body.addressLine2 === undefined ? undefined : req.body.addressLine2,
            city: req.body.city === undefined ? undefined : req.body.city,
            region: req.body.region === undefined ? undefined : req.body.region,
            postalCode: req.body.postalCode === undefined ? undefined : req.body.postalCode,
            country: req.body.country === undefined ? undefined : req.body.country,
            latitude: req.body.latitude === undefined ? undefined : req.body.latitude,
            longitude: req.body.longitude === undefined ? undefined : req.body.longitude,
            phone: req.body.phone === undefined ? undefined : req.body.phone,
            email: req.body.email === undefined ? undefined : req.body.email,
            isPrimary: req.body.isPrimary ?? undefined,
          },
        });
        void invalidateReadCache(req.auth!.organizationId);
        return {
          data: {
            id: l.id,
            name: l.name,
            addressLine1: l.addressLine1,
            addressLine2: l.addressLine2,
            city: l.city,
            region: l.region,
            postalCode: l.postalCode,
            country: l.country,
            latitude: l.latitude ? Number(l.latitude) : null,
            longitude: l.longitude ? Number(l.longitude) : null,
            phone: l.phone,
            email: l.email,
            isPrimary: l.isPrimary,
            sortOrder: l.sortOrder,
          },
        };
      }),
  );

  r.delete(
    '/business-info/locations/:id',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Delete a location.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.location.deleteMany({ where: { id: req.params.id } });
        void invalidateReadCache(req.auth!.organizationId);
        return { ok: true as const };
      }),
  );

  // ---------- contact channels --------------------------------------------
  r.get(
    '/business-info/contacts',
    {
      schema: {
        tags: ['business-info'],
        summary: 'List contact channels.',
        response: { 200: listEnvelopeSchema(contactChannelSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.contactChannel.findMany({ orderBy: { sortOrder: 'asc' } });
        return {
          data: rows.map((c) => ({
            id: c.id,
            kind: c.kind as never,
            label: c.label,
            value: c.value,
            isPrimary: c.isPrimary,
            sortOrder: c.sortOrder,
          })),
          nextCursor: null,
        };
      }),
  );

  r.post(
    '/business-info/contacts',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Create a contact channel.',
        body: upsertContactChannelBodySchema,
        response: { 201: itemEnvelopeSchema(contactChannelSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        if (req.body.isPrimary) {
          await tx.contactChannel.updateMany({ where: { kind: req.body.kind }, data: { isPrimary: false } });
        }
        const last = await tx.contactChannel.findFirst({ orderBy: { sortOrder: 'desc' } });
        const c = await tx.contactChannel.create({
          data: {
            organizationId: orgId,
            kind: req.body.kind,
            label: req.body.label ?? null,
            value: req.body.value,
            isPrimary: req.body.isPrimary ?? false,
            sortOrder: (last?.sortOrder ?? -1) + 1,
          },
        });
        reply.code(201);
        void invalidateReadCache(orgId); // contact channels are in read payload
        return {
          data: {
            id: c.id,
            kind: c.kind as never,
            label: c.label,
            value: c.value,
            isPrimary: c.isPrimary,
            sortOrder: c.sortOrder,
          },
        };
      });
    },
  );

  r.delete(
    '/business-info/contacts/:id',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Delete a contact channel.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.contactChannel.deleteMany({ where: { id: req.params.id } });
        void invalidateReadCache(req.auth!.organizationId);
        return { ok: true as const };
      }),
  );

  // ---------- FAQs --------------------------------------------------------
  r.get(
    '/business-info/faqs',
    {
      schema: {
        tags: ['business-info'],
        summary: 'List FAQs (ordered by sortOrder).',
        response: { 200: listEnvelopeSchema(faqSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.fAQ.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
        return {
          data: rows.map((f) => ({
            id: f.id,
            question: f.question,
            answer: f.answer,
            tags: f.tags,
            visibility: f.visibility,
            sortOrder: f.sortOrder,
            isPublished: f.isPublished,
            createdAt: f.createdAt.toISOString(),
            updatedAt: f.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  r.post(
    '/business-info/faqs',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Create an FAQ.',
        body: createFaqBodySchema,
        response: { 201: itemEnvelopeSchema(faqSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const last = await tx.fAQ.findFirst({ orderBy: { sortOrder: 'desc' } });
        const f = await tx.fAQ.create({
          data: {
            organizationId: orgId,
            question: req.body.question,
            answer: req.body.answer,
            tags: req.body.tags ?? [],
            visibility: req.body.visibility ?? 'public',
            isPublished: req.body.isPublished ?? true,
            sortOrder: req.body.sortOrder ?? (last?.sortOrder ?? -1) + 1,
          },
        });
        await recordAudit({
          action: 'faq_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'faq',
          entityId: f.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'faq_changed',
          payload: { id: f.id, action: 'created' },
        });
        // F2: invalidate explicitly (matching the delete paths) so the voice/
        // chatbot read caches don't serve a stale FAQ set in the brief window
        // before the fire-and-forget webhook chain flushes it.
        void invalidateReadCache(orgId);
        // Embed so the bot's top-K FAQ ranker can find it immediately.
        void embedFaqAndStore(rootPrisma, f.id).catch((err) =>
          req.log.warn({ err: err instanceof Error ? err.message : err, faqId: f.id }, '[embed] faq embed-on-create failed'),
        );
        reply.code(201);
        return {
          data: {
            id: f.id,
            question: f.question,
            answer: f.answer,
            tags: f.tags,
            visibility: f.visibility,
            sortOrder: f.sortOrder,
            isPublished: f.isPublished,
            createdAt: f.createdAt.toISOString(),
            updatedAt: f.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  r.patch(
    '/business-info/faqs/:id',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Update an FAQ.',
        params: z.object({ id: uuidSchema }),
        body: updateFaqBodySchema,
        response: { 200: itemEnvelopeSchema(faqSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.fAQ.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('FAQ not found.');
        const f = await tx.fAQ.update({
          where: { id: existing.id },
          data: {
            question: req.body.question ?? undefined,
            answer: req.body.answer ?? undefined,
            tags: req.body.tags ?? undefined,
            visibility: req.body.visibility ?? undefined,
            sortOrder: req.body.sortOrder ?? undefined,
            isPublished: req.body.isPublished ?? undefined,
          },
        });
        await recordAudit({
          action: 'faq_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'faq',
          entityId: f.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'faq_changed',
          payload: { id: f.id, action: 'updated' },
        });
        void invalidateReadCache(orgId); // F2 — see faq-create note
        // Re-embed when the embed text (question / answer) changed; no-ops via
        // the stored hash otherwise.
        if (req.body.question !== undefined || req.body.answer !== undefined) {
          void embedFaqAndStore(rootPrisma, f.id).catch((err) =>
            req.log.warn({ err: err instanceof Error ? err.message : err, faqId: f.id }, '[embed] faq embed-on-update failed'),
          );
        }
        return {
          data: {
            id: f.id,
            question: f.question,
            answer: f.answer,
            tags: f.tags,
            visibility: f.visibility,
            sortOrder: f.sortOrder,
            isPublished: f.isPublished,
            createdAt: f.createdAt.toISOString(),
            updatedAt: f.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  r.delete(
    '/business-info/faqs/:id',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Delete an FAQ.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        await tx.fAQ.deleteMany({ where: { id: req.params.id } });
        void invalidateReadCache(orgId);
        await recordAudit({
          action: 'faq_deleted',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'faq',
          entityId: req.params.id,
        });
        return { ok: true as const };
      });
    },
  );

  r.post(
    '/business-info/faqs/reorder',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Bulk-update sort order on FAQs.',
        body: reorderFaqsBodySchema,
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await Promise.all(
          req.body.order.map((o) =>
            tx.fAQ.updateMany({
              where: { id: o.id, organizationId: req.auth!.organizationId },
              data: { sortOrder: o.sortOrder },
            }),
          ),
        );
        void invalidateReadCache(req.auth!.organizationId);
        return { ok: true as const };
      }),
  );

  // ---------- policies ----------------------------------------------------
  r.get(
    '/business-info/policies',
    {
      schema: {
        tags: ['business-info'],
        summary: 'List policies.',
        response: { 200: listEnvelopeSchema(policySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.policy.findMany({ orderBy: { sortOrder: 'asc' } });
        return {
          data: rows.map((p) => ({
            id: p.id,
            kind: p.kind as never,
            title: p.title,
            content: p.content,
            isPublished: p.isPublished,
            sortOrder: p.sortOrder,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  r.put(
    '/business-info/policies',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Upsert a policy by kind.',
        body: upsertPolicyBodySchema,
        response: { 200: itemEnvelopeSchema(policySchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const p = await tx.policy.upsert({
          where: { organizationId_kind: { organizationId: orgId, kind: req.body.kind } },
          create: {
            organizationId: orgId,
            kind: req.body.kind,
            title: req.body.title,
            content: req.body.content,
            isPublished: req.body.isPublished ?? true,
            sortOrder: req.body.sortOrder ?? 0,
          },
          update: {
            title: req.body.title,
            content: req.body.content,
            isPublished: req.body.isPublished ?? undefined,
            sortOrder: req.body.sortOrder ?? undefined,
          },
        });
        await recordAudit({
          action: 'policy_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'policy',
          entityId: p.id,
        });
        void emitWebhookEvent({
          organizationId: orgId,
          eventKind: 'policy_changed',
          payload: { id: p.id, kind: p.kind },
        });
        void invalidateReadCache(orgId); // F2 — see faq-create note
        return {
          data: {
            id: p.id,
            kind: p.kind as never,
            title: p.title,
            content: p.content,
            isPublished: p.isPublished,
            sortOrder: p.sortOrder,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  r.delete(
    '/business-info/policies/:id',
    {
      schema: {
        tags: ['business-info'],
        summary: 'Delete a policy.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        await tx.policy.deleteMany({ where: { id: req.params.id } });
        void invalidateReadCache(orgId);
        await recordAudit({
          action: 'policy_deleted',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'policy',
          entityId: req.params.id,
        });
        return { ok: true as const };
      });
    },
  );
}
