// Phase 2 Step 3 — backfill embeddings for products that don't have one
// yet, OR whose name/short-description has changed since they were last
// embedded (tracked via embedding_hash).
//
// Usage:
//   pnpm --filter @platform/api exec tsx scripts/backfill-product-embeddings.ts \
//     [--org <orgId>] [--limit 500] [--dry-run]
//
// Cost: text-embedding-3-small is $0.02 / 1M tokens. A typical product
// embeds for ~30-60 tokens. A 1,000-product catalog backfills for ~$0.001.
//
// Safe to re-run: it skips products whose stored hash matches the current
// (name + short description) hash.
import { PrismaClient } from '@platform/db';

import { embedBatch, embeddingHash, isEmbeddingAvailable, productEmbedText } from '../src/lib/embedding.js';

const BATCH_SIZE = 50;
const prisma = new PrismaClient();

async function main() {
  if (!isEmbeddingAvailable()) {
    console.error('OPENAI_API_KEY is not set — required for embeddings. Aborting.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const orgFlag = args.indexOf('--org');
  const orgId = orgFlag >= 0 ? args[orgFlag + 1] : undefined;
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : 500;
  const dryRun = args.includes('--dry-run');

  console.log(
    `\nBackfilling product embeddings${orgId ? ` for org=${orgId}` : ' across all orgs'}, ` +
      `up to ${limit} products${dryRun ? ' (DRY RUN)' : ''}.\n`,
  );

  // Bypass RLS so we can iterate across orgs.
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);

  const products = await prisma.product.findMany({
    where: {
      deletedAt: null,
      ...(orgId ? { organizationId: orgId } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      name: true,
      shortDescription: true,
      embedding: true,
      embeddingHash: true,
    },
    take: limit,
  });

  const pending = products.filter((p) => {
    const expected = embeddingHash(productEmbedText(p));
    return !p.embedding || p.embedding.length === 0 || p.embeddingHash !== expected;
  });

  console.log(`Found ${pending.length} of ${products.length} products needing embeddings.`);
  if (pending.length === 0) {
    console.log('Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  if (dryRun) {
    console.log('Dry run — would embed:');
    for (const p of pending.slice(0, 10)) {
      console.log(`  ${p.id}  ${productEmbedText(p).slice(0, 80)}`);
    }
    if (pending.length > 10) console.log(`  … and ${pending.length - 10} more`);
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const slice = pending.slice(i, i + BATCH_SIZE);
    const texts = slice.map(productEmbedText);
    const start = Date.now();
    const vectors = await embedBatch(texts);
    const elapsed = Date.now() - start;

    await prisma.$transaction(
      slice.map((p, idx) =>
        prisma.product.update({
          where: { id: p.id },
          data: {
            embedding: vectors[idx]!,
            embeddingHash: embeddingHash(texts[idx]!),
          },
        }),
      ),
    );

    done += slice.length;
    console.log(
      `  + ${slice.length} embedded in ${elapsed} ms (${done}/${pending.length} done)`,
    );
  }

  console.log(`\n✓ Backfilled ${done} product embeddings.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('backfill-product-embeddings crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
