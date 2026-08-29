// MyFatoorah payment-gateway integration. Used by the bot at checkout
// to mint a real invoice URL the customer can pay through. Apply per-
// order so the link carries the cart total + thread reference, instead
// of leaking the generic "https://myfatoorah.com" homepage the LLM
// otherwise hallucinates.
//
// Gracefully no-ops when MYFATOORAH_API_KEY is unset — createInvoice()
// returns null and the caller falls back to a soft message ("we'll
// send you a link shortly"). Same pattern as Stripe / Resend elsewhere.

import { env } from './env.js';

export interface CreateInvoiceArgs {
  organizationId: string;
  threadId: string;
  cartId: string;
  customerName: string;
  customerPhone: string;
  /** Total amount in MAJOR units (e.g. 0.750 for KWD 0.750). */
  amountMajor: number;
  /** ISO 4217. KWD, USD, AED, etc. */
  currency: string;
  /** Operator-readable cart reference shown to the customer. */
  displayReference: string;
}

export interface CreatedInvoice {
  invoiceId: number;
  invoiceUrl: string;
}

export function isMyFatoorahConfigured(): boolean {
  return !!env.MYFATOORAH_API_KEY;
}

/**
 * Create a MyFatoorah invoice and return the payable URL. Returns null
 * (instead of throwing) when the integration isn't configured, when
 * MyFatoorah returns a non-2xx, or when the response is malformed.
 * The caller decides the fallback copy — that keeps this module
 * pure and lets bot replies stay localised.
 */
export async function createInvoice(
  args: CreateInvoiceArgs,
  log?: { warn: (...args: unknown[]) => void },
  // Per-tenant override. When provided, use the tenant's own MyFatoorah
  // credentials instead of the platform-global env key (multi-tenant
  // payments). testMode picks the sandbox vs production base URL.
  creds?: { apiKey: string; testMode?: boolean },
): Promise<CreatedInvoice | null> {
  const apiKey = creds?.apiKey || env.MYFATOORAH_API_KEY;
  const baseUrl = creds
    ? creds.testMode
      ? 'https://apitest.myfatoorah.com'
      : 'https://api.myfatoorah.com'
    : env.MYFATOORAH_BASE_URL;
  if (!apiKey) return null;

  const body = {
    NotificationOption: 'Lnk', // return-only link (no SMS/email triggered server-side)
    InvoiceValue: args.amountMajor,
    CustomerName: args.customerName.slice(0, 100) || 'Customer',
    DisplayCurrencyIso: args.currency.toUpperCase(),
    MobileCountryCode: derivePhoneCountryCode(args.customerPhone),
    CustomerMobile: stripCountryCode(args.customerPhone),
    Language: 'en',
    CustomerReference: args.displayReference.slice(0, 50),
    UserDefinedField: `org=${args.organizationId};thread=${args.threadId};cart=${args.cartId}`,
  };

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v2/SendPayment`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log?.warn({ err: err instanceof Error ? err.message : err }, '[myfatoorah] network error');
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log?.warn(
      { status: res.status, body: text.slice(0, 400) },
      '[myfatoorah] non-2xx response',
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    log?.warn({ err: err instanceof Error ? err.message : err }, '[myfatoorah] JSON parse error');
    return null;
  }

  const data = (parsed as { Data?: { InvoiceURL?: string; InvoiceId?: number } | null }).Data;
  if (!data?.InvoiceURL || !data.InvoiceId) {
    log?.warn({ parsed }, '[myfatoorah] missing InvoiceURL / InvoiceId');
    return null;
  }
  return { invoiceId: data.InvoiceId, invoiceUrl: data.InvoiceURL };
}

/** Extract a country code from an E.164-ish string ("+96550123456"). */
function derivePhoneCountryCode(phone: string): string {
  const m = phone.match(/^\+(\d{1,4})/);
  // No fallback country — if the phone isn't E.164 we leave it blank
  // and let MyFatoorah's validator handle it. WhatsApp inbound is
  // always E.164 so this branch is effectively unreachable in prod.
  return m ? m[1]! : '';
}

/** Phone without the leading "+<country>" group, with non-digits stripped. */
function stripCountryCode(phone: string): string {
  return phone.replace(/^\+\d{1,4}/, '').replace(/\D/g, '');
}
