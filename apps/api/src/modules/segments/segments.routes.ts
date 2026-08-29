// Phase 4 — Segments CRUD + preview.
//
// A Segment is a saved filter over Contacts. The evaluator (segment-evaluator.ts)
// turns the filter AST into a Prisma `where`. Used by the broadcast wizard
// (audience selection) and the fanout worker.
import {
  contactDtoSchema,
  createSegmentBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  segmentDtoSchema,
  segmentFilterSchema,
  successSchema,
  updateSegmentBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';

import { buildContactWhereForSegment } from './segment-evaluator.js';

interface SegmentRow {
  id: string;
  name: string;
  description: string | null;
  filter: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: SegmentRow, contactCount?: number) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    filter: segmentFilterSchema.parse(row.filter),
    contactCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function segmentsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /segments -------------------------------------------------
  r.get(
    '/segments',
    {
      schema: {
        tags: ['contacts'],
        summary: 'List saved contact segments.',
        response: { 200: listEnvelopeSchema(segmentDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.segment.findMany({ orderBy: { updatedAt: 'desc' } });
        // Compute counts in parallel — small N, fine to do here.
        const counts = await Promise.all(
          rows.map((row) =>
            tx.contact
              .count({
                where: buildContactWhereForSegment(segmentFilterSchema.parse(row.filter)),
              })
              .catch(() => 0),
          ),
        );
        return {
          data: rows.map((row, i) => toDto(row, counts[i])),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /segments ------------------------------------------------
  r.post(
    '/segments',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Create a segment.',
        body: createSegmentBodySchema,
        response: { 201: itemEnvelopeSchema(segmentDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const result = await app.tenant(req, async (tx) => {
        const dup = await tx.segment.findUnique({
          where: { organizationId_name: { organizationId: orgId, name: req.body.name } },
        });
        if (dup) throw conflict('A segment with that name already exists.');
        return tx.segment.create({
          data: {
            organizationId: orgId,
            name: req.body.name,
            description: req.body.description ?? null,
            filter: req.body.filter as never,
          },
        });
      });
      await recordAudit({
        action: 'segment_created',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'segment',
        entityId: result.id,
      });
      reply.code(201);
      return { data: toDto(result) };
    },
  );

  // ---------- PATCH /segments/:id ------------------------------------------
  r.patch(
    '/segments/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Update a segment.',
        params: z.object({ id: uuidSchema }),
        body: updateSegmentBodySchema,
        response: { 200: itemEnvelopeSchema(segmentDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.segment.findUnique({ where: { id } });
        if (!existing) throw notFound('Segment not found.');
        if (req.body.name && req.body.name !== existing.name) {
          const dup = await tx.segment.findUnique({
            where: { organizationId_name: { organizationId: orgId, name: req.body.name } },
          });
          if (dup && dup.id !== id) throw conflict('That name is already in use.');
        }
        return tx.segment.update({
          where: { id },
          data: {
            name: req.body.name ?? undefined,
            description: req.body.description !== undefined ? req.body.description : undefined,
            filter: req.body.filter !== undefined ? (req.body.filter as never) : undefined,
          },
        });
      });
      await recordAudit({
        action: 'segment_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'segment',
        entityId: id,
      });
      return { data: toDto(result) };
    },
  );

  // ---------- DELETE /segments/:id -----------------------------------------
  r.delete(
    '/segments/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Delete a segment.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      await app.tenant(req, async (tx) => {
        const existing = await tx.segment.findUnique({ where: { id } });
        if (!existing) throw notFound('Segment not found.');
        await tx.segment.delete({ where: { id } });
      });
      await recordAudit({
        action: 'segment_deleted',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'segment',
        entityId: id,
      });
      return { ok: true as const };
    },
  );

  // ---------- GET /segments/:id ---------------------------------------------
  r.get(
    '/segments/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Get a segment with its contact count.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(segmentDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const row = await tx.segment.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Segment not found.');
        const filter = segmentFilterSchema.parse(row.filter);
        const count = await tx.contact.count({ where: buildContactWhereForSegment(filter) });
        return { data: toDto(row, count) };
      }),
  );

  // ---------- GET /segments/:id/preview -------------------------------------
  r.get(
    '/segments/:id/preview',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Preview a segment: count + first N matching contacts.',
        params: z.object({ id: uuidSchema }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: {
          200: z.object({
            data: z.object({
              count: z.number().int().nonnegative(),
              sample: z.array(contactDtoSchema),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const row = await tx.segment.findUnique({ where: { id: req.params.id } });
        if (!row) throw notFound('Segment not found.');
        const filter = segmentFilterSchema.parse(row.filter);
        const where = buildContactWhereForSegment(filter);
        const [count, sample] = await Promise.all([
          tx.contact.count({ where }),
          tx.contact.findMany({
            where,
            include: { tags: { select: { tag: true } } },
            take: req.query.limit,
            orderBy: { createdAt: 'desc' },
          }),
        ]);
        return {
          data: {
            count,
            sample: sample.map((c) => ({
              id: c.id,
              phoneE164: c.phoneE164,
              email: c.email,
              displayName: c.displayName,
              whatsappName: c.whatsappName,
              locale: c.locale,
              optedInAt: c.optedInAt?.toISOString() ?? null,
              optedOutAt: c.optedOutAt?.toISOString() ?? null,
              blockedAt: c.blockedAt?.toISOString() ?? null,
              timezone: c.timezone,
              attributes:
                c.attributes && typeof c.attributes === 'object'
                  ? (c.attributes as Record<string, string | number | boolean | null>)
                  : {},
              source: c.source,
              tags: c.tags.map((t) => t.tag),
              lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
              lastOutboundAt: c.lastOutboundAt?.toISOString() ?? null,
              createdAt: c.createdAt.toISOString(),
              updatedAt: c.updatedAt.toISOString(),
            })),
          },
        };
      }),
  );

  // ---------- POST /segments/preview (ad-hoc, before save) ------------------
  // Used by the segment editor to live-count without saving.
  r.post(
    '/segments/preview',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Preview an unsaved filter (count only).',
        body: z.object({ filter: segmentFilterSchema }),
        response: { 200: z.object({ data: z.object({ count: z.number().int().nonnegative() }) }) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const where = buildContactWhereForSegment(req.body.filter);
        const count = await tx.contact.count({ where });
        return { data: { count } };
      }),
  );
}
