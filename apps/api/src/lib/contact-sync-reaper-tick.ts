import { CONTACT_SYNC_UNDO_WINDOW_MS } from '@platform/shared';

import { beyondUndoWindow } from './contact-sync-revert.js';

import { withRlsBypass } from './db.js';

/**
 * The sweep that contact_sync_sessions was always indexed for and never had.
 *
 * The table ships an index on (status, expires_at) whose migration comment reads
 * "Drives the expiry sweep", and schema.prisma repeats the claim — but nothing ever set a
 * session terminal or removed an old row. Sessions accumulated in 'pending' forever, the
 * documented index drove nothing, and the desktop's "expired" state was computed only as
 * a read-time fiction in the poll route: correct for whoever was watching, invisible to
 * everyone else.
 *
 * That is the exact failure pattern this repo has hit before — a retention window promised
 * in signed consent copy, indexed for, and never enforced (see the 2026-08-03 Sales Scan
 * review, finding 5). A control that is named but whose compensating path is absent.
 *
 * Two jobs:
 *
 * 1. EXPIRE. Flip live sessions past their deadline to 'expired' and drop any WhatsApp
 *    pairing QR still on the row. This is what makes the state honest in the database
 *    rather than only in one client's rendering.
 *
 * 2. PRUNE. Delete terminal rows after a short retention. These rows are ephemeral
 *    handoff state, not an audit trail — the audit trail is audit_logs, which is written
 *    separately and untouched here. Keeping them buys nothing and grows forever.
 */

const INTERVAL_MS = 5 * 60 * 1000;

/**
 * Terminal sessions and their ledger rows live exactly as long as undo does.
 *
 * ONE constant, shared with the revert route, deliberately. Retention at 24h with a 7-day
 * undo button would have produced the silent failure the design flagged as the biggest
 * risk in this work: the tenant clicks Undo on a two-day-old run and gets nothing, because
 * the rows that recorded what to undo were pruned.
 */
const PRUNE_AFTER_MS = CONTACT_SYNC_UNDO_WINDOW_MS;

export async function contactSyncReaperTick(log: {
  warn: (o: unknown, m: string) => void;
}): Promise<void> {
  const now = new Date();

  // 1. Expire anything past its deadline. updateMany is guarded on the live statuses so a
  // session that completed a millisecond ago can never be flipped to 'expired'.
  const expired = await withRlsBypass((tx) =>
    tx.contactSyncSession.updateMany({
      where: { status: { in: ['pending', 'opened'] }, expiresAt: { lte: now } },
      data: { status: 'expired', waQr: null },
    }),
  );

  // 1b. Abandoned review queues. A staged session is NOT expired by the sweep above —
  // reviewing takes days, not minutes — but a queue nobody ever comes back to is
  // third-party PII sitting in the database forever. After the same window undo uses, it
  // is discarded without importing anything.
  const abandoned = await withRlsBypass((tx) =>
    tx.contactSyncSession.updateMany({
      where: { status: 'review', stagedAt: { lt: new Date(now.getTime() - PRUNE_AFTER_MS) } },
      data: { status: 'failed', failureReason: 'Review queue expired without being applied.' },
    }),
  );

  // 1c. Applies that never finished. 'importing' is claimed atomically by the apply route
  // and released by finishSessionImport / failSessionImport — but a process killed mid-apply
  // (deploy restart, OOM) releases neither, and the row then matches NOTHING: not the live
  // sweep above, not the review sweep, not the terminal prune. The desktop polls it as
  // still-in-flight forever.
  //
  // One hour, not the 7-day window: an apply is seconds of work, so anything still claimed
  // after an hour is dead rather than slow. Its staged rows were already cleared, so failing
  // it is honest — the queue really is gone — and the tenant can re-sync.
  const stuckImports = await withRlsBypass((tx) =>
    tx.contactSyncSession.updateMany({
      where: { status: 'importing', updatedAt: { lt: new Date(now.getTime() - 60 * 60_000) } },
      data: { status: 'failed', failureReason: 'Import interrupted. Please sync again.' },
    }),
  );

  // 2. Prune terminal rows. Bounded per tick so one sweep can never hold a long
  // transaction over a large backlog.
  const cutoff = new Date(now.getTime() - PRUNE_AFTER_MS);
  const stale = await withRlsBypass((tx) =>
    tx.contactSyncSession.findMany({
      where: {
        status: { in: ['completed', 'expired', 'failed'] },
        // Measured from the IMPORT, matching the revert route exactly. Pruning on createdAt
        // while the button offered 7 days from import would delete the ledger recording what
        // to undo while the button was still on screen — the precise drift this shared
        // constant exists to prevent.
        OR: beyondUndoWindow(cutoff),
      },
      select: { id: true },
      take: 500,
    }),
  );
  if (stale.length > 0) {
    const ids = stale.map((s) => s.id);
    // Delete the ledger rows FIRST, in batches. Relying on the FK cascade would make one
    // DELETE of 500 sessions cascade across up to 2.5M item rows inside a single
    // transaction in the live API process — the tick runs in-process, every 5 minutes.
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      await withRlsBypass((tx) =>
        tx.contactSyncStagedItem.deleteMany({ where: { sessionId: { in: batch } } }),
      );
    }
    await withRlsBypass((tx) => tx.contactSyncSession.deleteMany({ where: { id: { in: ids } } }));
  }

  if (expired.count > 0 || stale.length > 0 || abandoned.count > 0 || stuckImports.count > 0) {
    log.warn(
      {
        expired: expired.count,
        pruned: stale.length,
        abandonedReviews: abandoned.count,
        stuckImports: stuckImports.count,
      },
      '[contact-sync-reaper] swept sessions',
    );
  }
}

/**
 * Registered from server.ts. Wrapped so a tick error can never take the process down, and
 * unref'd so it does not hold the event loop open during a shutdown.
 */
export function startContactSyncReaper(log: {
  warn: (o: unknown, m: string) => void;
  error: (o: unknown, m: string) => void;
}): void {
  const run = () => {
    contactSyncReaperTick(log).catch((err) =>
      log.error({ err }, '[contact-sync-reaper] tick failed'),
    );
  };
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  // Not on boot: give the process a moment to finish coming up first.
  setTimeout(run, 30_000).unref();
}
