// Continuous embedding backstop.
//
// Embeddings power the bot's top-K candidate selection for products, services
// and FAQs. They're generated on-write by the catalog API routes, but bulk
// paths (CSV/XLSX import, Shopify sync, direct DB writes) DON'T embed — so a
// tenant who imported their catalog ends up with unembedded rows the bot can't
// rank. This tick runs in the API process every few minutes, finds any
// product/service/FAQ with no embedding (embedding_hash IS NULL) across EVERY
// org, and embeds them in batches — guaranteeing everything is embedded no
// matter how it was added. Idempotent: once embedded, rows are skipped, so
// steady-state ticks are essentially free.

import { prisma } from '@platform/db';

import {
  embedBatch,
  embeddingHash,
  faqEmbedText,
  isEmbeddingAvailable,
  productEmbedText,
  serviceEmbedText,
} from './embedding.js';

const TICK_INTERVAL_MS = Number(process.env.EMBED_TICK_INTERVAL_MS ?? 3 * 60 * 1000); // 3 min
const PER_TICK = Number(process.env.EMBED_TICK_BATCH ?? 250); // max rows embedded per tick
const OPENAI_BATCH = 96; // OpenAI per-request input cap (<100)

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function embedRows(
  rows: { id: string; text: string }[],
  update: (id: string, data: { embedding: number[]; embeddingHash: string }) => Promise<unknown>,
): Promise<number> {
  let done = 0;
  for (let i = 0; i < rows.length; i += OPENAI_BATCH) {
    const slice = rows.slice(i, i + OPENAI_BATCH);
    const vecs = await embedBatch(slice.map((r) => r.text));
    for (let j = 0; j < slice.length; j++) {
      const row = slice[j]!;
      try {
        await update(row.id, { embedding: vecs[j]!, embeddingHash: embeddingHash(row.text) });
        done++;
      } catch (err) {
        // One bad row (deleted between select and update, or a guarded write)
        // must not abort the tick — that starves every stage after it. Leave
        // the row NULL and move on; the next tick retries it.
        console.error(
          `[embed-tick] row ${row.id} update failed:`,
          err instanceof Error ? err.message.trim().split('\n').pop() : err,
        );
      }
    }
  }
  return done;
}

async function tick(): Promise<void> {
  if (!isEmbeddingAvailable()) return;
  let budget = PER_TICK;

  // Products
  if (budget > 0) {
    const ps = await prisma.product.findMany({
      where: { embeddingHash: null, deletedAt: null },
      select: { id: true, name: true, shortDescription: true },
      take: budget,
    });
    if (ps.length) {
      const n = await embedRows(
        ps.map((p) => ({ id: p.id, text: productEmbedText(p) })),
        (id, data) => prisma.product.update({ where: { id }, data }),
      );
      budget -= n;
      console.log(`[embed-tick] embedded ${n} product(s)`);
    }
  }

  // Services
  if (budget > 0) {
    const ss = await prisma.service.findMany({
      where: { embeddingHash: null, deletedAt: null },
      select: { id: true, name: true, shortDescription: true },
      take: budget,
    });
    if (ss.length) {
      const n = await embedRows(
        ss.map((s) => ({ id: s.id, text: serviceEmbedText(s) })),
        (id, data) => prisma.service.update({ where: { id }, data }),
      );
      budget -= n;
      console.log(`[embed-tick] embedded ${n} service(s)`);
    }
  }

  // FAQs
  if (budget > 0) {
    const fs = await prisma.fAQ.findMany({
      where: { embeddingHash: null },
      select: { id: true, question: true, answer: true },
      take: budget,
    });
    if (fs.length) {
      const n = await embedRows(
        fs.map((f) => ({ id: f.id, text: faqEmbedText(f) })),
        (id, data) => prisma.fAQ.update({ where: { id }, data }),
      );
      console.log(`[embed-tick] embedded ${n} faq(s)`);
    }
  }
}

export function startEmbedBackfillTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[embed-tick] error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // First run 90s after boot so startup isn't competing with embedding calls.
  timer = setTimeout(run, 90 * 1000);
  return {
    name: 'embed-backfill-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
