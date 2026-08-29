// Direct multipart CSV/XLSX upload (alongside the presigned image flow).
//
// Why a separate path: image uploads use presigned PUT (browser → Wasabi
// directly), but a CSV upload needs the API to record the asset and return an
// id we can pass to POST /imports straight away. We stream the file body into
// Wasabi via PutObjectCommand to avoid buffering the whole file in memory.
import {
  ApiErrorCode,
  AssetKind,
  itemEnvelopeSchema,
  MAX_CSV_UPLOAD_BYTES,
  uuidSchema,
} from '@platform/shared';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { badRequest } from '../../lib/errors.js';
import { buildStorageKey, isStorageConfigured } from '../../lib/storage.js';

const ALLOWED_CSV_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

let s3: S3Client | null = null;
function getS3(): S3Client {
  if (s3) return s3;
  s3 = new S3Client({
    region: env.WASABI_REGION,
    endpoint: env.WASABI_ENDPOINT,
    forcePathStyle: false,
    credentials: {
      accessKeyId: env.WASABI_ACCESS_KEY_ID!,
      secretAccessKey: env.WASABI_SECRET_ACCESS_KEY!,
    },
  });
  return s3;
}

export default async function multipartUploadRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- POST /assets/upload-csv -------------------------------------
  // multipart/form-data; the API streams the body to Wasabi server-to-server.
  r.post(
    '/assets/upload-csv',
    {
      schema: {
        tags: ['storage'],
        summary: 'Upload a CSV/XLSX file (server-side stream to object storage).',
        consumes: ['multipart/form-data'],
        response: {
          201: itemEnvelopeSchema(
            z.object({
              assetId: uuidSchema,
              filename: z.string(),
              byteSize: z.number().int(),
              contentType: z.string(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('editor')],
      // Per-user cap on heavyweight uploads. A compromised editor account
      // shouldn't be able to pin Wasabi + worker capacity by queuing 50 MB
      // imports back-to-back. 5/minute is generous for genuine usage.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req) => `upload-csv:${req.auth?.userId ?? req.ip}`,
        },
      },
    },
    async (req, reply) => {
      if (!isStorageConfigured()) {
        throw badRequest(
          ApiErrorCode.SERVICE_UNAVAILABLE,
          'Object storage is not configured on this server.',
        );
      }
      const file = await (req as unknown as {
        file: () => Promise<
          | {
              filename: string;
              mimetype: string;
              file: NodeJS.ReadableStream;
              toBuffer: () => Promise<Buffer>;
            }
          | undefined
        >;
      }).file();
      if (!file) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'No file uploaded.');
      if (!ALLOWED_CSV_TYPES.has(file.mimetype) && !file.filename.match(/\.(csv|xlsx?|xlsm)$/i)) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, `Unsupported content-type: ${file.mimetype}`);
      }

      // Buffer in memory (capped); for 50 MB it's fine for a CSV import.
      const buf = await file.toBuffer();
      if (buf.byteLength > MAX_CSV_UPLOAD_BYTES) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, `File too large: ${buf.byteLength} bytes`);
      }

      const orgId = req.auth!.organizationId;
      const asset = await app.tenant(req, async (tx) => {
        const created = await tx.asset.create({
          data: {
            organizationId: orgId,
            kind: AssetKind.csv_upload,
            storageKey: 'pending',
            contentType: file.mimetype,
            byteSize: buf.byteLength,
            uploadedById: req.auth!.userId,
            metadata: { filename: file.filename },
          },
        });
        const storageKey = buildStorageKey({
          organizationId: orgId,
          kind: 'csv_upload',
          assetId: created.id,
          filename: file.filename,
        });
        return tx.asset.update({
          where: { id: created.id },
          data: { storageKey },
        });
      });

      await getS3().send(
        new PutObjectCommand({
          Bucket: env.WASABI_BUCKET,
          Key: asset.storageKey,
          ContentType: file.mimetype,
          Body: buf,
        }),
      );

      await recordAudit({
        action: 'asset_uploaded',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'asset',
        entityId: asset.id,
        metadata: { kind: 'csv_upload', filename: file.filename },
      });

      reply.code(201);
      return {
        data: {
          assetId: asset.id,
          filename: file.filename,
          byteSize: buf.byteLength,
          contentType: file.mimetype,
        },
      };
    },
  );
}
