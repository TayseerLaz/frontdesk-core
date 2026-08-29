import { z } from 'zod';

import { uuidSchema } from './common.js';

/**
 * Sales Scan — "Teach the bot with your own data".
 *
 * A tenant links the sales WhatsApp number they already use; we capture one week of
 * their real customer DMs (both directions) and hand back a summary plus an analysis
 * of how they speak.
 *
 * See docs/SALES-SCAN-FEATURE-BRAINSTORM.md (design) and
 * docs/SALES-SCAN-REVIEW-BLOCKERS.md (the blockers that gate the capture half).
 */

/** Hard bounds on a capture window. Clamped here so no env var or client can widen it. */
export const SALES_SCAN_MIN_WINDOW_DAYS = 1;
export const SALES_SCAN_MAX_WINDOW_DAYS = 14;
export const SALES_SCAN_DEFAULT_WINDOW_DAYS = 7;

/**
 * Consent copy lives here as an immutable constant — NOT in a TSX file — so the
 * agreement a tenant accepted is reproducible months later. The grant row stores
 * this text verbatim plus its SHA-256.
 *
 * RULE: any edit to CONSENT_TEXT **must** bump SALES_SCAN_CONSENT_VERSION *and* the
 * pinned SHA in apps/api/test/pure/sales-scan-invariants.test.ts, in the SAME commit —
 * that test is a blocking CI gate and will fail otherwise. It is what makes a stored
 * grant's agreement reproducible months later.
 */
export const SALES_SCAN_CONSENT_VERSION = '2026-08-29.1';

export const SALES_SCAN_CONSENT_TEXT = [
  'You are about to connect a WhatsApp number you actively use for sales.',
  '',
  'What we will do:',
  '- Read every direct message on that number, in both directions, for the window shown above.',
  '- Store those messages so we can summarise them and analyse how your team writes.',
  '- Strip payment credentials (card numbers, IBANs, one-time codes) before storing.',
  '',
  'About older messages, before you continue:',
  '- When you link the number, WhatsApp also sends us conversation history from BEFORE',
  '  today. This is not limited to the window above, and it includes messages exchanged',
  '  before you agreed to any of this.',
  '- How far back that reaches is decided by WhatsApp and your phone, not by us. It varies',
  '  by device and by account, and we cannot promise a specific cut-off.',
  '- Those older messages are stored, analysed and deleted on exactly the same terms as',
  '  the rest: payment credentials stripped, kept at most 90 days, and erased whenever you',
  '  press delete.',
  '',
  'What you should know:',
  '- We connect as a linked device, the same way WhatsApp Web does. WhatsApp allows only',
  '  4 linked devices per account, so connecting may use your last free slot.',
  '- Your customers have not agreed anything with us. You remain responsible for their data;',
  '  we process it only on your instruction, only for your account, and never to train',
  '  anything shared with other customers.',
  '- Messages are kept for at most 90 days. The summary is kept until you delete it.',
  '- You can stop the capture at any time, and delete everything we captured at any time.',
  '  Deletion is immediate in live systems; encrypted backups age out within 30 days.',
  '- Our staff can access this data to support you.',
].join('\n');

/**
 * Coexistence consent — a SEPARATE copy from SALES_SCAN_CONSENT_TEXT above, on purpose.
 *
 * The text above describes the Baileys transport: a linked device, an unpromisable history
 * depth, the 4-device cap. None of that describes coexistence, where Meta delivers a
 * documented 180 days over the official Cloud API and no companion-device slot is used.
 * Rewriting the copy above in place would have made it wrong for the transport it actually
 * documents, so each transport carries its own disclosure and its own hash.
 *
 * SAME RULE as above: any edit here must bump COEXISTENCE_CONSENT_VERSION *and* the pinned
 * SHA in apps/api/test/pure/coexistence-capture.test.ts, in the SAME commit. That test is a
 * blocking CI gate.
 *
 * Every factual claim below is from Meta's own documentation, checked 2026-08-24:
 * 180 days, one-shot delivery inside a 24-hour window, groups excluded, media asset ids
 * only for the last 14 days, and offboarding available only from the handset.
 */
export const COEXISTENCE_CONSENT_VERSION = '2026-08-29.1';

