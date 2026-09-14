// CALL-E webhook receiver — PUBLIC (no JWT).
//
// CALL-E posts one terminal event per call (call.completed / call.failed /
// call.result_validation_failed). Deliveries are UNSIGNED by design, so the
// receiver-side checks are:
//   1. the per-deployment token in the URL must match CALLE_WEBHOOK_TOKEN;
//   2. the CALL-E-Event-Id header must equal the body `id`;
//   3. the call id must belong to a phone task of the :orgId in the URL;
//   4. the event id is remembered in Redis for 7 days → duplicates are 200 no-ops.
// We never trust the webhook body for the result itself: we re-read the call
// from CALL-E (GET /v1/calls/{id}) and hand the normalised object to
// applyResult, whose compare-and-set also defends against the poll racing us.
// Returns 2xx fast; work is awaited because it is small (one GET + a few
// writes) and CALL-E only retries on non-2xx.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { getCalleCall } from '../../lib/calle.js';
import { prisma } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { applyResult } from '../../lib/phone-tasks.js';
import { getRedis } from '../../lib/redis.js';

const bodySchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    created_at: z.string().optional(),
    data: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export default async function calleWebhookRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/calle/webhook/:orgId',
    {
      schema: {
        tags: ['phone-tasks'],
        summary: 'CALL-E terminal call event receiver (token in URL, unsigned).',
        params: z.object({ orgId: z.string().uuid() }),
        querystring: z.object({ token: z.string().min(1) }),
        body: bodySchema,
      },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      if (!env.CALLE_WEBHOOK_TOKEN || req.query.token !== env.CALLE_WEBHOOK_TOKEN) {
        return reply.code(401).send({ ok: false });
      }
      const headerId = req.headers['call-e-event-id'];
      if (headerId && String(headerId) !== req.body.id) {
        return reply.code(400).send({ ok: false, reason: 'event id mismatch' });
      }

      // Dedup on event id (best effort — Redis down just means applyResult's
      // compare-and-set does the work).
      try {
        const redis = getRedis();
        const fresh = await redis.set(`calle:evt:${req.body.id}`, '1', 'EX', 7 * 24 * 3600, 'NX');
        if (fresh === null) return reply.code(200).send({ ok: true, duplicate: true });
      } catch (err) {
        req.log.warn({ err }, 'calle webhook dedup skipped');
      }

      const task = await prisma.phoneTask.findFirst({
        where: { organizationId: req.params.orgId, calleCallId: req.body.data.id },
      });
      if (!task) return reply.code(200).send({ ok: true, ignored: true });

      try {
        const call = task.dryRun ? null : await getCalleCall(task.calleCallId!);
        if (call) await applyResult(task, call);
      } catch (err) {
        req.log.error({ err, phoneTaskId: task.id }, 'calle webhook apply failed');
        // 500 → CALL-E retries; the tick will also pick it up.
        return reply.code(500).send({ ok: false });
      }
      return reply.code(200).send({ ok: true });
    },
  );
}
