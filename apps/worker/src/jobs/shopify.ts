// Shopify scrape + commit worker.
//
// phase 'scrape': pull the whole store from the Shopify Admin API, normalize
//   each record to the platform's upsert shape, and write shopify_staged_items
//   for review. Existing rejected/imported rows keep their status (we only
//   refresh their normalized payload); brand-new rows land as 'pending'.
//   On a scheduled/webhook trigger we ALSO auto-commit already-imported rows so
//   live edits flow through without re-approval.
// phase 'commit': upsert every 'approved' staged row into the live catalog,
//   mark it 'imported', then invalidate the read cache + emit catalog_changed.
import { createHash, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@platform/db';
import { decryptJsonSecret } from '@platform/db';
import { Worker } from 'bullmq';

import { env } from '../lib/env.js';
import { emitWebhookEvent } from '../lib/emit-webhook.js';
import { getConnection } from '../lib/redis.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { putObject } from '../lib/storage.js';
import {
  shopifyClient,
  type ShopifyClientOpts,
  type ShopifyCustomer,
  type ShopifyLocation,
  type ShopifyPage,
  type ShopifyPolicy,
  type ShopifyProduct,
  type ShopifyShop,
} from '../lib/shopify-client.js';

import { prisma, withRlsBypass, withTenant } from './db.js';
import { upsertOne } from './shared-upsert.js';

interface ShopifyJobData {
  organizationId: string;
  connectionId: string;
  scrapeRunId: string | null;
  phase: 'scrape' | 'commit';
  trigger: 'scheduled' | 'manual' | 'webhook';
}

type Section = 'product' | 'contact' | 'business_info' | 'policy' | 'faq' | 'location';

interface NormalizedItem {
  section: Section;
  externalId: string;
  title: string;
  normalized: Record<string, unknown>;
  raw: unknown;
}

// ----- helpers --------------------------------------------------------------

function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|li|br|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function priceToMinor(price: string | null | undefined): number | null {
  if (price == null || price === '') return null;
  const n = Number.parseFloat(price);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Best-effort E.164: keep a leading +, strip the rest of the non-digits. */
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.trim().replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Delete every read-cache entry for an org so the chatbot sees fresh data. */
async function invalidateReadCache(orgId: string): Promise<void> {
  try {
    const redis = getConnection();
    const pattern = `read:${orgId}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    console.error('[shopify] read-cache invalidate failed', err);
  }
}

// ----- normalization --------------------------------------------------------

function normProduct(p: ShopifyProduct, shopCurrency: string): NormalizedItem | null {
  const id = p.id != null ? String(p.id) : (p.handle ?? '');
  if (!id) return null;
  const sku = p.handle || `shopify-${id}`;
  // Map variant option1/2/3 onto the product's option names → a labeled object
  // ({ Size: 'M', Color: 'Red' }), the shape the catalog + detail API expect.
  const optionNames = (p.options ?? [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((o) => o.name);
  const variants = (p.variants ?? []).map((v, i) => {
    const vals = [v.option1, v.option2, v.option3];
    const options: Record<string, string> = {};
    vals.forEach((val, idx) => {
      if (val) options[optionNames[idx] || `Option ${idx + 1}`] = val;
    });
    return {
      name: v.title || 'Default',
      sku: v.sku || null,
      priceMinor: priceToMinor(v.price),
      // Shopify oversold inventory goes negative; the API stock is nonnegative.
      stockQuantity:
        typeof v.inventory_quantity === 'number' && v.inventory_quantity >= 0
          ? v.inventory_quantity
          : null,
      options,
      sortOrder: i,
    };
  });
  const firstVariant = p.variants?.[0];
  const stockTotal = (p.variants ?? []).reduce(
    (s, v) => s + (typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0),
    0,
  );
  return {
    section: 'product',
    externalId: id,
    title: p.title || sku,
    normalized: {
      core: {
        sku,
        name: p.title || sku,
        description: stripHtml(p.body_html),
        priceMinor: priceToMinor(firstVariant?.price),
        currency: shopCurrency,
        isAvailable: (p.status ?? 'active') === 'active',
        // Shopify lets oversold inventory go negative; our schema is nonnegative.
        // Only record a positive count, else leave it unknown (null).
        stockQuantity: stockTotal > 0 ? stockTotal : null,
        categorySlug: p.product_type || null,
      },
      images: (p.images ?? []).map((im) => im.src).filter((s): s is string => !!s).slice(0, 6),
      variants,
    },
    raw: p,
  };
}

function normCustomer(c: ShopifyCustomer): NormalizedItem | null {
  const phone = toE164(c.phone ?? c.default_address?.phone ?? null);
  if (!phone) return null; // contacts need a phone to be useful for messaging
  const id = c.id != null ? String(c.id) : phone;
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null;
  const optedIn =
    c.email_marketing_consent?.state === 'subscribed' ||
    c.sms_marketing_consent?.state === 'subscribed';
  return {
    section: 'contact',
    externalId: id,
    title: name ?? phone,
    normalized: {
      phoneE164: phone,
      displayName: name,
      optedIn,
      email: c.email ?? null,
      tags: c.tags
        ? c.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
    },
    raw: c,
  };
}

function normShop(shop: ShopifyShop): NormalizedItem {
  const channels: { kind: string; value: string }[] = [];
  if (shop.email) channels.push({ kind: 'email', value: shop.email });
  if (shop.phone) channels.push({ kind: 'phone', value: shop.phone });
  return {
    section: 'business_info',
    externalId: 'shop',
    title: shop.name || 'Business info',
    normalized: {
      core: {
        legalName: shop.name ?? null,
        websiteUrl: shop.domain ? `https://${shop.domain}` : null,
        timezone: shop.iana_timezone ?? undefined,
        currency: shop.currency ?? undefined,
      },
      contactChannels: channels,
    },
    raw: shop,
  };
}

