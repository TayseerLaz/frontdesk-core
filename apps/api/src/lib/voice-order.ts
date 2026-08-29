// Voice order capture — turns a structured order from the phone voicebot's
// `submit_order` tool into a real Cart (status 'new'), exactly like a WhatsApp/
// Messenger order, so it shows in /cart and alerts operators. Reuses the shared
// captureCart (cart-flow.ts) for line-item + delivery + total math; the
// voice-specific parts are:
//   (1) matching SPOKEN item names to the catalog (the realtime model never
//       sees SKUs) — unmatched lines land at price 0 with needsPricing=true;
//   (2) the absence of an inbox thread — threadId is null, so we always fire an
//       operator notification + webhook;
//   (3) idempotency — a retried submit_order for the same callUuid returns the
//       existing order instead of creating a duplicate (no double bill);
//   (4) continueExisting — append to the caller's most recent OPEN order;
//   (5) server-side guards — minimum order + required shopForm fields, so a
//       misbehaving LLM can't create an unfulfillable order.
import type { BotData } from './bot-engine.js';
import { captureCart } from './cart-flow.js';
import { withTenant } from './db.js';
import { createNotification } from './notifications.js';
import { dispatchVoiceOrderBill } from './voice-payment.js';
import { emitWebhookEvent } from './webhooks.js';

type CatalogLite = { id: string; sku: string; name: string; priceMinor: number | null };

// Lowercase, strip punctuation (keep Arabic block), collapse whitespace — the
// same normalisation idea as cart-parser, so "Zaatar Manakish" ≈ "zaatar
// manakish" and Arabic names compare cleanly.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort match of a spoken item name to a catalog product. Bidirectional
 * (unlike cart-parser's findProduct which only checks catalog⊆fragment) because
 * a caller may say a shorter or longer phrase than the exact menu name. Scores:
 * exact > one contains the other > shared-token count > literal SKU.
 */
export function matchProduct(spokenName: string, catalog: CatalogLite[]): CatalogLite | null {
  const q = normalize(spokenName);
  if (!q) return null;
  const qTokens = new Set(q.split(' ').filter((t) => t.length >= 3));
  let best: { p: CatalogLite; score: number } | null = null;
  for (const p of catalog) {
    const n = normalize(p.name);
    if (!n) continue;
    let score = 0;
    if (n === q) score = 1000;
    else if (q.includes(n)) score = 500 + n.length;
    else if (n.includes(q)) score = 400 + q.length;
    else {
      const nTokens = n.split(' ').filter((t) => t.length >= 3);
      const shared = nTokens.filter((t) => qTokens.has(t)).length;
      if (shared > 0) score = shared * 10 + Math.min(nTokens.length, 9);
    }
    if (score === 0 && p.sku && q.includes(normalize(p.sku))) score = 5;
    if (score > 0 && (!best || score > best.score)) best = { p, score };
  }
  return best?.p ?? null;
}

export interface VoiceOrderItemInput {
  name: string;
  quantity: number;
  notes?: string | null;
}

export interface CreateVoiceOrderArgs {
  orgId: string;
  callUuid: string;
  /** Caller's phone (normalised), used as the cart's customerPhone. */
  callerPhone: string;
  customerName: string | null;
  items: VoiceOrderItemInput[];
  /** Operator-configured shopForm answers, keyed by field key. */
  fields: Record<string, string>;
  /** From gatherBotData — carries products[] + shopForm. */
  data: BotData;
  /** Phone line (DID) the call came in on, for operator routing. */
  phoneIntegrationId?: string | null;
  /** Append to the caller's most recent open order instead of creating a new one. */
  continueExisting?: boolean;
  /** Skip the WhatsApp payment bill (caller opted out of messaging). */
  suppressBill?: boolean;
}

export interface VoiceOrderResult {
  orderId: string;
  itemsCount: number;
  totalMinor: number;
  currency: string;
  matched: number;
  unmatched: string[];
  merged: boolean;
}

export type VoiceOrderOutcome =
  | { ok: true; result: VoiceOrderResult }
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'missing_required'; missing: string[] }
  | { ok: false; reason: 'below_min'; minOrderMinor: number; subtotalMinor: number; currency: string };

/** number -> BigInt for the cart's BigInt money columns (defensive round). */
const toBig = (n: number): bigint => BigInt(Math.round(n));

