// Worker-side webhook emitter. Mirrors apps/api/src/lib/webhooks.ts so the
// broadcast workers can fan out events without round-tripping through the API.
// Inserts WebhookDelivery rows + enqueues the existing webhook-delivery worker.
import { Queue } from 'bullmq';
import type { WebhookEventKind } from '@prisma/client';

import { prisma } from '../jobs/db.js';
import { getConnection } from './redis.js';

interface DeliveryPayload {
  organizationId: string;
  deliveryId: string;
}

let webhookQueue: Queue<DeliveryPayload> | null = null;
function queue() {
  if (!webhookQueue) {
    webhookQueue = new Queue<DeliveryPayload>('webhook-delivery', {
      connection: getConnection(),
    });
  }
  return webhookQueue;
}

interface EmitArgs {
  organizationId: string;
  eventKind: WebhookEventKind;
  payload: Record<string, unknown>;
}

export async function emitWebhookEvent(args: EmitArgs): Promise<void> {
  try {
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

    const q = queue();
    await Promise.all(
      deliveries.map((d) =>
        q.add(
          'deliver',
          { organizationId: args.organizationId, deliveryId: d.id },
          {
            jobId: d.id,
            attempts: 8,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
            removeOnFail: { age: 30 * 24 * 3600 },
          },
        ),
      ),
    );
  } catch (err) {
    console.error('[worker emit-webhook] failed', err);
  }
}
