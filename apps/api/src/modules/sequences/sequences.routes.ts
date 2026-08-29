// Phase 5.4 — Drip / sequence campaigns.
//
// A Sequence is a series of templates fired at a contact in order. Steps live
// in `sequence_steps` (replace-set on PATCH). Contacts get enrolled (manual
// for v1) and a recurring tick worker scans for due steps.
import {
  ApiErrorCode,
  createSequenceBodySchema,
  enrollContactsBodySchema,
  enrollmentDtoSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  sequenceDtoSchema,
  successSchema,
  updateSequenceBodySchema,
  uuidSchema,
  variableMappingSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

interface SequenceWithSteps {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  channelId: string;
  createdAt: Date;
  updatedAt: Date;
  steps: {
    id: string;
    stepOrder: number;
    templateId: string;
    delayHours: number;
    variables: unknown;
  }[];
  _count?: { enrollments: number };
}

function toDto(row: SequenceWithSteps) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    channelId: row.channelId,
    steps: row.steps
      .slice()
      .sort((a, b) => a.stepOrder - b.stepOrder)
      .map((s) => ({
        id: s.id,
        stepOrder: s.stepOrder,
        templateId: s.templateId,
        delayHours: s.delayHours,
        variables: variableMappingSchema.parse(s.variables ?? {}),
      })),
    enrollmentCount: row._count?.enrollments,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function sequencesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /sequences ------------------------------------------------
  r.get(
    '/sequences',
    {
      schema: {
        tags: ['sequences'],
        summary: 'List sequences with their steps + enrollment counts.',
        response: { 200: listEnvelopeSchema(sequenceDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.sequence.findMany({
          orderBy: { updatedAt: 'desc' },
          include: { steps: true, _count: { select: { enrollments: true } } },
        });
        return { data: rows.map(toDto), nextCursor: null };
      }),
  );

  // ---------- POST /sequences ----------------------------------------------
  r.post(
    '/sequences',
    {
      schema: {
        tags: ['sequences'],
        summary: 'Create a sequence with its steps.',
        body: createSequenceBodySchema,
        response: { 201: itemEnvelopeSchema(sequenceDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const body = req.body;
      const result = await app.tenant(req, async (tx) => {
        const dup = await tx.sequence.findUnique({
          where: { organizationId_name: { organizationId: orgId, name: body.name } },
        });
        if (dup) throw conflict('A sequence with that name already exists.');
        // Verify channel + templates belong to this org (RLS already enforces).
        const channel = await tx.whatsAppChannel.findUnique({ where: { id: body.channelId } });
        if (!channel) throw notFound('WhatsApp channel not found.');
        for (const s of body.steps) {
          const t = await tx.whatsAppTemplate.findUnique({ where: { id: s.templateId } });
          if (!t) throw notFound(`Template ${s.templateId.slice(0, 8)} not found.`);
          if (t.status !== 'approved') {
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              `Template ${t.name} is "${t.status}". Only approved templates can be used in sequences.`,
            );
          }
        }
        const seq = await tx.sequence.create({
          data: {
            organizationId: orgId,
            name: body.name,
            description: body.description ?? null,
            channelId: body.channelId,
            isActive: body.isActive,
            createdByUserId: req.auth!.userId,
            steps: {
              create: body.steps.map((s, idx) => ({
                organizationId: orgId,
                stepOrder: idx,
                templateId: s.templateId,
                delayHours: s.delayHours,
                variables: (s.variables ?? {}) as never,
              })),
            },
          },
          include: { steps: true, _count: { select: { enrollments: true } } },
        });
        return seq;
      });
      await recordAudit({
        action: 'broadcast_created', // reuse — new sequence_* enum left for a future migration
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'sequence',
        entityId: result.id,
      });
      reply.code(201);
      return { data: toDto(result) };
    },
  );

  // ---------- PATCH /sequences/:id -----------------------------------------
  r.patch(
    '/sequences/:id',
    {
      schema: {
        tags: ['sequences'],
        summary: 'Update sequence + replace its steps (replace-set semantics).',
        params: z.object({ id: uuidSchema }),
        body: updateSequenceBodySchema,
        response: { 200: itemEnvelopeSchema(sequenceDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const body = req.body;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.sequence.findUnique({ where: { id } });
        if (!existing) throw notFound('Sequence not found.');
        if (body.name && body.name !== existing.name) {
          const dup = await tx.sequence.findUnique({
            where: { organizationId_name: { organizationId: orgId, name: body.name } },
          });
          if (dup && dup.id !== id) throw conflict('Another sequence already uses that name.');
        }
        // SECURITY (H-3): the sequence-tick worker sends drip messages from
        // `channelId` using THAT channel's decrypted Meta credentials. Unlike
        // create (POST), PATCH previously wrote `channelId` straight from the
        // body with no ownership check, so an editor could point a sequence at
        // ANOTHER org's WhatsApp number and send on that org's credentials.
        // Validate the channel (and any swapped-in step templates) belongs to
        // the caller's org — mirroring the create path — before persisting.
        if (body.channelId) {
          const channel = await tx.whatsAppChannel.findFirst({
            where: { id: body.channelId, organizationId: orgId },
            select: { id: true },
          });
          if (!channel) throw notFound('WhatsApp channel not found.');
        }
        if (body.steps) {
          const templateIds = Array.from(new Set(body.steps.map((s) => s.templateId)));
          if (templateIds.length > 0) {
            const foundTpls = await tx.whatsAppTemplate.findMany({
              where: { id: { in: templateIds }, organizationId: orgId },
              select: { id: true },
            });
            if (foundTpls.length !== templateIds.length) {
              throw notFound('One or more selected templates were not found.');
            }
          }
        }
        await tx.sequence.update({
          where: { id },
          data: {
            name: body.name ?? undefined,
            description: body.description !== undefined ? body.description : undefined,
            channelId: body.channelId ?? undefined,
            isActive: body.isActive ?? undefined,
          },
        });
        if (body.steps) {
          await tx.sequenceStep.deleteMany({ where: { sequenceId: id } });
          await tx.sequenceStep.createMany({
            data: body.steps.map((s, idx) => ({
              organizationId: orgId,
              sequenceId: id,
              stepOrder: idx,
              templateId: s.templateId,
              delayHours: s.delayHours,
              variables: (s.variables ?? {}) as never,
            })),
          });
        }
        return tx.sequence.findUniqueOrThrow({
          where: { id },
          include: { steps: true, _count: { select: { enrollments: true } } },
        });
      });
      return { data: toDto(result) };
    },
  );

  // ---------- DELETE /sequences/:id ----------------------------------------
  r.delete(
    '/sequences/:id',
    {
      schema: {
        tags: ['sequences'],
        summary: 'Delete a sequence (cascades enrollments + steps).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const id = req.params.id;
      await app.tenant(req, async (tx) => {
        const existing = await tx.sequence.findUnique({ where: { id } });
        if (!existing) throw notFound('Sequence not found.');
        await tx.sequence.delete({ where: { id } });
      });
      return { ok: true as const };
    },
  );

  // ---------- GET /sequences/:id -------------------------------------------
  r.get(
    '/sequences/:id',
    {
      schema: {
        tags: ['sequences'],
        summary: 'Fetch a sequence with steps + enrollment count.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(sequenceDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const row = await tx.sequence.findUnique({
          where: { id: req.params.id },
          include: { steps: true, _count: { select: { enrollments: true } } },
        });
        if (!row) throw notFound('Sequence not found.');
        return { data: toDto(row) };
      }),
  );

  // ---------- POST /sequences/:id/enroll -----------------------------------
  r.post(
    '/sequences/:id/enroll',
    {
      schema: {
        tags: ['sequences'],
        summary: 'Enroll one or more contacts in this sequence.',
        params: z.object({ id: uuidSchema }),
        body: enrollContactsBodySchema,
        response: {
          200: z.object({ data: z.object({ enrolled: z.number().int().nonnegative() }) }),
        },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const enrolled = await app.tenant(req, async (tx) => {
        const seq = await tx.sequence.findUnique({ where: { id } });
        if (!seq) throw notFound('Sequence not found.');
        if (!seq.isActive) {
          throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Sequence is not active.');
        }
        // Filter to contacts that exist + aren't opted out + aren't already enrolled.
        const validContacts = await tx.contact.findMany({
          where: {
            id: { in: req.body.contactIds },
            deletedAt: null,
            optedOutAt: null,
          },
          select: { id: true },
        });
        if (validContacts.length === 0) return 0;
        // The unique (sequenceId, contactId) prevents duplicates; createMany
        // with skipDuplicates handles that gracefully.
        const result = await tx.sequenceEnrollment.createMany({
          data: validContacts.map((c) => ({
            organizationId: orgId,
            sequenceId: id,
            contactId: c.id,
            status: 'active',
            nextStepIndex: 0,
            nextStepDueAt: new Date(), // fire ASAP
          })),
          skipDuplicates: true,
        });
        return result.count;
      });
      return { data: { enrolled } };
    },
  );

  // ---------- GET /sequences/:id/enrollments -------------------------------
  r.get(
    '/sequences/:id/enrollments',
    {
      schema: {
        tags: ['sequences'],
        summary: 'List enrollments for this sequence.',
        params: z.object({ id: uuidSchema }),
        querystring: z.object({
          status: z.enum(['active', 'paused', 'completed', 'cancelled']).optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: listEnvelopeSchema(enrollmentDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const id = req.params.id;
        const seq = await tx.sequence.findUnique({ where: { id } });
        if (!seq) throw notFound('Sequence not found.');
        const where: Record<string, unknown> = { sequenceId: id };
        if (req.query.status) where.status = req.query.status;
        const rows = await tx.sequenceEnrollment.findMany({
          where,
          take: req.query.limit + 1,
          ...(req.query.cursor ? { cursor: { id: req.query.cursor }, skip: 1 } : {}),
          orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
        });
        const hasMore = rows.length > req.query.limit;
        const slice = hasMore ? rows.slice(0, req.query.limit) : rows;
        return {
          data: slice.map((e) => ({
            id: e.id,
            contactId: e.contactId,
            status: e.status,
            nextStepIndex: e.nextStepIndex,
            nextStepDueAt: e.nextStepDueAt?.toISOString() ?? null,
            enrolledAt: e.enrolledAt.toISOString(),
            completedAt: e.completedAt?.toISOString() ?? null,
            cancelledAt: e.cancelledAt?.toISOString() ?? null,
          })),
          nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
        };
      }),
  );

  // ---------- POST /enrollments/:id/cancel ---------------------------------
  r.post(
    '/enrollments/:id/cancel',
    {
      schema: {
        tags: ['sequences'],
        summary: 'Cancel an enrollment (no further steps will fire).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const id = req.params.id;
      await app.tenant(req, async (tx) => {
        const e = await tx.sequenceEnrollment.findUnique({ where: { id } });
        if (!e) throw notFound('Enrollment not found.');
        await tx.sequenceEnrollment.update({
          where: { id },
          data: { status: 'cancelled', cancelledAt: new Date() },
        });
      });
      return { ok: true as const };
    },
  );
}
