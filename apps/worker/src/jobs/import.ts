// Streaming CSV/XLSX import worker.
//
// Why streaming: a 50 MB CSV with 200K rows would otherwise blow the heap.
// Strategy:
//   1. Stream-parse the file from Wasabi (csv-parse for CSV, ExcelJS streaming for XLSX).
//   2. For each row, apply column mapping → coerce to typed payload → Zod validate.
//   3. Upsert into the right table inside a per-tenant txn (RLS enforced).
//   4. Persist a per-row result so the user can download an error CSV later.
//   5. After every N rows, update the parent ImportJob's progress counters.
//
// Cancellation: the worker re-reads ImportJob.status between rows; if the user
// cancelled, we stop and mark as `cancelled` (rows already written stay).
import type { Prisma, PrismaClient } from '@platform/db';
import type { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';

import { parse as csvParse } from 'csv-parse';
import { Worker } from 'bullmq';
import ExcelJS from 'exceljs';
import { z } from 'zod';

import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { getObjectStream, putObject } from '../lib/storage.js';

import { prisma, withRlsBypass, withTenant } from './db.js';
import { upsertOne } from './shared-upsert.js';

async function notifyImportResult(
  organizationId: string,
  importJobId: string,
  status: 'succeeded' | 'partial' | 'failed' | 'cancelled',
  counts: { succeeded: number; failed: number; total: number },
) {
  const titles: Record<typeof status, string> = {
    succeeded: 'Import completed',
    partial: 'Import partially completed',
    failed: 'Import failed',
    cancelled: 'Import cancelled',
  };
  const severity =
    status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : status === 'partial' ? 'warning' : 'info';
  await withRlsBypass((tx) =>
    tx.notification.create({
      data: {
        organizationId,
        kind:
          status === 'succeeded'
            ? 'import_succeeded'
            : status === 'partial'
              ? 'import_partial'
              : status === 'failed'
                ? 'import_failed'
                : 'generic',
        severity,
        title: titles[status],
        body:
          status === 'cancelled'
            ? 'Cancelled by user.'
            : `${counts.succeeded} of ${counts.total} rows succeeded${counts.failed ? `, ${counts.failed} failed` : ''}.`,
        link: `/imports/${importJobId}`,
        entityType: 'import_job',
        entityId: importJobId,
      },
    }),
  ).catch((err) => console.error('[import] notify failed', err));
}

const PROGRESS_FLUSH_EVERY = 25;

// Hard ceiling on how many rows a single import may process. The upload is
// already capped at 50 MB COMPRESSED, but a crafted XLSX (e.g. a sharedStrings
// bomb) can decompress to multiple GB and stream effectively-unbounded rows —
// enough to OOM the worker. When a file exceeds this we abort the job with a
// clear failure instead of grinding the box to death.
const MAX_IMPORT_ROWS = 100_000;
// Bound the columns we read per row too, so a single pathological row with
// millions of cells can't blow the heap or make applyMapping loop forever.
// Real import templates have well under this many columns.
const MAX_CELLS_PER_ROW = 1_000;

interface RowError {
  path: string;
  message: string;
}

// ---------- streaming row sources ------------------------------------------
async function* streamCsvRows(
  source: Readable,
): AsyncGenerator<{ headers: string[]; row: string[]; rowNumber: number }> {
  const parser = source.pipe(
    csvParse({
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }),
  );
  let headers: string[] | null = null;
  let rowNumber = 1;
  for await (const record of parser) {
    const cells = (record as string[]).slice(0, MAX_CELLS_PER_ROW);
    if (!headers) {
      headers = cells;
      rowNumber++;
      continue;
    }
    yield { headers, row: cells, rowNumber };
    rowNumber++;
  }
}

async function* streamXlsxRows(
  source: Readable,
): AsyncGenerator<{ headers: string[]; row: string[]; rowNumber: number }> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    worksheets: 'emit',
  });
  let headers: string[] | null = null;
  for await (const worksheetReader of reader) {
    for await (const row of worksheetReader) {
      // row.values is 1-indexed (index 0 is always null in ExcelJS), so slice
      // from 1; cap the upper bound so a pathological wide row can't blow up.
      const values = (row.values as unknown[])
        .slice(1, MAX_CELLS_PER_ROW + 1)
        .map((v) => (v == null ? '' : String(v)));
      if (!headers) {
        headers = values;
        continue;
      }
      yield { headers, row: values, rowNumber: row.number };
    }
    break; // first worksheet only
  }
}

