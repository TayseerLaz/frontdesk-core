// API connector CRUD + manual sync trigger + webhook URL exposure.
//
// Inbound webhook receiver lives at POST /webhooks/inbound/:connectorId
// (registered separately so it can be unauthenticated + HMAC-verified).
//
// Scheduled jobs are registered as BullMQ "repeatable" jobs whenever a connector
// is created/updated with scheduleCron set. Removing scheduleCron removes the
// repeatable; updating it removes + re-adds.
import {
  ApiErrorCode,
  connectorSchema,
  createConnectorBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  syncRunSchema,
  triggerSyncBodySchema,
  updateConnectorBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { decryptJsonSecret, encryptJsonSecret, encryptSecret } from '@platform/db';

import { recordAudit, recordCredentialAudit } from '../../lib/audit.js';
import { generateOpaqueToken } from '../../lib/crypto.js';
import { env } from '../../lib/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { getSyncQueue } from '../../lib/queues.js';
import { safeFetch } from '../../lib/safe-fetch.js';
import {
  applyMappingV2,
  assertSafeOutboundUrl,
  extractRecords,
  listLeafPaths,
  previewProblems,
  suggestArrayPaths,
  suggestFieldMapping,
  UrlGuardError,
} from '@platform/shared';

function webhookUrlFor(connectorId: string, hasSecret: boolean): string | null {
  if (!hasSecret) return null;
  const base = env.API_PUBLIC_URL.replace(/\/+$/, '');
  return `${base}/api/v1/webhooks/inbound/${connectorId}`;
}

export default async function connectorRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /connectors ---------------------------------------------
  r.get(
    '/connectors',
    {
      schema: {
        tags: ['connectors'],
        summary: 'List API connectors.',
        response: { 200: listEnvelopeSchema(connectorSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.apiConnector.findMany({ orderBy: { createdAt: 'desc' } });
        return {
          data: rows.map((c) => ({
            id: c.id,
            name: c.name,
            entityKind: c.entityKind,
            endpointUrl: c.endpointUrl,
            authKind: c.authKind,
            scheduleCron: c.scheduleCron,
            status: c.status,
            webhookUrl: webhookUrlFor(c.id, !!c.webhookSecret),
            lastRunAt: c.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
            consecutiveFailures: c.consecutiveFailures,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /connectors --------------------------------------------
  r.post(
    '/connectors',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Create an API connector.',
        body: createConnectorBodySchema,
        response: { 201: itemEnvelopeSchema(connectorSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      if (!req.body.endpointUrl && !req.body.enableInboundWebhook) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'A connector needs either an endpointUrl (pull) or enableInboundWebhook (push).',
        );
      }
      // Refuse to save SSRF-prone endpoint URLs at create time — better to
      // reject here than discover the problem on first sync.
      if (req.body.endpointUrl) {
        try {
          assertSafeOutboundUrl(req.body.endpointUrl);
        } catch (err) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            err instanceof UrlGuardError ? err.message : 'Refusing that endpoint URL.',
          );
        }
      }
      const webhookSecret = req.body.enableInboundWebhook
        ? `whsec_in_${generateOpaqueToken(24)}`
        : null;
      return app.tenant(req, async (tx) => {
        const created = await tx.apiConnector.create({
          data: {
            organizationId: orgId,
            name: req.body.name,
            entityKind: req.body.entityKind,
            endpointUrl: req.body.endpointUrl ?? null,
            authKind: req.body.authKind ?? 'none',
            // Encrypted at rest (F-01) — bearer tokens / API keys / basic creds.
            authConfig: encryptJsonSecret(req.body.authConfig) as never,
            scheduleCron: req.body.scheduleCron ?? null,
            columnMapping: req.body.columnMapping as never,
            webhookSecret: encryptSecret(webhookSecret),
            createdById: req.auth!.userId,
          },
        });
        await recordAudit({
          action: 'connector_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'api_connector',
          entityId: created.id,
        });
        // the platform-HQ-only credential trail (encrypted; hidden from the tenant).
        // Covers Shopify + any other API-connector integration.
        await recordCredentialAudit({
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          integration: `connector:${req.body.name}`,
          credentials: {
            name: req.body.name,
            endpointUrl: req.body.endpointUrl,
            authKind: req.body.authKind,
            authConfig: req.body.authConfig as Record<string, unknown> | undefined,
          },
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });

        if (created.scheduleCron) {
          await registerScheduledSync(orgId, created.id, created.scheduleCron);
        }

        reply.code(201);
        return {
          data: {
            id: created.id,
            name: created.name,
            entityKind: created.entityKind,
            endpointUrl: created.endpointUrl,
            authKind: created.authKind,
            scheduleCron: created.scheduleCron,
            status: created.status,
            webhookUrl: webhookUrlFor(created.id, !!created.webhookSecret),
            lastRunAt: null,
            lastSuccessAt: null,
            consecutiveFailures: 0,
            createdAt: created.createdAt.toISOString(),
            updatedAt: created.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- PATCH /connectors/:id ---------------------------------------
  r.patch(
    '/connectors/:id',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Update a connector.',
        params: z.object({ id: uuidSchema }),
        body: updateConnectorBodySchema,
        response: { 200: itemEnvelopeSchema(connectorSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      if (req.body.endpointUrl) {
        try {
          assertSafeOutboundUrl(req.body.endpointUrl);
        } catch (err) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            err instanceof UrlGuardError ? err.message : 'Refusing that endpoint URL.',
          );
        }
      }
      return app.tenant(req, async (tx) => {
        const existing = await tx.apiConnector.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Connector not found.');
        const updated = await tx.apiConnector.update({
          where: { id: existing.id },
          data: {
            name: req.body.name ?? undefined,
            endpointUrl: req.body.endpointUrl === undefined ? undefined : req.body.endpointUrl,
            authKind: req.body.authKind ?? undefined,
            authConfig:
              req.body.authConfig === undefined
                ? undefined
                : (encryptJsonSecret(req.body.authConfig) as never),
            scheduleCron: req.body.scheduleCron === undefined ? undefined : req.body.scheduleCron,
            columnMapping:
              req.body.columnMapping === undefined ? undefined : (req.body.columnMapping as never),
            status: req.body.status ?? undefined,
          },
        });
        await recordAudit({
          action: 'connector_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'api_connector',
          entityId: existing.id,
        });
        // the platform-HQ-only credential trail when creds were changed (encrypted).
        if (req.body.authConfig !== undefined || req.body.endpointUrl !== undefined) {
          await recordCredentialAudit({
            organizationId: orgId,
            actorUserId: req.auth!.userId,
            integration: `connector:${updated.name}`,
            credentials: {
              name: updated.name,
              endpointUrl: req.body.endpointUrl,
              authKind: req.body.authKind,
              authConfig: req.body.authConfig as Record<string, unknown> | undefined,
            },
            ipAddress: req.ip ?? null,
            userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          });
        }

        // Re-register schedule if it changed.
        if (req.body.scheduleCron !== undefined) {
          await unregisterScheduledSync(existing.id, existing.scheduleCron);
          if (updated.scheduleCron) {
            await registerScheduledSync(orgId, updated.id, updated.scheduleCron);
          }
        }

        return {
          data: {
            id: updated.id,
            name: updated.name,
            entityKind: updated.entityKind,
            endpointUrl: updated.endpointUrl,
            authKind: updated.authKind,
            scheduleCron: updated.scheduleCron,
            status: updated.status,
            webhookUrl: webhookUrlFor(updated.id, !!updated.webhookSecret),
            lastRunAt: updated.lastRunAt?.toISOString() ?? null,
            lastSuccessAt: updated.lastSuccessAt?.toISOString() ?? null,
            consecutiveFailures: updated.consecutiveFailures,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- DELETE /connectors/:id --------------------------------------
  r.delete(
    '/connectors/:id',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Delete a connector and its scheduled job.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const existing = await tx.apiConnector.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Connector not found.');
        await unregisterScheduledSync(existing.id, existing.scheduleCron);
        await tx.apiConnector.delete({ where: { id: existing.id } });
        await recordAudit({
          action: 'connector_deleted',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'api_connector',
          entityId: existing.id,
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /connectors/:id/test -----------------------------------
  // End-to-end probe: calls the upstream with real credentials, parses the
  // JSON body, and returns how many records we saw. Matches the shape the
  // sync worker uses (array or `{ data: [...] }`) so "green test → sync
  // will work" is a reliable signal, not just "endpoint responded 200".
  // ---------- POST /connectors/preview (F10 — website wizard) --------------
  // Fetch a sample from a product feed and return everything the wizard
  // needs: candidate array paths, the first record's selectable source paths,
  // a heuristic auto-mapping, and — when a draft mapping is passed — the
  // first 3 normalized products with fixable problems flagged. Read-only:
  // writes nothing, so iterating in the wizard is free.
  r.post(
    '/connectors/preview',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Fetch a sample from a product feed and preview extraction + mapping.',
        body: z.object({
          endpointUrl: z.string().url().optional(),
          authKind: z.enum(['none', 'bearer', 'api_key', 'basic']).default('none'),
          authConfig: z.record(z.string(), z.string()).optional(),
          // Editing an existing connector: reuse its stored (encrypted) creds
          // + URL so the operator never re-types secrets.
          connectorId: uuidSchema.optional(),
          mapping: z
            .object({
              arrayPath: z.string().max(200).optional().nullable(),
              fields: z.record(z.string(), z.string().max(300)).optional(),
              priceUnit: z.enum(['major', 'minor']).optional(),
            })
            .optional(),
        }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              ok: z.boolean(),
              error: z.string().nullable(),
              recordCount: z.number().int().nullable(),
              arrayPaths: z.array(z.string()),
              sourcePaths: z.array(z.string()),
              suggestedFields: z.record(z.string(), z.string()),
              rawSample: z.string().nullable(),
              mappedPreviews: z.array(
                z.object({
                  mapped: z.record(z.string(), z.unknown()),
                  problems: z.array(z.string()),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const fail = (error: string) => ({
        data: {
          ok: false,
          error,
          recordCount: null,
          arrayPaths: [] as string[],
          sourcePaths: [] as string[],
          suggestedFields: {} as Record<string, string>,
          rawSample: null,
          mappedPreviews: [] as { mapped: Record<string, unknown>; problems: string[] }[],
        },
      });

      let endpointUrl = req.body.endpointUrl ?? null;
      let authKind: string = req.body.authKind;
      let cfg: Record<string, string> = req.body.authConfig ?? {};
      if (req.body.connectorId && (!req.body.authConfig || Object.keys(cfg).length === 0)) {
        const stored = await app.tenant(req, (tx) =>
          tx.apiConnector.findUnique({ where: { id: req.body.connectorId! } }),
        );
        if (!stored) throw notFound('Connector not found.');
        endpointUrl = endpointUrl ?? stored.endpointUrl;
        authKind = stored.authKind;
        cfg = decryptJsonSecret<Record<string, string>>(stored.authConfig) ?? {};
      }
      if (!endpointUrl) return fail('No endpoint URL.');
      try {
        assertSafeOutboundUrl(endpointUrl);
      } catch (err) {
        return fail(err instanceof UrlGuardError ? err.message : 'Refusing that endpoint URL.');
      }

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (authKind === 'bearer' && cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      if (authKind === 'api_key' && cfg.headerName && cfg.value) headers[cfg.headerName] = cfg.value;
      if (authKind === 'basic' && cfg.username && cfg.password) {
        headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
      }

      let json: unknown;
      try {
        const res = await safeFetch(endpointUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15000),
        });
        const text = await res.text();
        if (!res.ok) return fail(`Upstream returned ${res.status}: ${text.slice(0, 200)}`);
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          return fail(`Response is not JSON. First bytes: ${text.slice(0, 200)}`);
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Fetch failed.');
      }

      const arrayPath = req.body.mapping?.arrayPath ?? undefined;
      const records = extractRecords(json, arrayPath || undefined);
      const arrayPaths = suggestArrayPaths(json);
      if (records.length === 0) {
        return {
          data: {
            ok: false,
            error:
              arrayPaths.length > 0
                ? 'No records at that path — pick one of the detected paths.'
                : 'Could not find an array of records in the response.',
            recordCount: 0,
            arrayPaths,
            sourcePaths: [],
            suggestedFields: {},
            rawSample: JSON.stringify(json, null, 2).slice(0, 4000),
            mappedPreviews: [],
          },
        };
      }

      const sourcePaths = listLeafPaths(records[0]!);
      const fields = req.body.mapping?.fields;
      const mappedPreviews =
        fields && Object.keys(fields).length > 0
          ? records.slice(0, 3).map((r) => {
              const mapped = applyMappingV2(r, {
                __v: 2,
                arrayPath,
                fields,
                priceUnit: req.body.mapping?.priceUnit ?? 'major',
              });
              return { mapped, problems: previewProblems(mapped) };
            })
          : [];

      return {
        data: {
          ok: true,
          error: null,
          recordCount: records.length,
          arrayPaths,
          sourcePaths,
          suggestedFields: suggestFieldMapping(sourcePaths),
          rawSample: JSON.stringify(records[0], null, 2).slice(0, 4000),
          mappedPreviews,
        },
      };
    },
  );

  r.post(
    '/connectors/:id/test',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Probe the upstream endpoint, parse the response, and return a record count.',
        params: z.object({ id: uuidSchema }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              ok: z.boolean(),
              status: z.number().nullable(),
              error: z.string().nullable(),
              recordCount: z.number().int().nullable(),
              bodySample: z.string().nullable(),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const connector = await app.tenant(req, async (tx) =>
        tx.apiConnector.findUnique({ where: { id: req.params.id } }),
      );
      if (!connector) throw notFound('Connector not found.');
      if (!connector.endpointUrl) {
        return {
          data: {
            ok: false,
            status: null,
            error: 'No endpointUrl configured.',
            recordCount: null,
            bodySample: null,
          },
        };
      }
      // SSRF guard — reject loopback, RFC1918, link-local (AWS IMDS),
      // non-http(s), credential-bearing URLs. See lib/url-guard.ts.
      try {
        assertSafeOutboundUrl(connector.endpointUrl);
      } catch (err) {
        return {
          data: {
            ok: false,
            status: null,
            error: err instanceof UrlGuardError ? err.message : 'Refusing outbound request.',
            recordCount: null,
            bodySample: null,
          },
        };
      }
      const cfg = decryptJsonSecret<Record<string, string>>(connector.authConfig) ?? {};
      const headers: Record<string, string> = { Accept: 'application/json' };
      switch (connector.authKind) {
        case 'bearer':
          if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
          break;
        case 'api_key':
          if (cfg.headerName && cfg.value) headers[cfg.headerName] = cfg.value;
          break;
        case 'basic':
          if (cfg.username && cfg.password) {
            headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
          }
          break;
        default:
          break;
      }
      try {
        const res = await safeFetch(connector.endpointUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const snippet = await safeBodyText(res);
          return {
            data: {
              ok: false,
              status: res.status,
              error: res.statusText || `Upstream returned ${res.status}`,
              recordCount: null,
              bodySample: snippet,
            },
          };
        }
        // Read body as text first so we can return a preview on parse failure.
        const text = await res.text();
        let recordCount: number | null = null;
        let parseError: string | null = null;
        try {
          const parsed = JSON.parse(text) as unknown;
          recordCount = countRecords(parsed);
        } catch (err) {
          parseError = err instanceof Error ? err.message : 'Invalid JSON';
        }
        return {
          data: {
            ok: parseError == null,
            status: res.status,
            error: parseError,
            recordCount,
            bodySample: text.slice(0, 500) || null,
          },
        };
      } catch (err) {
        return {
          data: {
            ok: false,
            status: null,
            error: err instanceof Error ? err.message : String(err),
            recordCount: null,
            bodySample: null,
          },
        };
      }
    },
  );

  // ---------- POST /connectors/:id/sync -----------------------------------
  r.post(
    '/connectors/:id/sync',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Manually trigger a sync run.',
        params: z.object({ id: uuidSchema }),
        body: triggerSyncBodySchema,
        response: { 202: itemEnvelopeSchema(syncRunSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const run = await app.tenant(req, async (tx) => {
        const connector = await tx.apiConnector.findUnique({ where: { id: req.params.id } });
        if (!connector) throw notFound('Connector not found.');
        if (connector.status === 'disabled') {
          throw conflict('Connector is disabled.');
        }
        // Webhook-only connectors have nothing to pull — a manual sync would just
        // fail against a null endpoint. Data arrives via their inbound webhook URL.
        if (!connector.endpointUrl) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'This is a webhook-only connector — it has no endpoint to pull from. It receives data via its inbound webhook URL.',
          );
        }
        return tx.syncRun.create({
          data: {
            organizationId: orgId,
            connectorId: connector.id,
            trigger: 'manual',
            status: 'pending',
          },
        });
      });
      await getSyncQueue().add(
        'sync',
        { organizationId: orgId, connectorId: req.params.id, syncRunId: run.id, trigger: 'manual' },
        { jobId: run.id, attempts: 1 },
      );
      await recordAudit({
        action: 'connector_sync_started',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'sync_run',
        entityId: run.id,
      });
      reply.code(202);
      return {
        data: {
          id: run.id,
          connectorId: run.connectorId,
          trigger: run.trigger,
          status: run.status,
          startedAt: null,
          finishedAt: null,
          recordsFetched: 0,
          recordsUpserted: 0,
          recordsFailed: 0,
          errorMessage: null,
          createdAt: run.createdAt.toISOString(),
        },
      };
    },
  );

  // ---------- GET /connectors/:id/runs ------------------------------------
  r.get(
    '/connectors/:id/runs',
    {
      schema: {
        tags: ['connectors'],
        summary: 'List recent sync runs for a connector.',
        params: z.object({ id: uuidSchema }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: listEnvelopeSchema(syncRunSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.syncRun.findMany({
          where: { connectorId: req.params.id },
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        });
        return {
          data: rows.map((r) => ({
            id: r.id,
            connectorId: r.connectorId,
            trigger: r.trigger,
            status: r.status,
            startedAt: r.startedAt?.toISOString() ?? null,
            finishedAt: r.finishedAt?.toISOString() ?? null,
            recordsFetched: r.recordsFetched,
            recordsUpserted: r.recordsUpserted,
            recordsFailed: r.recordsFailed,
            errorMessage: r.errorMessage,
            createdAt: r.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );
}

// ---------- BullMQ scheduling helpers ---------------------------------------
async function registerScheduledSync(organizationId: string, connectorId: string, cron: string) {
  await getSyncQueue().add(
    'sync',
    { organizationId, connectorId, syncRunId: null, trigger: 'scheduled' as const },
    {
      // BullMQ repeatable: the cron payload is shared across every fire, so
      // we can't pre-allocate a SyncRun here. The worker sees syncRunId=null
      // and creates a fresh row at job-start time.
      repeat: { pattern: cron },
      jobId: `connector:${connectorId}`,
    },
  );
}

async function unregisterScheduledSync(connectorId: string, cron: string | null) {
  if (!cron) return;
  try {
    await getSyncQueue().removeRepeatable('sync', { pattern: cron }, `connector:${connectorId}`);
  } catch {
    // ignore — repeatable might already be gone
  }
}

// Count records the same way the sync worker does: top-level array or an
// object wrapping an array under `data`. Anything else is "0 records" —
// rather than zero, we return null so the UI can say "couldn't infer a
// count" without implying the upstream is empty.
function countRecords(parsed: unknown): number | null {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    const d = (parsed as { data?: unknown }).data;
    if (Array.isArray(d)) return d.length;
  }
  return null;
}

async function safeBodyText(res: Response): Promise<string | null> {
  try {
    const t = await res.text();
    return t ? t.slice(0, 500) : null;
  } catch {
    return null;
  }
}
