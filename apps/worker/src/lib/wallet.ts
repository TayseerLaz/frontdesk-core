// Worker-side wallet twin (docs/wallet-billing-plan.md). The full engine lives
// in apps/api/src/lib/wallet.ts; the worker can't import across apps, so this is
// the minimal charge path it needs, using the worker's own `prisma`.
//
// Model: charge-at-send per recipient. Each charge is ONE atomic conditional
// UPDATE (`WHERE available_micros >= price`) so concurrent sends can never
// overspend, and a drained balance simply caps the broadcast (remaining
// recipients are skipped). A broadcast is "metered" iff it carries a price
// snapshot (billing_unit_price_micros) — set by the API at accept time — so
// toggling metering afterwards never disturbs an in-flight broadcast.

import { DEFAULT_META_COST_MICROS } from '@platform/shared';

import { prisma } from '../jobs/db.js';

/**
 * Live metered price for a tenant (for send paths without an accept-time price
 * snapshot, e.g. drip sequences). Returns null when the tenant is unmetered.
 */
export async function resolveMeteredPrice(
  orgId: string,
): Promise<{ priceMicros: number; metaCostMicros: number } | null> {
  const rows = await prisma.$queryRaw<{ price: bigint; meta: bigint; enabled: boolean }[]>`
    SELECT price_per_message_micros AS price, meta_cost_micros AS meta, metering_enabled AS enabled
      FROM tenant_wallets WHERE organization_id = ${orgId}::uuid`;
  const w = rows[0];
  if (!w || !w.enabled) return null;
  return { priceMicros: Number(w.price), metaCostMicros: Number(w.meta) };
}

/** Can this wallet cover one more message at `unitPriceMicros`? Pre-send gate. */
export async function canAfford(orgId: string, unitPriceMicros: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT (available_micros >= ${BigInt(Math.round(unitPriceMicros))}::bigint) AS ok
      FROM tenant_wallets WHERE organization_id = ${orgId}::uuid`;
  return rows[0]?.ok ?? false;
}

/**
 * Debit one delivered message from available. Atomic + conditional; idempotent
 * per recipient via `billed_at`. Returns ok:false if the balance couldn't cover
 * it (caller already sent — a rare race where it becomes a free message).
 */
export async function chargeAtSend(args: {
  orgId: string;
  unitPriceMicros: number;
  metaCostMicros?: number;
  broadcastId?: string | null;
  recipientId?: string | null;
}): Promise<{ ok: boolean }> {
  const { orgId, broadcastId = null, recipientId = null } = args;
  const P = BigInt(Math.round(args.unitPriceMicros));
  const meta = BigInt(Math.round(args.metaCostMicros ?? DEFAULT_META_COST_MICROS));
  return prisma.$transaction(async (tx) => {
    if (recipientId) {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE broadcast_recipients SET billed_at = now()
         WHERE id = ${recipientId}::uuid AND organization_id = ${orgId}::uuid AND billed_at IS NULL
         RETURNING id`;
      if (claimed.length === 0) return { ok: true }; // already charged
    }
    const rows = await tx.$queryRaw<{ available_micros: bigint; held_micros: bigint }[]>`
      UPDATE tenant_wallets
         SET available_micros = available_micros - ${P}::bigint,
             lifetime_spent_micros = lifetime_spent_micros + ${P}::bigint,
             lifetime_messages = lifetime_messages + 1,
             updated_at = now()
       WHERE organization_id = ${orgId}::uuid
         AND available_micros >= ${P}::bigint
       RETURNING available_micros, held_micros`;
    if (rows.length === 0) {
      if (recipientId) {
        await tx.$executeRaw`UPDATE broadcast_recipients SET billed_at = NULL WHERE id = ${recipientId}::uuid AND organization_id = ${orgId}::uuid`;
      }
      return { ok: false };
    }
    const after = rows[0]!;
    if (broadcastId) {
      await tx.$executeRaw`UPDATE broadcasts SET billing_settled_micros = billing_settled_micros + ${P}::bigint WHERE id = ${broadcastId}::uuid`;
    }
    await tx.walletLedger.create({
      data: {
        organizationId: orgId,
        kind: 'settle',
        amountMicros: -P,
        availableAfter: after.available_micros,
        heldAfter: after.held_micros,
        broadcastId,
        recipientId,
        unitPriceMicros: P,
        metaCostMicros: meta,
      },
    });
    return { ok: true };
  });
}

