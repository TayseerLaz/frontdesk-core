// Wallet balance-depletion alert tick.
//
// HQ configures per-tenant % thresholds (50/75/80/90/100 of the last top-up
// used). This tick runs in the API process every few minutes, and when a
// metered tenant's balance crosses one of its thresholds it fires ONE
// notification (to the tenant + every ALIGNED admin) for the highest new level.
// Dedup is a Redis set `walletalert:{org}` of already-fired thresholds, which is
// cleared on the next top-up (see wallet.rearmLowBalance) so alerts re-arm each
// cycle. Cheap + idempotent: steady-state ticks send nothing.

import { prisma } from '@platform/db';

import { createNotification } from './notifications.js';
import { getRedis } from './redis.js';
import { walletAlertState, type Wallet } from './wallet.js';

const TICK_INTERVAL_MS = Number(process.env.WALLET_ALERT_TICK_INTERVAL_MS ?? 3 * 60 * 1000); // 3 min
const FIRED_TTL_S = 90 * 24 * 60 * 60; // 90 days safety cleanup for orphan keys

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const N = (b: bigint | number | null | undefined): number => (b == null ? 0 : Number(b));

type WalletModelRow = {
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

function toWallet(r: WalletModelRow): Wallet {
  return {
    organizationId: r.organizationId,
    meteringEnabled: r.meteringEnabled,
    availableMicros: N(r.availableMicros),
    heldMicros: N(r.heldMicros),
    pricePerMessageMicros: N(r.pricePerMessageMicros),
    metaCostMicros: N(r.metaCostMicros),
    lowBalanceThresholdMicros: N(r.lowBalanceThresholdMicros),
    lifetimeToppedUpMicros: N(r.lifetimeToppedUpMicros),
    lifetimeSpentMicros: N(r.lifetimeSpentMicros),
    lifetimeMessages: r.lifetimeMessages,
    alertThresholds: r.alertThresholds ?? [],
    alertBaselineMicros: N(r.alertBaselineMicros),
  };
}

async function notifyAlignedAdmins(severity: 'warning' | 'error', title: string, body: string): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { isSuperAdmin: true },
    select: { id: true, memberships: { select: { organizationId: true }, take: 1 } },
  });
  for (const a of admins) {
    const orgId = a.memberships[0]?.organizationId;
    if (!orgId) continue;
    await createNotification({
      organizationId: orgId,
      targetUserId: a.id,
      kind: 'quota_warning',
      severity,
      title,
      body,
      link: '/hq',
    });
  }
}

async function tick(): Promise<void> {
  const rows = (await prisma.tenantWallet.findMany({
    where: { meteringEnabled: true, alertBaselineMicros: { gt: 0 } },
  })) as unknown as WalletModelRow[];
  if (!rows.length) return;
  const redis = getRedis();

  for (const row of rows) {
    if (!row.alertThresholds?.length) continue;
    const w = toWallet(row);
    const st = walletAlertState(w);
    if (st.crossedThreshold == null) continue;

    const key = `walletalert:${row.organizationId}`;
    // Only notify when THIS level is newly crossed (SADD returns 1 = added).
    const added = await redis.sadd(key, String(st.crossedThreshold));
    if (added !== 1) continue;
    // Mark all lower already-crossed thresholds fired too, so they never fire
    // retroactively, and set a safety TTL on the key.
    const lower = w.alertThresholds.filter((t) => t < st.crossedThreshold! && st.pctUsed >= t);
    if (lower.length) await redis.sadd(key, ...lower.map(String));
    await redis.expire(key, FIRED_TTL_S);

    const org = await prisma.organization.findUnique({
      where: { id: row.organizationId },
      select: { name: true },
    });
    const isEmpty = st.level === 'empty';
    await createNotification({
      organizationId: row.organizationId,
      kind: 'quota_warning',
      severity: isEmpty ? 'error' : 'warning',
      title: isEmpty
        ? 'WhatsApp balance empty — sending paused'
        : `WhatsApp balance ${st.pctUsed}% used`,
      body: st.message ?? '',
      link: '/billing',
    });
    await notifyAlignedAdmins(
      isEmpty ? 'error' : 'warning',
      isEmpty
        ? `${org?.name ?? 'A tenant'}: WhatsApp balance empty (sending paused)`
        : `${org?.name ?? 'A tenant'}: WhatsApp balance ${st.pctUsed}% used`,
      st.message ?? '',
    );
    console.log(
      `[wallet-alert] ${org?.name ?? row.organizationId} crossed ${st.crossedThreshold}% (used ${st.pctUsed}%)`,
    );
  }
}

export function startWalletAlertTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[wallet-alert] error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  timer = setTimeout(run, 60 * 1000); // first run 60s after boot
  return {
    name: 'wallet-alert-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