const POLICY_KIND: Record<string, string> = {
  refund: 'return',
  privacy: 'privacy',
  terms: 'terms',
  shipping: 'shipping',
  legal: 'terms',
};

function normPolicy(p: ShopifyPolicy): NormalizedItem | null {
  const handle = (p.handle ?? '').toLowerCase();
  const kindKey = Object.keys(POLICY_KIND).find((k) => handle.includes(k));
  const kind = kindKey ? POLICY_KIND[kindKey]! : 'terms';
  const content = stripHtml(p.body);
  if (!content) return null;
  return {
    section: 'policy',
    externalId: handle || kind,
    title: p.title || kind,
    normalized: { kind, title: p.title || kind, content },
    raw: p,
  };
}

function normPage(p: ShopifyPage): NormalizedItem | null {
  const id = p.id != null ? String(p.id) : '';
  const answer = stripHtml(p.body_html);
  if (!id || !p.title || !answer) return null;
  return {
    section: 'faq',
    externalId: id,
    title: p.title,
    normalized: { question: p.title, answer },
    raw: p,
  };
}

function normLocation(l: ShopifyLocation): NormalizedItem | null {
  const id = l.id != null ? String(l.id) : '';
  if (!id || !l.name) return null;
  return {
    section: 'location',
    externalId: id,
    title: l.name,
    normalized: {
      name: l.name,
      addressLine1: l.address1 ?? null,
      city: l.city ?? null,
      region: l.province ?? null,
      postalCode: l.zip ?? null,
      country: l.country ?? null,
      phone: l.phone ?? null,
    },
    raw: l,
  };
}

// ----- product images (mirrors import.ts; idempotent on a product with 0 imgs)

async function importProductImages(orgId: string, productId: string, urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const existing = await withTenant(orgId, (tx) =>
    (tx as PrismaClient).productImage.count({ where: { productId } }),
  );
  if (existing > 0) return;
  let order = 0;
  for (const url of urls.slice(0, 6)) {
    try {
      const res = await safeFetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'image/jpeg';
      if (!contentType.startsWith('image/')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > 10 * 1024 * 1024) continue;
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
      order += 1;
    } catch {
      // never fail a product over a photo
    }
  }
}

// ----- commit a single staged item ------------------------------------------

interface StagedRow {
  id: string;
  section: Section;
  normalized: unknown;
  resultEntityId: string | null;
}

