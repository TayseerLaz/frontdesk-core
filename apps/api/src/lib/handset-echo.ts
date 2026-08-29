import { withRlsBypass } from './db.js';
import { upsertWaThread } from './wa-thread.js';

/**
 * Coexistence handset replies — Meta's `smb_message_echoes` webhook field.
 *
 * WHAT THIS IS FOR. Under Coexistence the business keeps answering customers from the
 * WhatsApp Business app on their phone. Those replies reach us here. Without this, Hader's
 * inbox shows only what Hader itself sent, so an operator sees a customer question as
 * unanswered when the owner already dealt with it — and, worse, `maybeReplyAsBot` has no
 * way to know either, because a handset reply produces no HTTP request to Hader at all.
 *
 * So this is not only an inbox feature. It is the ONLY source of the fact that a human
 * already answered, which is why `handsetRepliedAt` is written here and gated in the bot
 * path, and why the coalesce token is bumped: a reply typed during the bot's 8–20s
 * generation window has to be able to kill the draft before it sends.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *  - No wallet charge. Meta billed the tenant's own handset for this message. Metering it
 *    here would bill them twice, and `chargeAtSend` without a broadcast recipient row has
 *    no idempotency claim and is structurally unrefundable.
 *  - No bot dispatch. An echo is outbound; nothing about it should provoke a reply.
 *  - No STOP / opt-out detection. That reads inbound customer text, and an echo is the
 *    business's own words.
 *  - No `lastInboundAt` write. An echo is not the customer speaking.
 *  - No thread reopen. Deliberately unlike the inbound path, which sets `status: 'open'`.
 *    The owner answering from their phone is not a reason to resurface a thread an operator
 *    already resolved in Hader.
 *
 * ONE BEHAVIOUR CHANGE WORTH KNOWING. This does bump `lastMessageAt` and `outboundCount`,
 * because both are simply true and the inbox orders on the former. That makes the thread
 * eligible for a `noReply` follow-up ("we answered, they went quiet"), which is what that
 * engine is for — but it is a real change. The blast radius today is nil: `follow_ups` is
 * defaultDisabled, needs an approved template, and is inert per tenant until one is picked,
 * so only a tenant who has deliberately configured follow-ups AND connected coexistence
 * can see it. Left un-gated on purpose rather than adding a switch nobody needs yet.
 */

/** One echo as Meta sends it, under `value.message_echoes[]`. */
type MessageEcho = {
  id?: string;
  /** The business's own number. Not used for routing — the channel is already resolved. */
  from?: string;
  /** The CUSTOMER. This is what identifies the thread. */
  to?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  [k: string]: unknown;
};

/**
 * Preview text for an echo, mirroring the inbound path's convention so a handset photo and
 * a customer photo read the same way in the inbox rather than one saying "[image]" and the
 * other nothing.
 */
function echoBody(e: MessageEcho): string {
  const type = e.type ?? 'text';
  if (type === 'text') return e.text?.body ?? '';
  const caption = (e as { [k: string]: { caption?: string } | undefined })[type]?.caption;
  if (caption) return caption;
  return `[${type}]`;
}

export type EchoConsumeResult = {
  /** Rows actually written. Excludes duplicates Meta redelivered. */
  stored: number;
  /** Echoes we already had, by wamid. Expected and harmless — Meta retries for days. */
  duplicates: number;
  /** Echoes we could not attribute to a customer number. */
  skipped: number;
};

/**
 * Persist a batch of handset replies for ONE organisation and channel.
 *
 * Runs under `withRlsBypass` for the same reason the inbound webhook does: there is no
 * authenticated request behind a webhook, so there is no tenant context to inherit. Every
 * query is explicitly filtered on the organisationId the caller resolved from the phone
 * number, which is the F-02 discipline — bypass only where tenancy has already been
 * established, never as a shortcut.
 */
