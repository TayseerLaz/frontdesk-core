// WhatsApp Cloud API channel — Phase 1.5.
// One channel per organisation. Stores the Meta-side identifiers the
// platform needs to verify credentials, receive webhooks, and send
// templates on behalf of the tenant. Secrets are stored at rest but
// always returned masked in API responses.
import { z } from 'zod';

import { uuidSchema } from './common.js';
import { coexistenceHistoryConsentSchema } from './sales-scan.js';

// Mask = "ak_live_****1234" style. Returned by GET, never the full secret.
const maskedSecretSchema = z.string().nullable();

export const whatsappChannelSchema = z.object({
  id: uuidSchema,
  // Multi-number fields: a human label, which number is the org default, and
  // whether the AI bot auto-replies on this number.
  label: z.string().nullable(),
  isPrimary: z.boolean(),
  botEnabled: z.boolean(),
  wabaId: z.string().nullable(),
  phoneNumberId: z.string().nullable(),
  displayPhoneNumber: z.string().nullable(),
  appId: z.string().nullable(),
  // Booleans + masked previews — full secrets are never sent over the wire.
  hasAccessToken: z.boolean(),
  hasAppSecret: z.boolean(),
  accessTokenMasked: maskedSecretSchema,
  appSecretMasked: maskedSecretSchema,
  // The platform-generated token clients paste into Meta's webhook config.
  webhookVerifyToken: z.string(),
  // The full URL Meta should POST to — computed server-side using API_PUBLIC_URL.
  webhookCallbackUrl: z.string(),
  greetingMessage: z.string().nullable(),
  businessName: z.string().nullable(),
  businessAbout: z.string().nullable(),
  businessAddress: z.string().nullable(),
  businessEmail: z.string().nullable(),
  isActive: z.boolean(),
  lastVerifiedAt: z.string().datetime().nullable(),
  lastVerifyStatus: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WhatsAppChannelDto = z.infer<typeof whatsappChannelSchema>;

// Upsert body — every field optional so the page can save partial progress.
// Empty strings are treated as "clear this field"; omitted = "leave alone".
export const upsertWhatsappChannelBodySchema = z.object({
  label: z.string().trim().max(80).optional().nullable(),
  // Per-number AI bot switch (multi-number). Omitted = leave as-is.
  botEnabled: z.boolean().optional(),
  wabaId: z.string().trim().max(64).optional().nullable(),
  phoneNumberId: z.string().trim().max(64).optional().nullable(),
  displayPhoneNumber: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, 'Looks invalid — use E.164, e.g. +14155551234.')
    .optional()
    .nullable(),
  appId: z.string().trim().max(64).optional().nullable(),
  // Secrets: omit to leave alone, send empty string to clear, send any other
  // value to overwrite. The route reads + masks before responding.
  accessToken: z.string().trim().max(2048).optional(),
  appSecret: z.string().trim().max(512).optional(),
  greetingMessage: z.string().trim().max(4000).optional().nullable(),
  businessName: z.string().trim().max(200).optional().nullable(),
  // businessAbout is stored in our DB for the chatbot read API (NOT pushed
  // to Meta's WhatsApp profile, which has a 139-char limit) — so we
  // accept long-form About content (vision/values/etc) up to ~5KB.
  businessAbout: z.string().trim().max(5000).optional().nullable(),
  businessAddress: z.string().trim().max(500).optional().nullable(),
  businessEmail: z.string().trim().email().optional().nullable().or(z.literal('')),
  isActive: z.boolean().optional(),
});
export type UpsertWhatsAppChannelBody = z.infer<typeof upsertWhatsappChannelBodySchema>;

// ---- Embedded Signup / Coexistence -----------------------------------------
// Body posted by the portal after Meta's FB.login popup returns. `code` is the
// exchangeable token code with a 30-SECOND time-to-live, so the handler
// exchanges it before touching the database.
//
// wabaId and phoneNumberId come from the browser and are therefore UNTRUSTED:
// the handler proves phoneNumberId really belongs to wabaId by listing the
// WABA's numbers with the freshly-minted token before it writes anything.
export const whatsappEmbeddedSignupBodySchema = z.object({
  code: z.string().trim().min(10).max(1024),
  wabaId: z.string().trim().min(1).max(64),
  // OPTIONAL on purpose. The standard flow's FINISH event carries
  // phone_number_id, but the COEXISTENCE event does not - Meta documents it as
  // `{ data: { waba_id }, type: "WA_EMBEDDED_SIGNUP",
  //    event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", version: 3 }`
  // and nothing else. The browser holds a `code`, not a token, so it cannot
  // look one up either. When absent the handler resolves it from the WABA's own
  // number list using the freshly-minted token, and REFUSES rather than guesses
  // if that list does not name exactly one number. Still validated when present.
  phoneNumberId: z.string().trim().min(1).max(64).optional(),
  label: z.string().trim().max(80).optional().nullable(),
  /**
   * Consent to receive up to 180 days of this business's past customer conversations.
   *
   * OPTIONAL, and its absence is a REFUSAL, not a default. Connecting a number is not the
   * same act as handing over six months of conversations: a tenant may be connecting
   * purely to send from, and may never have been shown the history copy. Without this
   * block the handler still provisions the channel and still syncs contacts, but does not
   * ask Meta for history at all.
   *
   * Why it has to be here, on the connect request, rather than in Settings afterwards:
   * Meta delivers history ONCE, inside a 24-hour window after onboarding, and it cannot be
   * re-requested without the tenant fully offboarding and redoing this whole flow. There is
   * no later moment at which asking would still work.
   */
  historyConsent: coexistenceHistoryConsentSchema.optional(),
});
export type WhatsAppEmbeddedSignupBody = z.infer<typeof whatsappEmbeddedSignupBodySchema>;

// Public, non-secret values the portal needs to open the FB.login popup.
// `configured` is false when the server has no Embedded Signup env vars, which
// is how the portal decides whether to render the button at all.
export const whatsappEmbeddedSignupConfigSchema = z.object({
  configured: z.boolean(),
  appId: z.string().nullable(),
  configId: z.string().nullable(),
  graphVersion: z.string(),
  /**
   * The history-consent copy, served from the server so the browser can never render a
   * different version than the one the handler will accept. The page echoes `version` back
   * in `historyConsent.version`; a mismatch is refused rather than silently accepted, so a
   * stale open tab cannot consent someone to copy they never saw.
   */
  historyConsent: z.object({
    version: z.string(),
    text: z.string(),
    /**
     * Whether to offer the history opt-in at all. False when this org does not have the
     * `sales_scan` feature switched on by an super-admin — there is no product that
     * consumes the corpus for them, so we do not ask for it. The exchange enforces the
     * same condition server-side; this only decides whether the checkboxes render.
     */
    available: z.boolean(),
  }),
});
export type WhatsAppEmbeddedSignupConfig = z.infer<typeof whatsappEmbeddedSignupConfigSchema>;

// Result of a verification round-trip with Meta.
export const whatsappVerifyResultSchema = z.object({
  ok: z.boolean(),
  status: z.string(), // 'success' | 'token_invalid' | 'phone_not_found' | 'network_error' | ...
  // When ok=true, Meta-confirmed details we read back.
  verifiedDisplayPhoneNumber: z.string().nullable(),
  verifiedQualityRating: z.string().nullable(),
  verifiedNameStatus: z.string().nullable(),
  errorMessage: z.string().nullable(),
  rawSample: z.string().nullable(), // ≤500 chars of upstream body for debugging
});
export type WhatsAppVerifyResult = z.infer<typeof whatsappVerifyResultSchema>;

// Result of subscribing this org's webhook to the WABA (one-click connect).
// We POST /{waba-id}/subscribed_apps with the per-org override callback URL +
// verify token; Meta GET-verifies the URL before accepting. On success the
// channel is auto-activated so the bot can start replying.
export const whatsappSubscribeResultSchema = z.object({
  ok: z.boolean(),
  status: z.string(), // 'subscribed' | 'missing_credentials' | 'token_invalid' | 'verify_failed' | 'network_error' | 'http_<n>'
  // The callback URL we told Meta to deliver to (so the UI can show it).
  callbackUrl: z.string().nullable(),
  // True when we also flipped the channel to active as part of this call.
  activated: z.boolean(),
  errorMessage: z.string().nullable(),
  rawSample: z.string().nullable(), // ≤500 chars of upstream body for debugging
});
export type WhatsAppSubscribeResult = z.infer<typeof whatsappSubscribeResultSchema>;

// Test-send a template to a number the operator types. Defaults to the
// well-known Meta sandbox `hello_world / en_US`, but accepts an arbitrary
// template name + language so accounts whose library doesn't include
// `hello_world` (most production accounts) can pass anything they've had
// approved.
//
// Variable-binding fields:
//   parameters        → body {{1}}, {{2}}, …
//   headerTextParam   → header (TEXT format) {{1}}. Meta only supports
//                       a single variable in a text header.
//   buttonUrlParams   → URL buttons {{1}}. Array entries are in the same
//                       order as the URL buttons appear in the template's
//                       components.buttons; non-URL buttons are skipped.
//                       Pass an empty string for URL buttons that don't
//                       contain a placeholder.
export const whatsappTestSendBodySchema = z.object({
  // Multi-number: send the test from this number; omitted ⇒ the primary.
  channelId: uuidSchema.optional(),
  to: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,16}$/, 'Use E.164 digits only, e.g. +14155551234.'),
  templateName: z.string().trim().min(1).max(512).optional(),
  templateLanguage: z.string().trim().min(2).max(16).optional(),
  parameters: z.array(z.string().max(1024)).max(20).optional(),
  headerTextParam: z.string().max(1024).optional(),
  buttonUrlParams: z.array(z.string().max(1024)).max(10).optional(),
});
export const whatsappTestSendResultSchema = z.object({
  ok: z.boolean(),
  metaMessageId: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type WhatsAppTestSendBody = z.infer<typeof whatsappTestSendBodySchema>;
export type WhatsAppTestSendResult = z.infer<typeof whatsappTestSendResultSchema>;

// Send a free-form text message to a customer who has messaged you in the
// last 24 hours (Meta's "session" window). Outside that window, only
// approved templates are allowed — use the test-send endpoint or build a
// templates module.
export const whatsappSendTextBodySchema = z.object({
  to: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,16}$/, 'Use E.164 digits only, e.g. +14155551234.'),
  body: z.string().trim().min(1).max(4096),
  // Multi-number: when set, the reply is sent FROM the number this thread
  // belongs to (thread.whatsAppChannelId). Omitted ⇒ the org's primary number.
  threadId: uuidSchema.optional(),
});
export type WhatsAppSendTextBody = z.infer<typeof whatsappSendTextBodySchema>;

// Send a media message (image / document) using a previously-uploaded
// Asset id. The server uploads the bytes to Meta to obtain a media_id,
// then sends the message. Caption is optional.
export const whatsappSendMediaBodySchema = z.object({
  to: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,16}$/, 'Use E.164 digits only, e.g. +14155551234.'),
  assetId: uuidSchema,
  mediaType: z.enum(['image', 'document', 'audio', 'video']),
  caption: z.string().trim().max(1024).optional(),
});
export type WhatsAppSendMediaBody = z.infer<typeof whatsappSendMediaBodySchema>;

// Inbound message row for the audit table.
export const whatsappMessageSchema = z.object({
  id: uuidSchema,
  direction: z.enum(['inbound', 'outbound']),
  metaMessageId: z.string().nullable(),
  fromNumber: z.string().nullable(),
  toNumber: z.string().nullable(),
  messageType: z.string().nullable(),
  body: z.string().nullable(),
  receivedAt: z.string().datetime(),
});
export type WhatsAppMessageDto = z.infer<typeof whatsappMessageSchema>;
