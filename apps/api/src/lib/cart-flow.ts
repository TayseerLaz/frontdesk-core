// Shared cart/order flow for non-WhatsApp channels (Messenger/Instagram).
//
// Mirrors the WhatsApp cart logic (whatsapp.routes) but is self-contained and
// reuses the battle-tested cart-parser (parseAddedItems — synonym/list-format
// aware) so the WhatsApp hot path is NOT touched. Cart rows are per-thread, so
// everything keys off threadId + a generic customerId (PSID for Messenger).
import type { BookingAvailability } from './booking-slots.js';
import { resolveSlotFromText, slotHasRoom } from './booking-slots.js';
import { parseAddedItems } from './cart-parser.js';
// F-02: the bot hot path runs under withTenant (RLS as a backstop), not
// withRlsBypass. Every query still carries an explicit organizationId filter as
// defence-in-depth, but a forgotten filter can no longer leak cross-tenant —
// the app_user role + tenant_isolation policy block it at the database.
import { withTenant } from './db.js';

export interface ShopFormLite {
  currency: string;
  deliveryFeeMinor?: number | null;
  freeDeliveryAboveMinor?: number | null;
  fields?: { key: string; label: string; type: string; required: boolean }[];
}

export interface CatalogProductLite {
  id: string;
  sku: string;
  name: string;
  priceMinor: number | null;
}

export interface BookingFormLite {
  enabled: boolean;
  fields: { key: string; label: string; type: string; required: boolean }[];
}

/**
 * Capture a booking from the bot's [BOOKING: {json}] marker (mirrors the
 * WhatsApp booking flow, minus the LLM fallback-extractor — the marker is the
 * primary path). Persists a Booking row + a thread note, flags the thread
 * `pending` for operator review, and emits the `booking_created` webhook.
 * Deduped: skips if a booking was captured for this thread in the last 30 min.
 * Returns the new booking id, or null if nothing was captured.
 */
export async function captureBooking(args: {
  orgId: string;
  threadId: string;
  customerId: string;
  customerName: string | null;
  bookingMarkerJson: string;
  bookingForm: BookingFormLite;
  availability?: BookingAvailability | null;
  /** Business context for the Google Calendar confirmation, when connected. */
  calendar?: {
    timezone: string;
    businessName: string | null;
    address: string | null;
    /** The customer's own words, so the confirmation mirrors their language. */
    customerText: string | null;
  } | null;
}): Promise<{ id: string; confirmationMessage: string | null } | null> {
  if (!args.bookingForm.enabled || args.bookingForm.fields.length === 0) return null;
  let parsed: Record<string, string>;
  try {
    const obj = JSON.parse(args.bookingMarkerJson) as Record<string, unknown>;
    parsed = {};
    for (const [k, v] of Object.entries(obj)) parsed[k] = v == null ? '' : String(v);
  } catch {
    return null;
  }

  // Resolve the chosen slot → exact appointment instant when availability is on.
  // We try the explicit 'date'-type field first, then any field value that
  // matches an offered slot label. Capacity is re-checked at capture so a rare
  // race only overshoots by one (and gets flagged for the operator).
  const av = args.availability ?? null;
  let appointmentAt: Date | null = null;
  let slotWasFull = false;
  if (av?.enabled) {
    const now = new Date();
    const dateField = args.bookingForm.fields.find((f) => f.type === 'date');
    const candidates = dateField ? [parsed[dateField.key]] : Object.values(parsed);
    for (const v of candidates) {
      const slot = resolveSlotFromText(v, av, now);
      if (slot) {
        appointmentAt = slot;
        break;
      }
    }
    if (appointmentAt) {
      // False when the slot is at capacity OR the operator is busy there in a
      // connected Google Calendar. Either way the booking is kept and flagged.
      slotWasFull = !(await slotHasRoom(
        args.orgId,
        appointmentAt,
        av.capacityPerSlot,
        av.slotMinutes,
      ));
    }
  }

  const result = await withTenant(args.orgId, async (tx) => {
    const recent = await tx.booking.findFirst({
      where: {
        organizationId: args.orgId,
        threadId: args.threadId,
        createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
      },
      select: { id: true },
    });
    if (recent) return null;

    const fields = args.bookingForm.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      value: parsed[f.key] ?? null,
    }));
    const booking = await tx.booking.create({
      data: {
        organizationId: args.orgId,
        threadId: args.threadId,
        customerPhone: args.customerId,
        customerName: args.customerName,
        fields: fields as never,
        status: 'new',
        appointmentAt,
        ...(slotWasFull
          ? { notes: '⚠ Slot was unavailable when booked (at capacity, or busy in Google Calendar) — please review.' }
          : {}),
      },
    });
    await tx.whatsAppNote.create({
      data: {
        threadId: args.threadId,
        organizationId: args.orgId,
        authorUserId: null,
        body: `📅 Booking captured (id ${booking.id.slice(0, 8)}…)${slotWasFull ? ' ⚠ slot was unavailable' : ''}. See /bookings.`,
      },
    });
    await tx.whatsAppThread.update({
      where: { id: args.threadId },
      data: { status: 'pending' as never },
    });
    return { id: booking.id, fields };
  });
  if (!result) return null;

  void (await import('./webhooks.js'))
    .emitWebhookEvent({
      organizationId: args.orgId,
      eventKind: 'booking_created',
      payload: { id: result.id, customerPhone: args.customerId, fields: result.fields },
    })
    .catch(() => undefined);

  // Calendar event + Meet link + confirmation text. AFTER the transaction:
  // this calls Google, and a network round-trip must not hold a database
  // transaction open. Fails soft — the sync tick places the event later.
  let confirmationMessage: string | null = null;
  if (args.calendar) {
    try {
      const { confirmBooking } = await import('./booking-confirm.js');
      const confirmed = await confirmBooking({
        orgId: args.orgId,
        bookingId: result.id,
        customerName: args.customerName,
        customerPhone: args.customerId,
        fields: result.fields,
        appointmentAt,
        slotMinutes: av?.slotMinutes ?? 60,
        timezone: args.calendar.timezone,
        businessName: args.calendar.businessName,
        address: args.calendar.address,
        customerText: args.calendar.customerText,
      });
      confirmationMessage = confirmed?.message ?? null;
    } catch {
      /* non-fatal: the booking stands, the tick will sync it */
    }
  }

  return { id: result.id, confirmationMessage };
}

