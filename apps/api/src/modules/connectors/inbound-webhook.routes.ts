// Inbound webhook receiver: POST /api/v1/webhooks/inbound/:connectorId
//
// Public (no portal auth). Verifies HMAC-SHA256 over the raw body using the
// connector's webhookSecret. On success, creates a SyncRun and enqueues a sync
// job that fetches the connector's endpointUrl OR processes the inline body.
//
// Header: X-Signature: sha256=<hex(hmac(secret, timestamp + "." + body))>
//         X-Webhook-Timestamp: <unix-seconds>
import { ApiErrorCode } from '@platform/shared';
import { decryptSecret } from '@platform/db';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { getSyncQueue } from '../../lib/queues.js';
import { getRedis } from '../../lib/redis.js';

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

// Single-use replay guard (L-1). The signature is only accepted inside the skew
// window, so a captured request stays replayable for up to 2× the skew (its
// timestamp can be up to skew in the past AND up to skew in the future). A TTL of
// 2× skew therefore covers the whole window the signature could still be accepted.
const WEBHOOK_NONCE_TTL_SEC = 2 * MAX_TIMESTAMP_SKEW_SECONDS;

/** Returns true the FIRST time this (connector, signature) is seen; false on replay. */
async function claimWebhookNonce(connectorId: string, signature: string): Promise<boolean> {
  const digest = createHash('sha256').update(signature).digest('hex');
  const key = `webhook:nonce:connector-inbound:${connectorId}:${digest}`;
  const res = await getRedis().set(key, '1', 'EX', WEBHOOK_NONCE_TTL_SEC, 'NX');
  return res === 'OK';
}

function verifySignature(secret: string, body: string, timestamp: string, signature: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

export default async function inboundWebhookRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/webhooks/inbound/:connectorId',
    {
      schema: {
        tags: ['connectors'],
        summary: 'Inbound webhook from a connected external system. HMAC required.',
        params: z.object({ connectorId: z.string().uuid() }),
      },
      // No preHandler — this is public (HMAC-verified).
      // No auth, no tenant context — we look the connector up directly.
      //
      // Per-connector rate limit: an attacker rotating source IPs can bypass
      // the global per-IP limit. Keying on connectorId caps the blast radius
      // of HMAC-failed flood attempts to ~30/sec per connector.
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 second',
          keyGenerator: (req) => `inbound-webhook:${(req.params as { connectorId?: string }).connectorId ?? req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const sigHeader = req.headers['x-signature'];
      const tsHeader = req.headers['x-webhook-timestamp'];
      const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      const timestamp = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
      if (!signature || !timestamp) {
        throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Missing X-Signature or X-Webhook-Timestamp.');
      }

      const tsNum = Number(timestamp);
      if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > MAX_TIMESTAMP_SKEW_SECONDS) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Timestamp out of acceptable window.');
      }

      const connector = await withRlsBypass((tx) =>
        tx.apiConnector.findUnique({ where: { id: req.params.connectorId } }),
      );
      if (!connector || !connector.webhookSecret) throw notFound('Connector not found or webhook disabled.');

      // Hash the ORIGINAL bytes Fastify received (captured at req.rawBody by the
      // content-type parser in server.ts), never a Node re-serialization. A
      // JSON.stringify(req.body) round-trip reorders keys and changes escaping,
      // so it both breaks legitimate senders whose serialization differs and
      // weakens the integrity guarantee the HMAC is supposed to provide (F-03).
      // If the raw bytes are absent we can't verify at all — reject rather than
      // re-serialize (L-10). Empty string is a valid body and kept as-is.
      const rawBody = (req as unknown as { rawBody?: string }).rawBody;
      if (rawBody === undefined) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Missing raw request body.');
      }
      // webhookSecret is encrypted at rest (F-01) — decrypt before HMAC compare.
      const webhookSecret = decryptSecret(connector.webhookSecret);
      if (!verifySignature(webhookSecret, rawBody, timestamp, signature)) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Invalid signature.');
      }

      // Single-use replay guard (L-1): even a validly-signed request must not be
      // replayable within the skew window to create duplicate SyncRun rows.
      // Dedupe on (connectorId, signature); first sight wins, replays are rejected.
      if (!(await claimWebhookNonce(connector.id, signature))) {
        throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Replayed webhook request.');
      }

      const run = await withRlsBypass((tx) =>
        tx.syncRun.create({
          data: {
            organizationId: connector.organizationId,
            connectorId: connector.id,
            trigger: 'webhook',
            status: 'pending',
            metadata: { inboundPayloadHash: createHmac('sha256', 'platform').update(rawBody).digest('hex').slice(0, 16) } as never,
          },
        }),
      );

      await getSyncQueue().add(
        'sync',
        {
          organizationId: connector.organizationId,
          connectorId: connector.id,
          syncRunId: run.id,
          trigger: 'webhook',
        },
        { jobId: run.id, attempts: 1 },
      );

      reply.code(202).send({ accepted: true, syncRunId: run.id });
    },
  );
}
