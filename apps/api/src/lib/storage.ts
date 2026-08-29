import type { Readable } from 'node:stream';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from './env.js';

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!env.WASABI_ACCESS_KEY_ID || !env.WASABI_SECRET_ACCESS_KEY) {
    throw new Error('Object storage is not configured (WASABI_ACCESS_KEY_ID/SECRET_ACCESS_KEY missing).');
  }
  if (client) return client;
  client = new S3Client({
    region: env.WASABI_REGION,
    endpoint: env.WASABI_ENDPOINT,
    forcePathStyle: false,
    credentials: {
      accessKeyId: env.WASABI_ACCESS_KEY_ID,
      secretAccessKey: env.WASABI_SECRET_ACCESS_KEY,
    },
    // AWS SDK v3 (≥3.729) adds `x-amz-checksum-crc32` + `x-amz-sdk-checksum-algorithm`
    // to presigned PUT URLs by default. Browsers don't send those headers, so the
    // signature Wasabi calculates doesn't match and the PUT returns 403
    // SignatureDoesNotMatch. Tell the SDK not to require the checksum on request.
    // See: https://github.com/aws/aws-sdk-js-v3/issues/6810
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

export function isStorageConfigured(): boolean {
  return Boolean(env.WASABI_ACCESS_KEY_ID && env.WASABI_SECRET_ACCESS_KEY);
}

/**
 * Build a deterministic, tenant-scoped object key.
 * Format: org/<orgId>/<kind>/<yyyy>/<mm>/<assetId>[.ext]
 */
export function buildStorageKey(args: {
  organizationId: string;
  kind: string;
  assetId: string;
  filename?: string;
}): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = args.filename ? extOf(args.filename) : '';
  return `org/${args.organizationId}/${args.kind}/${yyyy}/${mm}/${args.assetId}${ext}`;
}

function extOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  const ext = filename.slice(idx).toLowerCase();
  // Allow only common safe extensions; otherwise drop.
  if (!/^\.[a-z0-9]{1,6}$/i.test(ext)) return '';
  return ext;
}

export async function presignPutUrl(args: {
  storageKey: string;
  contentType: string;
  byteSize: number;
}): Promise<{ url: string; expiresInSeconds: number }> {
  const cmd = new PutObjectCommand({
    Bucket: env.WASABI_BUCKET,
    Key: args.storageKey,
    ContentType: args.contentType,
    ContentLength: args.byteSize,
  });
  const url = await getSignedUrl(getClient(), cmd, { expiresIn: env.WASABI_SIGNED_URL_TTL_SECONDS });
  return { url, expiresInSeconds: env.WASABI_SIGNED_URL_TTL_SECONDS };
}

/**
 * Upload raw bytes to object storage from the server (no browser round-trip).
 * Used for media we fetch ourselves — e.g. downloading an inbound WhatsApp
 * image from Meta and persisting it so the inbox can render it later.
 */
export async function putObject(args: {
  storageKey: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  // Wasabi intermittently 403s with InvalidAccessKeyId on a valid key
  // (observed 2026-08-09, five-hour burst). Most callers are fire-and-forget
  // — a single failed PUT permanently loses inbound media — so absorb
  // transient faults here.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await getClient().send(
        new PutObjectCommand({
          Bucket: env.WASABI_BUCKET,
          Key: args.storageKey,
          Body: args.body,
          ContentType: args.contentType,
          ContentLength: args.body.length,
        }),
      );
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt === 1 ? 800 : 2500));
    }
  }
  throw lastErr;
}

export async function presignGetUrl(storageKey: string, expiresIn = 3600): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: env.WASABI_BUCKET, Key: storageKey });
  return getSignedUrl(getClient(), cmd, { expiresIn });
}

/**
 * Best-effort public URL — only returned when WASABI_PUBLIC_BUCKET=true is
 * explicitly set. By default (and on the Wasabi accounts we're hosted on)
 * bucket-level public-read is disallowed at the account level, so emitting
 * a public URL would 403 the browser. Callers that don't get a value back
 * here should fall back to presignGetUrl.
 */
export function publicUrlFor(storageKey: string): string | null {
  if (!env.WASABI_PUBLIC_BUCKET) return null;
  if (env.WASABI_PUBLIC_URL_BASE) {
    const base = env.WASABI_PUBLIC_URL_BASE.replace(/\/+$/, '');
    return `${base}/${storageKey}`;
  }
  return null;
}

/** Stream the contents of a stored object. Used by CSV-driven flows that
 * parse small-to-medium files synchronously inside an API route. */
export async function getObjectStream(storageKey: string): Promise<Readable> {
  const out = await getClient().send(
    new GetObjectCommand({ Bucket: env.WASABI_BUCKET, Key: storageKey }),
  );
  if (!out.Body) throw new Error(`Empty body for ${storageKey}`);
  return out.Body as Readable;
}
