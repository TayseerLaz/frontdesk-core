// Phone-task tick — runs inside the API process every 30 s.
//
// Two jobs:
//   1. POLL. CALL-E posts a webhook when a call ends, but localhost and any
//      box without CALLE_WEBHOOK_TOKEN never receive it, so every non-terminal
//      task older than a few seconds is polled via GET /v1/calls/{id} (or, in
//      dry-run, completed synthetically once it has "rung" for 15 s). Webhook
//      and poll converge on applyResult's compare-and-set, so both can run.
//   2. AUTO-CONFIRM. For tenants with phoneTaskSettings.codAutoConfirm, every
//      cash-on-delivery order (cart status 'new', no online payment) older than
//      delayMinutes that has no phone task yet gets one. Bounded per tick so a
//      backlog can never burst a tenant's daily cap in one go.
//
// Same shape as wallet-alert-tick: setTimeout loop, never throws out, one
// in-process guard against overlapping runs.
import { prisma } from '@platform/db';
import type { FastifyBaseLogger } from 'fastify';

import { createPhoneTask, parseSettings, refreshPhoneTask } from './phone-tasks.js';

const TICK_INTERVAL_MS = Number(process.env.PHONE_TASK_TICK_INTERVAL_MS ?? 30_000);
const POLL_MIN_AGE_MS = 5_000;
const AUTO_MAX_PER_ORG_PER_TICK = 5;
const AUTO_LOOKBACK_MS = 24 * 60 * 60 * 1000;

let stopped = false;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function pollOpenTasks(log: FastifyBaseLogger): Promise<void> {
  const open = await prisma.phoneTask.findMany({
    where: {
      status: { in: ['queued', 'in_progress'] },
      calleCallId: { not: null },
      createdAt: { lt: new Date(Date.now() - POLL_MIN_AGE_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  for (const task of open) {
    try {
      await refreshPhoneTask(task);
    } catch (err) {
      log.warn({ err, phoneTaskId: task.id }, 'phone-task poll failed');
    }
  }
}

async function autoConfirmCod(log: FastifyBaseLogger): Promise<void> {
  const orgs = await prisma.organization.findMany({
    where: { phoneTaskSettings: { not: { equals: null } as never } },
    select: { id: true, phoneTaskSettings: true, disabledFeatures: true },
  });
  for (const org of orgs) {
    const settings = parseSettings(org.phoneTaskSettings);
    if (!settings.codAutoConfirm) continue;
    if (org.disabledFeatures.includes('phone_tasks')) continue;
    const cutoff = new Date(Date.now() - settings.delayMinutes * 60_000);
    const carts = await prisma.cart.findMany({
      where: {
        organizationId: org.id,
        status: 'new',
        paymentStatus: null, // cash on delivery = no online payment in flight
        createdAt: { lte: cutoff, gte: new Date(Date.now() - AUTO_LOOKBACK_MS) },
        itemsCount: { gt: 0 },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    let placed = 0;
    for (const cart of carts) {
      if (placed >= AUTO_MAX_PER_ORG_PER_TICK) break;
      const existing = await prisma.phoneTask.count({
        where: { organizationId: org.id, targetType: 'cart', targetId: cart.id },
      });
      if (existing > 0) continue;
      try {
        await createPhoneTask({
          orgId: org.id,
          body: { kind: 'cod_order_confirm', cartId: cart.id },
          createdById: null,
          source: 'auto',
        });
        placed += 1;
      } catch (err) {
        // Cap reached / opted out / unsupported region: logged, not retried
        // this tick. Unsupported-region carts already got a failed row, so
        // `existing > 0` stops them being retried forever.
        log.info({ err: err instanceof Error ? err.message : err, cartId: cart.id }, 'auto phone confirm skipped');
      }
    }
  }
}

async function runOnce(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  try {
    await pollOpenTasks(log);
    await autoConfirmCod(log);
  } catch (err) {
    log.error({ err }, 'phone-task tick failed');
  } finally {
    running = false;
  }
}

export function startPhoneTaskTick(log: FastifyBaseLogger): { name: string; stop: () => void } {
  stopped = false;
  const loop = async () => {
    if (stopped) return;
    await runOnce(log);
    if (!stopped) timer = setTimeout(loop, TICK_INTERVAL_MS);
  };
  timer = setTimeout(loop, 3_000);
  return {
    name: 'phone-task-tick',
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
