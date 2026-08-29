// Per-campaign reply attribution.
//
// When a customer sends an inbound WhatsApp message, we credit it as a
// "response" to the most recent broadcast that reached them within the
// attribution window. One reply is attributed to at most one campaign (the
// latest send), and only once per recipient (respondedAt guards re-counting).
// Best-effort: never throws into the inbound path.
import { withRlsBypass } from './db.js';

// A reply only counts as a campaign response if it lands within this window
// after the send. Beyond it, the reply is almost certainly unrelated.
const ATTRIBUTION_WINDOW_MS = 72 * 60 * 60 * 1000;

export async function attributeBroadcastResponse(
  orgId: string,
  fromPhone: string,
  receivedAt: Date,
): Promise<void> {
  try {
    const digits = fromPhone.replace(/[^0-9]/g, '');
    if (!digits) return;
    // Match either stored format (+E.164 or bare digits).
    const candidates = Array.from(new Set([fromPhone, digits, `+${digits}`]));
    const since = new Date(receivedAt.getTime() - ATTRIBUTION_WINDOW_MS);

    await withRlsBypass(async (tx) => {
      const recipient = await tx.broadcastRecipient.findFirst({
        where: {
          organizationId: orgId,
          phoneE164: { in: candidates },
          sentAt: { gte: since, lte: receivedAt },
          respondedAt: null,
        },
        orderBy: { sentAt: 'desc' },
        select: { id: true, broadcastId: true },
      });
      if (!recipient) return;
      await tx.broadcastRecipient.update({
        where: { id: recipient.id },
        data: { respondedAt: receivedAt },
      });
      await tx.broadcast.update({
        where: { id: recipient.broadcastId },
        data: { respondedCount: { increment: 1 } },
      });
    });
  } catch {
    /* attribution is best-effort — never block the inbound path */
  }
}
