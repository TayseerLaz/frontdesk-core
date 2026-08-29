// F5 — back-in-stock notify tick (roadmap 2026-08-26).
//
// Every 5 minutes (Redis lock, single runner): find pending stock watches
// whose product/service is available again and notify the customer on
// WhatsApp. The tick IS the restock trigger — no per-write-path hooks to
// forget (CSV import, connector sync, Shopify commit, and manual edits all
// funnel through the same availability columns this scans). ≤5 min latency.
//
// Send rails (the follow-up-tick pattern, do not remove):
//   • org must be active AND have the `stock_watch` feature enabled
//   • contact optedOutAt / blockedAt / deletedAt gates
//   • inside the 24h session window → free text; outside → the APPROVED local
//     `back_in_stock` template ({{1}} name, {{2}} product) — no approved row
//     ⇒ that send silently stays pending (feature is inert until Meta approves)
//   • wallet metering: canAfford → send → chargeAtSend
//   • hard per-org per-tick budget so a 500-watcher restock drains gradually
//   • claim-then-rollback on notifiedAt so a crashed send retries next tick
import { prisma } from './db.js';
import { recordOutboundTemplate } from './inbox-consistency.js';
import { getConnection } from '../lib/redis.js';
import { canAfford, chargeAtSend, resolveMeteredPrice } from '../lib/wallet.js';
import { restockMessageText, stockWatchPrefersArabic } from '@platform/shared';

const TICK_INTERVAL_MS = Number(process.env.STOCK_WATCH_TICK_INTERVAL_MS ?? 5 * 60_000);
const TICK_LOCK_TTL_S = Math.ceil(TICK_INTERVAL_MS / 1000) + 5;
const TICK_LOCK_KEY = 'lock:stock-watch-tick';
const MAX_SENDS_PER_ORG_TICK = 30;
const TEMPLATE_NAME = 'back_in_stock';
const WINDOW_MS = 24 * 3_600_000;

type Template = { id: string; name: string; language: string; bodyText: string | null };
type Channel = { id: string; accessToken: string | null; phoneNumberId: string | null; isPrimary: boolean };

function pickTemplate(rows: Template[], preferArabic: boolean): Template | null {
  if (rows.length === 0) return null;
  const ar = rows.find((r) => r.language.toLowerCase().startsWith('ar'));
  const other = rows.find((r) => !r.language.toLowerCase().startsWith('ar'));
  return (preferArabic ? (ar ?? other) : (other ?? ar)) ?? rows[0] ?? null;
}

// Template send with TWO body params: {{1}} customer name, {{2}} entity name.
async function sendTemplate(args: {
  token: string;
  phoneNumberId: string;
  to: string;
  template: Template;
  customerName: string;
  entityName: string;
}): Promise<{ ok: boolean; metaMessageId: string | null; error: string | null }> {
  const payload = {
    messaging_product: 'whatsapp',
    to: args.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: args.template.name,
      language: { code: args.template.language },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text' as const, text: args.customerName },
            { type: 'text' as const, text: args.entityName },
          ],
        },
      ],
    },
  };
  return callMeta(args.token, args.phoneNumberId, payload);
}

async function sendText(args: {
  token: string;
  phoneNumberId: string;
  to: string;
  body: string;
}): Promise<{ ok: boolean; metaMessageId: string | null; error: string | null }> {
  return callMeta(args.token, args.phoneNumberId, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: args.to.replace(/^\+/, ''),
    type: 'text',
    text: { preview_url: false, body: args.body },
  });
}

async function callMeta(
  token: string,
  phoneNumberId: string,
  payload: unknown,
): Promise<{ ok: boolean; metaMessageId: string | null; error: string | null }> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

