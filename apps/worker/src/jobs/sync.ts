// API connector sync worker.
//
// Reads an external REST endpoint (with the configured auth), expects a JSON
// array (or { data: [...] }) of records, applies the column mapping, and
// upserts each record using the same per-entity validators as the import worker.
//
// Designed to be idempotent: SKU-based upserts for products, slug-based for
// services, name-based for FAQs (after dedupe), upsert-singleton for business_info.
//
// Schedule comes from ApiConnector.scheduleCron — for v1 we resolve "every X
// minutes" simple specs in the API's repeatable-job registration; arbitrary cron
// is handled by BullMQ's repeat option set when the connector is created.
import type { ApiConnector, ImportEntityKind, PrismaClient, SyncRun } from '@platform/db';
import { decryptJsonSecret } from '@platform/db';
import {
  applyMappingV2,
  assertSafeOutboundUrl,
  extractRecords,
  isMappingV2,
  UrlGuardError,
} from '@platform/shared';
import { ssrfSafeLookup } from '@platform/shared/ssrf';

import { Worker } from 'bullmq';
import { Agent, request as undiciRequest } from 'undici';

// DNS-resolving + IP-pinning dispatcher: refuses to connect to private/
// loopback IPs even when a public hostname resolves to one (F-05 rebinding).
let ssrfDispatcher: Agent | null = null;
function getSsrfDispatcher(): Agent {
  if (!ssrfDispatcher) ssrfDispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });
  return ssrfDispatcher;
}
import { z } from 'zod';

import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';

import { prisma, withRlsBypass, withTenant } from './db.js';

interface SyncJobData {
  organizationId: string;
  connectorId: string;
  /**
   * Pre-allocated SyncRun id for manual/webhook triggers. NULL for scheduled
   * (BullMQ repeatable) triggers — the worker creates the row itself.
   * Legacy queue entries may carry the string '__pending__' sentinel.
   */
  syncRunId: string | null;
  trigger: 'scheduled' | 'manual' | 'webhook';
}

// Re-use the entity schemas used by the import worker.
import {
  productSchema,
  serviceSchema,
  faqSchema,
  businessInfoSchema,
  upsertOne,
} from './shared-upsert.js';

function buildHeaders(connector: ApiConnector): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const cfg = decryptJsonSecret<Record<string, string>>(connector.authConfig) ?? {};
  switch (connector.authKind) {
    case 'bearer':
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      break;
    case 'api_key':
      if (cfg.headerName && cfg.value) headers[cfg.headerName] = cfg.value;
      break;
    case 'basic':
      if (cfg.username && cfg.password) {
        const b64 = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
        headers.Authorization = `Basic ${b64}`;
      }
      break;
    default:
      break;
  }
  return headers;
}

// Emit an org-wide bell notification when a scheduled/manual sync finishes
// in a non-success state. Mirrors the pattern used by the import worker so
// operators can catch failing connectors without polling the connectors
// page. Failures are silenced in the catch so a notification hiccup never
// masks the underlying sync-run error.
async function notifySyncResult(args: {
  organizationId: string;
  connectorId: string;
  connectorName: string;
  status: 'succeeded' | 'partial' | 'failed';
  counts: { fetched: number; upserted: number; failed: number };
  errorMessage?: string | null;
}): Promise<void> {
  if (args.status === 'succeeded') return; // only notify on noise
  const severity = args.status === 'failed' ? 'error' : 'warning';
  const title =
    args.status === 'failed' ? 'Connector sync failed' : 'Connector sync finished with errors';
  const body =
    args.status === 'failed'
      ? `${args.connectorName}: ${args.errorMessage ?? 'sync failed'}`
      : `${args.connectorName}: ${args.counts.upserted} of ${args.counts.fetched} records upserted, ${args.counts.failed} failed.`;
  await withRlsBypass((tx) =>
    tx.notification.create({
      data: {
        organizationId: args.organizationId,
        kind: args.status === 'failed' ? 'sync_failed' : 'generic',
        severity,
        title,
        body,
        link: `/connectors`,
        entityType: 'api_connector',
        entityId: args.connectorId,
      },
    }),
  ).catch((err) => console.error('[sync] notify failed', err));
}

function applyMapping(record: Record<string, unknown>, mapping: Record<string, string> | null): Record<string, unknown> {
  if (!mapping || Object.keys(mapping).length === 0) return record;
  const out: Record<string, unknown> = {};
  for (const [source, value] of Object.entries(record)) {
    const target = mapping[source] ?? source;
    out[target] = value;
  }
  return out;
}

function pickEntityValidator(kind: ImportEntityKind) {
  switch (kind) {
    case 'product':
      return productSchema;
    case 'service':
      return serviceSchema;
    case 'faq':
      return faqSchema;
    case 'business_info':
      return businessInfoSchema;
  }
}