export async function consumeMessageEchoes(args: {
  organizationId: string;
  whatsAppChannelId: string | null;
  echoes: MessageEcho[];
  log: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
}): Promise<EchoConsumeResult> {
  const result: EchoConsumeResult = { stored: 0, duplicates: 0, skipped: 0 };

  for (const e of args.echoes) {
    const customerPhone = e.to?.trim();
    if (!customerPhone) {
      result.skipped += 1;
      continue;
    }
    // Meta's own send time, in seconds. Never now(): a redelivered echo from three days
    // ago must not read as "the owner just replied", or the bot gate below silences a
    // thread that has genuinely been waiting.
    const sentAt =
      e.timestamp && Number.isFinite(Number(e.timestamp))
        ? new Date(Number(e.timestamp) * 1000)
        : new Date();
    const body = echoBody(e);
    const metaMessageId = e.id ?? null;

    try {
      await withRlsBypass(async (tx) => {
        // Cheap pre-check so an ordinary redelivery is not an exception path. The unique
        // index added in migration 20260824120000 is the real guarantee; the catch below
        // handles the race this check cannot.
        if (metaMessageId) {
          const existing = await tx.whatsAppMessage.findFirst({
            where: { organizationId: args.organizationId, metaMessageId },
            select: { id: true },
          });
          if (existing) {
            result.duplicates += 1;
            return;
          }
        }

        // Read the prior stamp before the upsert so the write can be forward-only. An
        // out-of-order redelivery of an OLDER echo must not walk handsetRepliedAt
        // backwards and un-silence the bot on a conversation a human is handling.
        const prior = await tx.whatsAppThread.findFirst({
          where: {
            organizationId: args.organizationId,
            customerPhone,
            whatsAppChannelId: args.whatsAppChannelId ?? null,
          },
          select: { handsetRepliedAt: true, lastMessageAt: true },
        });
        const handsetRepliedAt =
          prior?.handsetRepliedAt && prior.handsetRepliedAt > sentAt
            ? prior.handsetRepliedAt
            : sentAt;
        // Same rule for the thread's own ordering field: a late redelivery must not
        // drag a busy conversation back down the inbox.
        const newer = !prior?.lastMessageAt || sentAt > prior.lastMessageAt;

        const thread = await upsertWaThread(tx, {
          organizationId: args.organizationId,
          customerPhone,
          whatsAppChannelId: args.whatsAppChannelId,
          create: {
            status: 'open',
            lastMessageAt: sentAt,
            lastMessagePreview: body.slice(0, 200),
            // NOT lastInboundAt — an echo is the business speaking, not the customer.
            inboundCount: 0,
            outboundCount: 1,
            searchText: body,
            handsetRepliedAt,
          },
          update: {
            outboundCount: { increment: 1 },
            handsetRepliedAt,
            // Deliberately no `status: 'open'`, unlike the inbound path. The owner
            // answering from their phone is not a reason to resurface a thread an
            // operator already resolved in Hader.
            ...(newer ? { lastMessageAt: sentAt, lastMessagePreview: body.slice(0, 200) } : {}),
          },
        });

        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: args.organizationId,
            direction: 'outbound',
            metaMessageId,
            toNumber: customerPhone,
            messageType: e.type ?? 'text',
            body,
            receivedAt: sentAt,
            // `sentBy: 'operator'` is deliberate and requires no schema change: the inbox
            // already maps every non-'bot' outbound row to the operator bubble
            // (inbox.routes.ts ~:854), so these render correctly with no UI work, and the
            // dashboard's bot-handled count correctly does not claim them. `via: 'handset'`
            // is what distinguishes them from a Hader-portal reply for analytics.
            rawPayload: { sentBy: 'operator', via: 'handset' } as never,
          },
        });
        result.stored += 1;
      });
    } catch (err) {
      // P2002 on the new unique index: Meta redelivered while we were writing. Not an
      // error, just the race the pre-check above cannot close.
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
        result.duplicates += 1;
        continue;
      }
      args.log.warn(
        { orgId: args.organizationId, metaMessageId, err },
        '[whatsapp] handset echo: could not store — left parked for replay',
      );
    }
  }

  // Kill any bot draft mid-flight for the customers involved. `maybeReplyAsBot` re-reads
  // this key AFTER generation and discards its draft if the value changed, so overwriting
  // it is enough — no new mechanism, and it covers the exact window the owner is most
  // likely to reply in (the 8–20s a large-catalog generation takes).
  if (result.stored > 0) {
    const phones = [
      ...new Set(args.echoes.map((e) => e.to?.trim()).filter((p): p is string => Boolean(p))),
    ];
    try {
      const { getRedis } = await import('./redis.js');
      const redis = getRedis();
      for (const phone of phones) {
        await redis.set(
          `botcoalesce:${args.organizationId}:${phone}`,
          `handset.${Date.now()}`,
          'PX',
          300_000,
        );
      }
    } catch {
      // Redis down. The handsetRepliedAt gate still catches the next inbound; only the
      // mid-generation supersede is lost, which is the pre-existing behaviour.
    }
  }

  return result;
}
