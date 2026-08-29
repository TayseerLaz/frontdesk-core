// Shopify integration — connection settings, verify, scrape trigger, and the
// review/approve queue. Gated by the `shopify` org feature (opt-in; enabled
// per-tenant by an super-admin).
//
// Credentials (access token + API secret) are stored AES-256-GCM encrypted as a
// single JSON blob (encryptJsonSecret), mirroring ApiConnector.authConfig. The
// scrape + commit work happens in the worker (QUEUE_SHOPIFY); these routes only
// persist config, enqueue jobs, and serve the staged items for review.
import { decryptJsonSecret, encryptJsonSecret } from '@platform/db';
import {
  ApiErrorCode,
  itemEnvelopeSchema,
  successSchema,
  uuidSchema,
  shopifyConnectionSchema,
  shopifyStagedItemSchema,
  shopifyStagedListQuerySchema,
  shopifyStagedIdsBodySchema,
  shopifyApproveAllBodySchema,
  upsertShopifyConnectionBodySchema,
} from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit, recordCredentialAudit } from '../../lib/audit.js';
import { forbidden, badRequest, notFound } from '../../lib/errors.js';
import { env } from '../../lib/env.js';
import { safeFetch } from '../../lib/safe-fetch.js';
import { getShopifyQueue } from '../../lib/queues.js';

const SHOPIFY_API_VERSION = '2024-10';

interface ShopifyCreds {
  accessToken?: string;
  apiSecret?: string;
}

/** Strip protocol / path / trailing slash → bare "xxx.myshopify.com" (lowercased). */
function normalizeStoreDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\/$/, '');
}

/** The public URL Shopify webhooks POST to for this connection. */
function shopifyWebhookUrl(connectionId: string): string {
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/webhooks/shopify/${connectionId}`;
}

function decryptCreds(credentials: string | null): ShopifyCreds {
  if (!credentials) return {};
  return decryptJsonSecret<ShopifyCreds>(credentials) ?? {};
}

interface ConnectionRow {
  id: string;
  organizationId: string;
  storeDomain: string;
  credentials: string | null;
  status: string;
  shopName: string | null;
  shopCurrency: string | null;
  lastVerifyStatus: string | null;
  autoSyncEnabled: boolean;
  scheduleCron: string | null;
  lastScrapeAt: Date | null;
  lastSuccessAt: Date | null;
  webhookRegisteredAt: Date | null;
  updatedAt: Date;
}

// Auto-sync cadence + the Shopify webhook topics we subscribe to so live edits
// flow in. Webhooks are signed with the connection's API secret (the receiver
// at /webhooks/shopify/:id verifies them).
const SHOPIFY_SYNC_CRON = '0 */6 * * *'; // every 6 hours
const SHOPIFY_WEBHOOK_TOPICS = [
  'products/create',
  'products/update',
  'products/delete',
  'customers/create',
  'customers/update',
];

async function registerAutoSync(organizationId: string, connectionId: string, cron: string) {
  await getShopifyQueue().add(
    'scrape',
    { organizationId, connectionId, scrapeRunId: null, phase: 'scrape' as const, trigger: 'scheduled' as const },
    { repeat: { pattern: cron }, jobId: `shopify-auto-${connectionId}` },
  );
}

async function unregisterAutoSync(connectionId: string, cron: string | null) {
  if (!cron) return;
  try {
    await getShopifyQueue().removeRepeatable('scrape', { pattern: cron }, `shopify-auto-${connectionId}`);
  } catch {
    // repeatable may already be gone
  }
}

/** Best-effort: subscribe our receiver to the product/customer webhook topics. */
async function registerWebhooks(
  storeDomain: string,
  accessToken: string,
  connectionId: string,
): Promise<boolean> {
  const address = shopifyWebhookUrl(connectionId);
  let any = false;
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    try {
      const res = await safeFetch(
        `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok || res.status === 422) any = true; // 422 = already subscribed
    } catch {
      // best-effort — verify still succeeds even if webhook registration fails
    }
  }
  return any;
}

