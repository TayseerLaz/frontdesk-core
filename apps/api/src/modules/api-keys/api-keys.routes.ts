import {
  apiKeyScopes,
  apiKeySchema,
  createApiKeyBodySchema,
  createApiKeyResponseSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { generateOpaqueToken, hashToken } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';

// API key format: `ak_live_<24 random chars>`. The "prefix" we display in the UI
// is the first 16 chars (`ak_live_xxxxxxxx`). Full secret returned only on create.

export default async function apiKeyRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /api-keys -----------------------------------------------
  r.get(
    '/api-keys',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'List API keys for the active organization. Secrets are never returned again.',
        response: { 200: listEnvelopeSchema(apiKeySchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.apiKey.findMany({
          where: { revokedAt: null },
          orderBy: { createdAt: 'desc' },
        });
        return {
          data: rows.map((k) => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            scopes: k.scopes as never,
            lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
            expiresAt: k.expiresAt?.toISOString() ?? null,
            createdAt: k.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /api-keys ----------------------------------------------
  r.post(
    '/api-keys',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'Issue a new API key. The secret is returned ONCE.',
        body: createApiKeyBodySchema,
        response: { 201: itemEnvelopeSchema(createApiKeyResponseSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const secret = `ak_live_${generateOpaqueToken(24)}`;
      const prefix = secret.slice(0, 16); // ak_live_ + 8 chars
      const keyHash = hashToken(secret);

      return app.tenant(req, async (tx) => {
        const created = await tx.apiKey.create({
          data: {
            organizationId: orgId,
            name: req.body.name,
            prefix,
            keyHash,
            scopes: req.body.scopes,
            expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
            createdById: req.auth!.userId,
          },
        });
        await recordAudit({
          action: 'api_key_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'api_key',
          entityId: created.id,
          metadata: { name: req.body.name, scopes: req.body.scopes },
        });
        reply.code(201);
        return {
          data: {
            id: created.id,
            name: created.name,
            prefix: created.prefix,
            scopes: created.scopes as never,
            lastUsedAt: null,
            expiresAt: created.expiresAt?.toISOString() ?? null,
            createdAt: created.createdAt.toISOString(),
            secret,
          },
        };
      });
    },
  );

  // ---------- POST /api-keys/:id/revoke -----------------------------------
  r.post(
    '/api-keys/:id/revoke',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'Revoke an API key.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const key = await tx.apiKey.findUnique({ where: { id: req.params.id } });
        if (!key) throw notFound('API key not found.');
        await tx.apiKey.update({
          where: { id: key.id },
          data: { revokedAt: new Date() },
        });
        await recordAudit({
          action: 'api_key_revoked',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'api_key',
          entityId: key.id,
        });
        return { ok: true as const };
      });
    },
  );

  // Helper: list available scopes (for the UI).
  r.get(
    '/api-keys/scopes',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'List available API key scopes.',
        response: { 200: z.object({ scopes: z.array(z.enum(apiKeyScopes)) }) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async () => ({ scopes: [...apiKeyScopes] }),
  );
}
