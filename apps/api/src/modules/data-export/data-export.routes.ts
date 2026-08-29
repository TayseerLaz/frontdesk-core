// Phase 3 §5.1.4 — GDPR data portability for the entire organization.
//
// The per-user export at /account/export already covers personal data.
// This module adds an admin-gated "export everything in this org": the
// catalog (products/services/categories/business info), all WhatsApp
// conversations and messages, the bot config + KB, and the audit log.
//
// We can't synchronously stream gigabytes of JSON, so /export enqueues a
// BullMQ job and the worker assembles a zip, uploads to Wasabi, and emails
// the requester a signed download link. The portal lists past exports.
import { ApiErrorCode, itemEnvelopeSchema, listEnvelopeSchema, uuidSchema } from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { getDataExportQueue } from '../../lib/queues.js';
import { presignGetUrl } from '../../lib/storage.js';

// Per-tenant access control: ALIGNED-admin can turn self-service export off.
// (ALIGNED admins can still export any org's data from the admin panel.)
async function ensureExportsEnabled(orgId: string): Promise<void> {
  const org = await withRlsBypass((tx) =>
    tx.organization.findUnique({ where: { id: orgId }, select: { disabledFeatures: true } }),
  );
  if (org?.disabledFeatures?.includes('exports')) {
    throw forbidden(
      ApiErrorCode.FEATURE_DISABLED,
      'Data export is turned off for this workspace. Contact ALIGNED support if you need an export.',
    );
  }
}

const dataExportSchema = z.object({
  id: uuidSchema,
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  storageKey: z.string().nullable(),
  fileSizeBytes: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export default async function dataExportRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/exports',
    {
      schema: {
        tags: ['account'],
        summary: 'List recent organization data exports.',
        response: { 200: listEnvelopeSchema(dataExportSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      await ensureExportsEnabled(req.auth!.organizationId);
      return app.tenant(req, async (tx) => {
        const rows = await tx.dataExport.findMany({
          orderBy: { createdAt: 'desc' },
          take: 25,
        });
        return {
          data: rows.map((e) => ({
            id: e.id,
            status: e.status as 'pending' | 'running' | 'succeeded' | 'failed',
            storageKey: e.storageKey,
            fileSizeBytes: e.fileSizeBytes,
            errorMessage: e.errorMessage,
            startedAt: e.startedAt?.toISOString() ?? null,
            finishedAt: e.finishedAt?.toISOString() ?? null,
            createdAt: e.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      });
    },
  );

  r.post(
    '/exports',
    {
      schema: {
        tags: ['account'],
        summary: 'Request a new organization data export. Worker emails the link when ready.',
        response: { 201: itemEnvelopeSchema(dataExportSchema) },
      },
      // Cap: at most 3 exports / hour per org. A full export reads from
      // every catalog + inbox table, so we don't want users smashing the
      // button while one's already running.
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 hour',
          keyGenerator: (req: { auth?: { organizationId?: string }; ip: string }) =>
            req.auth?.organizationId ?? req.ip,
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const userId = req.auth!.userId;
      await ensureExportsEnabled(orgId);

      // Refuse if there's an in-flight export — keep the queue lean and
      // give the operator a clear error instead of a silent build-up.
      const inflight = await app.tenant(req, (tx) =>
        tx.dataExport.findFirst({
          where: { status: { in: ['pending', 'running'] } },
        }),
      );
      if (inflight) {
        throw badRequest(
          ApiErrorCode.CONFLICT,
          'An export is already in progress. Wait for it to finish before starting another.',
        );
      }

      const requester = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId }, select: { email: true } }),
      );
      if (!requester) throw notFound('Requesting user not found.');

      const created = await app.tenant(req, (tx) =>
        tx.dataExport.create({
          data: { organizationId: orgId, requestedByUserId: userId, status: 'pending' },
        }),
      );

      await getDataExportQueue().add(
        'data-export',
        {
          organizationId: orgId,
          requestedByUserId: userId,
          requestedByEmail: requester.email,
          exportId: created.id,
        },
        {
          attempts: 1,
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      );

      reply.code(201);
      return {
        data: {
          id: created.id,
          status: 'pending' as const,
          storageKey: null,
          fileSizeBytes: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          createdAt: created.createdAt.toISOString(),
        },
      };
    },
  );

  // Mint a signed download URL for a finished export. We don't return
  // the URL inline on the list response — that would store a signed URL
  // in the React-Query cache and persist past its TTL.
  r.get(
    '/exports/:id/download',
    {
      schema: {
        tags: ['account'],
        summary: 'Get a short-lived signed download URL for a completed export.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(z.object({ url: z.string().url(), expiresInSeconds: z.number() })),
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      await ensureExportsEnabled(req.auth!.organizationId);
      const row = await app.tenant(req, (tx) =>
        tx.dataExport.findUnique({ where: { id: req.params.id } }),
      );
      if (!row) throw notFound('Export not found.');
      if (row.status !== 'succeeded' || !row.storageKey) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Export is not ready for download.');
      }
      const url = await presignGetUrl(row.storageKey);
      return { data: { url, expiresInSeconds: 900 } };
    },
  );
}
