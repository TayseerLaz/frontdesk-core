// Tenant wallet & metered WhatsApp billing engine (docs/wallet-billing-plan.md).
//
// All amounts are integer MICRO-USD. Every money mutation is one ATOMIC
// conditional SQL (so two concurrent sends can't spend the same funds) plus a
// ledger row in the same transaction. We use the owner `prisma` (RLS-bypassed)
// and scope EVERY query by organization_id explicitly.

import { prisma } from './db.js';
import {
  DEFAULT_META_COST_MICROS,
  DEFAULT_PRICE_MICROS,
  MIN_PRICE_MICROS,
  type WalletQuote,
} from '@platform/shared';

const N = (b: bigint | number | null | undefined): number => (b == null ? 0 : Number(b));

export interface Wallet {
  organizationId: string;
  meteringEnabled: boolean;
  availableMicros: number;
  heldMicros: number;
  pricePerMessageMicros: number;
  metaCostMicros: number;
  lowBalanceThresholdMicros: number;
  lifetimeToppedUpMicros: number;
  lifetimeSpentMicros: number;
  lifetimeMessages: number;
  alertThresholds: number[];
  alertBaselineMicros: number;
}

type WalletRow = {
  organizationId: string;
  meteringEnabled: boolean;
  availableMicros: bigint;
  heldMicros: bigint;
  pricePerMessageMicros: bigint;
  metaCostMicros: bigint;
  lowBalanceThresholdMicros: bigint;
  lifetimeToppedUpMicros: bigint;
  lifetimeSpentMicros: bigint;
  lifetimeMessages: number;
  alertThresholds: number[];
  alertBaselineMicros: bigint;
};

function mapWallet(w: WalletRow): Wallet {
  return {
    organizationId: w.organizationId,
    meteringEnabled: w.meteringEnabled,
    availableMicros: N(w.availableMicros),
    heldMicros: N(w.heldMicros),
    pricePerMessageMicros: N(w.pricePerMessageMicros),
    metaCostMicros: N(w.metaCostMicros),
    lowBalanceThresholdMicros: N(w.lowBalanceThresholdMicros),
    lifetimeToppedUpMicros: N(w.lifetimeToppedUpMicros),
    lifetimeSpentMicros: N(w.lifetimeSpentMicros),
    lifetimeMessages: w.lifetimeMessages,
    alertThresholds: w.alertThresholds ?? [],
    alertBaselineMicros: N(w.alertBaselineMicros),
  };
}

export const ALLOWED_ALERT_THRESHOLDS = [50, 75, 80, 90, 100] as const;

export interface WalletAlertState {
  /** 0–100. % of the last top-up consumed. 0 when there's no baseline. */
  pctUsed: number;
  /** The highest configured threshold the balance has crossed, or null. */
  crossedThreshold: number | null;
  level: 'ok' | 'alert' | 'empty';
  message: string | null;
}

/** Pure computation of the balance-alert state for a wallet (or null wallet). */
export function walletAlertState(w: Wallet | null): WalletAlertState {
  if (!w || !w.meteringEnabled) return { pctUsed: 0, crossedThreshold: null, level: 'ok', message: null };
  const baseline = w.alertBaselineMicros;
  const pctUsed =
    baseline > 0 ? Math.min(100, Math.max(0, Math.round(((baseline - w.availableMicros) / baseline) * 100))) : 0;
  const crossed = [...w.alertThresholds].filter((t) => pctUsed >= t).sort((a, b) => b - a)[0] ?? null;
  const empty = w.availableMicros < w.pricePerMessageMicros;
  const msgsLeft = w.pricePerMessageMicros > 0 ? Math.floor(w.availableMicros / w.pricePerMessageMicros) : 0;
  const dollars = (w.availableMicros / 1_000_000).toFixed(2);
  if (empty && (crossed != null || pctUsed >= 100)) {
    return {
      pctUsed: 100,
      crossedThreshold: 100,
      level: 'empty',
      message: `WhatsApp balance empty — sending is paused. Top up to resume.`,
    };
  }
  if (crossed != null) {
    return {
      pctUsed,
      crossedThreshold: crossed,
      level: 'alert',
      message: `WhatsApp balance alert: you've used ${pctUsed}% of your balance — about ${msgsLeft} messages ($${dollars}) left. Top up soon.`,
    };
  }
  return { pctUsed, crossedThreshold: null, level: 'ok', message: null };
}