function deliveryFor(subtotalMinor: number, shopForm: ShopFormLite): number {
  const base = shopForm.deliveryFeeMinor ?? 0;
  if (shopForm.freeDeliveryAboveMinor != null && subtotalMinor >= shopForm.freeDeliveryAboveMinor) {
    return 0;
  }
  return base;
}

/** The active draft cart for a thread, shaped for buildBotResponse.cartState. */
/** number -> BigInt for the cart's BigInt money columns (defensive round). */
const toBig = (n: number): bigint => BigInt(Math.round(n));

export async function loadDraftCartState(
  orgId: string,
  threadId: string,
): Promise<
  | {
      items: { name: string; quantity: number; unitPriceMinor: number; sku: string | null }[];
      subtotalMinor: number;
      currency: string;
      capturedFields?: Record<string, string>;
    }
  | null
> {
  try {
   return await withTenant(orgId, async (tx) => {
    const draft = await tx.cart.findFirst({
      where: { organizationId: orgId, threadId, status: 'draft' },
      include: { items: true },
    });
    if (!draft || draft.items.length === 0) return null;
    const capturedFields: Record<string, string> = {};
    for (const f of (draft.fields as { key?: string; value?: string }[] | null) ?? []) {
      if (f?.key && f.value) capturedFields[f.key] = String(f.value);
    }
    return {
      items: draft.items.map((it) => ({
        name: it.name,
        quantity: it.quantity,
        unitPriceMinor: Number(it.unitPriceMinor),
        sku: it.sku,
      })),
      subtotalMinor: Number(draft.subtotalMinor),
      currency: draft.currency,
      capturedFields: Object.keys(capturedFields).length > 0 ? capturedFields : undefined,
    };
   });
  } catch (err) {
    // A poisoned / oversized draft cart must never throw out of the reply path
    // (that would brick every subsequent message on the thread). Degrade to
    // "no running cart" for this turn; the Messenger/IG/voice bot keeps replying.
    return null;
  }
}

