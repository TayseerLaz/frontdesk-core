import { z } from 'zod';

import { AssetKind } from '../enums/catalog.js';
import { uuidSchema } from './common.js';

// Image MIME allowlist for product images. Other kinds widen the list.
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

// Document MIME allowlist. Caps the set of files a tenant can stash in
// object storage via the presign-upload route so an attacker can't request
// a presign for text/html and use the bucket as a phishing host.
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  // Audio — operator voice notes recorded in the browser. MediaRecorder emits
  // audio/mp4 (Safari), audio/webm (Chrome/Firefox) or audio/ogg (opus-recorder);
  // the rest cover uploaded clips.
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/aac',
  'audio/wav',
  'audio/x-m4a',
  'audio/3gpp',
  'audio/amr',
] as const;
export type DocumentMime = (typeof DOCUMENT_MIME_TYPES)[number];

// CSV/spreadsheet MIME allowlist for the dedicated CSV multipart route.
export const CSV_UPLOAD_MIME_TYPES = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export type CsvUploadMime = (typeof CSV_UPLOAD_MIME_TYPES)[number];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024; // 25 MB
export const MAX_CSV_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

export const presignUploadBodySchema = z.object({
  kind: z.nativeEnum(AssetKind),
  contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
  byteSize: z.number().int().positive().max(MAX_CSV_UPLOAD_BYTES),
  filename: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});
export type PresignUploadBody = z.infer<typeof presignUploadBodySchema>;

export const presignUploadResponseSchema = z.object({
  assetId: uuidSchema,
  storageKey: z.string(),
  // PUT this URL with the same Content-Type header to complete the upload.
  uploadUrl: z.string().url(),
  // Public read URL (or via signed GET endpoint if bucket is private).
  publicUrl: z.string().url().nullable(),
  expiresInSeconds: z.number().int().positive(),
});

export const finalizeUploadBodySchema = z.object({
  assetId: uuidSchema,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type FinalizeUploadBody = z.infer<typeof finalizeUploadBodySchema>;

export const assetSchema = z.object({
  id: uuidSchema,
  kind: z.nativeEnum(AssetKind),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  url: z.string().url().nullable(),
  createdAt: z.string().datetime(),
});
export type AssetDto = z.infer<typeof assetSchema>;