interface RunRow {
  id: string;
  phase: string;
  trigger: string;
  status: string;
  productsFound: number;
  contactsFound: number;
  otherFound: number;
  recordsImported: number;
  recordsFailed: number;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

function serializeRun(r: RunRow) {
  return {
    id: r.id,
    phase: r.phase,
    trigger: r.trigger,
    status: r.status,
    productsFound: r.productsFound,
    contactsFound: r.contactsFound,
    otherFound: r.otherFound,
    recordsImported: r.recordsImported,
    recordsFailed: r.recordsFailed,
    errorMessage: r.errorMessage,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function serializeConnection(
  conn: ConnectionRow | null,
  stagedCounts: Record<string, Record<string, number>>,
  latestRun: RunRow | null,
) {
  const creds = decryptCreds(conn?.credentials ?? null);
  return {
    connected: !!conn,
    storeDomain: conn?.storeDomain ?? null,
    status: conn?.status ?? null,
    shopName: conn?.shopName ?? null,
    shopCurrency: conn?.shopCurrency ?? null,
    hasAccessToken: !!creds.accessToken,
    hasApiSecret: !!creds.apiSecret,
    autoSyncEnabled: conn?.autoSyncEnabled ?? true,
    lastVerifyStatus: conn?.lastVerifyStatus ?? null,
    lastScrapeAt: conn?.lastScrapeAt?.toISOString() ?? null,
    lastSuccessAt: conn?.lastSuccessAt?.toISOString() ?? null,
    webhookRegisteredAt: conn?.webhookRegisteredAt?.toISOString() ?? null,
    updatedAt: conn?.updatedAt?.toISOString() ?? null,
    stagedCounts,
    latestRun: latestRun ? serializeRun(latestRun) : null,
  };
}

export default async function shopifyRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Reject every request when the feature is disabled for this org.
  async function assertEnabled(req: FastifyRequest): Promise<string> {
    const orgId = req.auth!.organizationId;
    const org = await app.tenant(req, (tx) =>
      tx.organization.findUnique({
        where: { id: orgId },
        select: { disabledFeatures: true },
      }),
    );
    if (org?.disabledFeatures?.includes('shopify')) {
      throw forbidden(
        ApiErrorCode.FEATURE_DISABLED,
        'Shopify integration is not enabled for your account.',
      );
    }
    return orgId;
  }

  async function loadConnectionView(req: FastifyRequest, orgId: string) {
    return app.tenant(req, async (tx) => {
      const conn = (await tx.shopifyConnection.findUnique({
        where: { organizationId: orgId },
      })) as ConnectionRow | null;
      const grouped = await tx.shopifyStagedItem.groupBy({
        by: ['section', 'status'],
        where: { organizationId: orgId },
        _count: { _all: true },
      });
      const stagedCounts: Record<string, Record<string, number>> = {};
      for (const g of grouped) {
        (stagedCounts[g.section] ??= {})[g.status] = g._count._all;
      }
      const latestRun = (await tx.shopifyScrapeRun.findFirst({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
      })) as RunRow | null;
      return serializeConnection(conn, stagedCounts, latestRun);
    });
  }

  // ---------- GET /shopify --------------------------------------------------
  r.get(
    '/shopify',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Get the Shopify connection (secrets masked) + staged counts.',
        response: { 200: itemEnvelopeSchema(shopifyConnectionSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = await assertEnabled(req);
      return { data: await loadConnectionView(req, orgId) };
    },
  );

  // ---------- PUT /shopify --------------------------------------------------
  r.put(
    '/shopify',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Upsert the Shopify connection. Credentials are write-only.',
        body: upsertShopifyConnectionBodySchema,
        response: { 200: itemEnvelopeSchema(shopifyConnectionSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = await assertEnabled(req);
      const b = req.body;
      await app.tenant(req, async (tx) => {
        const existing = (await tx.shopifyConnection.findUnique({
          where: { organizationId: orgId },
        })) as ConnectionRow | null;

        // Merge credentials: undefined = keep, '' = clear, value = set.
        const creds = decryptCreds(existing?.credentials ?? null);
        if (b.accessToken !== undefined) {
          if (b.accessToken === '') delete creds.accessToken;
          else creds.accessToken = b.accessToken;
        }
        if (b.apiSecret !== undefined) {
          if (b.apiSecret === '') delete creds.apiSecret;
          else creds.apiSecret = b.apiSecret;
        }
        const credentials = Object.keys(creds).length ? encryptJsonSecret(creds) : null;
        const storeDomain =
          b.storeDomain !== undefined
            ? normalizeStoreDomain(b.storeDomain)
            : existing?.storeDomain;
        if (!storeDomain) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'A store domain is required.');

        const row = await tx.shopifyConnection.upsert({
          where: { organizationId: orgId },
          create: {
            organizationId: orgId,
            storeDomain,
            credentials,
            autoSyncEnabled: b.autoSyncEnabled ?? true,
            createdById: req.auth!.userId,
          },
          update: {
            storeDomain,
            credentials,
            ...(b.autoSyncEnabled !== undefined ? { autoSyncEnabled: b.autoSyncEnabled } : {}),
          },
        });

        await recordAudit({
          action: 'connector_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'shopify_connection',
          entityId: row.id,
          metadata: { event: 'shopify_connection_saved', storeDomain },
        });
        await recordCredentialAudit({
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          integration: 'shopify',
          credentials: {
            storeDomain: b.storeDomain,
            accessToken: b.accessToken,
            apiSecret: b.apiSecret,
          },
          status: 'saved',
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
      });
      return { data: await loadConnectionView(req, orgId) };
    },
  );

  // ---------- POST /shopify/verify -----------------------------------------
  // Validate the stored credentials against the Shopify Admin API (shop.json)
  // and capture the shop name + currency. Does not scrape — see /shopify/scrape.
  r.post(
    '/shopify/verify',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Verify the stored Shopify credentials.',
        response: { 200: itemEnvelopeSchema(shopifyConnectionSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = await assertEnabled(req);
      const conn = (await app.tenant(req, (tx) =>
        tx.shopifyConnection.findUnique({ where: { organizationId: orgId } }),
      )) as ConnectionRow | null;
      if (!conn) throw notFound('Connect a Shopify store first.');
      const creds = decryptCreds(conn.credentials);
      if (!creds.accessToken) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Add the Admin API access token first.');

      let status = 'ok';
      let shopName: string | null = conn.shopName;
      let shopCurrency: string | null = conn.shopCurrency;
      try {
        const res = await safeFetch(
          `https://${conn.storeDomain}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
          {
            method: 'GET',
            headers: { 'X-Shopify-Access-Token': creds.accessToken, Accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.status === 401 || res.status === 403) {
          status = 'unauthorized';
        } else if (!res.ok) {
          status = `http_${res.status}`;
        } else {
          const json = (await res.json()) as { shop?: { name?: string; currency?: string } };
          shopName = json.shop?.name ?? null;
          shopCurrency = json.shop?.currency ?? null;
        }
      } catch {
        status = 'network_error';
      }

      await app.tenant(req, (tx) =>
        tx.shopifyConnection.update({
          where: { id: conn.id },
          data: {
            lastVerifyStatus: status,
            status: status === 'ok' ? 'active' : 'failing',
            shopName,
            shopCurrency,
          },
        }),
      );

      // On success register the live-update webhooks + the auto-sync cron.
      if (status === 'ok') {
        const cron = conn.scheduleCron ?? SHOPIFY_SYNC_CRON;
        const whOk = await registerWebhooks(conn.storeDomain, creds.accessToken, conn.id);
        if (conn.autoSyncEnabled) {
          await unregisterAutoSync(conn.id, conn.scheduleCron);
          await registerAutoSync(orgId, conn.id, cron);
        }
        await app.tenant(req, (tx) =>
          tx.shopifyConnection.update({
            where: { id: conn.id },
            data: {
              scheduleCron: cron,
              ...(whOk ? { webhookRegisteredAt: new Date() } : {}),
            },
          }),
        );
      }

      if (status !== 'ok') {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          status === 'unauthorized'
            ? 'Shopify rejected the access token. Re-check the token + store domain.'
            : `Could not reach Shopify (${status}).`,
        );
      }
      return { data: await loadConnectionView(req, orgId) };
    },
  );

  // ---------- POST /shopify/scrape -----------------------------------------
  // Pull everything from Shopify into the review queue (background job).
  r.post(
    '/shopify/scrape',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Scrape the Shopify store into the review queue.',
        response: { 202: itemEnvelopeSchema(shopifyConnectionSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = await assertEnabled(req);
      const conn = (await app.tenant(req, (tx) =>
        tx.shopifyConnection.findUnique({ where: { organizationId: orgId } }),
      )) as ConnectionRow | null;
      if (!conn) throw notFound('Connect a Shopify store first.');
      if (!decryptCreds(conn.credentials).accessToken) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Add the Admin API access token first.');
      }

      const run = await app.tenant(req, (tx) =>
        tx.shopifyScrapeRun.create({
          data: {
            organizationId: orgId,
            connectionId: conn.id,
            phase: 'scrape',
            trigger: 'manual',
            status: 'pending',
          },
          select: { id: true },
        }),
      );
      await getShopifyQueue().add(
        'scrape',
        {
          organizationId: orgId,
          connectionId: conn.id,
          scrapeRunId: run.id,
          phase: 'scrape',
          trigger: 'manual',
        },
        { jobId: `shopify-scrape-${run.id}`, attempts: 1, removeOnComplete: { count: 200 }, removeOnFail: { count: 200 } },
      );
      await recordAudit({
        action: 'connector_sync_started',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'shopify_connection',
        entityId: conn.id,
        metadata: { event: 'shopify_scrape_started', scrapeRunId: run.id },
      });
      reply.code(202);
      return { data: await loadConnectionView(req, orgId) };
    },
  );

  // ---------- GET /shopify/staged ------------------------------------------
  r.get(
    '/shopify/staged',
    {
      schema: {
        tags: ['shopify'],
        summary: 'List staged items awaiting review (filter by section/status).',
        querystring: shopifyStagedListQuerySchema,
        response: {
          200: z.object({
            data: z.array(shopifyStagedItemSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = await assertEnabled(req);
      const { section, status, cursor, limit } = req.query;
      const take = limit ?? 50;
      const rows = await app.tenant(req, (tx) =>
        tx.shopifyStagedItem.findMany({
          where: {
            organizationId: orgId,
            ...(section ? { section } : {}),
            ...(status ? { status } : {}),
          },
          take: take + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
      const hasMore = rows.length > take;
      const page = hasMore ? rows.slice(0, take) : rows;
      return {
        data: page.map((row) => ({
          id: row.id,
          section: row.section,
          externalId: row.externalId,
          title: row.title,
          status: row.status,
          normalized: row.normalized,
          resultEntityId: row.resultEntityId,
          errorMessage: row.errorMessage,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
      };
    },
  );

  // ---------- POST /shopify/staged/approve | reject ------------------------
  for (const action of ['approve', 'reject'] as const) {
    r.post(
      `/shopify/staged/${action}`,
      {
        schema: {
          tags: ['shopify'],
          summary: `${action === 'approve' ? 'Approve' : 'Reject'} staged items by id.`,
          body: shopifyStagedIdsBodySchema,
          response: { 200: successSchema },
        },
        preHandler: [app.requireRole('editor')],
      },
      async (req) => {
        const orgId = await assertEnabled(req);
        const nextStatus = action === 'approve' ? 'approved' : 'rejected';
        await app.tenant(req, (tx) =>
          tx.shopifyStagedItem.updateMany({
            // Only pending/approved/rejected items can flip; never touch imported.
            where: { organizationId: orgId, id: { in: req.body.ids }, status: { not: 'imported' } },
            data: { status: nextStatus },
          }),
        );
        return { ok: true as const };
      },
    );
  }

  // ---------- POST /shopify/staged/approve-all -----------------------------
  r.post(
    '/shopify/staged/approve-all',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Approve every pending staged item (optionally one section).',
        body: shopifyApproveAllBodySchema,
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = await assertEnabled(req);
      await app.tenant(req, (tx) =>
        tx.shopifyStagedItem.updateMany({
          where: {
            organizationId: orgId,
            status: 'pending',
            ...(req.body.section ? { section: req.body.section } : {}),
          },
          data: { status: 'approved' },
        }),
      );
      return { ok: true as const };
    },
  );

  // ---------- POST /shopify/import -----------------------------------------
  // Commit every approved staged item into the live catalog (background job).
  r.post(
    '/shopify/import',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Import all approved staged items into the catalog.',
        response: { 202: itemEnvelopeSchema(shopifyConnectionSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = await assertEnabled(req);
      const conn = (await app.tenant(req, (tx) =>
        tx.shopifyConnection.findUnique({ where: { organizationId: orgId } }),
      )) as ConnectionRow | null;
      if (!conn) throw notFound('Connect a Shopify store first.');

      const approvedCount = await app.tenant(req, (tx) =>
        tx.shopifyStagedItem.count({ where: { organizationId: orgId, status: 'approved' } }),
      );
      if (approvedCount === 0) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'No approved items to import. Approve some first.');

      const run = await app.tenant(req, (tx) =>
        tx.shopifyScrapeRun.create({
          data: {
            organizationId: orgId,
            connectionId: conn.id,
            phase: 'commit',
            trigger: 'manual',
            status: 'pending',
          },
          select: { id: true },
        }),
      );
      await getShopifyQueue().add(
        'commit',
        {
          organizationId: orgId,
          connectionId: conn.id,
          scrapeRunId: run.id,
          phase: 'commit',
          trigger: 'manual',
        },
        { jobId: `shopify-commit-${run.id}`, attempts: 1, removeOnComplete: { count: 200 }, removeOnFail: { count: 200 } },
      );
      reply.code(202);
      return { data: await loadConnectionView(req, orgId) };
    },
  );

  // ---------- GET /shopify/scrape-runs -------------------------------------
  r.get(
    '/shopify/scrape-runs',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Recent scrape + import runs.',
        response: { 200: z.object({ data: z.array(z.unknown()) }) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = await assertEnabled(req);
      const rows = (await app.tenant(req, (tx) =>
        tx.shopifyScrapeRun.findMany({
          where: { organizationId: orgId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      )) as RunRow[];
      return { data: rows.map(serializeRun) };
    },
  );

  // ---------- DELETE /shopify ----------------------------------------------
  r.delete(
    '/shopify',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Disconnect Shopify (deletes the connection + staged items).',
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = await assertEnabled(req);
      await app.tenant(req, async (tx) => {
        const conn = await tx.shopifyConnection.findUnique({ where: { organizationId: orgId } });
        if (conn) {
          await unregisterAutoSync(conn.id, conn.scheduleCron);
          await tx.shopifyConnection.delete({ where: { id: conn.id } });
          await recordAudit({
            action: 'connector_deleted',
            organizationId: orgId,
            actorUserId: req.auth!.userId,
            entityType: 'shopify_connection',
            entityId: conn.id,
            metadata: { event: 'shopify_disconnected' },
          });
        }
      });
      return { ok: true as const };
    },
  );
}