/** Parse the bot reply's adds and upsert them into the thread's draft cart. */
export async function syncDraftFromReply(args: {
  orgId: string;
  threadId: string;
  customerId: string;
  reply: string;
  userMessage: string;
  previousBotReply: string;
  products: CatalogProductLite[];
  shopForm: ShopFormLite;
}): Promise<void> {
  const parsed = parseAddedItems(
    args.reply,
    args.products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, priceMinor: p.priceMinor })),
    { userMessage: args.userMessage, previousBotReply: args.previousBotReply },
  );
  if (parsed.length === 0) return;

  await withTenant(args.orgId, async (tx) => {
    let draft = await tx.cart.findFirst({
      where: { organizationId: args.orgId, threadId: args.threadId, status: 'draft' },
      include: { items: true },
    });
    if (!draft) {
      draft = await tx.cart.create({
        data: {
          organizationId: args.orgId,
          threadId: args.threadId,
          customerPhone: args.customerId,
          status: 'draft',
          currency: args.shopForm.currency,
          fields: [] as never,
        },
        include: { items: true },
      });
    }
    for (const p of parsed) {
      const existing = draft.items.find((it) => it.sku === p.sku);
      if (existing) {
        await tx.cartItem.update({
          where: { id: existing.id },
          data: {
            quantity: p.quantity,
            unitPriceMinor: toBig(p.unitPriceMinor),
            lineTotalMinor: toBig(p.quantity * p.unitPriceMinor),
          },
        });
      } else {
        await tx.cartItem.create({
          data: {
            organizationId: args.orgId,
            cartId: draft.id,
            productId: p.productId,
            sku: p.sku,
            name: p.name,
            quantity: p.quantity,
            unitPriceMinor: toBig(p.unitPriceMinor),
            lineTotalMinor: toBig(p.quantity * p.unitPriceMinor),
          },
        });
      }
    }
    const refreshed = await tx.cartItem.findMany({ where: { cartId: draft.id } });
    const subtotalMinor = refreshed.reduce((s, it) => s + Number(it.lineTotalMinor), 0);
    const deliveryMinor = deliveryFor(subtotalMinor, args.shopForm);
    await tx.cart.update({
      where: { id: draft.id },
      data: {
        subtotalMinor: toBig(subtotalMinor),
        deliveryMinor: toBig(deliveryMinor),
        totalMinor: toBig(subtotalMinor + deliveryMinor),
        itemsCount: refreshed.reduce((s, it) => s + it.quantity, 0),
      },
    });
  });
}

/**
 * Promote the draft cart (or the marker payload if no draft) to a real order
 * ('new'). Returns receipt info, or null if there was nothing to capture.
 */