export function startSyncWorker() {
  const worker = new Worker<SyncJobData>(
    'sync',
    async (job) => {
      const { organizationId, connectorId, trigger } = job.data;
      let { syncRunId } = job.data;

      // Phase 5.7 — accept either null (preferred for scheduled triggers) or
      // the legacy '__pending__' sentinel (for any in-flight queue entries
      // produced before the change).
      if (!syncRunId || syncRunId === '__pending__') {
        const created = await prisma.syncRun.create({
          data: {
            organizationId,
            connectorId,
            status: 'pending',
            trigger: trigger ?? 'scheduled',
          },
          select: { id: true },
        });
        syncRunId = created.id;
      }

      const connector = await prisma.apiConnector.findUnique({ where: { id: connectorId } });
      if (!connector || connector.status === 'disabled') {
        await prisma.syncRun.update({
          where: { id: syncRunId },
          data: { status: 'failed', errorMessage: 'Connector missing or disabled.', finishedAt: new Date() },
        });
        return;
      }
      // Defence in depth: if the job payload's orgId doesn't match the
      // connector's orgId (stale repeatable job, data corruption), refuse
      // rather than notify/upsert into the wrong tenant.
      if (connector.organizationId !== organizationId) {
        await prisma.syncRun.update({
          where: { id: syncRunId },
          data: {
            status: 'failed',
            errorMessage: 'Connector does not belong to the job organization.',
            finishedAt: new Date(),
          },
        });
        return;
      }
      if (!connector.endpointUrl) {
        await prisma.syncRun.update({
          where: { id: syncRunId },
          data: {
            status: 'failed',
            errorMessage: 'Connector has no endpointUrl (webhook-only).',
            finishedAt: new Date(),
          },
        });
        return;
      }

      await prisma.syncRun.update({
        where: { id: syncRunId },
        data: { status: 'running', startedAt: new Date() },
      });

      let fetched = 0;
      let upserted = 0;
      let failed = 0;
      let errorMessage: string | null = null;
      let records: Record<string, unknown>[] = [];

      try {
        // Defence in depth: connectors created before the URL guard shipped
        // might still have loopback / private-IP endpoints in the DB.
        // Reject at fetch time so the worker can't be used as an SSRF proxy.
        assertSafeOutboundUrl(connector.endpointUrl);
        const res = await undiciRequest(connector.endpointUrl, {
          method: 'GET',
          headers: buildHeaders(connector),
          signal: AbortSignal.timeout(60_000),
          dispatcher: getSsrfDispatcher(),
        });
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new Error(`Upstream returned ${res.statusCode}`);
        }
        const json = (await res.body.json()) as unknown;
        // F10 — a v2 mapping can point at a nested array (arrayPath); with
        // none, extractRecords keeps the old behaviour (root array / .data)
        // plus common wrapper keys (products/items/results/...).
        const rawMapping = connector.columnMapping as unknown;
        records = extractRecords(json, isMappingV2(rawMapping) ? rawMapping.arrayPath : undefined);
        fetched = records.length;
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        await markFailed(connector, syncRunId, errorMessage);
        await notifySyncResult({
          organizationId,
          connectorId: connector.id,
          connectorName: connector.name,
          status: 'failed',
          counts: { fetched, upserted, failed },
          errorMessage,
        });
        throw err;
      }

      const rawMapping2 = connector.columnMapping as unknown;
      const legacyMapping = isMappingV2(rawMapping2)
        ? null
        : ((connector.columnMapping as Record<string, string> | null) ?? null);
      const validator = pickEntityValidator(connector.entityKind);

      for (const raw of records) {
        const mapped = isMappingV2(rawMapping2)
          ? applyMappingV2(raw, rawMapping2)
          : applyMapping(raw, legacyMapping);
        try {
          validator.parse(mapped);
          const resultId = await withTenant(organizationId, (tx) =>
            upsertOne(tx as PrismaClient, organizationId, connector.entityKind, mapped),
          );
          // F10 — attach product images from the mapped imageUrls (best-
          // effort, outside the upsert tx; idempotent — only when the
          // product has no images yet). Same helper the CSV import uses.
          const imgUrls = mapped.imageUrls;
          if (connector.entityKind === 'product' && typeof imgUrls === 'string' && imgUrls.trim()) {
            const { importProductImages } = await import('./import.js');
            await importProductImages(organizationId, resultId, imgUrls).catch(() => {
              /* image attach failure never fails the record */
            });
          }
          upserted++;
        } catch {
          failed++;
        }
      }

      const finalStatus = failed === 0 ? 'succeeded' : upserted === 0 ? 'failed' : 'partial';
      await prisma.$transaction([
        prisma.syncRun.update({
          where: { id: syncRunId },
          data: {
            status: finalStatus,
            recordsFetched: fetched,
            recordsUpserted: upserted,
            recordsFailed: failed,
            finishedAt: new Date(),
          },
        }),
        prisma.apiConnector.update({
          where: { id: connector.id },
          data: {
            lastRunAt: new Date(),
            lastSuccessAt: finalStatus === 'failed' ? connector.lastSuccessAt : new Date(),
            consecutiveFailures: finalStatus === 'failed' ? connector.consecutiveFailures + 1 : 0,
            status:
              finalStatus === 'failed' && connector.consecutiveFailures + 1 >= 5 ? 'failing' : connector.status,
          },
        }),
      ]);

      await notifySyncResult({
        organizationId,
        connectorId: connector.id,
        connectorName: connector.name,
        status: finalStatus,
        counts: { fetched, upserted, failed },
      });
    },
    {
      connection: getConnection(),
      concurrency: env.SYNC_CONCURRENCY,
    },
  );
  return worker;
}

async function markFailed(connector: ApiConnector, syncRunId: string, message: string): Promise<SyncRun> {
  return prisma.$transaction(async (tx) => {
    await tx.apiConnector.update({
      where: { id: connector.id },
      data: {
        lastRunAt: new Date(),
        consecutiveFailures: connector.consecutiveFailures + 1,
        status: connector.consecutiveFailures + 1 >= 5 ? 'failing' : connector.status,
      },
    });
    return tx.syncRun.update({
      where: { id: syncRunId },
      data: { status: 'failed', errorMessage: message, finishedAt: new Date() },
    });
  });
}
