// Phase 5.4 — Drip / sequence campaigns. Zod schemas shared by api + web.
import { z } from 'zod';

import { uuidSchema } from './common.js';
import { variableMappingSchema } from './broadcast.js';

const SEQUENCE_ENROLLMENT_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;

export const sequenceStepDtoSchema = z.object({
  id: uuidSchema,
  stepOrder: z.number().int().nonnegative(),
  templateId: uuidSchema,
  delayHours: z.number().int().nonnegative(),
  variables: variableMappingSchema,
});
export type SequenceStepDto = z.infer<typeof sequenceStepDtoSchema>;

export const sequenceDtoSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  channelId: uuidSchema,
  steps: z.array(sequenceStepDtoSchema),
  enrollmentCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SequenceDto = z.infer<typeof sequenceDtoSchema>;

const stepBodySchema = z.object({
  templateId: uuidSchema,
  delayHours: z.number().int().min(0).max(24 * 365),
  variables: variableMappingSchema.default({}),
});

export const createSequenceBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  channelId: uuidSchema,
  isActive: z.boolean().default(true),
  steps: z.array(stepBodySchema).min(1).max(20),
});
export type CreateSequenceBody = z.infer<typeof createSequenceBodySchema>;

export const updateSequenceBodySchema = createSequenceBodySchema.partial();

export const enrollContactsBodySchema = z.object({
  contactIds: z.array(uuidSchema).min(1).max(10000),
});
export type EnrollContactsBody = z.infer<typeof enrollContactsBodySchema>;

export const enrollmentDtoSchema = z.object({
  id: uuidSchema,
  contactId: uuidSchema,
  status: z.enum(SEQUENCE_ENROLLMENT_STATUSES),
  nextStepIndex: z.number().int().nonnegative(),
  nextStepDueAt: z.string().datetime().nullable(),
  enrolledAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
});
export type EnrollmentDto = z.infer<typeof enrollmentDtoSchema>;