/** Upsert one staged row into the live catalog. Returns the local entity id. */
async function commitOne(orgId: string, item: StagedRow): Promise<string> {
  const n = item.normalized as Record<string, unknown>;
  switch (item.section) {
    case 'product': {
      const core = n.core as Record<string, unknown>;
      const productId = await withTenant(orgId, (tx) =>
        upsertOne(tx as PrismaClient, orgId, 'product', core),
      );
      // Replace-set variants.
      const variants = (n.variants as Record<string, unknown>[] | undefined) ?? [];
      await withTenant(orgId, async (tx) => {
        const t = tx as PrismaClient;
        await t.productVariant.deleteMany({ where: { productId } });
        if (variants.length > 0) {
          const baseSku = (core.sku as string) || productId;
          await t.productVariant.createMany({
            data: variants.map((v, i) => ({
              organizationId: orgId,
              productId,
              name: (v.name as string) || 'Default',
              // sku is required + unique per org — synthesize a stable one when
              // Shopify's variant SKU is blank.
              sku: (v.sku as string | null) || `${baseSku}-v${i + 1}`,
              options: (v.options ?? []) as never,
              priceMinor: (v.priceMinor as number | null) ?? null,
              stockQuantity: (v.stockQuantity as number | null) ?? null,
              isAvailable: true,
              sortOrder: (v.sortOrder as number | undefined) ?? i,
            })),
            skipDuplicates: true,
          });
        }
      });
      await importProductImages(orgId, productId, (n.images as string[] | undefined) ?? []);
      return productId;
    }
    case 'contact': {
      const phoneE164 = n.phoneE164 as string;
      const row = await withTenant(orgId, (tx) =>
        (tx as PrismaClient).contact.upsert({
          where: { organizationId_phoneE164: { organizationId: orgId, phoneE164 } },
          create: {
            organizationId: orgId,
            phoneE164,
            displayName: (n.displayName as string | null) ?? null,
            source: 'import',
            ...(n.optedIn ? { optedInAt: new Date() } : {}),
            attributes: {
              email: n.email ?? null,
              shopifyTags: n.tags ?? [],
            } as never,
          },
          update: {
            displayName: (n.displayName as string | null) ?? undefined,
            deletedAt: null,
          },
        }),
      );
      return row.id;
    }
    case 'business_info': {
      const core = n.core as Record<string, unknown>;
      await withTenant(orgId, (tx) =>
        upsertOne(tx as PrismaClient, orgId, 'business_info', core),
      );
      const channels = (n.contactChannels as { kind: string; value: string }[] | undefined) ?? [];
      await withTenant(orgId, async (tx) => {
        const t = tx as PrismaClient;
        for (const ch of channels) {
          const exists = await t.contactChannel.findFirst({
            where: { organizationId: orgId, kind: ch.kind as never, value: ch.value },
          });
          if (!exists) {
            await t.contactChannel.create({
              data: { organizationId: orgId, kind: ch.kind as never, value: ch.value },
            });
          }
        }
      });
      return 'business_info';
    }
    case 'policy': {
      const kind = n.kind as string;
      const row = await withTenant(orgId, (tx) =>
        (tx as PrismaClient).policy.upsert({
          where: { organizationId_kind: { organizationId: orgId, kind: kind as never } },
          create: {
            organizationId: orgId,
            kind: kind as never,
            title: (n.title as string) || kind,
            content: (n.content as string) || '',
            isPublished: true,
          },
          update: { title: (n.title as string) || kind, content: (n.content as string) || '' },
        }),
      );
      return row.id;
    }
    case 'faq': {
      const row = await withTenant(orgId, async (tx) => {
        const t = tx as PrismaClient;
        if (item.resultEntityId) {
          return t.fAQ.update({
            where: { id: item.resultEntityId },
            data: { question: n.question as string, answer: n.answer as string },
          });
        }
        return t.fAQ.create({
          data: {
            organizationId: orgId,
            question: n.question as string,
            answer: n.answer as string,
            visibility: 'public',
            isPublished: true,
          },
        });
      });
      return row.id;
    }
    case 'location': {
      const row = await withTenant(orgId, async (tx) => {
        const t = tx as PrismaClient;
        const data = {
          name: n.name as string,
          addressLine1: (n.addressLine1 as string | null) ?? null,
          city: (n.city as string | null) ?? null,
          region: (n.region as string | null) ?? null,
          postalCode: (n.postalCode as string | null) ?? null,
          country: (n.country as string | null) ?? null,
          phone: (n.phone as string | null) ?? null,
        };
        if (item.resultEntityId) {
          return t.location.update({ where: { id: item.resultEntityId }, data });
        }
        return t.location.create({ data: { organizationId: orgId, ...data } });
      });
      return row.id;
    }
  }
}

