// Two-stage retrieval — hybrid candidate generation + optional cross-encoder rerank.
//
// buildBotResponse holds NO Prisma tx (the slow LLM call must not sit inside a
// transaction), so the sparse retriever runs IN-MEMORY over the already-loaded
// catalog rather than a pg_trgm round-trip. It's the same idea as pg_trgm —
// character-trigram Jaccard similarity — which catches lexical matches the dense
// embedding misses (exact SKUs, rare tokens, and morphological variants like the
// plural "البوكسات" vs the product "بوكس الزوارة"). Dense + sparse are fused with
// Reciprocal Rank Fusion, then an optional Cohere cross-encoder reranks the top
// candidates. Every stage degrades gracefully: no key / error / disabled → the
// input order is preserved, never an empty or broken result.

import { env } from './env.js';

// ---------------------------------------------------------------------------
// Sparse retrieval — character-trigram Jaccard (in-memory pg_trgm equivalent).
// ---------------------------------------------------------------------------

/** Lowercased, whitespace-collapsed character 3-grams of a string. */
export function trigrams(s: string): Set<string> {
  const norm = ` ${(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= norm.length; i++) grams.add(norm.slice(i, i + 3));
  return grams;
}

/** Jaccard similarity of two trigram sets (0..1). */
export function trigramSim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface SparseDoc {
  id: string;
  text: string;
}

/**
 * Rank docs by trigram similarity to the query. Returns ids ordered
 * most-similar first, keeping only those above `minScore`.
 */
export function sparseRank(
  query: string,
  docs: SparseDoc[],
  limit: number,
  minScore = 0.06,
): string[] {
  const q = trigrams(query);
  if (q.size === 0) return [];
  const scored: { id: string; score: number }[] = [];
  for (const d of docs) {
    const score = trigramSim(q, trigrams(d.text));
    if (score >= minScore) scored.push({ id: d.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.id);
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion — combine ranked id lists (scale-free).
// ---------------------------------------------------------------------------

/**
 * Fuse several ranked id-lists into one. `score(id) = Σ 1/(k + rank_in_list)`.
 * k≈60 damps the tail so a strong #1 in one list still ranks well overall.
 * Ids missing from a list simply contribute nothing from it.
 */
export function rrfFuse(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Cross-encoder rerank — Cohere Rerank (flagged; graceful fallback).
// ---------------------------------------------------------------------------

export function isRerankEnabled(): boolean {
  return (
    (env.RERANK_MODE ?? 'off') !== 'off' && Boolean(env.COHERE_API_KEY)
  );
}

interface RerankDoc {
  id: string;
  text: string;
}

/**
 * Rerank candidates with Cohere's multilingual cross-encoder and return the top
 * `topK` ids in the new order. On disabled/no-key/error/timeout, returns the
 * first `topK` input ids unchanged — the reranker can never break retrieval.
 */
export async function rerankCandidates(
  query: string,
  docs: RerankDoc[],
  topK: number,
): Promise<string[]> {
  const fallback = docs.slice(0, topK).map((d) => d.id);
  if (!isRerankEnabled() || docs.length === 0 || !query.trim()) return fallback;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), env.RERANK_TIMEOUT_MS ?? 1500);
    const res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${env.COHERE_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.COHERE_RERANK_MODEL ?? 'rerank-v3.5',
        query,
        documents: docs.map((d) => d.text),
        top_n: Math.min(topK, docs.length),
      }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      console.warn('[retrieval] rerank non-200:', res.status);
      return fallback;
    }
    const json = (await res.json()) as { results?: { index: number }[] };
    const order = json.results?.map((r) => docs[r.index]?.id).filter((x): x is string => Boolean(x));
    return order && order.length > 0 ? order : fallback;
  } catch (err) {
    console.warn('[retrieval] rerank failed:', err instanceof Error ? err.message : String(err));
    return fallback;
  }
}
