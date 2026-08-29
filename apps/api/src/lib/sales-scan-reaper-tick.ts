import { withRlsBypass } from './db.js';
import { requestIngestStop } from './sales-scan-ingest.js';

/**
 * the platform-side safety net for Sales Scan windows. Three jobs, all of which exist because the
 * capture service is the thing most likely to be broken when we need it most.
 *
 * 1. EXPIRY. The capture service enforces its own deadline, but if it is down/wedged a
 *    window would otherwise stay `active` forever in the eyes of the portal. This flips
 *    the row terminal from the system of record's side.
 *
 * 2. PURGE RETRY — blocker B1, the single worst finding in the review. `terminateGrant` is
 *    guarded to non-terminal rows so duplicate stop clicks are harmless; the consequence
 *    is that once a row is terminal a guarded retry is a permanent no-op. So a purge that
 *    failed at that exact moment could never be retried, and the tenant's WhatsApp
 *    credentials would outlive their consent silently, forever, with `authPurgedAt` null
 *    and nobody watching that column.
 *
 *    This sweep is the unguarded half: for every grant with `endedAt` set and
 *    `authPurgedAt` still null, re-issue the teardown. `authPurgedAt` is only ever stamped
 *    by the ingest receiver, and only after the capture service has verified the bytes are
 *    gone — so this loop is safe to run forever and stops on its own once the purge lands.
 *
 * 3. RETENTION — blocker B10. The consent every tenant agrees to says, verbatim, "Messages
 *    are kept for at most 90 days", and sales_messages carries an index annotated
 *    "Retention pruning (90-day raw window)" — but until 2026-08-05 nothing ever pruned.
 *    The only deleteMany on the table was the tenant's own "delete captured data" button,
 *    which meant a tenant who never pressed it (or who had the feature switched off, which
 *    used to 403 that button) kept their customers' messages forever. A promise nobody
 *    enforces is the worst kind.
 */

const INTERVAL_MS = 5 * 60 * 1000;
/** Log loudly once a grant has been waiting this long for its credentials to die. */
const PURGE_ALERT_AFTER_MS = 30 * 60 * 1000;

/**
 * Hard retention ceiling for captured message bodies, in days.
 *
 * Deliberately a CONSTANT and not an env var. This number is a promise made in the consent
 * text the tenant signed (and whose SHA is pinned in the CI gate) — an env var would let a
 * deployment quietly hold customers' messages longer than the thing they consented to, the
 * same reason windowDays is clamped in code as well as in Zod.
 */
const RETENTION_DAYS = 90;
/** Bound each sweep so a large backlog degrades into several passes, never one long lock. */
const RETENTION_BATCH = 5_000;

async function sweepExpired(log: { warn: (o: unknown, m: string) => void }): Promise<void> {
  const now = new Date();
  const live = await withRlsBypass((tx) =>
    tx.salesScanGrant.findMany({
      where: { status: { in: ['pending', 'linking', 'active'] } },
      select: { id: true, grantExpiresAt: true, captureEndsAt: true },
    }),
  );
  for (const g of live) {
    const ends = g.captureEndsAt && g.captureEndsAt < g.grantExpiresAt ? g.captureEndsAt : g.grantExpiresAt;
    if (ends > now) continue;
    await withRlsBypass((tx) =>
      tx.salesScanGrant.updateMany({
        where: { id: g.id, status: { in: ['pending', 'linking', 'active'] } },
        data: { status: 'expired', endedAt: now, endReason: 'window_expired_reaper' },
      }),
    );
    log.warn({ grantId: g.id }, '[sales-scan] window expired — terminated from the platform side');
    // Ask the capture service to disconnect + purge. If it is unreachable the purge sweep
    // below keeps retrying.
    await requestIngestStop(g.id, 'window_expired_reaper').catch(() => undefined);
  }
}

