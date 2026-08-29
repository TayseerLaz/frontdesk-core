#!/usr/bin/env node
// One-off (idempotent) script that PUTs the bucket CORS configuration
// for the Wasabi bucket used by image + CSV uploads.
//
// Triggered from the deploy pipeline AFTER .env.production is synced.
// Reads its origins from WEB_DOMAIN + WEB_DOMAIN_LEGACY env vars so the
// allowed origins follow the portal domain automatically.
//
// Safe to run every deploy: PutBucketCors REPLACES the existing rules
// with the body we send, and the body is fully deterministic.
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`[wasabi-cors] ${k} not set in env — skipping CORS sync.`);
    process.exit(0);
  }
  return v;
};

const Bucket = need('WASABI_BUCKET');
const endpoint = need('WASABI_ENDPOINT');
const region = need('WASABI_REGION');
const accessKeyId = need('WASABI_ACCESS_KEY_ID');
const secretAccessKey = need('WASABI_SECRET_ACCESS_KEY');

// Build the allowed origins from the portal's current + previous host(s).
// Keep the legacy aligned-tech host on the list so old browser tabs don't
// suddenly fail mid-session. Localhost added unconditionally for dev.
const primary = process.env.WEB_DOMAIN
  ? `https://${process.env.WEB_DOMAIN}`
  : 'https://hader.ai';
const AllowedOrigins = Array.from(
  new Set([
    primary,
    'https://hader.ai',
    'https://alignbot.aligned-tech.com',
    'http://localhost:3000',
  ]),
);

const s3 = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: false,
});

const CORSConfiguration = {
  CORSRules: [
    {
      AllowedOrigins,
      AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3000,
    },
  ],
};

try {
  await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration }));
  console.log(
    `[wasabi-cors] CORS applied to ${Bucket}. Allowed origins:`,
    AllowedOrigins.join(', '),
  );
  // Read-back is informational only; on failure we don't fail the deploy.
  try {
    const got = await s3.send(new GetBucketCorsCommand({ Bucket }));
    console.log(
      `[wasabi-cors] Verified ${got.CORSRules?.[0]?.AllowedOrigins?.length ?? 0} origin(s) on bucket.`,
    );
  } catch {
    /* swallow */
  }
} catch (err) {
  console.error('[wasabi-cors] PutBucketCors failed:', err?.message ?? err);
  process.exit(1);
}
