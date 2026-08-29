// Public Shopify webhook receiver (no portal auth). Shopify signs every webhook
// with the app's API secret key (the `shpss_…` we collect on connect):
//   X-Shopify-Hmac-Sha256: base64( HMAC-SHA256(rawBody, apiSecret) )
// On a verified product/customer change we enqueue a re-scrape so already-
// imported items auto-update and brand-new items land in the review queue.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { decryptJsonSecret } from '@platform/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { getShopifyQueue } from '../../lib/queues.js';
import { getRedis } from '../../lib/redis.js';

// Shopify webhooks carry no signed timestamp, so replay protection can't lean on
// a skew window. Dedupe on the unique X-Shopify-Webhook-Id (per delivery) for a
// day — long enough to cover Shopify's own retry window — so a captured signed
// webhook can't be replayed to force repeated re-scrapes. (L-1)
const WEBHOOK_NONCE_TTL_SEC = 24 * 60 * 60;

// Returns the raw bytes Fastify received; undefined when they weren't captured.
// We never fall back to JSON.stringify(req.body) — a re-serialization reorders
// keys and would make the HMAC silently mismatch legitimate senders. (L-10)
function rawBodyOf(req: FastifyRequest): string | undefined {
  return (req as unknown as { rawBody?: string }).rawBody;
}

/** Returns true the FIRST time this webhook identity is seen; false on replay. */
async function claimWebhookNonce(scope: string): Promise<boolean> {
  const digest = createHash('sha256').update(scope).digest('hex');
  const key = `webhook:nonce:shopify:${digest}`;
  const res = await getRedis().set(key, '1', 'EX', WEBHOOK_NONCE_TTL_SEC, 'NX');
  return res === 'OK';
}

function verify(apiSecret: string, rawBody: string, header: string): boolean {
  const expected = createHmac('sha256', apiSecret).update(rawBody, 'utf8').digest();
  let received: Buffer;
  try {
    received = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

export default async function shopifyWebhookRoutes(app: FastifyInstance) {
  app.post(
    '/webhooks/shopify/:connectionId',
    {
      schema: {
        tags: ['shopify'],
        summary: 'Shopify webhook (HMAC-verified with the connection API secret).',
        params: z.object({ connectionId: z.string().uuid() }),
      },
      // Public — HMAC-verified, no JWT. Light rate-limit to blunt forged floods.
      config: { rateLimit: { max: 60, timeWindow: '1 second' } },
    },
    async (req, reply) => {
      const { connectionId } = req.params as { connectionId: string };
      const sigHeader = (req.headers['x-shopify-hmac-sha256'] as string | undefined) ?? '';
      const topic = (req.headers['x-shopify-topic'] as string | undefined) ?? 'unknown';
      if (!sigHeader) return reply.code(401).send({ ok: false });

      // No raw bytes → can't verify → reject (never re-serialize the body). (L-10)
      const rawBody = rawBodyOf(req);
      if (rawBody === undefined) return reply.code(401).send({ ok: false });

      // Look up the connection across tenants (public route → bypass RLS).
      const conn = await withRlsBypass((tx) =>
        tx.shopifyConnection.findUnique({
          where: { id: connectionId },
          select: { id: true, organizationId: true, credentials: true },
        }),
      );
      if (!conn) return reply.code(404).send({ ok: false });

      const creds = decryptJsonSecret<{ apiSecret?: string }>(conn.credentials) ?? {};
      if (!creds.apiSecret || !verify(creds.apiSecret, rawBody, sigHeader)) {
        return reply.code(401).send({ ok: false });
      }

      // Single-use replay guard (L-1): a captured signed webhook must not be
      // replayable to force repeated re-scrapes. Key on the unique per-delivery
      // X-Shopify-Webhook-Id; if absent, fall back to hashing the body + shop
      // (the connection scopes the shop). Legitimate Shopify retries reuse the
      // same id, so deduping them is harmless — the scrape is debounced anyway.
      const webhookId = (req.headers['x-shopify-webhook-id'] as string | undefined) ?? '';
      const nonceScope = webhookId
        ? `id:${connectionId}:${webhookId}`
        : `body:${connectionId}:${createHash('sha256').update(rawBody).digest('hex')}`;
      if (!(await claimWebhookNonce(nonceScope))) {
        return reply.code(200).send({ ok: true });
      }

      // Respect the per-tenant feature toggle — silently 200 if disabled so
      // Shopify doesn't keep retrying.
      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({
          where: { id: conn.organizationId },
          select: { disabledFeatures: true },
        }),
      );
      if (org?.disabledFeatures?.includes('shopify')) return reply.code(200).send({ ok: true });

      // Enqueue a re-scrape (debounced by a stable jobId per connection so a
      // burst of webhooks collapses into one run). Already-imported items
      // auto-update on commit; new ones land as pending for review.
      const run = await withRlsBypass((tx) =>
        tx.shopifyScrapeRun.create({
          data: {
            organizationId: conn.organizationId,
            connectionId: conn.id,
            phase: 'scrape',
            trigger: 'webhook',
            status: 'pending',
          },
          select: { id: true },
        }),
      );
      await getShopifyQueue().add(
        'scrape',
        {
          organizationId: conn.organizationId,
          connectionId: conn.id,
          scrapeRunId: run.id,
          phase: 'scrape',
          trigger: 'webhook',
        },
        {
          // Collapse bursts: one queued scrape per connection at a time.
          jobId: `shopify-webhook-${conn.id}`,
          attempts: 1,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      );
      req.log.info({ connectionId, topic }, '[shopify] webhook accepted → scrape enqueued');
      return reply.code(200).send({ ok: true });
    },
  );
}