async function sweepPurges(log: {
  warn: (o: unknown, m: string) => void;
  error: (o: unknown, m: string) => void;
}): Promise<void> {
  const pending = await withRlsBypass((tx) =>
    tx.salesScanGrant.findMany({
      where: { endedAt: { not: null }, authPurgedAt: null },
      select: { id: true, endedAt: true, endReason: true },
      take: 200,
    }),
  );
  // Forget grants whose purge has landed, so the alert-cadence map cannot grow forever.
  const stillPending = new Set(pending.map((g) => g.id));
  for (const id of lastPurgeAlertAt.keys()) {
    if (!stillPending.has(id)) lastPurgeAlertAt.delete(id);
  }

  for (const g of pending) {
    const waitedMs = g.endedAt ? Date.now() - g.endedAt.getTime() : 0;
    if (waitedMs > PURGE_ALERT_AFTER_MS && shouldAlertNow(g.id, waitedMs)) {
      // Deliberately error-level: this is the state where a tenant believes their
      // credentials are gone and they are not.
      log.error(
        { grantId: g.id, waitedMinutes: Math.round(waitedMs / 60000) },
        '[sales-scan] CREDENTIALS NOT PURGED long after the window ended — capture service unreachable?',
      );
    }
    await requestIngestStop(g.id, g.endReason ?? 'purge_retry').catch(() => undefined);
  }
}

/**
 * Back off the purge alarm so it stays believable.
 *
 * The sweep runs every 5 minutes and re-logs unconditionally once the 30-minute threshold
 * is crossed, which is 288 identical ERROR lines per grant per day, forever. Two demo
 * grants did exactly that from 2026-07-30 onward. An alarm nobody can read is an alarm
 * nobody acts on — and this is the one that says a tenant's WhatsApp credentials may have
 * outlived their consent, so it is precisely the one that must not become wallpaper.
 *
 * Doubling intervals (30m, 1h, 2h, 4h, …, capped at 24h) keeps the signal permanently
 * visible without drowning it. In-memory on purpose: a restart re-alerting once is the
 * correct behaviour, and this must never depend on Redis being up.
 */
const lastPurgeAlertAt = new Map<string, number>();

function shouldAlertNow(grantId: string, waitedMs: number): boolean {
  const now = Date.now();
  const last = lastPurgeAlertAt.get(grantId);
  if (last === undefined) {
    lastPurgeAlertAt.set(grantId, now);
    return true;
  }
  // Cadence tracks how long the problem has persisted, capped at a day.
  const cadence = Math.min(waitedMs / 2, 24 * 60 * 60 * 1000);
  if (now - last < cadence) return false;
  lastPurgeAlertAt.set(grantId, now);
  return true;
}

/**
 * Enforce the 90-day retention ceiling promised in the consent text (blocker B10).
 *
 * Prunes on `createdAt`, not `sentAt`: retention is about how long WE have held the row.
 * Pruning on sentAt would both delete freshly-captured history the moment it arrived and
 * let a row we captured 91 days ago survive because its message was recent. The
 * (organization_id, created_at) index exists for exactly this query.
 */
async function sweepRetention(log: {
  info: (o: unknown, m: string) => void;
  warn: (o: unknown, m: string) => void;
}): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Delete by id so the batch cap is real; deleteMany has no LIMIT.
  const doomed = await withRlsBypass((tx) =>
    tx.salesMessage.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: RETENTION_BATCH,
    }),
  );
  if (doomed.length === 0) return;

  const res = await withRlsBypass((tx) =>
    tx.salesMessage.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } }),
  );

  // Deliberately loud. Deleting a tenant's captured corpus is correct here, but it must
  // never happen without a trace someone can point at months later.
  log.warn(
    { deleted: res.count, olderThanDays: RETENTION_DAYS, cutoff: cutoff.toISOString() },
    '[sales-scan] retention sweep pruned captured messages past the 90-day consent ceiling',
  );

  if (doomed.length === RETENTION_BATCH) {
    log.info(
      { batch: RETENTION_BATCH },
      '[sales-scan] retention batch was full — more remains, continuing next sweep',
    );
  }
}