async function processOrg(orgId: string, now: Date): Promise<void> {
  // Ready watches: pending + entity back in stock. Oldest asks first.
  const watches = await prisma.stockWatch.findMany({
    where: {
      organizationId: orgId,
      notifiedAt: null,
      OR: [
        { product: { isAvailable: true, deletedAt: null } },
        { service: { isAvailable: true, deletedAt: null } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: {
      product: { select: { name: true } },
      service: { select: { name: true } },
      contact: {
        select: {
          phoneE164: true,
          displayName: true,
          optedOutAt: true,
          blockedAt: true,
          deletedAt: true,
          lastInboundAt: true,
        },
      },
      thread: { select: { whatsAppChannelId: true } },
    },
  });
  if (watches.length === 0) return;
  if (watches.length > 100) {
    console.warn(`[stock-watch] org ${orgId} has ${watches.length}+ ready watchers — restock costs like a small broadcast`);
  }

  const channels: Channel[] = await prisma.whatsAppChannel.findMany({
    where: { organizationId: orgId, isActive: true },
    select: { id: true, accessToken: true, phoneNumberId: true, isPrimary: true },
  });
  const primary =
    channels.find((c) => c.isPrimary && c.accessToken && c.phoneNumberId) ??
    channels.find((c) => c.accessToken && c.phoneNumberId) ??
    null;
  if (!primary) return;

  const templateRows: Template[] = await prisma.whatsAppTemplate.findMany({
    where: { organizationId: orgId, name: TEMPLATE_NAME, status: 'approved' },
    select: { id: true, name: true, language: true, bodyText: true },
  });

  const metered = await resolveMeteredPrice(orgId);
  let budget = MAX_SENDS_PER_ORG_TICK;

  for (const w of watches) {
    if (budget <= 0) return;
    const c = w.contact;
    if (c.optedOutAt || c.blockedAt || c.deletedAt) continue;
    const entityName = w.product?.name ?? w.service?.name;
    if (!entityName) continue;

    // Threads send from their own number, resolved ONLY within this org's
    // pre-loaded channels (H-3); primary otherwise.
    const channel =
      (w.thread?.whatsAppChannelId
        ? channels.find((ch) => ch.id === w.thread!.whatsAppChannelId && ch.accessToken && ch.phoneNumberId)
        : null) ?? primary;
    if (!channel.accessToken || !channel.phoneNumberId) continue;

    const inWindow =
      c.lastInboundAt != null && now.getTime() - c.lastInboundAt.getTime() < WINDOW_MS;
    const preferArabic = stockWatchPrefersArabic(w.inquiryText);
    const template = inWindow ? null : pickTemplate(templateRows, preferArabic);
    if (!inWindow && !template) continue; // outside window, nothing approved — stays pending

    if (metered && !(await canAfford(orgId, metered.priceMicros))) return;

    // Claim BEFORE the network call so a duplicate tick can't double-send;
    // roll back on failure so the next tick retries.
    const claim = await prisma.stockWatch.updateMany({
      where: { id: w.id, notifiedAt: null },
      data: { notifiedAt: now },
    });
    if (claim.count === 0) continue;

    const to = c.phoneE164.replace(/^\+/, '');
    const customerName = c.displayName?.trim() || (preferArabic ? 'عميلنا العزيز' : 'there');
    const out = inWindow
      ? await sendText({
          token: channel.accessToken,
          phoneNumberId: channel.phoneNumberId,
          to,
          body: restockMessageText(preferArabic ? 'ar' : 'en', entityName),
        })
      : await sendTemplate({
          token: channel.accessToken!,
          phoneNumberId: channel.phoneNumberId!,
          to,
          template: template!,
          customerName,
          entityName,
        });

    if (!out.ok) {
      console.error('[stock-watch] send failed', { orgId, watch: w.id, error: out.error });
      await prisma.stockWatch.updateMany({
        where: { id: w.id, notifiedAt: now },
        data: { notifiedAt: null },
      });
      continue;
    }

    // Persist into the inbox (find-or-create thread) so operators see it.
    const renderedBody = inWindow
      ? restockMessageText(preferArabic ? 'ar' : 'en', entityName)
      : (template!.bodyText ?? '')
          .replace(/\{\{\s*1\s*\}\}/g, customerName)
          .replace(/\{\{\s*2\s*\}\}/g, entityName) || `🔔 Back in stock: ${entityName}`;
    await recordOutboundTemplate({
      organizationId: orgId,
      toNumber: to,
      metaMessageId: out.metaMessageId,
      templateName: TEMPLATE_NAME,
      whatsAppChannelId: channel.id,
      renderedBody,
    });

    if (metered) {
      await chargeAtSend({
        orgId,
        unitPriceMicros: metered.priceMicros,
        metaCostMicros: metered.metaCostMicros,
      });
    }
    budget -= 1;
    console.log('[stock-watch] notified', { orgId, watch: w.id, entityName, inWindow });
  }
}

async function tick(): Promise<void> {
  const redis = getConnection();
  const lock = await redis.set(TICK_LOCK_KEY, '1', 'EX', TICK_LOCK_TTL_S, 'NX');
  if (lock !== 'OK') return;
  const now = new Date();

  // Only orgs that actually have pending watches — one grouped query.
  const pending = await prisma.stockWatch.groupBy({
    by: ['organizationId'],
    where: { notifiedAt: null },
    _count: { _all: true },
  });
  if (pending.length === 0) return;

  const orgs = await prisma.organization.findMany({
    where: { id: { in: pending.map((p) => p.organizationId) }, status: 'active' },
    select: { id: true, disabledFeatures: true },
  });
  for (const org of orgs) {
    if ((org.disabledFeatures ?? []).includes('stock_watch')) continue;
    try {
      await processOrg(org.id, now);
    } catch (err) {
      console.error('[stock-watch] org failed', org.id, err);
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;

export function startStockWatchTick(): { close: () => Promise<void>; name: string } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[stock-watch-tick] error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // Stagger 17s after boot so we don't race the other ticks for Redis.
  timer = setTimeout(run, 17_000);
  return {
    name: 'stock-watch-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
