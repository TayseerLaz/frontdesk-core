// Ops one-off: bulk-load or correct a tenant's catalog from a CSV, using the
// SAME validator + upsert the portal's import job uses (`upsertOne`), so a
// command-line load and a portal upload can never diverge.
//
// Usage:
//   pnpm --filter @platform/api exec tsx scripts/import-catalog-csv.ts \
//     --org <orgId> --file <path.csv> [--kind product] [--dry-run]
//
// CSV columns = the portal's product template:
//   sku,name,shortDescription,description,priceMinor,currency,isAvailable,
//   stockQuantity,categorySlug,imageUrls
//
// Upsert key is (organizationId, sku), so re-running is safe and a row whose
// SKU already exists is CORRECTED in place rather than duplicated. Note the
// portal's semantics, which this shares: an empty cell CLEARS that column
// (description especially) — carry existing text forward if you mean to keep
// it. `imageUrls` is accepted for template parity but ignored here; image
// fetching lives in the queue worker.
//
// Embeddings are not generated here. Products land visible to the bot
// immediately (bot-engine includes un-embedded products); run
// scripts/backfill-product-embeddings.ts afterwards so WhatsApp top-K ranking
// sees them too.
import { PrismaClient } from '@platform/db';
import { readFileSync } from 'node:fs';

import { upsertOne } from '../src/lib/import-upsert.js';

const prisma = new PrismaClient();

// RFC 4180: quoted fields may contain commas, newlines and doubled quotes.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0]!.map((h) => h.trim());
  return nonEmpty.slice(1).map((r) =>
    Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])),
  );
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const orgId = arg('org');
  const file = arg('file');
  const kind = (arg('kind') ?? 'product') as 'product';
  const dryRun = process.argv.includes('--dry-run');
  if (!orgId || !file) {
    console.error('Usage: --org <orgId> --file <path.csv> [--kind product] [--dry-run]');
    process.exit(1);
  }

  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  if (!org) {
    console.error(`No organization ${orgId}`);
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(file, 'utf8'));
  console.log(`${org.name}: ${rows.length} row(s) from ${file}${dryRun ? ' [DRY RUN]' : ''}`);

  const existing = new Set(
    (
      await prisma.product.findMany({
        where: { organizationId: orgId },
        select: { sku: true },
      })
    ).map((p) => p.sku),
  );

  let created = 0;
  let updated = 0;
  const failures: { sku: string; error: string }[] = [];

  for (const row of rows) {
    // Empty cell -> undefined, so the zod coercions (`^\d+$`) don't choke on ''
    // and optional columns stay optional. imageUrls is template-only here.
    const raw: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === 'imageUrls') continue;
      raw[k] = v === '' ? undefined : v;
    }
    const isNew = !existing.has(String(raw.sku ?? ''));
    if (dryRun) {
      console.log(`  ${isNew ? 'CREATE' : 'UPDATE'} ${raw.sku} — ${raw.name} @ ${raw.priceMinor ?? '—'}`);
      isNew ? created++ : updated++;
      continue;
    }
    try {
      await upsertOne(prisma, orgId, kind, raw);
      isNew ? created++ : updated++;
    } catch (err) {
      failures.push({ sku: String(raw.sku ?? '?'), error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(`\ncreated: ${created}  updated: ${updated}  failed: ${failures.length}`);
  for (const f of failures) console.error(`  FAIL ${f.sku}: ${f.error}`);
  await prisma.$disconnect();
  if (failures.length > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
