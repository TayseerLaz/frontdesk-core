import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

import { env } from './env.js';

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!env.WASABI_ACCESS_KEY_ID || !env.WASABI_SECRET_ACCESS_KEY) {
    throw new Error('Object storage is not configured (WASABI_* env vars missing).');
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
  });
  return client;
}

/** Stream an object from Wasabi as a Node.js Readable stream. */
export async function getObjectStream(storageKey: string): Promise<Readable> {
  const out = await getClient().send(new GetObjectCommand({ Bucket: env.WASABI_BUCKET, Key: storageKey }));
  if (!out.Body) throw new Error('Empty response body from object storage.');
  return out.Body as Readable;
}

/** Upload a buffer to Wasabi at the given key. Returns the byte size. */
export async function putObject(args: {
  storageKey: string;
  body: Buffer;
  contentType: string;
}): Promise<number> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: env.WASABI_BUCKET,
      Key: args.storageKey,
      Body: args.body,
      ContentType: args.contentType,
    }),
  );
  return args.body.byteLength;
}
