// Per-tenant, multi-provider payment-link resolver.
//
// The bot emits a literal [PAYMENT_LINK] marker at checkout; the WhatsApp
// route resolves it through THIS module using the tenant's configured
// provider + (decrypted) credentials. Every adapter returns null on any
// failure so the caller can fall back to a soft message — a payment hiccup
// never breaks the reply.

import { createInvoice } from '../myfatoorah.js';

export interface PaymentContext {
  organizationId: string;
  threadId: string;
  cartId: string;
  customerName: string;
  customerPhone: string;
  amountMajor: number; // e.g. 12.50
  amountMinor: number; // smallest unit (cents/fils) — Stripe unit_amount
  currency: string; // ISO 4217, upper-case
  displayReference: string; // short cart ref shown to the customer
}

export interface ResolvedPaymentConfig {
  provider: string;
  staticLinkUrl: string | null;
  bankDetails: string | null;
  testMode: boolean;
  credentials: Record<string, string>; // already decrypted by the caller
}

// What to substitute for [PAYMENT_LINK]:
//   url  → a payable link
//   text → instructions (e.g. bank-transfer details)
//   null → no online payment (cash/none, or the provider failed) — caller
//          falls back to a soft "we'll send a link / pay on delivery" line.
export type PaymentResolution =
  // `ref` is the gateway's external id (e.g. MyFatoorah InvoiceId) we persist
  // on the cart so the inbound payment webhook can correlate it back (F-04).
  // Stripe/PayPal echo our cart id in their webhook, so they need no ref here.
  | { kind: 'url'; url: string; ref?: string | null }
  | { kind: 'text'; text: string }
  | null;

type Logger = { warn: (...args: unknown[]) => void };

export async function resolvePaymentLink(
  cfg: ResolvedPaymentConfig,
  ctx: PaymentContext,
  log: Logger,
): Promise<PaymentResolution> {
  switch (cfg.provider) {
    case 'static_link':
      return cfg.staticLinkUrl ? { kind: 'url', url: cfg.staticLinkUrl } : null;

    case 'bank_transfer':
      return cfg.bankDetails ? { kind: 'text', text: cfg.bankDetails } : null;

    case 'myfatoorah': {
      const apiKey = cfg.credentials.myfatoorahApiKey;
      if (!apiKey) return null;
      const inv = await createInvoice(
        {
          organizationId: ctx.organizationId,
          threadId: ctx.threadId,
          cartId: ctx.cartId,
          customerName: ctx.customerName,
          customerPhone: ctx.customerPhone,
          amountMajor: ctx.amountMajor,
          currency: ctx.currency,
          displayReference: ctx.displayReference,
        },
        log,
        { apiKey, testMode: cfg.testMode },
      );
      return inv ? { kind: 'url', url: inv.invoiceUrl, ref: String(inv.invoiceId) } : null;
    }

    case 'stripe': {
      const url = await createStripeCheckout(cfg.credentials.stripeSecretKey, ctx, log);
      return url ? { kind: 'url', url } : null;
    }

    case 'paypal': {
      const url = await createPaypalOrder(
        cfg.credentials.paypalClientId,
        cfg.credentials.paypalSecret,
        cfg.testMode,
        ctx,
        log,
      );
      return url ? { kind: 'url', url } : null;
    }

    case 'cash':
    case 'none':
    default:
      return null;
  }
}

// ---- Stripe (Checkout Session via REST, no SDK dep) ------------------------
async function createStripeCheckout(
  secretKey: string | undefined,
  ctx: PaymentContext,
  log: Logger,
): Promise<string | null> {
  if (!secretKey) return null;
  // Stripe unit_amount is in the currency's smallest unit — same as our
  // amountMinor (cents/fils). success_url is required; use a generic page.
  const form = new URLSearchParams({
    mode: 'payment',
    success_url: 'https://hader.ai/pay/thanks',
    cancel_url: 'https://hader.ai/pay/cancelled',
    client_reference_id: ctx.cartId,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': ctx.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(ctx.amountMinor),
    'line_items[0][price_data][product_data][name]': `Order ${ctx.displayReference}`,
    'metadata[organizationId]': ctx.organizationId,
    'metadata[cartId]': ctx.cartId,
    'metadata[threadId]': ctx.threadId,
  });
  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { url?: string; error?: { message?: string } };
    if (!res.ok || !json.url) {
      log.warn({ status: res.status, err: json.error?.message }, '[payments] stripe checkout failed');
      return null;
    }
    return json.url;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, '[payments] stripe network error');
    return null;
  }
}

// ---- PayPal (Orders v2, OAuth client-credentials) --------------------------
async function createPaypalOrder(
  clientId: string | undefined,
  secret: string | undefined,
  testMode: boolean,
  ctx: PaymentContext,
  log: Logger,
): Promise<string | null> {
  if (!clientId || !secret) return null;
  const base = testMode ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  try {
    // 1. OAuth token (client credentials).
    const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenRes.ok || !tokenJson.access_token) {
      log.warn({ status: tokenRes.status }, '[payments] paypal token failed (check creds/currency support)');
      return null;
    }
    // 2. Create order. PayPal expects the major-unit amount as a string.
    const orderRes = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: ctx.cartId,
            custom_id: `org=${ctx.organizationId};cart=${ctx.cartId}`,
            description: `Order ${ctx.displayReference}`,
            amount: { currency_code: ctx.currency.toUpperCase(), value: ctx.amountMajor.toFixed(2) },
          },
        ],
        application_context: {
          return_url: 'https://hader.ai/pay/thanks',
          cancel_url: 'https://hader.ai/pay/cancelled',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const orderJson = (await orderRes.json()) as {
      links?: { rel: string; href: string }[];
      message?: string;
    };
    if (!orderRes.ok) {
      log.warn({ status: orderRes.status, err: orderJson.message }, '[payments] paypal order failed');
      return null;
    }
    const approve = orderJson.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
    return approve?.href ?? null;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, '[payments] paypal network error');
    return null;
  }
}
