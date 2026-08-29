// Phase 2 Step 3 — embedding helper for top-K catalog injection.
//
// Why OpenAI text-embedding-3-small specifically:
//   • 1,536-dim — small enough to store + ship at 30+ products without
//     overhead, large enough to capture semantic similarity well.
//   • $0.02 / 1M tokens. A typical 30-token query embeds for $0.0000006.
//     Even at 10,000 bot turns/day per tenant the cost is ~$2/year.
//   • Multilingual — handles Arabic, English, French equally well, which
//     matches our Gulf/Levant customer base.
//
// Why we don't use Groq embeddings:
//   • Groq doesn't offer an embedding endpoint (yet — only chat + audio).
//
// Why we don't use pgvector:
//   • Catalogs are small (tens to low hundreds of products per tenant).
//     Cosine similarity on 30×1536 floats in Node takes <1 ms. pgvector
//     + IVF index would be premature optimisation.
import OpenAI from 'openai';
import { createHash } from 'node:crypto';

import { env } from './env.js';

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for catalog embeddings (text-embedding-3-small).');
  }
  if (_client) return _client;
  _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _client;
}

export function isEmbeddingAvailable(): boolean {
  return !!env.OPENAI_API_KEY;
}

/** SHA-256 of the text we embedded — used to skip re-embedding unchanged rows. */
export function embeddingHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Build the canonical "embed text" for a product: name + short
 * description. Stable across calls so the hash works as a dedup key.
 */
export function productEmbedText(p: {
  name: string;
  shortDescription: string | null;
  attributes?: unknown;
}): string {
  const parts = [p.name];
  if (p.shortDescription) parts.push(p.shortDescription);
  return parts.join(' — ').slice(0, 500); // cap to avoid embedding novel-length descriptions
}

/** Embed a single string. Throws on failure; caller decides whether to skip. */
export async function embed(text: string): Promise<number[]> {
  const res = await client().embeddings.create({
    model: MODEL,
    input: text,
    dimensions: DIMENSIONS,
  });
  const vec = res.data[0]?.embedding;
  if (!vec || vec.length !== DIMENSIONS) {
    throw new Error(`Embedding returned unexpected shape: ${vec?.length ?? 0} dims`);
  }
  return vec;
}

/** Batch-embed up to 100 strings in one call (OpenAI's per-request limit). */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await client().embeddings.create({
    model: MODEL,
    input: texts,
    dimensions: DIMENSIONS,
  });
  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Cosine similarity between two equal-length unit-ish vectors. text-
 * embedding-3 returns L2-normalised vectors by default, so this is just
 * a dot product (no need to normalise again).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * Top-K rank a list of items by their precomputed embedding against a
 * query embedding. Items without an embedding are tagged with score=0
 * and pushed to the end — the caller decides whether to include them
 * as filler (we do, to avoid silently hiding products).
 */
export function topKByEmbedding<T extends { embedding: number[] | null | undefined }>(
  items: T[],
  query: number[],
  k: number,
): T[] {
  const scored = items.map((item) => {
    const emb = item.embedding;
    const score =
      Array.isArray(emb) && emb.length === query.length ? cosineSimilarity(emb, query) : -Infinity;
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.item);
}

/**
 * Idempotent embed + persist for a single product. Used by the create
 * and update routes as fire-and-forget after the write commits. Compares
 * the canonical text hash to the row's stored embeddingHash and skips
 * the (paid) OpenAI call when the content is unchanged.
 *
 * Caller MUST not await this on the user-facing request path.
 */
export async function embedProductAndStore(
  prisma: {
    product: {
      findUnique: (q: {
        where: { id: string };
        select: { embeddingHash: true; name: true; shortDescription: true };
      }) => Promise<{ embeddingHash: string | null; name: string; shortDescription: string | null } | null>;
      update: (q: {
        where: { id: string };
        data: { embedding: number[]; embeddingHash: string };
      }) => Promise<unknown>;
    };
  },
  productId: string,
): Promise<{ embedded: boolean; reason?: string }> {
  if (!isEmbeddingAvailable()) return { embedded: false, reason: 'no-key' };
  const row = await prisma.product.findUnique({
    where: { id: productId },
    select: { embeddingHash: true, name: true, shortDescription: true },
  });
  if (!row) return { embedded: false, reason: 'not-found' };
  const text = productEmbedText(row);
  const expected = embeddingHash(text);
  if (row.embeddingHash === expected) return { embedded: false, reason: 'unchanged' };
  const vector = await embed(text);
  await prisma.product.update({
    where: { id: productId },
    data: { embedding: vector, embeddingHash: expected },
  });
  return { embedded: true };
}

/** Canonical embed text for a service: name + short description. */
export function serviceEmbedText(s: { name: string; shortDescription: string | null }): string {
  const parts = [s.name];
  if (s.shortDescription) parts.push(s.shortDescription);
  return parts.join(' — ').slice(0, 500);
}

/** Idempotent embed + persist for one service (mirrors embedProductAndStore). */
export async function embedServiceAndStore(
  prisma: {
    service: {
      findUnique: (q: {
        where: { id: string };
        select: { embeddingHash: true; name: true; shortDescription: true };
      }) => Promise<{ embeddingHash: string | null; name: string; shortDescription: string | null } | null>;
      update: (q: {
        where: { id: string };
        data: { embedding: number[]; embeddingHash: string };
      }) => Promise<unknown>;
    };
  },
  serviceId: string,
): Promise<{ embedded: boolean; reason?: string }> {
  if (!isEmbeddingAvailable()) return { embedded: false, reason: 'no-key' };
  const row = await prisma.service.findUnique({
    where: { id: serviceId },
    select: { embeddingHash: true, name: true, shortDescription: true },
  });
  if (!row) return { embedded: false, reason: 'not-found' };
  const text = serviceEmbedText(row);
  const expected = embeddingHash(text);
  if (row.embeddingHash === expected) return { embedded: false, reason: 'unchanged' };
  const vector = await embed(text);
  await prisma.service.update({
    where: { id: serviceId },
    data: { embedding: vector, embeddingHash: expected },
  });
  return { embedded: true };
}

/** Canonical embed text for an FAQ: question + answer. */
export function faqEmbedText(f: { question: string; answer: string }): string {
  return [f.question, f.answer].filter(Boolean).join(' — ').slice(0, 500);
}

/** Idempotent embed + persist for one FAQ (mirrors embedProductAndStore). */
export async function embedFaqAndStore(
  prisma: {
    fAQ: {
      findUnique: (q: {
        where: { id: string };
        select: { embeddingHash: true; question: true; answer: true };
      }) => Promise<{ embeddingHash: string | null; question: string; answer: string } | null>;
      update: (q: {
        where: { id: string };
        data: { embedding: number[]; embeddingHash: string };
      }) => Promise<unknown>;
    };
  },
  faqId: string,
): Promise<{ embedded: boolean; reason?: string }> {
  if (!isEmbeddingAvailable()) return { embedded: false, reason: 'no-key' };
  const row = await prisma.fAQ.findUnique({
    where: { id: faqId },
    select: { embeddingHash: true, question: true, answer: true },
  });
  if (!row) return { embedded: false, reason: 'not-found' };
  const text = faqEmbedText(row);
  const expected = embeddingHash(text);
  if (row.embeddingHash === expected) return { embedded: false, reason: 'unchanged' };
  const vector = await embed(text);
  await prisma.fAQ.update({
    where: { id: faqId },
    data: { embedding: vector, embeddingHash: expected },
  });
  return { embedded: true };
}