export async function captureCart(args: {
  orgId: string;
  // null for channels with no message thread (voice calls). The draft-cart
  // lookup below then matches WHERE thread_id IS NULL — and since drafts are
  // only ever created with a real threadId (syncDraftFromReply), a null-thread
  // call never collides with one and always takes the create-from-marker path.
  threadId: string | null;
  customerId: string;
  customerName: string | null;
  cartMarkerPayload: {
    items?: {
      sku?: string;
      name?: string;
      quantity?: number;
      unitPriceMinor?: number;
      notes?: string;
      // Voice: spoken item that couldn't be matched to the catalog (price 0,
      // operator must price it). Distinguishes from a genuinely-free item.
      needsPricing?: boolean;
    }[];
    fields?: Record<string, unknown>;
  };
  shopForm: ShopFormLite;
  products: CatalogProductLite[];
  // Origin channel + voice-call attribution (defaults preserve WhatsApp behavior).
  channel?: string;
  phoneIntegrationId?: string | null;
  callUuid?: string | null;
}): Promise<{ id: string; itemsCount: number; totalMinor: number; currency: string } | null> {
  return withTenant(args.orgId, async (tx) => {
    const draft = await tx.cart.findFirst({
      where: { organizationId: args.orgId, threadId: args.threadId, status: 'draft' },
      include: { items: true },
    });
    const bySku = new Map(args.products.map((p) => [p.sku.toLowerCase(), p]));
    const lineItems: {
      productId: string | null;
      sku: string | null;
      name: string;
      quantity: number;
      unitPriceMinor: number;
      needsPricing: boolean;
    }[] = [];
    if (draft && draft.items.length > 0) {
      for (const it of draft.items) {
        lineItems.push({
          productId: it.productId,
          sku: it.sku,
          name: it.name,
          quantity: it.quantity,
          unitPriceMinor: Number(it.unitPriceMinor),
          needsPricing: false,
        });
      }
    } else {
      for (const it of args.cartMarkerPayload.items ?? []) {
        const sku = (it.sku ?? '').toString().trim();
        const matched = sku ? bySku.get(sku.toLowerCase()) : undefined;
        const name = (it.name ?? matched?.name ?? '').toString().trim();
        if (!name) continue;
        lineItems.push({
          productId: matched?.id ?? null,
          sku: matched?.sku ?? (sku || null),
          name,
          quantity: Math.max(1, Math.floor(Number(it.quantity ?? 1))),
          unitPriceMinor: Math.max(0, Math.floor(Number(it.unitPriceMinor ?? matched?.priceMinor ?? 0))),
          needsPricing: it.needsPricing === true,
        });
      }
    }
    if (lineItems.length === 0) return null;

    const subtotalMinor = lineItems.reduce((s, it) => s + it.quantity * it.unitPriceMinor, 0);
    const deliveryMinor = deliveryFor(subtotalMinor, args.shopForm);
    const totalMinor = subtotalMinor + deliveryMinor;
    const itemsCount = lineItems.reduce((s, it) => s + it.quantity, 0);
    const fieldRows = (args.shopForm.fields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      value: (args.cartMarkerPayload.fields ?? {})[f.key] ?? null,
    }));

    // Origin metadata — only set when provided (voice path), so the WhatsApp /
    // Messenger callers keep the column defaults (channel='whatsapp').
    const originData: Record<string, unknown> = {};
    if (args.channel) originData.channel = args.channel;
    if (args.phoneIntegrationId !== undefined) originData.phoneIntegrationId = args.phoneIntegrationId;
    if (args.callUuid !== undefined) originData.callUuid = args.callUuid;

    let cartId: string;
    if (draft) {
      await tx.cart.update({
        where: { id: draft.id },
        data: {
          status: 'new',
          customerName: args.customerName,
          fields: fieldRows as never,
          subtotalMinor: toBig(subtotalMinor),
          deliveryMinor: toBig(deliveryMinor),
          totalMinor: toBig(totalMinor),
          itemsCount,
          currency: args.shopForm.currency,
          ...originData,
        },
      });
      cartId = draft.id;
      // Re-sync items when capturing from a marker fallback into an existing
      // (item-less) draft.
      if (draft.items.length === 0) {
        await tx.cartItem.createMany({
          data: lineItems.map((it) => ({
            organizationId: args.orgId,
            cartId: draft.id,
            productId: it.productId,
            sku: it.sku,
            name: it.name,
            quantity: it.quantity,
            unitPriceMinor: toBig(it.unitPriceMinor),
            lineTotalMinor: toBig(it.quantity * it.unitPriceMinor),
            needsPricing: it.needsPricing,
          })),
        });
      }
    } else {
      const created = await tx.cart.create({
        data: {
          organizationId: args.orgId,
          threadId: args.threadId,
          customerPhone: args.customerId,
          customerName: args.customerName,
          fields: fieldRows as never,
          subtotalMinor: toBig(subtotalMinor),
          deliveryMinor: toBig(deliveryMinor),
          totalMinor: toBig(totalMinor),
          itemsCount,
          currency: args.shopForm.currency,
          status: 'new',
          ...originData,
          items: {
            createMany: {
              data: lineItems.map((it) => ({
                organizationId: args.orgId,
                productId: it.productId,
                sku: it.sku,
                name: it.name,
                quantity: it.quantity,
                unitPriceMinor: toBig(it.unitPriceMinor),
                lineTotalMinor: toBig(it.quantity * it.unitPriceMinor),
                needsPricing: it.needsPricing,
              })),
            },
          },
        },
      });
      cartId = created.id;
    }
    return { id: cartId, itemsCount, totalMinor, currency: args.shopForm.currency };
  });
}
