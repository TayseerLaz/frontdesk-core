import { z } from 'zod';

import {
  WEBHOOK_EVENT_KINDS,
  WebhookDeliveryStatus,
  WebhookEventKind,
} from '../enums/day3.js';
import { uuidSchema } from './common.js';

export const webhookEndpointSchema = z.object({
  id: uuidSchema,
  url: z.string().url(),
  description: z.string().nullable(),
  eventKinds: z.array(z.nativeEnum(WebhookEventKind)),
  isActive: z.boolean(),
  consecutiveFailures: z.number().int(),
  lastDeliveryAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type WebhookEndpointDto = z.infer<typeof webhookEndpointSchema>;

/** Returned ONCE on create; signing secret never re-shown. */
export const createWebhookResponseSchema = webhookEndpointSchema.extend({
  signingSecret: z.string(),
});

export const createWebhookEndpointBodySchema = z.object({
  url: z.string().url(),
  description: z.string().max(500).optional(),
  eventKinds: z.array(z.nativeEnum(WebhookEventKind)).optional().default([]),
});
export type CreateWebhookEndpointBody = z.infer<typeof createWebhookEndpointBodySchema>;

export const updateWebhookEndpointBodySchema = z.object({
  url: z.string().url().optional(),
  description: z.string().max(500).nullable().optional(),
  eventKinds: z.array(z.nativeEnum(WebhookEventKind)).optional(),
  isActive: z.boolean().optional(),
});

export const webhookDeliverySchema = z.object({
  id: uuidSchema,
  endpointId: uuidSchema,
  eventKind: z.nativeEnum(WebhookEventKind),
  status: z.nativeEnum(WebhookDeliveryStatus),
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  responseBody: z.string().nullable(),
  scheduledFor: z.string().datetime(),
  attemptedAt: z.string().datetime().nullable(),
  deliveredAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type WebhookDeliveryDto = z.infer<typeof webhookDeliverySchema>;

// Used by `WEBHOOK_EVENT_KINDS` selector — silence unused-import lint.
export const _webhook_event_kinds = WEBHOOK_EVENT_KINDS;
