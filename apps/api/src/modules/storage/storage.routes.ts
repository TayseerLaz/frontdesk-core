import {
  ApiErrorCode,
  AssetKind,
  CSV_UPLOAD_MIME_TYPES,
  DOCUMENT_MIME_TYPES,
  finalizeUploadBodySchema,
  IMAGE_MIME_TYPES,
  itemEnvelopeSchema,
  MAX_CSV_UPLOAD_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  presignUploadBodySchema,
  presignUploadResponseSchema,
  successSchema,
  uuidSchema,
  type CsvUploadMime,
  type DocumentMime,
  type ImageMime,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  buildStorageKey,
  isStorageConfigured,
  presignGetUrl,
  presignPutUrl,
  publicUrlFor,
} from '../../lib/storage.js';

function checkLimits(kind: AssetKind, contentType: string, byteSize: number) {
  if (byteSize <= 0) {
    throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'byteSize must be positive.');
  }
  if (kind === 'image') {
    if (!IMAGE_MIME_TYPES.includes(contentType as ImageMime)) {
      throw badRequest(ApiErrorCode.VALIDATION_ERROR, `Image content-type "${contentType}" not allowed.`);
    }
    if (byteSize > MAX_IMAGE_BYTES) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Image too large (max 10 MB).');
  } else if (kind === 'document') {
    if (!DOCUMENT_MIME_TYPES.includes(contentType as DocumentMime)) {
      throw badRequest(
        ApiErrorCode.VALIDATION_ERROR,
        `Document content-type "${contentType}" not allowed.`,
      );
    }
    if (byteSize > MAX_DOCUMENT_BYTES) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Document too large (max 25 MB).');
  } else if (kind === 'csv_upload') {
    if (!CSV_UPLOAD_MIME_TYPES.includes(contentType as CsvUploadMime)) {
      throw badRequest(
        ApiErrorCode.VALIDATION_ERROR,
        `CSV content-type "${contentType}" not allowed.`,
      );
    }
    if (byteSize > MAX_CSV_UPLOAD_BYTES) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Upload too large (max 50 MB).');
  }
}

export default async function storageRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- POST /assets/presign-upload ---------------------------------
  r.post(
    '/assets/presign-upload',
    {
      schema: {
        tags: ['storage'],
        summary: 'Get a presigned PUT URL for direct browser → object-storage upload.',
        body: presignUploadBodySchema,
        response: { 200: presignUploadResponseSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      if (!isStorageConfigured()) {
        throw badRequest(ApiErrorCode.SERVICE_UNAVAILABLE, 'Object storage is not configured on this server.');
      }
      checkLimits(req.body.kind, req.body.contentType, req.body.byteSize);

      return app.tenant(req, async (tx) => {
        const orgId = req.auth!.organizationId;
        const asset = await tx.asset.create({
          data: {
            organizationId: orgId,
            kind: req.body.kind,
            storageKey: 'pending',
            contentType: req.body.contentType,
            byteSize: req.body.byteSize,
            uploadedById: req.auth!.userId,
            metadata: req.body.metadata ?? undefined,
          },
        });
        const storageKey = buildStorageKey({
          organizationId: orgId,
          kind: req.body.kind,
          assetId: asset.id,
          filename: req.body.filename,
        });
        await tx.asset.update({ where: { id: asset.id }, data: { storageKey } });

        const { url, expiresInSeconds } = await presignPutUrl({
          storageKey,
          contentType: req.body.contentType,
          byteSize: req.body.byteSize,
        });
        const publicUrl = publicUrlFor(storageKey);

        return {
          assetId: asset.id,
          storageKey,
          uploadUrl: url,
          publicUrl,
          expiresInSeconds,
        };
      });
    },
  );

  // ---------- POST /assets/:id/finalize -----------------------------------
  r.post(
    '/assets/:id/finalize',
    {
      schema: {
        tags: ['storage'],
        summary: 'Mark an asset upload as complete and store dimensions/checksum.',
        params: z.object({ id: uuidSchema }),
        body: finalizeUploadBodySchema.omit({ assetId: true }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const asset = await tx.asset.findUnique({ where: { id: req.params.id } });
        if (!asset) throw notFound('Asset not found.');
        await tx.asset.update({
          where: { id: asset.id },
          data: {
            width: req.body.width ?? asset.width,
            height: req.body.height ?? asset.height,
            checksumSha256: req.body.checksumSha256 ?? asset.checksumSha256,
          },
        });
        await recordAudit({
          action: 'asset_uploaded',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'asset',
          entityId: asset.id,
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- GET /assets/:id/url -----------------------------------------
  r.get(
    '/assets/:id/url',
    {
      schema: {
        tags: ['storage'],
        summary: 'Get a (signed if private) read URL for an asset.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(z.object({ url: z.string().url() })) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const asset = await tx.asset.findUnique({ where: { id: req.params.id } });
        if (!asset) throw notFound('Asset not found.');
        const url = publicUrlFor(asset.storageKey) ?? (await presignGetUrl(asset.storageKey));
        return { data: { url } };
      });
    },
  );

  // ---------- GET /assets/preview-by-key ----------------------------------
  // Resolves a presigned read URL from a raw storage key. Used when the
  // caller only stored the key (not the assetId) — e.g. BotConfig
  // .greetingImageStorageKey. Tenant-scoped via the `org/<orgId>/...`
  // prefix in our key naming scheme; rejects any key that doesn't match
  // the caller's org so one tenant can't peek into another's bucket.
  r.get(
    '/assets/preview-by-key',
    {
      schema: {
        tags: ['storage'],
        summary: 'Get a presigned read URL for a storage key the caller owns.',
        querystring: z.object({ key: z.string().min(1).max(500) }),
        response: { 200: itemEnvelopeSchema(z.object({ url: z.string().url() })) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const key = req.query.key;
      if (!key.startsWith(`org/${orgId}/`)) {
        throw notFound('Asset not found.');
      }
      const url = publicUrlFor(key) ?? (await presignGetUrl(key));
      return { data: { url } };
    },
  );
}