// Normalize an arbitrary spreadsheet header to a canonical key shape:
//   "SKU"              → "sku"
//   "Price (cents)"    → "price_cents"
//   "Short description" → "short_description"
//   "  Category Slug " → "category_slug"
// Lowercases, collapses any non-alphanumeric run to a single underscore,
// trims leading/trailing underscores. Then we run the result through a
// per-kind alias table so common human-friendly variants
// ("price cents" / "stock" / "available" / "is available") all resolve
// to the camelCase field names the Zod schemas in shared-upsert.ts
// expect.
function normalizeHeader(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Download comma-separated image URLs from a product row and attach them as
// ProductImages. Runs OUTSIDE the row's upsert transaction (network fetches
// must not hold a DB tx). Idempotent: only attaches when the product has no
// images yet, so re-imports don't duplicate. Each image is best-effort — a
// bad URL is skipped, never failing the row. SSRF-guarded (operator-supplied
// URLs still get validated so the worker can't be used as a proxy).
export async function importProductImages(orgId: string, productId: string, urlsRaw: string): Promise<void> {
  const urls = urlsRaw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (urls.length === 0) return;
  const existing = await withTenant(orgId, (tx) =>
    (tx as PrismaClient).productImage.count({ where: { productId } }),
  );
  if (existing > 0) return;

  let order = 0;
  for (const url of urls) {
    try {
      // SSRF-safe: validates the URL + every redirect hop and pins the
      // connection IP (blocked/private/rebinding targets throw UrlGuardError,
      // caught below to skip this image).
      const res = await safeFetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'image/jpeg';
      if (!contentType.startsWith('image/')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > 10 * 1024 * 1024) continue; // 10 MB cap
      const storageKey = `org/${orgId}/products/${productId}/${randomUUID()}`;
      await putObject({ storageKey, body: buf, contentType });
      const checksum = createHash('sha256').update(buf).digest('hex');
      await withTenant(orgId, async (tx) => {
        const t = tx as PrismaClient;
        const asset = await t.asset.create({
          data: {
            organizationId: orgId,
            kind: 'image',
            storageKey,
            contentType,
            byteSize: buf.byteLength,
            checksumSha256: checksum,
          },
        });
        await t.productImage.create({
          data: {
            organizationId: orgId,
            productId,
            assetId: asset.id,
            sortOrder: order,
            isPrimary: order === 0,
          },
        });
      });
      order++;
    } catch {
      // Skip a bad image; never fail the whole product row over a photo.
    }
  }
}

// kind → { normalizedHeader → canonicalSchemaKey }. Only the synonyms
// that don't already snake_case to the right key need listing; e.g.
// "name" maps to "name" implicitly. Update this when a new field is
// added to a shared schema.
const HEADER_ALIASES: Record<string, Record<string, string>> = {
  product: {
    short_description: 'shortDescription',
    long_description: 'description',
    description: 'description',
    price: 'priceMinor',
    price_cents: 'priceMinor',
    price_minor: 'priceMinor',
    available: 'isAvailable',
    is_available: 'isAvailable',
    stock: 'stockQuantity',
    stock_quantity: 'stockQuantity',
    quantity: 'stockQuantity',
    category: 'categorySlug',
    category_slug: 'categorySlug',
    image_urls: 'imageUrls',
    image_url: 'imageUrls',
    images: 'imageUrls',
    image: 'imageUrls',
  },
  service: {
    short_description: 'shortDescription',
    long_description: 'description',
    description: 'description',
    duration: 'durationMinutes',
    duration_minutes: 'durationMinutes',
    base_price: 'basePriceMinor',
    base_price_cents: 'basePriceMinor',
    base_price_minor: 'basePriceMinor',
    price: 'basePriceMinor',
    available: 'isAvailable',
    is_available: 'isAvailable',
    price_unit: 'priceUnit',
    category: 'categorySlug',
    category_slug: 'categorySlug',
  },
  faq: {
    q: 'question',
    a: 'answer',
    tag: 'tags',
  },
  business_info: {
    legal_name: 'legalName',
    business_name: 'legalName',
    name: 'legalName',
    website: 'websiteUrl',
    website_url: 'websiteUrl',
    about: 'about',
    tagline: 'tagline',
    currency: 'currency',
    timezone: 'timezone',
  },
};

function applyMapping(
  headers: string[],
  values: string[],
  mapping: Record<string, string> | null,
  kind: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const aliases = HEADER_ALIASES[kind] ?? {};
  for (let i = 0; i < headers.length; i++) {
    const rawHeader = headers[i] ?? '';
    // Explicit mapping (operator-supplied) wins over normalization so a
    // power user can still wire a weird header to any field name.
    const explicit = mapping?.[rawHeader] ?? mapping?.[rawHeader.trim()];
    let target: string;
    if (explicit) {
      target = explicit;
    } else {
      const normalized = normalizeHeader(rawHeader);
      target = aliases[normalized] ?? normalized;
    }
    if (!target) continue;
    out[target] = values[i] ?? '';
  }
  return out;
}

// ---------- the worker -----------------------------------------------------
export function startImportWorker() {
  const worker = new Worker(
    'import',
    async (job) => {
      const { organizationId, importJobId } = job.data as {
        organizationId: string;
        importJobId: string;
      };

      const importJob = await prisma.importJob.update({
        where: { id: importJobId },
        data: { status: 'validating', startedAt: new Date() },
      });

      // Defence in depth: if the job payload's orgId doesn't match the import
      // job row's orgId (stale/forged queue entry, data corruption), refuse
      // rather than upsert rows into the wrong tenant. Mirrors sync.ts.
      if (importJob.organizationId !== organizationId) {
        await prisma.importJob.update({
          where: { id: importJobId },
          data: {
            status: 'failed',
            errorMessage: 'Import job does not belong to the job organization.',
            finishedAt: new Date(),
          },
        });
        return;
      }

      const asset = importJob.sourceAssetId
        ? await prisma.asset.findUnique({ where: { id: importJob.sourceAssetId } })
        : null;
      if (!asset) throw new Error('Source asset missing for import job ' + importJobId);

      const stream = await getObjectStream(asset.storageKey);
      const isXlsx =
        asset.contentType.includes('spreadsheet') || asset.contentType.includes('officedocument');
      const rows = isXlsx ? streamXlsxRows(stream) : streamCsvRows(stream);

      let processed = 0;
      let succeeded = 0;
      let failed = 0;
      const skipped = 0;

      await prisma.importJob.update({
        where: { id: importJobId },
        data: { status: 'processing' },
      });

      for await (const { headers, row, rowNumber } of rows) {
        // Row ceiling (M-11). Abort before touching row MAX_IMPORT_ROWS+1 so a
        // decompression-bomb XLSX (or any pathologically huge file) can't stream
        // unbounded rows and OOM the worker. Mark the job failed with a clear
        // message rather than silently truncating.
        if (processed >= MAX_IMPORT_ROWS) {
          await prisma.importJob.update({
            where: { id: importJobId },
            data: {
              status: 'failed',
              errorMessage: `Import aborted: file exceeds the maximum of ${MAX_IMPORT_ROWS.toLocaleString(
                'en-US',
              )} rows. Split it into smaller files and try again.`,
              totalRows: processed,
              processedRows: processed,
              succeededRows: succeeded,
              failedRows: failed,
              skippedRows: skipped,
              finishedAt: new Date(),
            },
          });
          await notifyImportResult(organizationId, importJobId, 'failed', {
            succeeded,
            failed,
            total: processed,
          });
          return;
        }
        if (processed > 0 && processed % PROGRESS_FLUSH_EVERY === 0) {
          const fresh = await prisma.importJob.findUnique({
            where: { id: importJobId },
            select: { status: true },
          });
          if (fresh?.status === 'cancelled') {
            await prisma.importJob.update({
              where: { id: importJobId },
              data: {
                processedRows: processed,
                succeededRows: succeeded,
                failedRows: failed,
                skippedRows: skipped,
                finishedAt: new Date(),
              },
            });
            return;
          }
          await prisma.importJob.update({
            where: { id: importJobId },
            data: { processedRows: processed, succeededRows: succeeded, failedRows: failed },
          });
        }

        const raw = applyMapping(
          headers,
          row,
          (importJob.columnMapping as Record<string, string> | null) ?? null,
          importJob.entityKind,
        );
        try {
          const resultId = await withTenant(organizationId, (tx) =>
            upsertOne(tx as PrismaClient, organizationId, importJob.entityKind, raw),
          );
          // Attach product images from the optional Image URLs column (best-
          // effort, outside the upsert tx — see importProductImages).
          const imgUrls = (raw as Record<string, unknown>).imageUrls;
          if (importJob.entityKind === 'product' && typeof imgUrls === 'string' && imgUrls.trim()) {
            await importProductImages(organizationId, resultId, imgUrls).catch(() => {
              /* image attach failure never fails the row */
            });
          }
          succeeded++;
          await prisma.importJobRow.create({
            data: {
              organizationId,
              importJobId,
              rowNumber,
              status: 'succeeded',
              resultEntityId: resultId,
              rawData: raw as Prisma.InputJsonValue,
            },
          });
        } catch (err) {
          failed++;
          const errors: RowError[] =
            err instanceof z.ZodError
              ? err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
              : [{ path: '', message: err instanceof Error ? err.message : String(err) }];
          await prisma.importJobRow.create({
            data: {
              organizationId,
              importJobId,
              rowNumber,
              status: 'failed',
              rawData: raw as Prisma.InputJsonValue,
              errors: errors as unknown as Prisma.InputJsonValue,
            },
          });
        }
        processed++;
      }

      const finalStatus = failed === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial';
      await prisma.importJob.update({
        where: { id: importJobId },
        data: {
          status: finalStatus,
          totalRows: processed,
          processedRows: processed,
          succeededRows: succeeded,
          failedRows: failed,
          finishedAt: new Date(),
        },
      });
      await notifyImportResult(organizationId, importJobId, finalStatus, {
        succeeded,
        failed,
        total: processed,
      });
    },
    {
      connection: getConnection(),
      concurrency: env.IMPORT_CONCURRENCY,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    try {
      await prisma.importJob.update({
        where: { id: job.data.importJobId },
        data: { status: 'failed', errorMessage: err.message, finishedAt: new Date() },
      });
    } catch {
      // ignore
    }
  });

  return worker;
}
