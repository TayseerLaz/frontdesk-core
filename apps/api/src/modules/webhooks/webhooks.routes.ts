import {
  ApiErrorCode,
  assertSafeOutboundUrl,
  createWebhookEndpointBodySchema,
  createWebhookResponseSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  updateWebhookEndpointBodySchema,
  UrlGuardError,
  uuidSchema,
  webhookDeliverySchema,
  webhookEndpointSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { generateOpaqueToken } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getWebhookQueue } from '../../lib/queues.js';

function assertWebhookUrlOrThrow(url: string): void {
  try {
    assertSafeOutboundUrl(url);
  } catch (err) {
    throw badRequest(
      ApiErrorCode.VALIDATION_ERROR,
      err instanceof UrlGuardError ? err.message : 'Refusing that webhook URL.',
    );
  }
}

export default async function webhookEndpointRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /webhook-endpoints --------------------------------------
  r.get(
    '/webhook-endpoints',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'List outbound webhook endpoints.',
        response: { 200: listEnvelopeSchema(webhookEndpointSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.webhookEndpoint.findMany({ orderBy: { createdAt: 'desc' } });
        return {
          data: rows.map((e) => ({
            id: e.id,
            url: e.url,
            description: e.description,
            eventKinds: e.eventKinds,
            isActive: e.isActive,
            consecutiveFailures: e.consecutiveFailures,
            lastDeliveryAt: e.lastDeliveryAt?.toISOString() ?? null,
            createdAt: e.createdAt.toISOString(),
            updatedAt: e.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /webhook-endpoints -------------------------------------
  // Returns the signing secret ONCE. After this it is never disclosed again.
  r.post(
    '/webhook-endpoints',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Create a webhook endpoint. Signing secret is returned only once.',
        body: createWebhookEndpointBodySchema,
        response: { 201: itemEnvelopeSchema(createWebhookResponseSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      assertWebhookUrlOrThrow(req.body.url);
      const signingSecret = `whsec_${generateOpaqueToken(24)}`;
      return app.tenant(req, async (tx) => {
        const created = await tx.webhookEndpoint.create({
          data: {
            organizationId: orgId,
            url: req.body.url,
            description: req.body.description ?? null,
            eventKinds: req.body.eventKinds ?? [],
            signingSecret,
            createdById: req.auth!.userId,
          },
        });
        await recordAudit({
          action: 'webhook_endpoint_created',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'webhook_endpoint',
          entityId: created.id,
          metadata: { url: created.url },
        });
        reply.code(201);
        return {
          data: {
            id: created.id,
            url: created.url,
            description: created.description,
            eventKinds: created.eventKinds,
            isActive: created.isActive,
            consecutiveFailures: created.consecutiveFailures,
            lastDeliveryAt: null,
            createdAt: created.createdAt.toISOString(),
            updatedAt: created.updatedAt.toISOString(),
            signingSecret,
          },
        };
      });
    },
  );

  // ---------- PATCH /webhook-endpoints/:id --------------------------------
  r.patch(
    '/webhook-endpoints/:id',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Update a webhook endpoint.',
        params: z.object({ id: uuidSchema }),
        body: updateWebhookEndpointBodySchema,
        response: { 200: itemEnvelopeSchema(webhookEndpointSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      if (req.body.url !== undefined && req.body.url !== null) {
        assertWebhookUrlOrThrow(req.body.url);
      }
      return app.tenant(req, async (tx) => {
        const existing = await tx.webhookEndpoint.findUnique({ where: { id: req.params.id } });
        if (!existing) throw notFound('Webhook endpoint not found.');
        const updated = await tx.webhookEndpoint.update({
          where: { id: existing.id },
          data: {
            url: req.body.url ?? undefined,
            description: req.body.description === undefined ? undefined : req.body.description,
            eventKinds: req.body.eventKinds ?? undefined,
            isActive: req.body.isActive ?? undefined,
            // Reset failure counter when an admin re-enables a disabled endpoint.
            ...(req.body.isActive === true && existing.consecutiveFailures > 0
              ? { consecutiveFailures: 0 }
              : {}),
          },
        });
        return {
          data: {
            id: updated.id,
            url: updated.url,
            description: updated.description,
            eventKinds: updated.eventKinds,
            isActive: updated.isActive,
            consecutiveFailures: updated.consecutiveFailures,
            lastDeliveryAt: updated.lastDeliveryAt?.toISOString() ?? null,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          },
        };
      });
    },
  );

  // ---------- DELETE /webhook-endpoints/:id -------------------------------
  r.delete(
    '/webhook-endpoints/:id',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Delete a webhook endpoint.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.webhookEndpoint.deleteMany({ where: { id: req.params.id } });
        await recordAudit({
          action: 'webhook_endpoint_deleted',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'webhook_endpoint',
          entityId: req.params.id,
        });
        return { ok: true as const };
      }),
  );

  // ---------- GET /webhook-endpoints/:id/deliveries -----------------------
  r.get(
    '/webhook-endpoints/:id/deliveries',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'List recent delivery attempts for an endpoint.',
        params: z.object({ id: uuidSchema }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: listEnvelopeSchema(webhookDeliverySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.webhookDelivery.findMany({
          where: { endpointId: req.params.id },
          orderBy: { createdAt: 'desc' },
          take: req.query.limit,
        });
        return {
          data: rows.map((d) => ({
            id: d.id,
            endpointId: d.endpointId,
            eventKind: d.eventKind,
            status: d.status,
            attempts: d.attempts,
            responseStatus: d.responseStatus,
            responseBody: d.responseBody,
            scheduledFor: d.scheduledFor.toISOString(),
            attemptedAt: d.attemptedAt?.toISOString() ?? null,
            deliveredAt: d.deliveredAt?.toISOString() ?? null,
            errorMessage: d.errorMessage,
            createdAt: d.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /webhook-deliveries/:id/retry --------------------------
  r.post(
    '/webhook-deliveries/:id/retry',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Re-enqueue a failed delivery.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const delivery = await app.tenant(req, async (tx) => {
        const d = await tx.webhookDelivery.findUnique({ where: { id: req.params.id } });
        if (!d) throw notFound('Delivery not found.');
        if (d.status === 'delivered') {
          // Idempotent — already delivered.
          return null;
        }
        await tx.webhookDelivery.update({
          where: { id: d.id },
          data: { status: 'pending', errorMessage: null, attempts: 0 },
        });
        return d;
      });
      if (delivery) {
        await getWebhookQueue().add(
          'deliver',
          { organizationId: orgId, deliveryId: delivery.id },
          { jobId: `${delivery.id}:retry:${Date.now()}` },
        );
      }
      return { ok: true as const };
    },
  );
}