/** Set which balance-depletion % thresholds alert this tenant. */
export async function setAlertThresholds(orgId: string, thresholds: number[]): Promise<Wallet> {
  const clean = [...new Set(thresholds)]
    .filter((t) => (ALLOWED_ALERT_THRESHOLDS as readonly number[]).includes(t))
    .sort((a, b) => a - b);
  await ensureWallet(orgId);
  const w = await prisma.tenantWallet.update({
    where: { organizationId: orgId },
    data: { alertThresholds: clean },
  });
  return mapWallet(w as unknown as WalletRow);
}

/** The org's wallet, or null when it has none (fully unmetered — behaves as before). */
export async function getWallet(orgId: string): Promise<Wallet | null> {
  const w = await prisma.tenantWallet.findUnique({ where: { organizationId: orgId } });
  return w ? mapWallet(w as unknown as WalletRow) : null;
}

/** True only when a wallet exists AND metering is switched on — the send gate. */
export async function isMetered(orgId: string): Promise<boolean> {
  const w = await prisma.tenantWallet.findUnique({
    where: { organizationId: orgId },
    select: { meteringEnabled: true },
  });
  return !!w?.meteringEnabled;
}

/** Ensure a wallet row exists (used before top-up / price set). */
async function ensureWallet(orgId: string): Promise<void> {
  await prisma.tenantWallet.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId },
    update: {},
  });
}

/** Set the per-message price (µ$). Enforces the floor. Does not move money. */
export async function setPrice(orgId: string, priceMicros: number): Promise<Wallet> {
  const price = Math.max(MIN_PRICE_MICROS, Math.round(priceMicros));
  const w = await prisma.tenantWallet.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, pricePerMessageMicros: BigInt(price) },
    update: { pricePerMessageMicros: BigInt(price) },
  });
  return mapWallet(w as unknown as WalletRow);
}

/** Turn the send gate on/off without moving money. */
export async function setMetering(orgId: string, enabled: boolean): Promise<Wallet> {
  await ensureWallet(orgId);
  const w = await prisma.tenantWallet.update({
    where: { organizationId: orgId },
    data: { meteringEnabled: enabled },
  });
  return mapWallet(w as unknown as WalletRow);
}

export async function setLowBalanceThreshold(orgId: string, thresholdMicros: number): Promise<Wallet> {
  await ensureWallet(orgId);
  const w = await prisma.tenantWallet.update({
    where: { organizationId: orgId },
    data: { lowBalanceThresholdMicros: BigInt(Math.max(0, Math.round(thresholdMicros))) },
  });
  return mapWallet(w as unknown as WalletRow);
}

/** Credit the wallet (reflects a real payment). Auto-enables metering. */
export async function topUp(
  orgId: string,
  amountMicros: number,
  actorUserId: string | null,
  note?: string,
): Promise<Wallet> {
  const amt = BigInt(Math.max(0, Math.round(amountMicros)));
  await ensureWallet(orgId);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ available_micros: bigint; held_micros: bigint }[]>`
      UPDATE tenant_wallets
         SET available_micros = available_micros + ${amt}::bigint,
             lifetime_topped_up_micros = lifetime_topped_up_micros + ${amt}::bigint,
             metering_enabled = true,
             -- Reset the "full tank" baseline so %-used alerts re-arm for the new cycle.
             alert_baseline_micros = available_micros + ${amt}::bigint,
             updated_at = now()
       WHERE organization_id = ${orgId}::uuid
       RETURNING available_micros, held_micros`;
    const after = rows[0]!;
    await tx.walletLedger.create({
      data: {
        organizationId: orgId,
        kind: 'topup',
        amountMicros: amt,
        availableAfter: after.available_micros,
        heldAfter: after.held_micros,
        note: note ?? null,
        actorUserId,
      },
    });
    const w = await tx.tenantWallet.findUniqueOrThrow({ where: { organizationId: orgId } });
    return mapWallet(w as unknown as WalletRow);
  });
}