export const COEXISTENCE_CONSENT_TEXT = [
  'You are about to connect the WhatsApp number you already use for your business.',
  'You keep using it on your phone exactly as you do now. We work the same number',
  'alongside you.',
  '',
  'What WhatsApp will send us when you connect:',
  '- Your contact list from the WhatsApp Business app: names and phone numbers.',
  '- Up to 180 days of your past conversations with customers, both what they sent you',
  '  and what you sent them. This includes messages exchanged long before today, and',
  '  before you agreed to any of this.',
  '- From then on, a copy of every message you send from your phone, so your team sees',
  '  one conversation instead of two.',
  '',
  'What that history does NOT include:',
  '- Group chats. They stay on your phone only.',
  '- Photos, voice notes and files older than 14 days. Those arrive as a note that',
  '  something was attached, not the file itself.',
  '',
  'It happens once. WhatsApp sends this history a single time, within 24 hours of you',
  'connecting, and will not send it again. Getting it a second time would mean',
  'disconnecting your number completely and starting over.',
  '',
  'What connecting does to your phone, before you continue:',
  '- WhatsApp will sign your other devices out — WhatsApp Web, desktop, tablet. You can',
  '  link them again afterwards from your phone.',
  '- You must keep opening the WhatsApp Business app every week or two. If you stop, the',
  '  connection can lapse and we stop receiving your messages.',
  '- Disconnecting is done from your phone, not from this portal: WhatsApp Business app →',
  '  Settings → Account → Business Platform.',
  '',
  'What we do with it:',
  '- We summarise your conversations and analyse how your team writes, so your assistant',
  '  answers the way you do.',
  '- We strip payment credentials (card numbers, IBANs, one-time codes) before storing.',
  '- We use it only for your account. We never use it to train anything shared with other',
  '  customers.',
  '- Your customers have not agreed anything with us. You remain responsible for their',
  '  data; we process it only on your instruction.',
  '- Our staff can access this data to support you.',
  '',
  'How long we keep it:',
  '- We hold captured messages for at most 90 days from the day we receive them. Because',
  '  the history reaches back 180 days, the oldest conversation in it can be older than 90',
  '  days while we hold it. The 90 days is how long we keep it, not how old it is.',
  '- The summary is kept until you delete it.',
  '- You can stop the capture at any time, and delete everything we captured at any time.',
  '  Deletion is immediate in live systems; encrypted backups age out within 30 days.',
  '- Stopping does not disconnect your number. WhatsApp keeps sending us copies of what',
  '  you send from your phone, and we discard them on arrival instead of storing them.',
  '  To stop WhatsApp sending them at all, disconnect from your phone as described above.',
].join('\n');

/**
 * The three acknowledgements a tenant must tick before we ask Meta for their history.
 *
 * Separate on purpose — each names a different consequence, and a single "I agree" would
 * hide the two that are easy to miss. All are `z.literal(true)`: absence is never consent.
 *
 * Note there is deliberately no ban-risk acknowledgement here, unlike the Baileys consent
 * body. There is no ban exposure on the official API, and asking someone to accept a risk
 * that does not exist is worse than not asking.
 */
export const coexistenceHistoryConsentSchema = z.object({
  /** Must match the version the client rendered, so nobody consents to stale copy. */
  version: z.string().min(1),
  /** "You will receive up to 180 days of my past customer conversations and my contacts." */
  acknowledgedScope: z.literal(true),
  /** "My customers have not agreed anything with us; their data remains my responsibility." */
  acknowledgedControllerDuty: z.literal(true),
  /** "Connecting signs my other WhatsApp devices out and I must keep using the app." */
  acknowledgedOnboardingEffects: z.literal(true),
});
export type CoexistenceHistoryConsent = z.infer<typeof coexistenceHistoryConsentSchema>;

export const salesScanStatusEnum = z.enum([
  'pending',
  'linking',
  'active',
  'completed',
  'revoked',
  'expired',
  'failed',
]);
export type SalesScanStatus = z.infer<typeof salesScanStatusEnum>;

/** Statuses in which a grant still owns (or may own) a live session. */
export const SALES_SCAN_LIVE_STATUSES: SalesScanStatus[] = ['pending', 'linking', 'active'];

