// Phase 11.3 — Meta media_id cache for product images.
//
// The bot's WhatsApp image-attach path used to do, per image, on EVERY
// reply that mentioned a product:
//
//   1. resolve Wasabi public URL or presign a GET URL  (~50-200ms)
//   2. fetch the image bytes from Wasabi                (~400-1500ms)
//   3. POST those bytes to graph.facebook.com/.../media  (~400-800ms)
//   4. POST a /messages with the returned media_id       (~300-800ms)
//
// Steps 2 + 3 add ~1-2s to every image bubble. Meta media_ids returned
// in step 3 are valid for 30 days — there's no reason to re-upload the
// same image every time.
//
// This module caches the media_id on the ProductImage row + the
// channel it was uploaded under (media_ids are scoped to phone_number_id,
// so a tenant switching their primary number invalidates the cache).
//
// Reusable + tenant-agnostic — picks up the channel + Wasabi config
// from the caller. Returns null on any failure so the caller can fall
// back to the per-message upload path.

import type { FastifyBaseLogger } from 'fastify';

import { withRlsBypass } from './db.js';
import { presignGetUrl, publicUrlFor } from './storage.js';

// Refresh a cached media_id when it's older than 25 days — gives a 5-day
// safety margin against Meta's 30-day expiry.
const FRESHNESS_MS = 25 * 24 * 60 * 60 * 1000;

export interface MediaCacheChannel {
  id: string;
  phoneNumberId: string | null;
  accessToken: string | null;
}

export interface MediaCacheArgs {
  productImageId: string;
  storageKey: string;
  channel: MediaCacheChannel;
  log: Pick<FastifyBaseLogger, 'warn' | 'info'>;
}

/**
 * Returns a Meta media_id for the given product image, uploading +
 * caching if needed. Returns null on any failure (caller should fall
 * back to its existing per-message upload path).
 */
export async function getOrUploadMetaMediaId(
  args: MediaCacheArgs,
): Promise<string | null> {
  const { productImageId, storageKey, channel, log } = args;
  if (!channel.phoneNumberId || !channel.accessToken) return null;

  // 1. Cache hit path — re-use if present, fresh, and uploaded under
  //    the SAME channel we're about to send through.
  const cached = await withRlsBypass((tx) =>
    tx.productImage.findUnique({
      where: { id: productImageId },
      select: {
        metaMediaId: true,
        metaMediaIdUploadedAt: true,
        metaMediaIdChannelId: true,
      },
    }),
  );
  if (
    cached?.metaMediaId &&
    cached.metaMediaIdChannelId === channel.id &&
    cached.metaMediaIdUploadedAt &&
    Date.now() - cached.metaMediaIdUploadedAt.getTime() < FRESHNESS_MS
  ) {
    return cached.metaMediaId;
  }

  // 2. Miss / stale — fetch the bytes from Wasabi + upload to Meta.
  try {
    const fileUrl = publicUrlFor(storageKey) ?? (await presignGetUrl(storageKey));
    const fr = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
    if (!fr.ok) {
      log.warn(
        { status: fr.status, storageKey },
        '[meta-media-cache] Wasabi fetch failed',
      );
      return null;
    }
    const bytes = Buffer.from(await fr.arrayBuffer());

    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
      `${productImageId}.jpg`,
    );
    const mediaRes = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId)}/media`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${channel.accessToken}` },
        body: fd,
        signal: AbortSignal.timeout(20_000),
      },
    );
    const mediaJson = (await mediaRes.json().catch(() => ({}))) as { id?: string };
    if (!mediaRes.ok || !mediaJson.id) {
      log.warn(
        { status: mediaRes.status, mediaJson, productImageId },
        '[meta-media-cache] Meta upload failed',
      );
      return null;
    }
    const newId = mediaJson.id;

    // 3. Write back to the cache. Fire-and-forget: the send path
    // doesn't need to wait for the write.
    void withRlsBypass((tx) =>
      tx.productImage.update({
        where: { id: productImageId },
        data: {
          metaMediaId: newId,
          metaMediaIdUploadedAt: new Date(),
          metaMediaIdChannelId: channel.id,
        },
      }),
    ).catch(() => undefined);

    return newId;
  } catch (err) {
    log.warn(
      { err, productImageId },
      '[meta-media-cache] threw while uploading',
    );
    return null;
  }
}