/** Admin ± adjustment. Clamps so available never goes below 0. */
export async function adjust(
  orgId: string,
  deltaMicros: number,
  actorUserId: string | null,
  note?: string,
): Promise<Wallet> {
  const delta = BigInt(Math.round(deltaMicros));
  await ensureWallet(orgId);
  return prisma.$transaction(async (tx) => {
    // GREATEST clamp keeps available ≥ 0 even for a large negative adjust.
    const rows = await tx.$queryRaw<{ available_micros: bigint; held_micros: bigint; applied: bigint }[]>`
      UPDATE tenant_wallets
         SET available_micros = GREATEST(available_micros + ${delta}::bigint, 0),
             updated_at = now()
       WHERE organization_id = ${orgId}::uuid
       RETURNING available_micros, held_micros,
                 (GREATEST(available_micros, 0)) AS applied`;
    const after = rows[0]!;
    await tx.walletLedger.create({
      data: {
        organizationId: orgId,
        kind: 'adjust',
        amountMicros: delta,
        availableAfter: after.available_micros,
        heldAfter: after.held_micros,
        note: note ?? null,
        actorUserId,
      },
    });
    const w = await tx.tenantWallet.findUniqueOrThrow({ where: { organizationId: orgId } });
    return mapWallet(w as unknown as WalletRow);
  });
}

/** Pure read for the pre-send guard + UI cost line. Never mutates. */
export async function quote(orgId: string, count: number): Promise<WalletQuote> {
  const w = await getWallet(orgId);
  const c = Math.max(0, Math.floor(count));
  if (!w || !w.meteringEnabled) {
    return {
      metered: false,
      unitPriceMicros: w?.pricePerMessageMicros ?? DEFAULT_PRICE_MICROS,
      totalMicros: 0,
      availableMicros: w?.availableMicros ?? 0,
      maxAffordable: c,
      removeCount: 0,
      ok: true,
    };
  }
  const price = w.pricePerMessageMicros;
  const total = price * c;
  const maxAffordable = price > 0 ? Math.floor(w.availableMicros / price) : c;
  return {
    metered: true,
    unitPriceMicros: price,
    totalMicros: total,
    availableMicros: w.availableMicros,
    maxAffordable,
    removeCount: Math.max(0, c - maxAffordable),
    ok: w.availableMicros >= total,
  };
}

export interface HoldResult {
  ok: boolean;
  heldMicros: number;
  unitPriceMicros: number;
  maxAffordable: number;
}

/**
 * Reserve N×price from available → held for an immediate broadcast. Atomic +
 * conditional: fails (ok=false) if the balance can't cover it. Snapshots the
 * price + Meta cost onto the broadcast. Unmetered orgs → ok with 0 hold.
 */
export async function hold(orgId: string, broadcastId: string, count: number): Promise<HoldResult> {
  const w = await getWallet(orgId);
  if (!w || !w.meteringEnabled) {
    return { ok: true, heldMicros: 0, unitPriceMicros: w?.pricePerMessageMicros ?? DEFAULT_PRICE_MICROS, maxAffordable: count };
  }
  const price = w.pricePerMessageMicros;
  const H = BigInt(price * Math.max(0, Math.floor(count)));
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ available_micros: bigint; held_micros: bigint }[]>`
      UPDATE tenant_wallets
         SET available_micros = available_micros - ${H}::bigint,
             held_micros = held_micros + ${H}::bigint,
             updated_at = now()
       WHERE organization_id = ${orgId}::uuid
         AND metering_enabled = true
         AND available_micros >= ${H}::bigint
       RETURNING available_micros, held_micros`;
    if (rows.length === 0) {
      return { ok: false, heldMicros: 0, unitPriceMicros: price, maxAffordable: Math.floor(w.availableMicros / price) };
    }
    const after = rows[0]!;
    await tx.broadcast.update({
      where: { id: broadcastId },
      data: {
        billingUnitPriceMicros: BigInt(price),
        billingMetaCostMicros: BigInt(w.metaCostMicros),
        billingHeldMicros: H,
        billingSettledMicros: 0n,
        billingReleased: false,
      },
    });
    await tx.walletLedger.create({
      data: {
        organizationId: orgId,
        kind: 'hold',
        amountMicros: -H,
        availableAfter: after.available_micros,
        heldAfter: after.held_micros,
        broadcastId,
        unitPriceMicros: BigInt(price),
        metaCostMicros: BigInt(w.metaCostMicros),
      },
    });
    return { ok: true, heldMicros: Number(H), unitPriceMicros: price, maxAffordable: Number(H) / price };
  });
}