export const salesScanGrantDtoSchema = z.object({
  id: uuidSchema,
  status: salesScanStatusEnum,
  phoneE164: z.string().nullable(),
  windowDays: z.number().int(),
  grantedAt: z.string(),
  /** Absolute compliance deadline — never moved once set. */
  grantExpiresAt: z.string(),
  linkedAt: z.string().nullable(),
  /** What the tenant's countdown shows. Null until the number links. */
  captureEndsAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
  messageCount: z.number().int(),
  consentVersion: z.string(),
  /** Whole days left on the capture window; null when not capturing. */
  daysRemaining: z.number().int().nullable(),
});
export type SalesScanGrantDto = z.infer<typeof salesScanGrantDtoSchema>;

export const salesScanStatusResponseSchema = z.object({
  /** Has a super-admin activated this tenant? Drives locked vs unlocked UI. */
  featureEnabled: z.boolean(),
  /**
   * Is the capture backend actually reachable? False while the ingest service is
   * unconfigured — the UI then shows "activated, scanning available soon" instead
   * of a QR that could never appear.
   */
  ingestAvailable: z.boolean(),
  /** The current non-terminal grant, or the most recent one. Null if never used. */
  grant: salesScanGrantDtoSchema.nullable(),
  /** Base64 data-URL QR, present only while status is `linking`. */
  qr: z.string().nullable(),
  /**
   * True when `qr` is a PLACEHOLDER from demo mode, not a real WhatsApp link code. The UI
   * MUST say so — showing a fake code as real leaves a tenant scanning at nothing.
   */
  isPreview: z.boolean().default(false),
  /** 8-char pairing code alternative to the QR, when requested. */
  pairingCode: z.string().nullable(),
  hasSummary: z.boolean(),
  consent: z.object({
    version: z.string(),
    text: z.string(),
  }),
  limits: z.object({
    minWindowDays: z.number().int(),
    maxWindowDays: z.number().int(),
    defaultWindowDays: z.number().int(),
  }),
});
export type SalesScanStatusResponse = z.infer<typeof salesScanStatusResponseSchema>;

export const salesScanConnectBodySchema = z.object({
  windowDays: z
    .number()
    .int()
    .min(SALES_SCAN_MIN_WINDOW_DAYS)
    .max(SALES_SCAN_MAX_WINDOW_DAYS)
    .default(SALES_SCAN_DEFAULT_WINDOW_DAYS),
  /** Must exactly match the version the client rendered, so nobody consents to stale copy. */
  consentVersion: z.string().min(1),
  /** All three must be true. They are separate on purpose — see the consent text. */
  acknowledgedAuthority: z.literal(true),
  acknowledgedBanRisk: z.literal(true),
  acknowledgedControllerDuty: z.literal(true),
});
export type SalesScanConnectBody = z.infer<typeof salesScanConnectBodySchema>;

/** One recurring customer question, with the tenant's own best answer. */
export const salesScanQuestionSchema = z.object({
  question: z.string(),
  count: z.number().int(),
  /** Verbatim text is only ever taken from the tenant's OWN outbound messages. */
  bestAnswer: z.string().nullable(),
});

export const salesScanSummaryPayloadSchema = z.object({
  headline: z.string(),
  voiceProfile: z.object({
    tone: z.string(),
    formality: z.string(),
    languages: z.array(z.string()),
    greetings: z.array(z.string()),
    signOffs: z.array(z.string()),
    habits: z.array(z.string()),
  }),
  topQuestions: z.array(salesScanQuestionSchema),
  stats: z.object({
    messagesAnalyzed: z.number().int(),
    inbound: z.number().int(),
    outbound: z.number().int(),
    conversations: z.number().int(),
    medianReplyMinutes: z.number().nullable(),
  }),
});
export type SalesScanSummaryPayload = z.infer<typeof salesScanSummaryPayloadSchema>;

export const salesScanSummaryDtoSchema = z.object({
  id: uuidSchema,
  grantId: uuidSchema,
  status: z.string(),
  payload: salesScanSummaryPayloadSchema,
  messagesAnalyzed: z.number().int(),
  generatedAt: z.string(),
});
export type SalesScanSummaryDto = z.infer<typeof salesScanSummaryDtoSchema>;