/**
 * Refund a charge-at-send debit when a metered message FAILED delivery. Meta
 * bills on delivery, not the send attempt (failed = $0), so an undelivered
 * message must credit the tenant back. Symmetric to chargeAtSend; idempotent +
 * race-safe via an atomic refunded_at claim so duplicate sweeps / webhooks never
 * double-refund. Amount read from the recipient's own settle ledger row.
 * Mirrors apps/api/src/lib/wallet.ts refundFailedSend.
 */
export async function refundFailedSend(
  orgId: string,
  recipientId: string,
): Promise<{ refunded: boolean; micros: number }> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<{ id: string; broadcast_id: string | null }[]>`
      UPDATE broadcast_recipients SET refunded_at = now()
       WHERE id = ${recipientId}::uuid AND organization_id = ${orgId}::uuid
         AND billed_at IS NOT NULL AND refunded_at IS NULL
       RETURNING id, broadcast_id`;
    if (claimed.length === 0) return { refunded: false, micros: 0 };
    const broadcastId = claimed[0]!.broadcast_id;
    const led = await tx.$queryRaw<{ unit_price_micros: bigint | null }[]>`
      SELECT unit_price_micros FROM wallet_ledger
       WHERE organization_id = ${orgId}::uuid AND recipient_id = ${recipientId}::uuid AND kind = 'settle'
       ORDER BY created_at DESC LIMIT 1`;
    const P = led[0]?.unit_price_micros ?? 0n;
    if (P <= 0n) return { refunded: true, micros: 0 };
    const rows = await tx.$queryRaw<{ available_micros: bigint; held_micros: bigint }[]>`
      UPDATE tenant_wallets
         SET available_micros = available_micros + ${P}::bigint,
             lifetime_spent_micros = GREATEST(lifetime_spent_micros - ${P}::bigint, 0),
             lifetime_messages = GREATEST(lifetime_messages - 1, 0),
             updated_at = now()
       WHERE organization_id = ${orgId}::uuid
       RETURNING available_micros, held_micros`;
    const after = rows[0];
    if (!after) return { refunded: true, micros: 0 };
    if (broadcastId) {
      await tx.$executeRaw`UPDATE broadcasts SET billing_settled_micros = GREATEST(billing_settled_micros - ${P}::bigint, 0) WHERE id = ${broadcastId}::uuid`;
    }
    await tx.walletLedger.create({
      data: {
        organizationId: orgId,
        kind: 'release',
        amountMicros: P,
        availableAfter: after.available_micros,
        heldAfter: after.held_micros,
        broadcastId,
        recipientId,
        unitPriceMicros: P,
      },
    });
    return { refunded: true, micros: Number(P) };
  });
}

/**
 * Fire a single "sending paused — balance exhausted" notification for a
 * broadcast that got capped. Deduped per broadcast via a DB guard so a
 * thousand skipped recipients don't spam the tenant.
 */
export async function notifyBalanceCapped(orgId: string, broadcastId: string): Promise<void> {
  try {
    // One notification per broadcast: use a deterministic entityId guard.
    const existing = await prisma.notification.findFirst({
      where: { organizationId: orgId, kind: 'quota_warning', entityType: 'broadcast', entityId: broadcastId },
      select: { id: true },
    });
    if (existing) return;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      await tx.notification.create({
        data: {
          organizationId: orgId,
          kind: 'quota_warning',
          severity: 'error',
          title: 'WhatsApp sending paused — balance exhausted',
          body: `Your WhatsApp balance ran out mid-broadcast, so some messages couldn't be sent. Top up your wallet and re-run the skipped recipients.`,
          link: '/billing',
          entityType: 'broadcast',
          entityId: broadcastId,
        },
      });
    });
  } catch {
    /* best-effort */
  }
}