/**
 * Charge one successful send against a held broadcast. Idempotent per recipient
 * via `billed_at` (a retried send job never double-charges). No-op if already billed.
 */
export async function settle(
  orgId: string,
  broadcastId: string,
  recipientId: string,
  unitPriceMicros: number,
  metaCostMicros: number,
): Promise<{ charged: boolean }> {
  const P = BigInt(Math.round(unitPriceMicros));
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE broadcast_recipients SET billed_at = now()
       WHERE id = ${recipientId}::uuid AND organization_id = ${orgId}::uuid AND billed_at IS NULL
       RETURNING id`;
    if (claimed.length === 0) return { charged: false };
    const rows = await tx.$queryRaw<{ available_micros: bigint; held_micros: bigint }[]>`
      UPDATE tenant_wallets
         SET held_micros = GREATEST(held_micros - ${P}::bigint, 0),
             lifetime_spent_micros = lifetime_spent_micros + ${P}::bigint,
             lifetime_messages = lifetime_messages + 1,
             updated_at = now()
       WHERE organization_id = ${orgId}::uuid
       RETURNING available_micros, held_micros`;
    const after = rows[0] ?? { available_micros: 0n, held_micros: 0n };
    await tx.broadcast.update({
      where: { id: broadcastId },
      data: { billingSettledMicros: { increment: P } },
    });
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
        metaCostMicros: BigInt(Math.round(metaCostMicros)),
      },
    });
    return { charged: true };
  });
}

/**
 * Direct debit from available for a scheduled/sequence/manual send (no prior
 * hold). Atomic + conditional; returns ok:false if unaffordable (caller skips).
 * Idempotent per recipient when a recipientId is given.
 */
export async function chargeAtSend(args: {
  orgId: string;
  unitPriceMicros: number;
  metaCostMicros: number;
  broadcastId?: string | null;
  recipientId?: string | null;
}): Promise<{ ok: boolean }> {
  const { orgId, broadcastId = null, recipientId = null } = args;
  const P = BigInt(Math.round(args.unitPriceMicros));
  return prisma.$transaction(async (tx) => {
    if (recipientId) {
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE broadcast_recipients SET billed_at = now()
         WHERE id = ${recipientId}::uuid AND organization_id = ${orgId}::uuid AND billed_at IS NULL
         RETURNING id`;
      if (claimed.length === 0) return { ok: true }; // already charged; treat as success
    }
    const rows = await tx.$queryRaw<{ available_micros: bigint; held_micros: bigint }[]>`
      UPDATE tenant_wallets
         SET available_micros = available_micros - ${P}::bigint,
             lifetime_spent_micros = lifetime_spent_micros + ${P}::bigint,
             lifetime_messages = lifetime_messages + 1,
             updated_at = now()
       WHERE organization_id = ${orgId}::uuid
         AND metering_enabled = true
         AND available_micros >= ${P}::bigint
       RETURNING available_micros, held_micros`;
    if (rows.length === 0) {
      // Not affordable — undo the idempotency claim so a later top-up can retry.
      if (recipientId) {
        await tx.$executeRaw`UPDATE broadcast_recipients SET billed_at = NULL WHERE id = ${recipientId}::uuid AND organization_id = ${orgId}::uuid`;
      }
      return { ok: false };
    }
    const after = rows[0]!;
    if (broadcastId) {
      await tx.broadcast.update({ where: { id: broadcastId }, data: { billingSettledMicros: { increment: P } } });
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
        metaCostMicros: BigInt(Math.round(args.metaCostMicros)),
      },
    });
    return { ok: true };
  });
}

/**
 * Refund a charge-at-send debit when the message later FAILED delivery. Meta
 * bills on delivery, not the send attempt (failed = $0), but chargeAtSend debits
 * the tenant the moment Meta ACCEPTS the send — so an undelivered message would
 * otherwise leave the tenant over-charged. This credits the exact amount back.
 *
 * Idempotent + race-safe: the refund is "claimed" with an atomic conditional
 * UPDATE that only fires when the recipient was billed and NOT yet refunded, so
 * duplicate 'failed' webhooks (or a re-delivered one) never double-refund. The
 * refunded amount is read from the recipient's own `settle` ledger row, so it
 * matches whatever price was actually charged for that recipient.
 */