/** Commit a set of staged rows, marking each imported. Returns counts. */
async function commitItems(orgId: string, rows: StagedRow[]): Promise<{ imported: number; failed: number }> {
  let imported = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const entityId = await commitOne(orgId, row);
      await withTenant(orgId, (tx) =>
        (tx as PrismaClient).shopifyStagedItem.update({
          where: { id: row.id },
          data: { status: 'imported', resultEntityId: entityId, importedAt: new Date(), errorMessage: null },
        }),
      );
      imported += 1;
    } catch (err) {
      failed += 1;
      await withTenant(orgId, (tx) =>
        (tx as PrismaClient).shopifyStagedItem.update({
          where: { id: row.id },
          data: { errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err) },
        }),
      ).catch(() => undefined);
    }
  }
  if (imported > 0) {
    await emitWebhookEvent({
      organizationId: orgId,
      eventKind: 'catalog_changed',
      payload: { source: 'shopify', imported },
    });
    await invalidateReadCache(orgId);
  }
  return { imported, failed };
}

// ----- phase handlers -------------------------------------------------------

async function handleScrape(data: ShopifyJobData): Promise<void> {
  const { organizationId: orgId, connectionId, trigger } = data;
  let { scrapeRunId } = data;
  if (!scrapeRunId) {
    const created = await prisma.shopifyScrapeRun.create({
      data: { organizationId: orgId, connectionId, phase: 'scrape', trigger, status: 'pending' },
      select: { id: true },
    });
    scrapeRunId = created.id;
  }

  const conn = await prisma.shopifyConnection.findUnique({ where: { id: connectionId } });
  if (!conn || conn.organizationId !== orgId) {
    await prisma.shopifyScrapeRun.update({
      where: { id: scrapeRunId },
      data: { status: 'failed', errorMessage: 'Connection missing or org mismatch.', finishedAt: new Date() },
    });
    return;
  }
  const creds = decryptJsonSecret<{ accessToken?: string }>(conn.credentials) ?? {};
  if (!creds.accessToken) {
    await prisma.shopifyScrapeRun.update({
      where: { id: scrapeRunId },
      data: { status: 'failed', errorMessage: 'Missing access token.', finishedAt: new Date() },
    });
    return;
  }

  await prisma.shopifyScrapeRun.update({
    where: { id: scrapeRunId },
    data: { status: 'running', startedAt: new Date() },
  });

  const opts: ShopifyClientOpts = { storeDomain: conn.storeDomain, accessToken: creds.accessToken };
  let productsFound = 0;
  let contactsFound = 0;
  let otherFound = 0;
  let newPending = 0;
  let errorMessage: string | null = null;

  try {
    const shop = await shopifyClient.fetchShop(opts);
    const shopCurrency = shop.currency || 'USD';

    // Gather + normalize each dataset (tolerate per-dataset failures).
    const items: NormalizedItem[] = [];
    items.push(normShop(shop));
    const safe = async <T>(fn: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await fn();
      } catch (e) {
        console.error('[shopify] dataset fetch failed', e);
        return [];
      }
    };
    for (const p of await safe(() => shopifyClient.fetchProducts(opts))) {
      const it = normProduct(p, shopCurrency);
      if (it) items.push(it);
    }
    for (const c of await safe(() => shopifyClient.fetchCustomers(opts))) {
      const it = normCustomer(c);
      if (it) items.push(it);
    }
    for (const p of await safe(() => shopifyClient.fetchPolicies(opts))) {
      const it = normPolicy(p);
      if (it) items.push(it);
    }
    for (const pg of await safe(() => shopifyClient.fetchPages(opts))) {
      const it = normPage(pg);
      if (it) items.push(it);
    }
    for (const l of await safe(() => shopifyClient.fetchLocations(opts))) {
      const it = normLocation(l);
      if (it) items.push(it);
    }

    // Stage everything (preserve rejected/imported status on existing rows).
    // Batch into chunks so a large store (thousands of customers) never runs
    // one enormous transaction.
    const CHUNK = 200;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      await withTenant(orgId, async (tx) => {
        const t = tx as PrismaClient;
        for (const it of chunk) {
          const existing = await t.shopifyStagedItem.findUnique({
            where: {
              organizationId_section_externalId: {
                organizationId: orgId,
                section: it.section as never,
                externalId: it.externalId,
              },
            },
            select: { id: true },
          });
          if (existing) {
            await t.shopifyStagedItem.update({
              where: { id: existing.id },
              data: {
                title: it.title,
                normalized: it.normalized as never,
                raw: it.raw as never,
                scrapeRunId,
              },
            });
          } else {
            await t.shopifyStagedItem.create({
              data: {
                organizationId: orgId,
                connectionId,
                scrapeRunId,
                section: it.section as never,
                externalId: it.externalId,
                title: it.title,
                normalized: it.normalized as never,
                raw: it.raw as never,
                status: 'pending',
              },
            });
            newPending += 1;
          }
          if (it.section === 'product') productsFound += 1;
          else if (it.section === 'contact') contactsFound += 1;
          else otherFound += 1;
        }
      });
    }

    // Auto-sync: on scheduled/webhook triggers re-commit already-imported rows
    // so live Shopify edits flow through without manual re-approval.
    if (trigger !== 'manual') {
      const importedRows = (await withTenant(orgId, (tx) =>
        (tx as PrismaClient).shopifyStagedItem.findMany({
          where: { organizationId: orgId, status: 'imported' },
          select: { id: true, section: true, normalized: true, resultEntityId: true },
        }),
      )) as StagedRow[];
      if (importedRows.length > 0) await commitItems(orgId, importedRows);
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const status = errorMessage ? 'failed' : 'succeeded';
  await prisma.shopifyScrapeRun.update({
    where: { id: scrapeRunId },
    data: { status, productsFound, contactsFound, otherFound, errorMessage, finishedAt: new Date() },
  });
  await prisma.shopifyConnection.update({
    where: { id: conn.id },
    data: {
      lastScrapeAt: new Date(),
      ...(errorMessage ? {} : { lastSuccessAt: new Date(), status: 'active' }),
      ...(errorMessage ? { status: 'failing' } : {}),
    },
  });

  if (!errorMessage && newPending > 0) {
    await withRlsBypass((tx) =>
      tx.notification.create({
        data: {
          organizationId: orgId,
          kind: 'shopify_review_ready',
          severity: 'info',
          title: 'Shopify items ready to review',
          body: `${newPending} new item${newPending === 1 ? '' : 's'} pulled from Shopify are waiting for your approval.`,
          link: '/settings/shopify/review',
          entityType: 'shopify_connection',
          entityId: conn.id,
        },
      }),
    ).catch((err) => console.error('[shopify] notify failed', err));
  }
}

