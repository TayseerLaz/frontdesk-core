import { z } from 'zod';

import { uuidSchema } from './common.js';

export const apiKeyScopes = [
  'read:catalog',
  'read:business-info',
  'read:faqs',
  // Voice media gateway (Aseer-time voicebot). `voice:config` reads the
  // compiled per-tenant realtime persona/grounding; `voice:calls` writes
  // call lifecycle + transcripts.
  'voice:config',
  'voice:calls',
] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];

export const apiKeySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(apiKeyScopes)),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(z.enum(apiKeyScopes)).min(1),
  expiresAt: z.string().datetime().optional(),
});
export type CreateApiKeyBody = z.infer<typeof createApiKeyBodySchema>;

/** Returned ONCE on creation; never retrievable again. */
export const createApiKeyResponseSchema = apiKeySchema.extend({
  secret: z.string(),
});