export async function refundFailedSend(
  orgId: string,
  recipientId: string,
): Promise<{ refunded: boolean; micros: number }> {
  return prisma.$transaction(async (tx) => {
    // Atomic idempotency claim: only proceed if billed and not already refunded.
    const claimed = await tx.$queryRaw<{ id: string; broadcast_id: string | null }[]>`
      UPDATE broadcast_recipients SET refunded_at = now()
       WHERE id = ${recipientId}::uuid AND organization_id = ${orgId}::uuid
         AND billed_at IS NOT NULL AND refunded_at IS NULL
       RETURNING id, broadcast_id`;
    if (claimed.length === 0) return { refunded: false, micros: 0 };
    const broadcastId = claimed[0]!.broadcast_id;
    // The exact amount charged for THIS recipient (from its settle ledger row).
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

/** Return a completed broadcast's unspent hold to available. Terminal + idempotent. */
export async function releaseRemainder(orgId: string, broadcastId: string): Promise<{ released: number }> {
  return prisma.$transaction(async (tx) => {
    const b = await tx.broadcast.findFirst({
      where: { id: broadcastId, organizationId: orgId },
      select: { billingReleased: true, billingHeldMicros: true, billingSettledMicros: true },
    });
    if (!b || b.billingReleased) return { released: 0 };
    const r = N(b.billingHeldMicros) - N(b.billingSettledMicros);
    if (r > 0) {
      const R = BigInt(r);
      const rows = await tx.$queryRaw<{ available_micros: bigint; held_micros: bigint }[]>`
        UPDATE tenant_wallets
           SET held_micros = GREATEST(held_micros - ${R}::bigint, 0),
               available_micros = available_micros + ${R}::bigint,
               updated_at = now()
         WHERE organization_id = ${orgId}::uuid
         RETURNING available_micros, held_micros`;
      const after = rows[0];
      if (after) {
        await tx.walletLedger.create({
          data: {
            organizationId: orgId,
            kind: 'release',
            amountMicros: R,
            availableAfter: after.available_micros,
            heldAfter: after.held_micros,
            broadcastId,
          },
        });
      }
    }
    await tx.broadcast.update({ where: { id: broadcastId }, data: { billingReleased: true } });
    return { released: Math.max(0, r) };
  });
}

/**
 * Fire a low-balance notification once when `available` drops below the
 * threshold. Re-arms on the next top-up (Redis flag cleared there). Best-effort.
 */
export async function maybeLowBalanceNotice(orgId: string): Promise<void> {
  try {
    const w = await getWallet(orgId);
    if (!w || !w.meteringEnabled) return;
    const threshold = w.lowBalanceThresholdMicros > 0 ? w.lowBalanceThresholdMicros : w.pricePerMessageMicros * 200;
    if (w.availableMicros > threshold) return;
    const { getRedis } = await import('./redis.js');
    const flag = `walletlow:${orgId}`;
    const claimed = await getRedis().set(flag, '1', 'EX', 60 * 60 * 24 * 7, 'NX');
    if (claimed !== 'OK') return; // already notified this drop
    const { createNotification } = await import('./notifications.js');
    const paused = w.availableMicros < w.pricePerMessageMicros;
    const { formatMicrosUsd } = await import('@platform/shared');
    await createNotification({
      organizationId: orgId,
      kind: 'quota_warning',
      severity: paused ? 'error' : 'warning',
      title: paused ? 'WhatsApp sending paused — balance too low' : 'WhatsApp balance running low',
      body: paused
        ? `Your balance ($${formatMicrosUsd(w.availableMicros)}) can't cover another message. Top up to keep sending broadcasts.`
        : `Your balance is $${formatMicrosUsd(w.availableMicros)} — about ${Math.floor(w.availableMicros / w.pricePerMessageMicros)} messages left. Top up soon.`,
      link: '/billing',
    });
  } catch {
    /* best-effort */
  }
}

/** Clear the low-balance "already notified" flag (called on top-up). */
export async function rearmLowBalance(orgId: string): Promise<void> {
  try {
    const { getRedis } = await import('./redis.js');
    // Clear the low-balance flag AND the fired %-threshold set so both re-arm
    // for the fresh top-up cycle.
    await getRedis().del(`walletlow:${orgId}`, `walletalert:${orgId}`);
  } catch {
    /* best-effort */
  }
}

export { DEFAULT_META_COST_MICROS };
