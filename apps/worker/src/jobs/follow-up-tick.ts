// Follow-up tick — automated re-engagement over approved WhatsApp templates.
//
// Every 5 minutes (Redis-locked, single replica), for every org whose
// `follow_ups` feature is enabled AND whose BotConfig.followUps master switch
// is on, run the three sub-engines from @platform/shared/follow-ups:
//
//   noReply      — thread answered but customer silent firstDelayHours →
//                  follow-up #1; still silent secondDelayHours later →
//                  follow-up #2, then the cadence closes. A customer reply
//                  re-opens it (derived from lastInboundAt vs
//                  followUpLastSentAt — nothing is written on the inbound
//                  hot path).
//   afterBooking — confirmed/completed booking whose appointment passed
//                  delayHours ago → one post-visit check-in, ever.
//   idleCheckin  — real past customer quiet for idleDays → casual check-in,
//                  spaced at least idleDays apart.
//
// Discipline copied from booking-reminder-tick: compare-and-set claim BEFORE
// the Meta call (two replicas can't double-send), roll the stamp back on a
// failed send so the next tick retries. Sends respect Contact optedOutAt /
// blockedAt / deletedAt, wallet metering (sequence-tick pattern), and a hard
// per-org per-tick budget so enabling the feature can never burst a number.
import { prisma } from './db.js';
import { recordOutboundTemplate } from './inbox-consistency.js';
import { getConnection } from '../lib/redis.js';
import { canAfford, chargeAtSend, resolveMeteredPrice } from '../lib/wallet.js';
import {
  FOLLOW_UP_IDLE_LOOKBACK_DAYS,
  FOLLOW_UP_MAX_SENDS_PER_ORG_TICK,
  FOLLOW_UP_NO_REPLY_LOOKBACK_DAYS,
  afterBookingDue,
  idleCheckinDue,
  noReplyAction,
  normalizeFollowUpsConfig,
  templateWantsName,
  type FollowUpsConfig,
} from '@platform/shared';

const TICK_INTERVAL_MS = Number(process.env.FOLLOW_UP_TICK_INTERVAL_MS ?? 5 * 60_000);
const TICK_LOCK_TTL_S = Math.ceil(TICK_INTERVAL_MS / 1000) + 5;
const TICK_LOCK_KEY = 'lock:follow-up-tick';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Template = {
  id: string;
  name: string;
  language: string;
  bodyText: string | null;
};

type Channel = {
  id: string;
  accessToken: string | null;
  phoneNumberId: string | null;
  isPrimary: boolean;
};

function hasArabic(s: string | null | undefined): boolean {
  return /[؀-ۿ]/.test(s ?? '');
}

// One template NAME can have several language rows — pick the one matching the
// customer's script (Arabic text → an ar_* row when it exists), else prefer a
// non-Arabic row, else whatever is approved.
function pickTemplate(rows: Template[], preferArabic: boolean): Template | null {
  if (rows.length === 0) return null;
  const ar = rows.find((r) => r.language.toLowerCase().startsWith('ar'));
  const other = rows.find((r) => !r.language.toLowerCase().startsWith('ar'));
  return (preferArabic ? (ar ?? other) : (other ?? ar)) ?? rows[0] ?? null;
}

