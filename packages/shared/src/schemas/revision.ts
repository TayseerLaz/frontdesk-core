import { z } from 'zod';

import { RevisionAction, RevisionEntityType } from '../enums/day4.js';
import { uuidSchema } from './common.js';

export const catalogRevisionSchema = z.object({
  id: uuidSchema,
  entityType: z.nativeEnum(RevisionEntityType),
  entityId: uuidSchema,
  action: z.nativeEnum(RevisionAction),
  versionNumber: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  actorUserId: uuidSchema.nullable(),
  actorName: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type CatalogRevisionDto = z.infer<typeof catalogRevisionSchema>;

export const catalogRevisionWithSnapshotSchema = catalogRevisionSchema.extend({
  snapshot: z.unknown(),
});
export type CatalogRevisionWithSnapshotDto = z.infer<typeof catalogRevisionWithSnapshotSchema>;

export const restoreRevisionBodySchema = z.object({});
