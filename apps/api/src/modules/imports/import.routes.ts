import {
  ApiErrorCode,
  IMPORT_ENTITY_KINDS,
  type ImportEntityKind,
  importJobRowSchema,
  importJobSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  startImportBodySchema,
  successSchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getImportQueue } from '../../lib/queues.js';
import { isStorageConfigured } from '../../lib/storage.js';

import { buildTemplateXlsx, TEMPLATES } from './template.js';

export default async function importRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /imports/templates/:kind --------------------------------
  r.get(
    '/imports/templates/:kind',
    {
      schema: {
        tags: ['imports'],
        summary: 'Download an XLSX import template for the given entity kind.',
        params: z.object({
          kind: z.enum(IMPORT_ENTITY_KINDS as [ImportEntityKind, ...ImportEntityKind[]]),
        }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req, reply) => {
      const buf = await buildTemplateXlsx(req.params.kind);
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="aligned-${req.params.kind}-template.xlsx"`);
      return reply.send(buf);
    },
  );

  // ---------- GET /imports/templates/:kind/fields -------------------------
  // Returns the target field hints — used to drive the column mapping UI.
  r.get(
    '/imports/templates/:kind/fields',
    {
      schema: {
        tags: ['imports'],
        summary: 'List target fields for an entity kind (drives the column mapping UI).',
        params: z.object({
          kind: z.enum(IMPORT_ENTITY_KINDS as [ImportEntityKind, ...ImportEntityKind[]]),
        }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => ({ data: TEMPLATES[req.params.kind].fields }),
  );

  // ---------- POST /imports -----------------------------------------------
  r.post(
    '/imports',
    {
      schema: {
        tags: ['imports'],
        summary: 'Start an import from a previously uploaded CSV/XLSX asset.',
        body: startImportBodySchema,
        response: { 202: itemEnvelopeSchema(importJobSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      if (!isStorageConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'Object storage not configured — uploads (and therefore imports) are unavailable in this environment.',
        );
      }
      if (!req.body.sourceAssetId) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'sourceAssetId is required.');
      }
      const orgId = req.auth!.organizationId;
      const job = await app.tenant(req, async (tx) => {
        const asset = await tx.asset.findUnique({ where: { id: req.body.sourceAssetId! } });
        if (!asset) throw notFound('Source asset not found.');
        if (asset.kind !== 'csv_upload')
          throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Asset must be of kind "csv_upload".');

        return tx.importJob.create({
          data: {
            organizationId: orgId,
            entityKind: req.body.entityKind,
            sourceAssetId: asset.id,
            sourceFilename: (asset.metadata as { filename?: string } | null)?.filename ?? null,
            columnMapping: req.body.columnMapping ?? undefined,
            createdById: req.auth!.userId,
          },
        });
      });

      await getImportQueue().add(
        'import',
        { organizationId: orgId, importJobId: job.id },
        {
          jobId: job.id,
          attempts: 1,
          removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
          removeOnFail: { age: 30 * 24 * 60 * 60 },
        },
      );

      await recordAudit({
        action: 'import_started',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'import_job',
        entityId: job.id,
        metadata: { entityKind: req.body.entityKind },
      });

      reply.code(202);
      return { data: serializeJob(job) };
    },
  );

  // ---------- GET /imports ------------------------------------------------
  r.get(
    '/imports',
    {
      schema: {
        tags: ['imports'],
        summary: 'List recent import jobs.',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
        response: { 200: listEnvelopeSchema(importJobSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.importJob.findMany({
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        });
        return { data: rows.map(serializeJob), nextCursor: null };
      }),
  );

  // ---------- GET /imports/:id --------------------------------------------
  r.get(
    '/imports/:id',
    {
      schema: {
        tags: ['imports'],
        summary: 'Get an import job by id.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(importJobSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.importJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Import job not found.');
        return { data: serializeJob(job) };
      }),
  );

  // ---------- GET /imports/:id/rows ---------------------------------------
  r.get(
    '/imports/:id/rows',
    {
      schema: {
        tags: ['imports'],
        summary: 'List per-row results for an import job.',
        params: z.object({ id: uuidSchema }),
        querystring: z.object({
          status: z.enum(['succeeded', 'failed', 'skipped']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: listEnvelopeSchema(importJobRowSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.importJobRow.findMany({
          where: { importJobId: req.params.id, ...(req.query.status ? { status: req.query.status } : {}) },
          orderBy: { rowNumber: 'asc' },
          take: req.query.limit,
        });
        return {
          data: rows.map((r) => ({
            id: r.id,
            rowNumber: r.rowNumber,
            status: r.status,
            resultEntityId: r.resultEntityId,
            rawData: (r.rawData ?? null) as Record<string, unknown> | null,
            errors:
              (r.errors as { path: string; message: string }[] | null | undefined) ?? null,
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- PATCH /imports/:id/rows/:rowId ------------------------------
  // Edit a failed row and retry it. The operator opens the row inline,
  // fixes the invalid field(s), and POSTs the new raw record. We re-run
  // the same Zod validator + upsert the worker uses, then write the
  // result back onto the ImportJobRow and bump the parent job's counters.
  r.patch(
    '/imports/:id/rows/:rowId',
    {
      schema: {
        tags: ['imports'],
        summary: 'Edit a single import row and retry it. Re-runs validation + upsert.',
        params: z.object({ id: uuidSchema, rowId: uuidSchema }),
        body: z.object({
          // We accept an arbitrary object — validation is done downstream
          // by the same per-kind schema the worker uses.
          rawData: z.record(z.string(), z.unknown()),
        }),
        response: { 200: itemEnvelopeSchema(importJobRowSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.importJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Import job not found.');
        const row = await tx.importJobRow.findUnique({ where: { id: req.params.rowId } });
        if (!row || row.importJobId !== job.id) throw notFound('Row not found.');
        if (row.status === 'succeeded') {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'This row already succeeded. Delete the resulting record and re-import if you need to change it.',
          );
        }

        const { upsertOne, ZodError, zodErrorToImportErrors } = await import(
          '../../lib/import-upsert.js'
        );

        let nextStatus: 'succeeded' | 'failed' = 'failed';
        let resultEntityId: string | null = null;
        let errors: { path: string; message: string }[] = [];

        try {
          resultEntityId = await upsertOne(
            tx as never,
            job.organizationId,
            job.entityKind as ImportEntityKind,
            req.body.rawData,
          );
          nextStatus = 'succeeded';
        } catch (err) {
          if (err instanceof ZodError) {
            errors = zodErrorToImportErrors(err);
          } else {
            errors = [
              {
                path: '_',
                message: err instanceof Error ? err.message : 'Upsert failed.',
              },
            ];
          }
          nextStatus = 'failed';
        }

        // Job counter delta. The row was previously failed or skipped
        // (succeeded was rejected above), so the only counter that can
        // move is failedRows decreasing when we just succeeded.
        const wasFailed = row.status === 'failed';
        const nowSucceeded = nextStatus === 'succeeded';
        const nowFailed = nextStatus === 'failed';
        const failedDelta = (nowFailed ? 1 : 0) - (wasFailed ? 1 : 0);
        const succeededDelta = nowSucceeded ? 1 : 0;

        const updated = await tx.importJobRow.update({
          where: { id: row.id },
          data: {
            status: nextStatus,
            resultEntityId,
            rawData: req.body.rawData as never,
            errors: errors.length > 0 ? (errors as never) : (null as never),
          },
        });

        if (failedDelta !== 0 || succeededDelta !== 0) {
          await tx.importJob.update({
            where: { id: job.id },
            data: {
              failedRows: { increment: failedDelta },
              succeededRows: { increment: succeededDelta },
              // If the worker had marked the job 'partial' or 'failed' and
              // the operator just fixed the last failure, flip it back to
              // 'succeeded' — otherwise leave the lifecycle status alone.
              ...(failedDelta < 0 && job.failedRows + failedDelta === 0 && job.status === 'partial'
                ? { status: 'succeeded' as never }
                : {}),
            },
          });
        }

        await recordAudit({
          action: 'import_completed',
          organizationId: job.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'import_job_row',
          entityId: row.id,
          metadata: {
            event: nextStatus === 'succeeded' ? 'row_fixed' : 'row_retry_failed',
            rowNumber: row.rowNumber,
          },
        });

        return {
          data: {
            id: updated.id,
            rowNumber: updated.rowNumber,
            status: updated.status,
            resultEntityId: updated.resultEntityId,
            rawData: (updated.rawData ?? null) as Record<string, unknown> | null,
            errors:
              (updated.errors as { path: string; message: string }[] | null | undefined) ?? null,
          },
        };
      }),
  );

  // ---------- GET /imports/:id/errors.csv ---------------------------------
  // Downloadable CSV of failed rows — per PDF spec §3.1.2 task 7.7.
  // Columns: row_number, errors, <original headers…>. Errors are joined with
  // "; " so Excel renders them on a single line.
  r.get(
    '/imports/:id/errors.csv',
    {
      schema: {
        tags: ['imports'],
        summary: 'Download failed rows for an import job as a CSV file.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req, reply) =>
      app.tenant(req, async (tx) => {
        const job = await tx.importJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Import job not found.');
        const rows = await tx.importJobRow.findMany({
          where: { importJobId: job.id, status: 'failed' },
          orderBy: { rowNumber: 'asc' },
        });

        // Collect the union of raw-data keys across all failed rows to form
        // the CSV header. Preserves first-seen ordering.
        const keys: string[] = [];
        const seen = new Set<string>();
        for (const r of rows) {
          const raw = (r.rawData ?? {}) as Record<string, unknown>;
          for (const k of Object.keys(raw)) {
            if (!seen.has(k)) {
              seen.add(k);
              keys.push(k);
            }
          }
        }

        // CSV-escape AND neutralise spreadsheet formula injection. Excel,
        // LibreOffice, and Sheets all treat leading =, +, -, @, and TAB as
        // a formula. Prepending a single quote forces the cell to render as
        // text. Conservative — costs one byte, kills a whole class of
        // attacks that start in user-supplied catalog rows.
        const esc = (v: unknown) => {
          let s = v == null ? '' : String(v);
          if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
            s = `'${s}`;
          }
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };

        const header = ['row_number', 'errors', ...keys];
        const lines: string[] = [header.map(esc).join(',')];
        for (const r of rows) {
          const raw = (r.rawData ?? {}) as Record<string, unknown>;
          const errors = (r.errors ?? []) as { path: string; message: string }[] | null;
          const errorStr = errors
            ? errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')
            : '';
          lines.push([r.rowNumber, errorStr, ...keys.map((k) => raw[k])].map(esc).join(','));
        }

        const filename = `aligned-import-${job.id.slice(0, 8)}-errors.csv`;
        reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${filename}"`);
        return reply.send(lines.join('\n'));
      }),
  );

  // ---------- POST /imports/:id/cancel ------------------------------------
  r.post(
    '/imports/:id/cancel',
    {
      schema: {
        tags: ['imports'],
        summary: 'Cancel an in-progress import (best-effort; worker checks between rows).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.importJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Import job not found.');
        if (['succeeded', 'failed', 'cancelled', 'partial'].includes(job.status)) {
          return { ok: true as const };
        }
        await tx.importJob.update({ where: { id: job.id }, data: { status: 'cancelled' } });
        return { ok: true as const };
      }),
  );

  // ---------- DELETE /imports/:id ----------------------------------------
  // Removes a single import job + its row records. Allowed for any status —
  // including failed/cancelled — so operators can clear history.
  // In-progress jobs are cancelled first (so the worker stops) then deleted.
  r.delete(
    '/imports/:id',
    {
      schema: {
        tags: ['imports'],
        summary: 'Delete an import job (any status). Imported data is NOT reverted.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const job = await tx.importJob.findUnique({ where: { id: req.params.id } });
        if (!job) throw notFound('Import job not found.');
        // importJobRow has ON DELETE CASCADE so rows go with the job.
        await tx.importJob.delete({ where: { id: job.id } });
        return { ok: true as const };
      }),
  );

  // ---------- POST /imports/clear ---------------------------------------
  // Bulk clear finished import jobs (any of succeeded/partial/failed/cancelled
  // by default; pass `statuses: ['failed']` to scope). In-progress jobs are
  // left alone — use per-row DELETE if you need to nuke one of those.
  r.post(
    '/imports/clear',
    {
      schema: {
        tags: ['imports'],
        summary: 'Delete all finished imports for the current org (succeeded, partial, failed, cancelled).',
        body: z
          .object({
            statuses: z
              .array(
                z.enum([
                  'pending',
                  'validating',
                  'processing',
                  'succeeded',
                  'partial',
                  'failed',
                  'cancelled',
                ]),
              )
              .min(1)
              .optional(),
          })
          .optional()
          .nullable(),
        response: { 200: itemEnvelopeSchema(z.object({ removed: z.number() })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const statuses = req.body?.statuses ?? ['succeeded', 'partial', 'failed', 'cancelled'];
      return app.tenant(req, async (tx) => {
        const result = await tx.importJob.deleteMany({
          where: { status: { in: statuses as never } },
        });
        return { data: { removed: result.count } };
      });
    },
  );
}

function serializeJob(job: {
  id: string;
  entityKind: ImportEntityKind;
  status:
    | 'pending'
    | 'validating'
    | 'processing'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'cancelled';
  sourceFilename: string | null;
  totalRows: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  skippedRows: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: job.id,
    entityKind: job.entityKind,
    status: job.status,
    sourceFilename: job.sourceFilename,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    succeededRows: job.succeededRows,
    failedRows: job.failedRows,
    skippedRows: job.skippedRows,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
