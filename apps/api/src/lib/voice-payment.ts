// Voice order → payment link "bill" delivery.
//
// After a phone order is captured, mint the tenant's payment link (the SAME
// multi-provider path the WhatsApp checkout uses: per-tenant PaymentConfig →
// static/bank/MyFatoorah/Stripe/PayPal, with the platform-global MyFatoorah env
// as a fallback), record the intent so the inbound payment webhook (F-04) can
// mark it paid, and WhatsApp the caller a bill with the total + link.
//
// Always invoked with `void` from the order path: the gateway round-trips
// (payment provider + Meta) are slow and must never block the live call. Fully
// best-effort — every failure is swallowed/logged; the order + operator
// notification already exist regardless.
import { decryptSecret } from '@platform/db';

import { withRlsBypass } from './db.js';
import { createInvoice, isMyFatoorahConfigured } from './myfatoorah.js';
import { recordPaymentIntent } from './payments/confirm.js';
import { resolvePaymentLink, type PaymentResolution } from './payments/index.js';
import { sendWhatsAppText } from './whatsapp-send.js';

const NOOP_LOG = { warn: () => undefined };

// ISO 4217 minor-unit = 3 currencies (1 major = 1000 minor). An unlisted
// 3-decimal currency would otherwise be billed 10× wrong.
const THREE_DP = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
function decimals(currency: string): number {
  return THREE_DP.has(currency.toUpperCase()) ? 3 : 2;
}

export async function dispatchVoiceOrderBill(args: {
  orgId: string;
  cartId: string;
  customerName: string | null;
  /** Where the bill is sent (caller ID or the number the caller gave). */
  customerPhone: string;
  totalMinor: number;
  currency: string;
}): Promise<void> {
  if (!args.customerPhone || args.totalMinor <= 0) return;
  const code = args.currency.toUpperCase();
  const dec = decimals(code);
  const div = Math.pow(10, dec);
  const amountMajor = Number((args.totalMinor / div).toFixed(dec));
  const amountStr = `${amountMajor.toFixed(dec)} ${code}`;

  const payCtx = {
    organizationId: args.orgId,
    threadId: args.cartId, // voice has no thread; cartId stands in for provider metadata
    cartId: args.cartId,
    customerName: args.customerName || 'Customer',
    customerPhone: args.customerPhone,
    amountMajor,
    amountMinor: args.totalMinor,
    currency: code,
    displayReference: args.cartId.slice(0, 8),
  };

  let resolution: PaymentResolution = null;
  let provider = 'none';
  try {
    const pcfg = await withRlsBypass((tx) =>
      tx.paymentConfig.findUnique({ where: { organizationId: args.orgId } }),
    );
    if (pcfg && pcfg.provider !== 'none') {
      let creds: Record<string, string> = {};
      try {
        const j = decryptSecret(pcfg.credentials);
        creds = j ? (JSON.parse(j) as Record<string, string>) : {};
      } catch {
        creds = {};
      }
      resolution = await resolvePaymentLink(
        {
          provider: pcfg.provider,
          staticLinkUrl: pcfg.staticLinkUrl,
          bankDetails: pcfg.bankDetails,
          testMode: pcfg.testMode,
          credentials: creds,
        },
        payCtx,
        NOOP_LOG,
      );
      if (resolution) provider = pcfg.provider;
    }
    if (!resolution && isMyFatoorahConfigured()) {
      const invoice = await createInvoice(payCtx, NOOP_LOG);
      if (invoice) {
        resolution = { kind: 'url', url: invoice.invoiceUrl, ref: String(invoice.invoiceId) };
        provider = 'myfatoorah';
      }
    }
  } catch (err) {
    console.warn('[voice-payment] link resolve failed', {
      orgId: args.orgId,
      cartId: args.cartId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (resolution?.kind === 'url' && provider !== 'none') {
    await recordPaymentIntent({
      organizationId: args.orgId,
      cartId: args.cartId,
      provider,
      ref: resolution.ref ?? null,
    }).catch(() => undefined);
  }

  let body: string;
  if (resolution?.kind === 'url') {
    body = `Thanks for your order! Your total is ${amountStr}. Pay securely here: ${resolution.url}`;
  } else if (resolution?.kind === 'text') {
    body = `Thanks for your order! Your total is ${amountStr}.\n${resolution.text}`;
  } else {
    body = `Thanks for your order! Your total is ${amountStr}. You can pay on pickup or delivery.`;
  }

  const out = await sendWhatsAppText(args.orgId, args.customerPhone, body);
  if (!out.ok) {
    // Most common cause: the caller is outside Meta's 24h window (a cold number
    // that only phoned), which needs an approved template. Non-fatal — the order
    // and the operator notification already exist.
    console.warn('[voice-payment] bill send failed', {
      orgId: args.orgId,
      cartId: args.cartId,
      error: out.error,
    });
  }
}