function deliveryFee(
  subtotalMinor: number,
  shopForm: NonNullable<BotData['shopForm']>,
): number {
  const base = shopForm.deliveryFeeMinor ?? 0;
  if (shopForm.freeDeliveryAboveMinor != null && subtotalMinor >= shopForm.freeDeliveryAboveMinor) {
    return 0;
  }
  return base;
}

/**
 * Create (or merge into / dedupe) an order from a voice call. Returns a
 * discriminated outcome so the route can turn a guard failure into a clear
 * spoken error instead of an unfulfillable order.
 */
export async function createVoiceOrder(args: CreateVoiceOrderArgs): Promise<VoiceOrderOutcome> {
  const shopForm = args.data.shopForm;
  if (!shopForm) return { ok: false, reason: 'disabled' };
  const products = args.data.products as CatalogLite[];
  const currency = shopForm.currency;

  // ---- Server-side required-field guard (O3) -------------------------------
  const missing = shopForm.fields
    .filter((f) => f.required && !(args.fields[f.key] ?? '').trim())
    .map((f) => f.label);
  if (missing.length > 0) return { ok: false, reason: 'missing_required', missing };

  // ---- Idempotency (O4): a retried submit_order for this call returns the
  // already-created order (no duplicate cart / double bill). Only applies to a
  // fresh order; a continueExisting merge is handled separately below.
  if (!args.continueExisting) {
    const existing = await withTenant(args.orgId, (tx) =>
      tx.cart.findFirst({
        where: { organizationId: args.orgId, callUuid: args.callUuid, status: { not: 'cancelled' } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, itemsCount: true, totalMinor: true, currency: true },
      }),
    );
    if (existing) {
      return {
        ok: true,
        result: {
          orderId: existing.id,
          itemsCount: existing.itemsCount,
          totalMinor: Number(existing.totalMinor),
          currency: existing.currency,
          matched: 0,
          unmatched: [],
          merged: true,
        },
      };
    }
  }

  // ---- Resolve spoken items to the catalog ---------------------------------
  const resolved: {
    sku?: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    notes?: string;
    needsPricing: boolean;
  }[] = [];
  const unmatched: string[] = [];
  let matched = 0;
  for (const it of args.items) {
    const qty = Math.max(1, Math.floor(Number(it.quantity) || 1));
    const p = matchProduct(it.name, products);
    if (p) {
      matched++;
      resolved.push({
        sku: p.sku,
        name: p.name,
        quantity: qty,
        unitPriceMinor: p.priceMinor ?? 0,
        notes: it.notes ?? undefined,
        needsPricing: false,
      });
    } else {
      unmatched.push(it.name);
      // Keep it on the order so nothing the caller asked for is silently lost;
      // price 0 + needsPricing flags it for the operator to confirm.
      resolved.push({
        name: it.name,
        quantity: qty,
        unitPriceMinor: 0,
        notes: it.notes ?? 'not matched to the menu — needs pricing',
        needsPricing: true,
      });
    }
  }
  if (resolved.length === 0) return { ok: false, reason: 'empty' };

  const subtotalMinor = resolved.reduce((s, r) => s + r.quantity * r.unitPriceMinor, 0);

  // ---- Minimum-order guard (O3) — only for a brand-new order. A merge adds to
  // an already-above-minimum order, so we don't re-block it.
  if (
    !args.continueExisting &&
    shopForm.minOrderMinor != null &&
    subtotalMinor < shopForm.minOrderMinor
  ) {
    return {
      ok: false,
      reason: 'below_min',
      minOrderMinor: shopForm.minOrderMinor,
      subtotalMinor,
      currency,
    };
  }

  // ---- continueExisting: append to the caller's most recent OPEN order ------
  if (args.continueExisting) {
    const merged = await withTenant(args.orgId, async (tx) => {
      const open = await tx.cart.findFirst({
        where: {
          organizationId: args.orgId,
          customerPhone: args.callerPhone,
          status: { in: ['new', 'confirmed'] },
          OR: [{ paymentStatus: null }, { paymentStatus: { not: 'paid' } }],
        },
        orderBy: { createdAt: 'desc' },
        include: { items: true },
      });
      if (!open) return null;
      await tx.cartItem.createMany({
        data: resolved.map((r) => ({
          organizationId: args.orgId,
          cartId: open.id,
          sku: r.sku ?? null,
          name: r.name,
          quantity: r.quantity,
          unitPriceMinor: toBig(r.unitPriceMinor),
          lineTotalMinor: toBig(r.quantity * r.unitPriceMinor),
          needsPricing: r.needsPricing,
          notes: r.notes ?? null,
        })),
      });
      // Merge newly-collected field answers without clobbering existing values:
      // rebuild the canonical fieldRows, preferring a fresh non-empty answer,
      // else the value already on the order.
      const existingFields = (open.fields as { key: string; value: string | null }[] | null) ?? [];
      const existingByKey = new Map(existingFields.map((f) => [f.key, f.value]));
      const mergedFields = shopForm.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: f.required,
        value: (args.fields[f.key] ?? '').trim() || existingByKey.get(f.key) || null,
      }));
      const items = await tx.cartItem.findMany({ where: { cartId: open.id } });
      const sub = items.reduce((s, i) => s + Number(i.lineTotalMinor), 0);
      const del = deliveryFee(sub, shopForm);
      const updated = await tx.cart.update({
        where: { id: open.id },
        data: {
          fields: mergedFields as never,
          subtotalMinor: toBig(sub),
          deliveryMinor: toBig(del),
          totalMinor: toBig(sub + del),
          itemsCount: items.reduce((s, i) => s + i.quantity, 0),
          callUuid: args.callUuid,
          ...(args.customerName ? { customerName: args.customerName } : {}),
        },
        select: { id: true, itemsCount: true, totalMinor: true, currency: true },
      });
      return updated;
    });
    if (merged) {
      void emitWebhookEvent({
        organizationId: args.orgId,
        eventKind: 'cart_item_added',
        payload: { id: merged.id, source: 'voice', merged: true },
      }).catch(() => undefined);
      return {
        ok: true,
        result: {
          orderId: merged.id,
          itemsCount: merged.itemsCount,
          totalMinor: Number(merged.totalMinor),
          currency: merged.currency,
          matched,
          unmatched,
          merged: true,
        },
      };
    }
    // No open order to merge into → fall through and create a fresh one.
  }

  const captured = await captureCart({
    orgId: args.orgId,
    threadId: null,
    customerId: args.callerPhone,
    customerName: args.customerName,
    cartMarkerPayload: { items: resolved, fields: args.fields },
    shopForm,
    products,
    channel: 'voice',
    phoneIntegrationId: args.phoneIntegrationId ?? null,
    callUuid: args.callUuid,
  });
  if (!captured) return { ok: false, reason: 'empty' };

  // No inbox thread for voice → proactively notify operators + fire the same
  // webhook a WhatsApp order would.
  void emitWebhookEvent({
    organizationId: args.orgId,
    eventKind: 'cart_created',
    payload: {
      id: captured.id,
      source: 'voice',
      customerPhone: args.callerPhone,
      totalMinor: captured.totalMinor,
      currency: captured.currency,
      itemsCount: captured.itemsCount,
    },
  }).catch(() => undefined);

  void createNotification({
    organizationId: args.orgId,
    kind: 'cart_received',
    severity: unmatched.length > 0 ? 'warning' : 'info',
    title: `Voice order · ${captured.itemsCount} item${captured.itemsCount === 1 ? '' : 's'}`,
    body:
      `${args.customerName ?? args.callerPhone}` +
      (unmatched.length > 0 ? ` · ${unmatched.length} item(s) need pricing` : ''),
    link: '/cart',
    entityType: 'cart',
    entityId: captured.id,
  }).catch(() => undefined);

  // Mint + WhatsApp the payment "bill" to the caller — unless they've opted out
  // of messaging. Backgrounded (void) so the gateway + Meta round-trips never
  // block the live call's submit_order response.
  if (!args.suppressBill) {
    void dispatchVoiceOrderBill({
      orgId: args.orgId,
      cartId: captured.id,
      customerName: args.customerName,
      customerPhone: args.callerPhone,
      totalMinor: captured.totalMinor,
      currency: captured.currency,
    }).catch(() => undefined);
  }

  return {
    ok: true,
    result: {
      orderId: captured.id,
      itemsCount: captured.itemsCount,
      totalMinor: captured.totalMinor,
      currency: captured.currency,
      matched,
      unmatched,
      merged: false,
    },
  };
}
