import { z } from 'zod';

// Per-tenant payment provider. `none` = no online payment (the bot won't
// emit a payable link; cash/COD is handled conversationally). The dynamic
// gateways (myfatoorah/stripe/paypal) mint a real per-order link via the
// tenant's own API credentials.
export const PAYMENT_PROVIDERS = [
  'none',
  'cash',
  'bank_transfer',
  'static_link',
  'myfatoorah',
  'stripe',
  'paypal',
] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

// Upsert body. Credentials are write-only: the client sends them, the API
// encrypts them at rest, and they are NEVER returned (only `has*` booleans).
// Send an empty string to CLEAR a stored credential; omit to leave unchanged.
export const upsertPaymentConfigBodySchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS),
  staticLinkUrl: z.string().trim().max(1000).nullable().optional(),
  bankDetails: z.string().trim().max(2000).nullable().optional(),
  testMode: z.boolean().optional(),
  // Provider credentials (write-only).
  myfatoorahApiKey: z.string().trim().max(2000).optional(),
  stripeSecretKey: z.string().trim().max(2000).optional(),
  paypalClientId: z.string().trim().max(2000).optional(),
  paypalSecret: z.string().trim().max(2000).optional(),
  // Webhook-verification secrets (write-only) — authenticate inbound payment-
  // confirmation webhooks (F-04). Without these the platform cannot safely mark
  // an order paid, so it stays 'pending' until manually reconciled.
  //   stripe:     the endpoint signing secret (whsec_…)
  //   myfatoorah: the dashboard "Webhook Secret Key"
  //   paypal:     the configured Webhook ID (used with PayPal's verify API)
  stripeWebhookSecret: z.string().trim().max(2000).optional(),
  myfatoorahWebhookSecret: z.string().trim().max(2000).optional(),
  paypalWebhookId: z.string().trim().max(2000).optional(),
});
export type UpsertPaymentConfigBody = z.infer<typeof upsertPaymentConfigBodySchema>;

// Response — provider + non-secret settings + booleans flagging which secrets
// are stored. Raw secrets are never serialized.
export const paymentConfigSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS),
  staticLinkUrl: z.string().nullable(),
  bankDetails: z.string().nullable(),
  testMode: z.boolean(),
  hasMyfatoorahKey: z.boolean(),
  hasStripeKey: z.boolean(),
  hasPaypalCreds: z.boolean(),
  // Whether a webhook-verification secret is configured for the active gateway.
  hasStripeWebhookSecret: z.boolean(),
  hasMyfatoorahWebhookSecret: z.boolean(),
  hasPaypalWebhookId: z.boolean(),
  // True when the selected provider has everything it needs to mint a link.
  ready: z.boolean(),
  // True when inbound payments for the active provider can be auto-confirmed
  // (a webhook secret is set). False ⇒ orders need manual reconciliation.
  paymentConfirmationReady: z.boolean(),
  updatedAt: z.string(),
});
export type PaymentConfigDto = z.infer<typeof paymentConfigSchema>;
