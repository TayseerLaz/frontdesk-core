// Payment confirmation (F-04).
//
// Payment LINKS were minted (MyFatoorah / Stripe / PayPal / static), but
// nothing ever recorded that an order was actually PAID — orders sat in
// 'new'/'confirmed' forever and reconciliation was manual. This module is the
// write side of the inbound payment webhooks: it flips an order to paid exactly
// once, notifies the operator, and emits an `order_paid` event for downstream
// integrations.
//
// Everything here runs under withTenant (RLS-on) — the org is always known from
// the verified webhook — and every mutation is idempotent so a provider that
// retries a webhook (they all do) can never double-confirm or double-notify.
import { withTenant } from '../db.js';

export interface MarkCartPaidArgs {
  organizationId: string;
  cartId: string;
  provider: string;
  /** External transaction / invoice id from the gateway (for audit + dedupe). */
  ref?: string | null;
  /** Amount the gateway reports as paid, smallest unit — for a sanity log only. */
  amountMinorPaid?: number | null;
  currency?: string | null;
}

export type MarkCartPaidResult =
  | { status: 'confirmed'; cartId: string; totalMinor: number; currency: string }
  | { status: 'already_paid'; cartId: string }
  | { status: 'not_found' };

/**
 * Idempotently mark an order paid. Safe to call repeatedly with the same
 * (org, cart) — the second call returns `already_paid` and does NOT re-notify
 * or re-emit. Returns `not_found` when the cart doesn't exist for this org
 * (RLS + explicit filter both scope to the tenant).
 */
export async function markCartPaid(args: MarkCartPaidArgs): Promise<MarkCartPaidResult> {
  // Captured inside the tx so the voice caller can be told (post-commit) that
  // their payment landed — voice orders have no inbox thread, so without this the
  // customer who paid via the link hears nothing back (S5).
  let voiceNotify: { phone: string; name: string | null } | null = null;
  const outcome = await withTenant(args.organizationId, async (tx) => {
    const cart = await tx.cart.findFirst({
      where: { id: args.cartId, organizationId: args.organizationId },
      select: {
        id: true,
        paidAt: true,
        totalMinor: true,
        currency: true,
        threadId: true,
        channel: true,
        customerPhone: true,
        customerName: true,
      },
    });
    if (!cart) return { status: 'not_found' as const };
    if (cart.paidAt) return { status: 'already_paid' as const, cartId: cart.id };
    // A voice order with a real (non-placeholder) caller number → WhatsApp them a
    // paid confirmation after commit.
    if (
      !cart.threadId &&
      cart.channel === 'voice' &&
      cart.customerPhone &&
      !cart.customerPhone.startsWith('voice_')
    ) {
      voiceNotify = { phone: cart.customerPhone, name: cart.customerName };
    }

    await tx.cart.update({
      where: { id: cart.id },
      data: {
        status: 'confirmed',
        paymentStatus: 'paid',
        paidAt: new Date(),
        paymentProvider: args.provider,
        ...(args.ref ? { paymentRef: args.ref } : {}),
      },
    });

    // Operator-visible trail on the conversation, mirroring booking/cart notes.
    if (cart.threadId) {
      await tx.whatsAppNote.create({
        data: {
          threadId: cart.threadId,
          organizationId: args.organizationId,
          authorUserId: null,
          body: `💳 Payment confirmed for order ${cart.id.slice(0, 8)}… via ${args.provider}${
            args.ref ? ` (ref ${args.ref})` : ''
          }.`,
        },
      });
    }
    return {
      status: 'confirmed' as const,
      cartId: cart.id,
      totalMinor: Number(cart.totalMinor ?? 0),
      currency: cart.currency,
    };
  });

  if (outcome.status !== 'confirmed') return outcome;

  // Best-effort side effects — never let a notification/webhook hiccup turn a
  // successful confirmation into a 500 that makes the gateway retry forever.
  try {
    await (await import('../notifications.js')).createNotification({
      organizationId: args.organizationId,
      kind: 'order_paid',
      severity: 'success',
      title: 'Payment received',
      body: `Order ${outcome.cartId.slice(0, 8)}… was paid via ${args.provider}.`,
      link: '/carts',
      entityType: 'cart',
      entityId: outcome.cartId,
      metadata: { provider: args.provider, ref: args.ref ?? null },
    });
  } catch {
    /* swallow — already persisted */
  }
  try {
    await (await import('../webhooks.js')).emitWebhookEvent({
      organizationId: args.organizationId,
      eventKind: 'order_paid',
      payload: {
        id: outcome.cartId,
        provider: args.provider,
        ref: args.ref ?? null,
        totalMinor: outcome.totalMinor,
        currency: outcome.currency,
      },
    });
  } catch {
    /* swallow — already persisted */
  }
  // S5 — close the loop for the voice caller (no inbox thread to update). They
  // just paid via the link, so they're inside Meta's 24h window. Best-effort.
  // Cast defeats TS control-flow narrowing: it only sees `= null` (the
  // assignment lives inside the withTenant closure), so it would otherwise type
  // this `never` inside the truthy branch.
  const vn = voiceNotify as { phone: string; name: string | null } | null;
  if (vn) {
    try {
      const { sendWhatsAppText } = await import('../whatsapp-send.js');
      await sendWhatsAppText(
        args.organizationId,
        vn.phone,
        `${vn.name ? `Thanks ${vn.name}! ` : 'Thank you! '}Your payment for order ${outcome.cartId.slice(0, 8)}… is confirmed. We're preparing it now.`,
      );
    } catch {
      /* swallow — confirmation is best-effort */
    }
  }
  return outcome;
}

/**
 * Record that a payment link was issued for an order so the inbound webhook can
 * correlate back to it (especially MyFatoorah, whose webhook carries only its
 * InvoiceId — not our cart id). Sets provider + external ref + 'pending', but
 * never downgrades an order that is already paid. Best-effort.
 */
export async function recordPaymentIntent(args: {
  organizationId: string;
  cartId: string;
  provider: string;
  ref?: string | null;
}): Promise<void> {
  try {
    await withTenant(args.organizationId, async (tx) => {
      await tx.cart.updateMany({
        where: { id: args.cartId, organizationId: args.organizationId, paidAt: null },
        data: {
          paymentProvider: args.provider,
          paymentStatus: 'pending',
          ...(args.ref ? { paymentRef: args.ref } : {}),
        },
      });
    });
  } catch {
    /* non-critical — correlation can still fall back to cartId echoes */
  }
}

/**
 * Resolve an order by gateway + external reference (MyFatoorah InvoiceId path).
 * Returns the cart id or null. Scoped to the org.
 */
export async function findCartByPaymentRef(
  organizationId: string,
  provider: string,
  ref: string,
): Promise<string | null> {
  const row = await withTenant(organizationId, (tx) =>
    tx.cart.findFirst({
      where: { organizationId, paymentProvider: provider, paymentRef: ref },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    }),
  );
  return row?.id ?? null;
}
