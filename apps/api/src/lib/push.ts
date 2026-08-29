// FCM push for the Hader mobile app (Hader-ai-app/CLAUDE.md §6).
//
// Degrade shape mirrors storage.ts: when FIREBASE_SERVICE_ACCOUNT_JSON is
// unset the module is a NO-OP (one boot-time log line, never throws) — the
// platform must never depend on push to function. Everything here is
// fire-and-forget from the caller's perspective; sendPush swallows all errors.
//
// Audience model: device_tokens rows are written by the mobile app at login
// (POST /notifications/devices). Org-wide notifications fan out to every
// registered device in the org; targeted ones to that user's devices only.
// Tokens FCM reports as unregistered/invalid are pruned in the same pass.
import type { Messaging } from 'firebase-admin/messaging';

import { prisma } from './db.js';

let messagingPromise: Promise<Messaging | null> | undefined;

function getMessagingLazy(): Promise<Messaging | null> {
  messagingPromise ??= (async () => {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw || raw.trim() === '') {
      console.log('[push] FIREBASE_SERVICE_ACCOUNT_JSON unset — push disabled (no-op).');
      return null;
    }
    try {
      const { initializeApp, cert, getApps } = await import('firebase-admin/app');
      const { getMessaging } = await import('firebase-admin/messaging');
      const creds = JSON.parse(raw) as Record<string, string>;
      const app =
        getApps().find((a) => a.name === 'hader-push') ??
        initializeApp({ credential: cert(creds as never) }, 'hader-push');
      return getMessaging(app);
    } catch (err) {
      console.error('[push] firebase init failed — push disabled.', err);
      return null;
    }
  })();
  return messagingPromise;
}

export interface PushPayload {
  title: string;
  body?: string;
  /** go_router location the app opens on tap, e.g. `/inbox/thread/<id>`. */
  route?: string;
}

/**
 * Send a push to every registered device of the given users. Never throws.
 * Returns the number of successful sends (0 when disabled).
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<number> {
  try {
    if (userIds.length === 0) return 0;
    const messaging = await getMessagingLazy();
    if (!messaging) return 0;
    const rows = await prisma.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { id: true, fcmToken: true },
    });
    if (rows.length === 0) return 0;

    const res = await messaging.sendEachForMulticast({
      tokens: rows.map((r) => r.fcmToken),
      notification: {
        title: payload.title,
        ...(payload.body ? { body: payload.body } : {}),
      },
      data: payload.route ? { route: payload.route } : {},
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    // Prune tokens FCM says are gone so the table self-heals.
    const deadIds: string[] = [];
    res.responses.forEach((r, i) => {
      const code = r.error?.code ?? '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument'
      ) {
        deadIds.push(rows[i]!.id);
      }
    });
    if (deadIds.length > 0) {
      await prisma.deviceToken
        .deleteMany({ where: { id: { in: deadIds } } })
        .catch(() => undefined);
    }
    return res.successCount;
  } catch (err) {
    console.error('[push] sendPushToUsers failed (ignored)', err);
    return 0;
  }
}

/**
 * Fan a Notification out as push. Org-wide (no targetUserId) reaches every
 * registered device in the org. Fire-and-forget — call with `void`.
 */
export async function sendPushForNotification(args: {
  organizationId: string;
  targetUserId?: string | null;
  title: string;
  body?: string | null;
  link?: string | null;
}): Promise<void> {
  try {
    const messaging = await getMessagingLazy();
    if (!messaging) return;
    let userIds: string[];
    if (args.targetUserId) {
      userIds = [args.targetUserId];
    } else {
      const rows = await prisma.deviceToken.findMany({
        where: { organizationId: args.organizationId },
        select: { userId: true },
        distinct: ['userId'],
      });
      userIds = rows.map((r) => r.userId);
    }
    await sendPushToUsers(userIds, {
      title: args.title,
      body: args.body ?? undefined,
      route: args.link ?? undefined,
    });
  } catch (err) {
    console.error('[push] sendPushForNotification failed (ignored)', err);
  }
}
