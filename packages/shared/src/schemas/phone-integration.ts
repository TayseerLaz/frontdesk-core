import { z } from 'zod';

import { uuidSchema } from './common.js';
import { voiceConfigSchema } from './voice.js';

// ----------------------------------------------------------------------------
// Phone integrations — per-tenant phone lines (DIDs) routed to the Aseer-time
// voicebot bridge. Many per org. Each line auto-issues its own voice-scoped API
// key (voice:config + voice:calls), shown once. The bridge is just telephony +
// audio plumbing; the bot persona/knowledge comes from this platform's compiled
// voice config (org-wide). In shared gateway mode the inbound dialed number is
// resolved to a line via GET /voice/resolve, so `phoneNumber` is globally
// unique and must be matched against the dialed exten — hence normalization
// happens identically on write and on resolve.
// ----------------------------------------------------------------------------

/**
 * Canonical form of a dialed number / DID used for storage AND for matching the
 * inbound dialed exten in gateway mode. Digits only (a leading "+" and any
 * spaces/dashes/parens are stripped) so that "+961 1 234 567", "961-1-234-567"
 * and the bare "9611234567" the gateway delivers as the dialed exten all match.
 * Leading zeros are preserved (local DIDs depend on them).
 */
export function normalizePhoneNumber(raw: string): string {
  return raw.replace(/\D+/g, '');
}

const rawPhoneNumber = z
  .string()
  .trim()
  .min(1, 'Phone number is required.')
  .max(40)
  // At least two digits after normalization — rejects "+" / "()" / empty.
  .refine((v) => normalizePhoneNumber(v).length >= 2, 'Enter a valid phone number.');

/** Portal-facing phone-line DTO (list + detail). Never includes the secret. */
export const phoneIntegrationSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  phoneNumber: z.string(),
  isActive: z.boolean(),
  // Per-line AI switch. When false the line still records calls but the
  // voicebot gets no persona/config (the AI brain is off for this number).
  // Defaulted so older clients stay valid.
  botEnabled: z.boolean().default(true),
  // Display-only prefix of the auto-issued voice key (e.g. "ak_live_abc123"),
  // or null if the key was revoked out-of-band.
  keyPrefix: z.string().nullable(),
  lastCallAt: z.string().datetime().nullable(),
  callCount: z.number().int(),
  createdAt: z.string().datetime(),
});
export type PhoneIntegration = z.infer<typeof phoneIntegrationSchema>;

export const createPhoneIntegrationBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  phoneNumber: rawPhoneNumber,
});
export type CreatePhoneIntegrationBody = z.infer<typeof createPhoneIntegrationBodySchema>;

export const updatePhoneIntegrationBodySchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phoneNumber: rawPhoneNumber.optional(),
    isActive: z.boolean().optional(),
    // Per-line AI bot on/off switch.
    botEnabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update.');
export type UpdatePhoneIntegrationBody = z.infer<typeof updatePhoneIntegrationBodySchema>;

/** Returned ONCE on creation: the line plus its voice key secret. */
export const createPhoneIntegrationResponseSchema = phoneIntegrationSchema.extend({
  secret: z.string(),
});

/**
 * GET /voice/resolve response (gateway mode). Same compiled voice config the
 * voicebot would get from /voice/config, plus the resolved tenant + line ids so
 * the bridge can stamp per-line attribution on the call lifecycle.
 */
export const voiceResolveResponseSchema = voiceConfigSchema.extend({
  phoneIntegrationId: uuidSchema,
  organizationId: uuidSchema,
});
export type VoiceResolveResponse = z.infer<typeof voiceResolveResponseSchema>;
