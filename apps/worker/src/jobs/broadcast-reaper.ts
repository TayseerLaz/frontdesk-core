// Broadcast reaper — a broadcast must never stay "sending" forever.
//
// The send worker completes a broadcast when its last recipient goes terminal,
// but a broadcast can get wedged in `sending`: a recipient stuck in queued (a
// lost job), a completion event that never fired, or a tail of retries. This
// sweep runs every few minutes and force-finishes any broadcast still `sending`
// past its send window: leftover pending/queued recipients become `skipped`
// (timed out) and the broadcast flips to `completed` (+ event + webhook).
//
// Default window is 1 hour. Broadcasts that are DESIGNED to run long — batched
// sends or a send-window schedule — get a 24h safety cap instead so we never
// cut a legitimate slow drip short.

import { prisma } from '@platform/db';

import { emitWebhookEvent } from '../lib/emit-webhook.js';
import { refundFailedSend } from '../lib/wallet.js';

const REAP_HOURS = Number(process.env.BROADCAST_REAP_HOURS ?? 1);
const LONG_REAP_HOURS = Number(process.env.BROADCAST_REAP_LONG_HOURS ?? 24);
const TICK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
// Grace before auto-refunding a failed-delivery charge. The message_status
// webhook already refunds instantly; this sweep is the safety net for missed /
// late webhooks (and matches the "~30 min after send, failed ones are refunded"
// guarantee). Meta bills on delivery, so a 'failed' recipient owes $0.
const FAILED_REFUND_GRACE_MS =
  Number(process.env.WALLET_FAILED_REFUND_GRACE_MINUTES ?? 30) * 60 * 1000;

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

// Auto-refund the charge-at-send debit for metered messages that FAILED
// delivery and weren't already refunded by the webhook. Idempotent per
// recipient (atomic refunded_at claim in refundFailedSend).
async function refundFailedSweep(): Promise<void> {
  const cutoff = new Date(Date.now() - FAILED_REFUND_GRACE_MS);
  const rows = await prisma.$queryRaw<{ id: string; organization_id: string }[]>`
    SELECT id, organization_id FROM broadcast_recipients
     WHERE status = 'failed' AND billed_at IS NOT NULL AND refunded_at IS NULL
       AND delivered_at IS NULL AND read_at IS NULL
       AND COALESCE(failed_at, billed_at) < ${cutoff}
     LIMIT 1000`;
  if (rows.length === 0) return;
  let n = 0;
  let micros = 0;
  for (const r of rows) {
    try {
      const res = await refundFailedSend(r.organization_id, r.id);
      if (res.refunded) {
        n += 1;
        micros += res.micros;
      }
    } catch (err) {
      console.error('[broadcast-reaper] refund sweep failed for recipient', r.id, err);
    }
  }
  if (n > 0) {
    console.log(
      `[broadcast-reaper] auto-refunded ${n} failed-delivery charge(s) — $${(micros / 1_000_000).toFixed(4)}`,
    );
  }
}

async function tick(): Promise<void> {
  // Refund failed-delivery over-charges first (independent of the finalize loop).
  await refundFailedSweep().catch((err) =>
    console.error('[broadcast-reaper] refund sweep error', err),
  );
  const oneHourAgo = new Date(Date.now() - REAP_HOURS * 60 * 60 * 1000);
  // Candidates: still sending, started more than the short window ago.
  const candidates = await prisma.broadcast.findMany({
    where: { status: 'sending', startedAt: { lt: oneHourAgo } },
    select: {
      id: true,
      organizationId: true,
      name: true,
      totalRecipients: true,
      sentCount: true,
      deliveredCount: true,
      readCount: true,
      failedCount: true,
      startedAt: true,
      batchSize: true,
      sendWindowStartHour: true,
    },
  });

  for (const b of candidates) {
    if (!b.startedAt) continue;
    const longRunning = (b.batchSize != null && b.batchSize > 0) || b.sendWindowStartHour != null;
    const capHours = longRunning ? LONG_REAP_HOURS : REAP_HOURS;
    if (Date.now() - b.startedAt.getTime() < capHours * 60 * 60 * 1000) continue;

    // Any recipient not yet delivered/sent/failed is timed out.
    const skipped = await prisma.broadcastRecipient.updateMany({
      where: { broadcastId: b.id, status: { in: ['pending', 'queued'] } },
      data: {
        status: 'skipped',
        metaErrorCode: 'timed_out',
        metaErrorMessage: `Not sent within the ${capHours}-hour send window.`,
      },
    });

    await prisma.broadcast.update({
      where: { id: b.id },
      data: { status: 'completed', completedAt: new Date() },
    });
    await prisma.broadcastEvent.create({
      data: {
        organizationId: b.organizationId,
        broadcastId: b.id,
        kind: 'completed',
        detail: { reason: 'reaped_after_send_window', capHours, timedOut: skipped.count },
      },
    });
    await emitWebhookEvent({
      organizationId: b.organizationId,
      eventKind: 'broadcast_completed',
      payload: {
        broadcastId: b.id,
        name: b.name,
        totalRecipients: b.totalRecipients,
        sentCount: b.sentCount,
        deliveredCount: b.deliveredCount,
        readCount: b.readCount,
        failedCount: b.failedCount,
        timedOut: skipped.count,
        reaped: true,
      },
    }).catch(() => undefined);

    console.log(
      `[broadcast-reaper] finalized "${b.name}" (${b.id}) after ${capHours}h — ${skipped.count} recipient(s) timed out`,
    );
  }
}

export function startBroadcastReaperTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[broadcast-reaper] tick error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  timer = setTimeout(run, 2 * 60 * 1000); // first run 2 min after boot
  return {
    name: 'broadcast-reaper',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
