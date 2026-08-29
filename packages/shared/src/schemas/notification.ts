import { z } from 'zod';

import { NotificationKind, NotificationSeverity } from '../enums/day4.js';
import { uuidSchema } from './common.js';

export const notificationSchema = z.object({
  id: uuidSchema,
  kind: z.nativeEnum(NotificationKind),
  severity: z.nativeEnum(NotificationSeverity),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: uuidSchema.nullable(),
  isRead: z.boolean(),
  createdAt: z.string().datetime(),
});
export type NotificationDto = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
