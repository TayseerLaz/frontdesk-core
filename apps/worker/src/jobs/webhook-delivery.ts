// Outbound webhook delivery worker.
//
// For each WebhookDelivery row, POST the payload to the endpoint URL with:
//   X-Webhook-Event:    <eventKind>
//   X-Webhook-Delivery: <deliveryId>
//   X-Webhook-Timestamp: <unix-seconds>
//   X-Signature: sha256=<hex(hmac(secret, timestamp + "." + body))>
//
// Considered delivered on 2xx. 4xx (except 408/429) are NOT retried — the caller
// is unlikely to start accepting; 5xx and network errors are retried with the
// queue's exponential backoff. After WEBHOOK_MAX_ATTEMPTS we mark `giving_up`
// and disable the endpoint after a configurable threshold of consecutive failures.
import { createHmac } from 'node:crypto';

import { assertSafeOutboundUrl, UrlGuardError } from '@platform/shared';
import { Worker } from 'bullmq';
import { request as undiciRequest } from 'undici';

import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';
import { getSsrfDispatcher } from '../lib/safe-fetch.js';

import { prisma } from './db.js';

const FAIL_THRESHOLD_TO_DISABLE = 25;
const PERMANENT_FAIL_STATUSES = new Set([400, 401, 403, 404, 410, 422]);
const MAX_WEBHOOK_REDIRECTS = 5;

interface DeliveryJobData {
  organizationId: string;
  deliveryId: string;
}

function sign(secret: string, body: string, timestamp: number): string {
  const data = `${timestamp}.${body}`;
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return `sha256=${sig}`;
}

// SSRF-safe POST to a tenant-registered endpoint URL. Mirrors the worker's
// `safeFetch` (DNS-pinning dispatcher via `getSsrfDispatcher()` +
// `assertSafeOutboundUrl` guard + manual per-hop redirect re-validation), but
// carries a request body — the shared `safeFetch` is GET-shaped and has no
// `body` parameter, and this worker may only edit this file. Closes the
// read-SSRF hole in the raw `undiciRequest(endpoint.url, …)` call: DNS
// rebinding is caught by the pinning dispatcher, and a redirect to a
// private/link-local/metadata IP is caught by re-validating every `Location`
// before we connect to it. Throws `UrlGuardError` on a blocked URL or hop.
async function safePostWithBody(
  rawUrl: string,
  init: { headers: Record<string, string>; body: string; signal?: AbortSignal },
): Promise<{ status: number; bodyText: string }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_WEBHOOK_REDIRECTS; hop++) {
    assertSafeOutboundUrl(current); // throws UrlGuardError on private/literal-IP/bad-scheme
    // undici's `request` does NOT auto-follow redirects, so we see each 3xx and
    // re-validate the Location before connecting.
    const res = await undiciRequest(current, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      dispatcher: getSsrfDispatcher(),
    });
    const status = res.statusCode;
    if (status >= 300 && status < 400) {
      const loc = res.headers['location'];
      const locStr = Array.isArray(loc) ? loc[0] : loc;
      if (locStr) {
        res.body.resume(); // drain so the socket can be reused
        current = new URL(locStr, current).toString();
        continue;
      }
    }
    return { status, bodyText: (await res.body.text()).slice(0, 4000) };
  }
  throw new UrlGuardError('Too many redirects (SSRF-safe webhook delivery).');
}

export function startWebhookDeliveryWorker() {
  const worker = new Worker<DeliveryJobData>(
    'webhook-delivery',
    async (job) => {
      const delivery = await prisma.webhookDelivery.findUnique({
        where: { id: job.data.deliveryId },
        include: { endpoint: true },
      });
      if (!delivery) return; // Manually deleted; nothing to do.
      if (delivery.status === 'delivered') return;

      const endpoint = delivery.endpoint;
      if (!endpoint || !endpoint.isActive) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'giving_up', errorMessage: 'Endpoint inactive or removed.' },
        });
        return;
      }

      const body = JSON.stringify({
        id: delivery.id,
        event: delivery.eventKind,
        organizationId: delivery.organizationId,
        createdAt: delivery.createdAt.toISOString(),
        data: delivery.payload,
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = sign(endpoint.signingSecret, body, timestamp);

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'in_flight', attempts: delivery.attempts + 1, attemptedAt: new Date() },
      });

      let responseStatus: number | null = null;
      let responseBody = '';
      let errorMessage: string | null = null;
      let delivered = false;
      let permanentlyFailed = false;

      try {
        const res = await safePostWithBody(endpoint.url, {
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Platform-Webhooks/1.0',
            'x-webhook-event': delivery.eventKind,
            'x-webhook-delivery': delivery.id,
            'x-webhook-timestamp': String(timestamp),
            'x-signature': signature,
          },
          body,
          signal: AbortSignal.timeout(env.WEBHOOK_DELIVERY_TIMEOUT_MS),
        });
        responseStatus = res.status;
        responseBody = res.bodyText;

        if (responseStatus >= 200 && responseStatus < 300) {
          delivered = true;
        } else if (PERMANENT_FAIL_STATUSES.has(responseStatus)) {
          permanentlyFailed = true;
        }
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      const attempts = delivery.attempts + 1;
      const exhausted = attempts >= env.WEBHOOK_MAX_ATTEMPTS;

      if (delivered) {
        await prisma.$transaction([
          prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: 'delivered',
              responseStatus,
              responseBody,
              deliveredAt: new Date(),
              errorMessage: null,
            },
          }),
          prisma.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: { consecutiveFailures: 0, lastDeliveryAt: new Date() },
          }),
        ]);
        return;
      }

      if (permanentlyFailed) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'giving_up', responseStatus, responseBody, errorMessage },
        });
        await bumpFailureCount(endpoint.id);
        return;
      }

      if (exhausted) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'giving_up', responseStatus, responseBody, errorMessage },
        });
        await bumpFailureCount(endpoint.id);
        return;
      }

      // Stay pending and let BullMQ retry.
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'pending', responseStatus, responseBody, errorMessage },
      });
      throw new Error(errorMessage ?? `HTTP ${responseStatus} from webhook target`);
    },
    {
      connection: getConnection(),
      concurrency: env.WEBHOOK_CONCURRENCY,
    },
  );

  return worker;
}

async function bumpFailureCount(endpointId: string) {
  const ep = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { consecutiveFailures: { increment: 1 }, lastDeliveryAt: new Date() },
  });
  if (ep.consecutiveFailures >= FAIL_THRESHOLD_TO_DISABLE && ep.isActive) {
    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { isActive: false },
    });
  }
}
