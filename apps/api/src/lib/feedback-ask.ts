// F2 — send the post-conversation rating ask (roadmap 2026-08-26).
//
// Called fire-and-forget AFTER the resolve transaction commits (a network
// round-trip must never ride a Postgres tx — house invariant). Every guard
// lives here so callers stay one line:
//   • org feature gate (`feedback` in disabled_features → no-op)
//   • tenant toggle (BotConfig.feedback.enabled)
//   • WhatsApp threads only, real channel with creds
//   • 24h session window (free-form send only — no template in v1)
//   • contact opt-out / block gates
//   • one ask per thread EVER (unique threadId) + 30-day per-contact throttle
//
// Fail-soft throughout: any error logs and returns — resolving a conversation
// must never fail because the survey couldn't send.
import { withRlsBypass } from './db.js';
import {
  computeHandlerMix,
  containsArabic,
  feedbackAskText,
  parseFeedbackConfig,
  withinSessionWindow,
} from './feedback.js';

export async function maybeAskFeedback(args: {
  organizationId: string;
  threadId: string;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}): Promise<void> {
  const { organizationId, threadId, log } = args;
  try {
    const now = new Date();
    const ctx = await withRlsBypass(async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { disabledFeatures: true },
      });
      if (!org || org.disabledFeatures.includes('feedback')) return null;

      const cfg = await tx.botConfig.findUnique({
        where: { organizationId },
        select: { feedback: true },
      });
      if (!parseFeedbackConfig(cfg?.feedback).enabled) return null;

      const thread = await tx.whatsAppThread.findFirst({
        where: { id: threadId, organizationId },
        select: {
          channel: true,
          customerPhone: true,
          whatsAppChannelId: true,
          lastInboundAt: true,
          awaitingFeedbackAt: true,
        },
      });
      if (!thread || thread.channel !== 'whatsapp') return null;
      if (thread.awaitingFeedbackAt) return null; // ask already in flight
      if (!withinSessionWindow(thread.lastInboundAt, now)) return null; // outside 24h → v1 skips

      // One ask per thread, ever.
      const existing = await tx.conversationFeedback.findUnique({
        where: { threadId },
        select: { id: true },
      });
      if (existing) return null;

      // Contact gates + the 30-day per-contact throttle. Threads store the
      // phone WITHOUT the leading '+', contacts WITH it — match both forms.
      const phoneE164 = thread.customerPhone.startsWith('+')
        ? thread.customerPhone
        : `+${thread.customerPhone}`;
      const contact = await tx.contact.findFirst({
        where: {
          organizationId,
          phoneE164: { in: [phoneE164, thread.customerPhone] },
          deletedAt: null,
        },
        select: { id: true, optedOutAt: true, blockedAt: true },
      });
      if (contact?.optedOutAt || contact?.blockedAt) return null;
      if (contact) {
        const recent = await tx.conversationFeedback.findFirst({
          where: {
            organizationId,
            contactId: contact.id,
            askedAt: { gt: new Date(now.getTime() - 30 * 24 * 3600 * 1000) },
          },
          select: { id: true },
        });
        if (recent) return null;
      }

      // The AI-vs-human split, computed at ask time from what actually went out.
      const [aiCount, outboundCount] = await Promise.all([
        tx.whatsAppMessage.count({
          where: {
            threadId,
            organizationId,
            direction: 'outbound',
            rawPayload: { path: ['sentBy'], equals: 'bot' },
          },
        }),
        tx.whatsAppMessage.count({
          where: { threadId, organizationId, direction: 'outbound' },
        }),
      ]);
      if (outboundCount === 0) return null; // nobody ever replied — nothing to rate
      const humanCount = outboundCount - aiCount;

      // Send from the thread's own number, resolved ONLY within this org
      // (H-3); primary as the fallback for legacy threads.
      const channel = await tx.whatsAppChannel.findFirst({
        where: thread.whatsAppChannelId
          ? { id: thread.whatsAppChannelId, organizationId }
          : { organizationId, isPrimary: true },
        select: { phoneNumberId: true, accessToken: true, isActive: true },
      });
      if (!channel?.isActive || !channel.phoneNumberId || !channel.accessToken) return null;

      // Language: mirror the customer's last inbound script.
      const lastInbound = await tx.whatsAppMessage.findFirst({
        where: { threadId, organizationId, direction: 'inbound' },
        orderBy: { receivedAt: 'desc' },
        select: { body: true },
      });

      return {
        thread,
        contactId: contact?.id ?? null,
        aiCount,
        humanCount,
        channel,
        lang: containsArabic(lastInbound?.body) ? ('ar' as const) : ('en' as const),
      };
    });
    if (!ctx) return;

    const ask = feedbackAskText(ctx.lang);
    const to = ctx.thread.customerPhone.replace(/^\+/, '');
    const sendRes = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId!)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.channel.accessToken!}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: ask },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const sendText = await sendRes.text();
    if (!sendRes.ok) {
      log.warn({ threadId, status: sendRes.status, body: sendText.slice(0, 300) }, '[feedback] ask send failed');
      return;
    }
    let metaMessageId: string | null = null;
    try {
      metaMessageId = (JSON.parse(sendText) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
    } catch {
      /* noop */
    }

    await withRlsBypass(async (tx) => {
      await tx.conversationFeedback.create({
        data: {
          organizationId,
          threadId,
          contactId: ctx.contactId,
          channel: 'whatsapp',
          handlerMix: computeHandlerMix(ctx.aiCount, ctx.humanCount),
          aiMessageCount: ctx.aiCount,
          humanMessageCount: ctx.humanCount,
        },
      });
      await tx.whatsAppMessage.create({
        data: {
          threadId,
          organizationId,
          direction: 'outbound',
          metaMessageId,
          toNumber: to,
          messageType: 'text',
          body: ask,
          rawPayload: { sentBy: 'bot', reason: 'feedback_ask' } as never,
        },
      });
      await tx.whatsAppThread.update({
        where: { id: threadId },
        data: {
          awaitingFeedbackAt: new Date(),
          lastMessageAt: new Date(),
          lastMessagePreview: ask.slice(0, 200),
          outboundCount: { increment: 1 },
        },
      });
    });
    log.info({ threadId, organizationId }, '[feedback] rating ask sent');
  } catch (err) {
    log.warn({ err, threadId }, '[feedback] maybeAskFeedback failed (non-fatal)');
  }
}
