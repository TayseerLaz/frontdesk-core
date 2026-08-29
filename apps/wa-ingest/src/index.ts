import { createHmac, timingSafeEqual } from 'node:crypto';

import Fastify from 'fastify';

import { env } from './env.js';
import * as hader from './hader-client.js';
import { listAuthGrantIds, purgeAuth } from './auth-store.js';
import { logger } from './logger.js';
import { startContactsPool, activeContactsCount } from './contacts-pool.js';
import { pool } from './pool.js';

/**
 * Sales Scan capture service.
 *
 * Runs on the AlignDesk box, isolated from qr_whatsapp. Hader is the system of record;
 * this process is a follower that re-derives what it may run from Hader on every sweep.
 * READ-ONLY toward WhatsApp by construction (see session.ts — there is no send path).
 */
const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

/** Verify a Hader -> ingest call. Same scheme as the ingest -> Hader direction. */
function verify(req: { headers: Record<string, unknown>; rawBodyText: string }): boolean {
  const ts = String(req.headers['x-wa-ingest-timestamp'] ?? '');
  const got = String(req.headers['x-wa-ingest-signature'] ?? '').replace(/^sha256=/, '');
  if (!ts || !got) return false;
  // Reject stale timestamps so a captured request cannot be replayed indefinitely.
  const skew = Math.abs(Date.now() - Number(ts));
  if (!Number.isFinite(skew) || skew > 5 * 60 * 1000) return false;
  const want = createHmac('sha256', env.INGEST_SECRET).update(`${ts}.${req.rawBodyText}`).digest('hex');
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Capture the raw body so the HMAC is computed over the exact bytes signed, never over a
// re-serialization (that mismatch is a classic signature-verification bug).
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as unknown as { rawBodyText: string }).rawBodyText = String(body);
  try {
    done(null, body ? JSON.parse(String(body)) : {});
  } catch (err) {
    done(err as Error, undefined);
  }
});

app.addHook('preHandler', async (req, reply) => {
  if (req.url === '/health') return;
  const ok = verify({
    headers: req.headers as Record<string, unknown>,
    rawBodyText: (req as unknown as { rawBodyText?: string }).rawBodyText ?? '',
  });
  if (!ok) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/health', async () => ({
  ok: true,
  active: pool.activeCount,
  max: env.MAX_SESSIONS,
  contactsActive: activeContactsCount(),
  contactsEnabled: Boolean(env.CONTACTS_SECRET),
}));

/**
 * Status (incl. the QR) for one grant. OPERATOR/DEBUG ONLY — Hader does NOT call this.
 *
 * The tenant's page gets its QR the other way round: this service pushes it out via
 * hader-client pushStatus -> POST /api/v1/wa-ingest/status, Hader parks it in Redis
 * (90s TTL), and GET /sales-scan/status reads it back. Nothing in apps/api or
 * apps/worker dials this route; the only inbound calls Hader makes are /v1/reconcile
 * and /v1/stop, both fire-and-forget optimisations.
 */
app.post<{ Body: { grantId?: string } }>('/v1/status', async (req, reply) => {
  const grantId = req.body?.grantId;
  if (!grantId) return reply.code(400).send({ error: 'grantId required' });
  return { data: pool.getStatus(grantId) };
});

/** Nudge: Hader calls this right after a tenant starts a scan so the QR appears fast. */
app.post('/v1/reconcile', async () => {
  try {
    const grants = await hader.fetchAuthorisedGrants();
    for (const g of grants) await pool.ensureRunning(g);
  } catch (err) {
    logger.error({ err }, 'reconcile failed');
  }
  return { data: { active: pool.activeCount, sessions: pool.statuses() } };
});

/** Stop + queue purge for one grant. Idempotent. */
app.post<{ Body: { grantId?: string; reason?: string } }>('/v1/stop', async (req, reply) => {
  const grantId = req.body?.grantId;
  if (!grantId) return reply.code(400).send({ error: 'grantId required' });
  await pool.endSession(grantId, req.body?.reason ?? 'stopped_by_hader');
  return { data: { ok: true } };
});

async function main(): Promise<void> {
  await app.listen({ host: '127.0.0.1', port: env.PORT });
  logger.info({ port: env.PORT, max: env.MAX_SESSIONS }, 'wa-ingest listening');

  // Never resume blindly — purge orphan credentials, then start only live grants.
  if (env.CAPTURE_ENABLED) {
    await pool.reconcileOnBoot();

    // Heartbeat is separate from the reaper so a wedged sweep still surfaces liveness.
    setInterval(() => {
      void hader.heartbeat(pool.activeCount).catch((e) => hader.logPushFailure(e, 'heartbeat'));
    }, env.HEARTBEAT_INTERVAL_MS);

    void pool.runReaper();
  } else {
    // Capture off. Tear down any live session AND purge the credentials on disk. Those
    // keys belong to grants this process will never serve again, and leaving WhatsApp
    // credentials lying around after the feature that justified them is switched off is
    // the exact shape of blocker B1. stopAll() only closes sockets, so purging is
    // explicit — a comment claiming a cleanup the code does not perform is how these
    // gaps survive review in the first place.
    logger.info('WA_CAPTURE_ENABLED not set — Sales Scan capture disabled');
    await pool.stopAll().catch((err) => logger.error({ err }, 'capture teardown failed'));
    for (const grantId of listAuthGrantIds()) {
      // Skip the contacts sub-tree, which lives under the same AUTH_DIR. Today purgeAuth
      // refuses it because its name is not a UUID — but relying on a guard in another
      // file to stop this loop deleting a live contacts session's keys is the kind of
      // coupling that breaks the first time someone relaxes that regex.
      if (!/^[0-9a-f-]{36}$/i.test(grantId)) continue;
      const purged = purgeAuth(grantId);
      logger.info({ grantId, purged }, 'purged capture credentials');

      // REPORT IT. Destroying the bytes without telling Hader leaves `authPurgedAt` null
      // forever, which is indistinguishable from "credentials still exist" — so the
      // Hader-side purge-retry sweep alarms at ERROR every 5 minutes about credentials
      // that were destroyed here. That is exactly what happened from 2026-07-30: the
      // compliance column said "not purged" while the disk said otherwise, and the alarm
      // that exists to catch a real leak was crying wolf instead.
      //
      // pool.drainPurges() does this on the capture-enabled path; this branch never ran
      // it. Best-effort: if Hader is unreachable the sweep will retry via /v1/stop, which
      // is mounted regardless of CAPTURE_ENABLED.
      if (purged) {
        await hader
          .reportPurged(grantId)
          .catch((err) => hader.logPushFailure(err, 'purged (capture-disabled teardown)'));
      }
    }
  }

  // WhatsApp contact sync. Independent of the capture pool above and gated on its own
  // secret, so a deployment can run contact sync while capture stays switched off.
  startContactsPool();
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    logger.info({ sig }, 'shutting down');
    void pool.stopAll().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