async function handleCommit(data: ShopifyJobData): Promise<void> {
  const { organizationId: orgId, connectionId } = data;
  let { scrapeRunId } = data;
  if (!scrapeRunId) {
    const created = await prisma.shopifyScrapeRun.create({
      data: { organizationId: orgId, connectionId, phase: 'commit', trigger: data.trigger, status: 'pending' },
      select: { id: true },
    });
    scrapeRunId = created.id;
  }
  await prisma.shopifyScrapeRun.update({
    where: { id: scrapeRunId },
    data: { status: 'running', startedAt: new Date() },
  });

  const rows = (await withTenant(orgId, (tx) =>
    (tx as PrismaClient).shopifyStagedItem.findMany({
      where: { organizationId: orgId, status: 'approved' },
      select: { id: true, section: true, normalized: true, resultEntityId: true },
    }),
  )) as StagedRow[];

  const { imported, failed } = await commitItems(orgId, rows);

  await prisma.shopifyScrapeRun.update({
    where: { id: scrapeRunId },
    data: {
      status: failed === 0 ? 'succeeded' : imported === 0 ? 'failed' : 'partial',
      recordsImported: imported,
      recordsFailed: failed,
      finishedAt: new Date(),
    },
  });

  await withRlsBypass((tx) =>
    tx.notification.create({
      data: {
        organizationId: orgId,
        kind: 'shopify_import_done',
        severity: failed > 0 ? 'warning' : 'success',
        title: 'Shopify import complete',
        body: `${imported} item${imported === 1 ? '' : 's'} imported${failed > 0 ? `, ${failed} failed` : ''}.`,
        link: '/products',
        entityType: 'shopify_connection',
        entityId: connectionId,
      },
    }),
  ).catch((err) => console.error('[shopify] notify failed', err));
}

export function startShopifyWorker() {
  return new Worker<ShopifyJobData>(
    'shopify',
    async (job) => {
      if (job.data.phase === 'commit') await handleCommit(job.data);
      else await handleScrape(job.data);
    },
    { connection: getConnection(), concurrency: env.SYNC_CONCURRENCY },
  );
}
