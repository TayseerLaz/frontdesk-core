// Redis cache for the chatbot read API.
//
// Cache key shape: `read:{orgId}:{endpoint}:{queryHash}`
// We invalidate by prefix on any write to that org's catalog (`read:{orgId}:*`).
// Uses Redis SCAN so we never block on a huge KEYS call in prod.
//
// Phase 5.7 — payloads >2KB are gzipped before storing. The on-disk shape is
//   "z:" + base64(gzip(json))   for compressed entries
//   "j:" + raw json              for small entries (no compression overhead)
// Old entries written before compression existed start with "{" → handled
// transparently as legacy json (read-only fallback).
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { getRedis } from './redis.js';

const TTL_SECONDS = 60;
const STALE_TTL_SECONDS = 300;
const COMPRESS_THRESHOLD_BYTES = 2048;

interface CachedEntry<T> {
  value: T;
  storedAt: number;
}

function encode<T>(entry: CachedEntry<T>): string {
  const json = JSON.stringify(entry);
  if (json.length < COMPRESS_THRESHOLD_BYTES) return `j:${json}`;
  const gz = gzipSync(json, { level: 6 });
  return `z:${gz.toString('base64')}`;
}

function decode<T>(raw: string): CachedEntry<T> | null {
  try {
    if (raw.startsWith('j:')) return JSON.parse(raw.slice(2)) as CachedEntry<T>;
    if (raw.startsWith('z:')) {
      const buf = Buffer.from(raw.slice(2), 'base64');
      const json = gunzipSync(buf).toString('utf8');
      return JSON.parse(json) as CachedEntry<T>;
    }
    // Legacy entries (pre-Phase 5.7) — plain JSON.
    return JSON.parse(raw) as CachedEntry<T>;
  } catch {
    return null;
  }
}

function cacheKey(orgId: string, endpoint: string, query: Record<string, unknown> | null) {
  const normalised = query
    ? Object.keys(query)
        .sort()
        .map((k) => `${k}=${String(query[k])}`)
        .join('&')
    : '';
  const hash = createHash('sha1').update(normalised).digest('hex').slice(0, 16);
  return `read:${orgId}:${endpoint}:${hash}`;
}

export async function readCacheGet<T>(
  orgId: string,
  endpoint: string,
  query: Record<string, unknown> | null,
): Promise<{ value: T; stale: boolean } | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(cacheKey(orgId, endpoint, query));
    if (!raw) return null;
    const entry = decode<T>(raw);
    if (!entry) return null;
    const age = (Date.now() - entry.storedAt) / 1000;
    return { value: entry.value, stale: age > TTL_SECONDS };
  } catch (err) {
    console.error('[read-cache] get failed', err);
    return null;
  }
}

export async function readCacheSet<T>(
  orgId: string,
  endpoint: string,
  query: Record<string, unknown> | null,
  value: T,
): Promise<void> {
  try {
    const redis = getRedis();
    const entry: CachedEntry<T> = { value, storedAt: Date.now() };
    await redis.set(cacheKey(orgId, endpoint, query), encode(entry), 'EX', STALE_TTL_SECONDS);
  } catch (err) {
    console.error('[read-cache] set failed', err);
  }
}

/** Delete every cache entry for a given org. Called after any catalog write. */
export async function invalidateReadCache(orgId: string): Promise<void> {
  const redis = getRedis();
  const pattern = `read:${orgId}:*`;
  let cursor = '0';
  do {
    // SCAN is non-blocking — preferable to KEYS on large databases.
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}
