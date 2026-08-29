// Notification helper. Used by routes and (via the worker's own copy of this
// idea) by background jobs to surface user-visible events.
//
// Notifications are tenant-scoped. If `targetUserId` is set, only that user
// sees it; otherwise the whole org sees it and reads are tracked per-user.
import type { NotificationKind, NotificationSeverity, Prisma } from '@platform/db';

import { prisma } from './db.js';

interface CreateNotificationArgs {
  organizationId: string;
  kind: NotificationKind;
  severity?: NotificationSeverity;
  title: string;
  body?: string;
  link?: string;
  targetUserId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export async function createNotification(args: CreateNotificationArgs): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      await tx.notification.create({
        data: {
          organizationId: args.organizationId,
          kind: args.kind,
          severity: args.severity ?? 'info',
          title: args.title,
          body: args.body ?? null,
          link: args.link ?? null,
          targetUserId: args.targetUserId ?? null,
          entityType: args.entityType ?? null,
          entityId: args.entityId ?? null,
          metadata: (args.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    });
    // the platform mobile app: mirror the notification as an FCM push. Fire-and-forget
    // and no-op without FIREBASE_SERVICE_ACCOUNT_JSON — never load-bearing.
    const { sendPushForNotification } = await import('./push.js');
    void sendPushForNotification({
      organizationId: args.organizationId,
      targetUserId: args.targetUserId ?? null,
      title: args.title,
      body: args.body ?? null,
      link: args.link ?? null,
    });
  } catch (err) {
    console.error('[notifications] createNotification failed', err);
  }
}