async function callMeta(args: {
  token: string;
  phoneNumberId: string;
  to: string;
  templateName: string;
  language: string;
  nameParam: string | null; // fills {{1}} when the template wants it
}): Promise<{ ok: boolean; metaMessageId: string | null; error: string | null }> {
  const components =
    args.nameParam !== null
      ? [{ type: 'body', parameters: [{ type: 'text' as const, text: args.nameParam }] }]
      : [];
  const payload = {
    messaging_product: 'whatsapp',
    to: args.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: args.templateName,
      language: { code: args.language },
      ...(components.length ? { components } : {}),
    },
  };
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(args.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const text = await res.text();
    if (res.ok) {
      try {
        const body = JSON.parse(text) as { messages?: { id?: string }[] };
        return { ok: true, metaMessageId: body.messages?.[0]?.id ?? null, error: null };
      } catch {
        return { ok: false, metaMessageId: null, error: 'unparseable response' };
      }
    }
    return { ok: false, metaMessageId: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, metaMessageId: null, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

// STOP/blocked/deleted gate + display name, keyed the way contacts actually
// store phones (with or without a leading '+' — the platform-lead-outreach
// precedent).
async function contactGate(
  organizationId: string,
  phoneDigits: string,
): Promise<{ allowed: boolean; displayName: string | null }> {
  const contact = await prisma.contact.findFirst({
    where: {
      organizationId,
      phoneE164: { in: [phoneDigits, `+${phoneDigits}`] },
    },
    select: { optedOutAt: true, blockedAt: true, deletedAt: true, displayName: true },
  });
  if (!contact) return { allowed: true, displayName: null };
  if (contact.optedOutAt || contact.blockedAt || contact.deletedAt)
    return { allowed: false, displayName: null };
  return { allowed: true, displayName: contact.displayName ?? null };
}

type OrgSendCtx = {
  orgId: string;
  cfg: FollowUpsConfig;
  enabledAt: Date;
  channels: Channel[];
  primary: Channel | null;
  templatesByName: Map<string, Template[]>;
  metered: { priceMicros: number; metaCostMicros: number } | null;
  budget: { left: number };
};

// Send one follow-up template. Returns true only on a confirmed Meta send.
async function sendFollowUp(
  ctx: OrgSendCtx,
  args: {
    channel: Channel;
    toPhoneDigits: string;
    templateName: string;
    preferArabic: boolean;
    customerName: string | null;
    reason: 'no_reply_1' | 'no_reply_2' | 'after_booking' | 'idle_checkin';
  },
): Promise<boolean> {
  const rows = ctx.templatesByName.get(args.templateName) ?? [];
  const template = pickTemplate(rows, args.preferArabic);
  if (!template) return false;
  if (!args.channel.accessToken || !args.channel.phoneNumberId) return false;

  if (ctx.metered && !(await canAfford(ctx.orgId, ctx.metered.priceMicros))) return false;

  const nameParam = templateWantsName(template.bodyText)
    ? (args.customerName?.trim() || 'there')
    : null;
  const out = await callMeta({
    token: args.channel.accessToken,
    phoneNumberId: args.channel.phoneNumberId,
    to: args.toPhoneDigits,
    templateName: template.name,
    language: template.language,
    nameParam,
  });
  if (!out.ok) {
    console.error('[follow-up] meta send failed', {
      orgId: ctx.orgId,
      reason: args.reason,
      template: template.name,
      error: out.error,
    });
    return false;
  }

  const renderedBody =
    nameParam !== null
      ? (template.bodyText ?? '').replace(/\{\{\s*1\s*\}\}/g, nameParam)
      : (template.bodyText ?? null);
  await recordOutboundTemplate({
    organizationId: ctx.orgId,
    toNumber: args.toPhoneDigits,
    metaMessageId: out.metaMessageId,
    templateName: template.name,
    whatsAppChannelId: args.channel.id,
    renderedBody,
  });
  if (ctx.metered) {
    await chargeAtSend({
      orgId: ctx.orgId,
      unitPriceMicros: ctx.metered.priceMicros,
      metaCostMicros: ctx.metered.metaCostMicros,
    });
  }
  ctx.budget.left -= 1;
  return true;
}

// Threads send from the number the conversation lives on (multi-number);
// fall back to the org's primary. Channels are pre-loaded and org-scoped, so
// a foreign channel id can never resolve (the sequence-tick H-3 lesson).
function channelForThread(ctx: OrgSendCtx, threadChannelId: string | null): Channel | null {
  if (threadChannelId) {
    const own = ctx.channels.find((c) => c.id === threadChannelId);
    if (own?.accessToken && own.phoneNumberId) return own;
  }
  return ctx.primary;
}

async function lastInboundBody(threadId: string): Promise<string | null> {
  const m = await prisma.whatsAppMessage.findFirst({
    where: { threadId, direction: 'inbound' },
    orderBy: { receivedAt: 'desc' },
    select: { body: true },
  });
  return m?.body ?? null;
}

async function runNoReply(ctx: OrgSendCtx, now: Date): Promise<void> {
  const cfg = ctx.cfg.noReply;
  if (!cfg.enabled || !cfg.templateName || ctx.budget.left <= 0) return;
  const candidates = await prisma.whatsAppThread.findMany({
    where: {
      organizationId: ctx.orgId,
      channel: 'whatsapp',
      inboundCount: { gt: 0 },
      followUpStage: { lt: 2 },
      lastInboundAt: {
        gte: new Date(
          Math.max(
            ctx.enabledAt.getTime(),
            now.getTime() - FOLLOW_UP_NO_REPLY_LOOKBACK_DAYS * DAY_MS,
          ),
        ),
        lte: new Date(now.getTime() - cfg.firstDelayHours * HOUR_MS),
      },
    },
    orderBy: { lastInboundAt: 'desc' },
    take: 300,
    select: {
      id: true,
      customerPhone: true,
      customerName: true,
      customerWhatsappName: true,
      whatsAppChannelId: true,
      lastInboundAt: true,
      lastMessageAt: true,
      inboundCount: true,
      followUpStage: true,
      followUpLastSentAt: true,
    },
  });
  for (const t of candidates) {
    if (ctx.budget.left <= 0) return;
    const action = noReplyAction(t, cfg, ctx.enabledAt, now);
    if (action === 'none') continue;
    const gate = await contactGate(ctx.orgId, t.customerPhone);
    if (!gate.allowed) continue;
    const channel = channelForThread(ctx, t.whatsAppChannelId);
    if (!channel) continue;

    // Claim BEFORE the send: CAS on the exact stage we decided from. A racing
    // replica (or a customer reply landing mid-tick after our read) makes the
    // update match 0 rows and we walk away.
    const nextStage = action === 'send_first' ? 1 : 2;
    const claim = await prisma.whatsAppThread.updateMany({
      where: { id: t.id, followUpStage: t.followUpStage },
      data: { followUpStage: nextStage, followUpLastSentAt: now },
    });
    if (claim.count === 0) continue;

    const sent = await sendFollowUp(ctx, {
      channel,
      toPhoneDigits: t.customerPhone,
      templateName: cfg.templateName,
      preferArabic: hasArabic(await lastInboundBody(t.id)),
      customerName: t.customerName ?? t.customerWhatsappName ?? gate.displayName,
      reason: action === 'send_first' ? 'no_reply_1' : 'no_reply_2',
    });
    if (!sent) {
      // Roll the claim back so the next tick retries.
      await prisma.whatsAppThread.updateMany({
        where: { id: t.id, followUpStage: nextStage },
        data: { followUpStage: t.followUpStage, followUpLastSentAt: t.followUpLastSentAt },
      });
    }
  }
}

async function runAfterBooking(ctx: OrgSendCtx, now: Date): Promise<void> {
  const cfg = ctx.cfg.afterBooking;
  if (!cfg.enabled || !cfg.templateName || ctx.budget.left <= 0 || !ctx.primary) return;
  const candidates = await prisma.booking.findMany({
    where: {
      organizationId: ctx.orgId,
      followUpSentAt: null,
      status: { in: ['confirmed', 'completed'] },
      appointmentAt: {
        gte: ctx.enabledAt,
        lte: new Date(now.getTime() - cfg.delayHours * HOUR_MS),
      },
    },
    take: 200,
    select: {
      id: true,
      customerPhone: true,
      customerName: true,
      appointmentAt: true,
      followUpSentAt: true,
      status: true,
    },
  });
  for (const b of candidates) {
    if (ctx.budget.left <= 0) return;
    if (!afterBookingDue(b, cfg, ctx.enabledAt, now)) continue;
    const phoneDigits = b.customerPhone.replace(/[^0-9]/g, '');
    if (!phoneDigits) continue;
    const gate = await contactGate(ctx.orgId, phoneDigits);
    if (!gate.allowed) continue;

    const claim = await prisma.booking.updateMany({
      where: { id: b.id, followUpSentAt: null },
      data: { followUpSentAt: now },
    });
    if (claim.count === 0) continue;

    const sent = await sendFollowUp(ctx, {
      channel: ctx.primary,
      toPhoneDigits: phoneDigits,
      templateName: cfg.templateName,
      preferArabic: hasArabic(b.customerName),
      customerName: b.customerName ?? gate.displayName,
      reason: 'after_booking',
    });
    if (!sent) {
      await prisma.booking.updateMany({
        where: { id: b.id, followUpSentAt: now },
        data: { followUpSentAt: null },
      });
    }
  }
}

async function runIdleCheckin(ctx: OrgSendCtx, now: Date): Promise<void> {
  const cfg = ctx.cfg.idleCheckin;
  if (!cfg.enabled || !cfg.templateName || ctx.budget.left <= 0) return;
  const candidates = await prisma.whatsAppThread.findMany({
    where: {
      organizationId: ctx.orgId,
      channel: 'whatsapp',
      inboundCount: { gt: 0 },
      lastInboundAt: { gte: new Date(now.getTime() - FOLLOW_UP_IDLE_LOOKBACK_DAYS * DAY_MS) },
      lastMessageAt: { lte: new Date(now.getTime() - cfg.idleDays * DAY_MS) },
    },
    // Most-recently-active first: the warmest contacts get the budget.
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
    select: {
      id: true,
      customerPhone: true,
      customerName: true,
      customerWhatsappName: true,
      whatsAppChannelId: true,
      lastInboundAt: true,
      lastMessageAt: true,
      inboundCount: true,
      followUpStage: true,
      followUpLastSentAt: true,
    },
  });
  for (const t of candidates) {
    if (ctx.budget.left <= 0) return;
    if (!idleCheckinDue(t, cfg, now)) continue;
    const gate = await contactGate(ctx.orgId, t.customerPhone);
    if (!gate.allowed) continue;
    const channel = channelForThread(ctx, t.whatsAppChannelId);
    if (!channel) continue;

    // Claim: stamp the send AND close any half-open no-reply cadence (stage 2)
    // so the two engines can't ping-pong on one thread. CAS on the previous
    // stamp value.
    const claim = await prisma.whatsAppThread.updateMany({
      where: { id: t.id, followUpLastSentAt: t.followUpLastSentAt },
      data: { followUpLastSentAt: now, followUpStage: 2 },
    });
    if (claim.count === 0) continue;

    const sent = await sendFollowUp(ctx, {
      channel,
      toPhoneDigits: t.customerPhone,
      templateName: cfg.templateName,
      preferArabic: hasArabic(await lastInboundBody(t.id)),
      customerName: t.customerName ?? t.customerWhatsappName ?? gate.displayName,
      reason: 'idle_checkin',
    });
    if (!sent) {
      await prisma.whatsAppThread.updateMany({
        where: { id: t.id, followUpLastSentAt: now },
        data: { followUpLastSentAt: t.followUpLastSentAt, followUpStage: t.followUpStage },
      });
    }
  }
}

async function processOrg(orgId: string, rawConfig: unknown, now: Date): Promise<void> {
  const cfg = normalizeFollowUpsConfig(rawConfig);
  if (!cfg?.enabled || !cfg.enabledAt) return;
  const enabledAt = new Date(cfg.enabledAt);
  if (Number.isNaN(enabledAt.getTime())) return;

  const names = [cfg.noReply, cfg.afterBooking, cfg.idleCheckin]
    .filter((c) => c.enabled && c.templateName)
    .map((c) => c.templateName as string);
  if (names.length === 0) return;

  const channels: Channel[] = await prisma.whatsAppChannel.findMany({
    where: { organizationId: orgId, isActive: true },
    select: { id: true, accessToken: true, phoneNumberId: true, isPrimary: true },
  });
  const primary =
    channels.find((c) => c.isPrimary && c.accessToken && c.phoneNumberId) ??
    channels.find((c) => c.accessToken && c.phoneNumberId) ??
    null;
  if (!primary) return;

  const templateRows = await prisma.whatsAppTemplate.findMany({
    where: { organizationId: orgId, name: { in: names }, status: 'approved' },
    select: { id: true, name: true, language: true, bodyText: true },
  });
  const templatesByName = new Map<string, Template[]>();
  for (const row of templateRows) {
    const list = templatesByName.get(row.name) ?? [];
    list.push(row);
    templatesByName.set(row.name, list);
  }
  if (templatesByName.size === 0) return; // nothing approved yet — inert

  const ctx: OrgSendCtx = {
    orgId,
    cfg,
    enabledAt,
    channels,
    primary,
    templatesByName,
    metered: await resolveMeteredPrice(orgId),
    budget: { left: FOLLOW_UP_MAX_SENDS_PER_ORG_TICK },
  };

  await runNoReply(ctx, now);
  await runAfterBooking(ctx, now);
  await runIdleCheckin(ctx, now);
}

async function tick(): Promise<void> {
  const redis = getConnection();
  const lock = await redis.set(TICK_LOCK_KEY, '1', 'EX', TICK_LOCK_TTL_S, 'NX');
  if (lock !== 'OK') return;
  const now = new Date();

  // ~1 row per org — cheap to pull and filter in JS (no worker-side feature
  // gate exists elsewhere; this tick reads disabledFeatures itself).
  const configs = await prisma.botConfig.findMany({
    select: {
      organizationId: true,
      followUps: true,
      organization: { select: { disabledFeatures: true, status: true } },
    },
  });
  for (const c of configs) {
    if (!c.followUps) continue;
    if (c.organization.status !== 'active') continue;
    if ((c.organization.disabledFeatures ?? []).includes('follow_ups')) continue;
    try {
      await processOrg(c.organizationId, c.followUps, now);
    } catch (err) {
      console.error('[follow-up] org failed', c.organizationId, err);
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;

export function startFollowUpTick(): { close: () => Promise<void>; name: string } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[follow-up-tick] error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // Stagger 11s after boot so we don't race the other ticks for Redis.
  timer = setTimeout(run, 11_000);
  return {
    name: 'follow-up-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
