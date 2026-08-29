// Outbound webhook emission helper.
//
// Anywhere catalog data changes (product create/update/delete, service ditto,
// business-info upsert, FAQ/policy CRUD), call `emitWebhookEvent()` after the
// transaction commits. We:
//   1. Look up active endpoints subscribed to this kind (or with no filter).
//   2. Insert a WebhookDelivery row per endpoint (queued).
//   3. Enqueue a BullMQ job per delivery — actual HTTP call happens in worker.
//
// Failures here are logged but never thrown — the user's request must succeed
// even if webhook fan-out has a hiccup.
import type { WebhookEventKind } from '@platform/shared';

import { prisma } from './db.js';
import { invalidateReadCache } from './read-cache.js';
import { getWebhookQueue } from './queues.js';

interface EmitArgs {
  organizationId: string;
  eventKind: WebhookEventKind;
  /** Anything JSON-serialisable. Kept small (id + summary). */
  payload: Record<string, unknown>;
}

/**
 * Fan out an event to subscribed webhook endpoints AND invalidate the read-API
 * cache for this org. Both are best-effort.
 */
export async function emitWebhookEvent(args: EmitArgs): Promise<void> {
  // Always invalidate cache on a write, regardless of any subscribers.
  invalidateReadCache(args.organizationId).catch((err) =>
    console.error('[webhooks] cache invalidation failed', err),
  );

  try {
    // Find endpoints subscribed to this kind (empty array = subscribed to all).
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: {
        organizationId: args.organizationId,
        isActive: true,
        OR: [{ eventKinds: { isEmpty: true } }, { eventKinds: { has: args.eventKind } }],
      },
    });
    if (endpoints.length === 0) return;

    const deliveries = await prisma.$transaction(
      endpoints.map((ep) =>
        prisma.webhookDelivery.create({
          data: {
            organizationId: args.organizationId,
            endpointId: ep.id,
            eventKind: args.eventKind,
            payload: args.payload as never,
          },
        }),
      ),
    );

    const queue = getWebhookQueue();
    await Promise.all(
      deliveries.map((d) =>
        queue.add(
          'deliver',
          { organizationId: args.organizationId, deliveryId: d.id },
          {
            jobId: d.id,
            // BullMQ retries with exponential backoff. Worker also handles
            // its own backoff for HTTP-specific errors.
            attempts: 8,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
            removeOnFail: { age: 30 * 24 * 3600 },
          },
        ),
      ),
    );
  } catch (err) {
    console.error('[webhooks] emitWebhookEvent failed', err);
  }
}