/**
 * Same 90-day ceiling, applied to the webhook landing pad.
 *
 * `meta_webhook_events` was built as a capture-first safety net so a one-shot Coexistence
 * `history` delivery could never be lost to a 200 nobody could replay. It does that job
 * well — and it had exactly one writer, no reader, and nothing that ever deleted a row. So
 * a parked `history` payload, which is up to 180 days of a tenant's customers'
 * conversations in raw JSONB, would have sat there indefinitely, outside every retention
 * promise the consent text makes.
 *
 * Prunes on `received_at` for the same reason sweepRetention prunes on createdAt: retention
 * is how long WE have held it, not how old the content is. The consent copy says this
 * explicitly, because for history the two genuinely differ — a payload received today can
 * contain a conversation from six months ago.
 *
 * Rows are deleted whether or not `processed_at` is set. An unprocessed row past the
 * ceiling is not a reason to keep it: it means nothing consumed it in 90 days, and holding
 * third-party message content indefinitely on the hope that something eventually will is
 * the opposite of the promise. If that starts happening, the alarm below is the signal to
 * build the consumer, not to widen the ceiling.
 */
async function sweepWebhookLandingPad(log: {
  info: (o: unknown, m: string) => void;
  warn: (o: unknown, m: string) => void;
}): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const doomed = await withRlsBypass((tx) =>
    tx.metaWebhookEvent.findMany({
      where: { receivedAt: { lt: cutoff } },
      select: { id: true, field: true, processedAt: true },
      take: RETENTION_BATCH,
    }),
  );
  if (doomed.length === 0) return;

  const unprocessed = doomed.filter((d) => d.processedAt === null).length;

  const res = await withRlsBypass((tx) =>
    tx.metaWebhookEvent.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } }),
  );

  log.warn(
    {
      deleted: res.count,
      unprocessed,
      fields: [...new Set(doomed.map((d) => d.field))],
      olderThanDays: RETENTION_DAYS,
      cutoff: cutoff.toISOString(),
    },
    unprocessed > 0
      ? '[sales-scan] landing-pad retention pruned webhook payloads that were NEVER PROCESSED — a consumer is missing'
      : '[sales-scan] landing-pad retention pruned parked webhook payloads past the 90-day ceiling',
  );

  if (doomed.length === RETENTION_BATCH) {
    log.info(
      { batch: RETENTION_BATCH },
      '[sales-scan] landing-pad retention batch was full — more remains, continuing next sweep',
    );
  }
}

export function startSalesScanReaperTick(log: {
  info: (o: unknown, m: string) => void;
  warn: (o: unknown, m: string) => void;
  error: (o: unknown, m: string) => void;
}): void {
  // DELIBERATELY UNGATED. This used to return early unless WA_INGEST_URL and
  // WA_INGEST_SECRET were both set, on the reasoning that "there is no grant to expire
  // because /connect 503s without it". Both halves of that were false in production on
  // 2026-08-05: the vars were set, /connect did not 503, and a grant had been stuck in
  // `linking` for six days.
  //
  // More importantly, the reasoning was the wrong shape. Both sweeps below are pure
  // Postgres work under withRlsBypass — neither needs an ingest credential — and both
  // are compliance machinery: sweepExpired is what terminates a window from the system
  // of record when the capture service is wedged, and sweepPurges is the unguarded
  // purge-retry that exists because terminateGrant is guarded to non-terminal rows
  // (blocker B1, "the single worst finding in the review"). Gating them on a transport
  // variable means the operator action that stops offering QRs also blinds the alarm
  // that says credentials outlived their consent.
  //
  // The only credentialed call in either sweep is requestIngestStop, which already
  // self-guards on the same two vars — so with nothing configured these sweeps do their
  // Postgres work and skip the outbound call, which is exactly right.

  // Supervised loop rather than setInterval: one thrown error must cost a single sweep,
  // never the guarantee (the same reason the ingest-side reaper is a while-loop).
  void (async () => {
    for (;;) {
      try {
        await sweepExpired(log);
        await sweepPurges(log);
        await sweepRetention(log);
        await sweepWebhookLandingPad(log);
      } catch (err) {
        log.error({ err }, '[sales-scan] reaper sweep failed — retrying next interval');
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  })();

  log.info({ intervalMs: INTERVAL_MS }, '[sales-scan] reaper tick started');
}
