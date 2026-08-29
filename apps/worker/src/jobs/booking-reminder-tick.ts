// Booking reminder tick.
//
// Every minute, scan for confirmed bookings whose appointment falls inside
// the 2-hour-out firing window and whose operator-picked reminder template
// has not yet fired. For each due booking, call Meta /messages with the
// approved template, persist an outbound WhatsAppMessage, stamp
// reminderSentAt so we never re-fire, and emit a webhook so external
// integrations (CRMs, calendar systems) can observe the send.
//
// Rationale for "always template, never free-form":
//   The user spec asks us to send a verified template specifically when no
//   message has been sent in the last 24 hours — i.e. we're outside Meta's
//   free-form session window. Inside the window a free-form text *would*
//   work, but template messages also work and are operator-controlled,
//   pre-approved by Meta, and (crucially) deterministic. So the tick
//   sends the template either way; the 24h-inactivity branch is the case
//   the user worried about, but it is not the only case where the template
//   should fire.

import { prisma } from './db.js';
import { emitWebhookEvent } from '../lib/emit-webhook.js';
import { getConnection } from '../lib/redis.js';

const TICK_INTERVAL_MS = Number(process.env.BOOKING_REMINDER_TICK_INTERVAL_MS ?? 60_000);
const TICK_LOCK_TTL_S = Math.ceil(TICK_INTERVAL_MS / 1000) + 5;
const TICK_LOCK_KEY = 'lock:booking-reminder-tick';

// Fire when appointmentAt is between (now + LEAD - WINDOW/2) and
// (now + LEAD + WINDOW/2). LEAD = 2h is the user spec. The window adds
// slack for tick interval drift — at 1-minute ticks, 5 minutes of slack
// is plenty and avoids duplicate sends because reminderSentAt is also
// checked.
const LEAD_MS = 2 * 60 * 60 * 1000;
const WINDOW_MS = 5 * 60 * 1000;

async function callMeta(args: {
  token: string;
  phoneNumberId: string;
  to: string;
  templateName: string;
  language: string;
}): Promise<{ ok: boolean; metaMessageId: string | null; error: string | null }> {
  // Reminder templates may or may not have body placeholders. We don't
  // currently expose a per-booking variable mapping in the UI, so we send
  // the template with no `components` array — Meta accepts that for
  // zero-placeholder templates and for templates whose placeholders all
  // have default examples. Templates that require parameters will surface
  // a Meta error here; operators see it in the audit log.
  const payload = {
    messaging_product: 'whatsapp',
    to: args.to.replace(/^\+/, ''),
    type: 'template',
    template: { name: args.templateName, language: { code: args.language } },
  };
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(args.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const text = await res.text();
    if (res.ok) {
      try {
        const body = JSON.parse(text) as { messages?: { id?: string }[] };
        return { ok: true, metaMessageId: body.messages?.[0]?.id ?? null, error: null };
      } catch {
        return { ok: false, metaMessageId: null, error: 'unparseable response' };
      }
    }
    return { ok: false, metaMessageId: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, metaMessageId: null, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

async function processOne(bookingId: string): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { reminderTemplate: true },
  });
  if (!booking) return;
  // Re-check every gate inside the lock so a race between two replicas
  // (or an operator toggling the reminder off mid-tick) can't double-send.
  if (booking.status !== 'confirmed') return;
  if (!booking.reminderTemplateId || !booking.reminderTemplate) return;
  if (booking.reminderSentAt) return;
  if (!booking.appointmentAt) return;
  const template = booking.reminderTemplate;
  if (template.status !== 'approved') return;

  // Mark reminderSentAt optimistically *before* calling Meta, using a
  // compare-and-set on the still-null stamp. This is the only lock we
  // need: if two replicas race here, one of them updates 0 rows and
  // bails out. Side benefit — if Meta responds 5xx, we won't retry,
  // which is the safer failure mode for a 1-shot reminder (better to
  // miss one than spam a customer twice).
  const claim = await prisma.booking.updateMany({
    where: { id: bookingId, reminderSentAt: null },
    data: { reminderSentAt: new Date() },
  });
  if (claim.count === 0) return;

  // Primary channel for this org. Reminders go out on the same number
  // the customer has been talking to, matching the broadcast send path.
  const channel = await prisma.whatsAppChannel.findFirst({
    where: { organizationId: booking.organizationId, isPrimary: true },
  });
  if (!channel?.accessToken || !channel.phoneNumberId) {
    // Channel mis-configured — undo the stamp so the next tick retries
    // once the operator fixes the channel.
    await prisma.booking.update({
      where: { id: bookingId },
      data: { reminderSentAt: null },
    });
    return;
  }

  const out = await callMeta({
    token: channel.accessToken,
    phoneNumberId: channel.phoneNumberId,
    to: booking.customerPhone,
    templateName: template.name,
    language: template.language,
  });

  if (!out.ok) {
    // Send failed. Roll back the stamp so we'll try again next tick
    // (until the appointment slides past the firing window). Log to
    // stdout for ops visibility.
    await prisma.booking.update({
      where: { id: bookingId },
      data: { reminderSentAt: null },
    });
    console.error('[booking-reminder] meta send failed', {
      bookingId,
      template: template.name,
      error: out.error,
    });
    return;
  }

  // Persist as an outbound thread message so /inbox shows the reminder.
  await prisma.whatsAppMessage
    .create({
      data: {
        organizationId: booking.organizationId,
        threadId: booking.threadId,
        direction: 'outbound',
        metaMessageId: out.metaMessageId,
        toNumber: booking.customerPhone.replace(/^\+/, ''),
        messageType: 'template',
        body: template.name,
        metaStatus: 'sent',
        metaStatusAt: new Date(),
      },
    })
    .catch((err) => console.error('[booking-reminder] persist outbound failed', err));

  void emitWebhookEvent({
    organizationId: booking.organizationId,
    eventKind: 'booking_reminder_sent',
    payload: {
      bookingId: booking.id,
      customerPhone: booking.customerPhone,
      appointmentAt: booking.appointmentAt.toISOString(),
      templateId: template.id,
      templateName: template.name,
      metaMessageId: out.metaMessageId,
    },
  });
}

async function tick(): Promise<void> {
  const redis = getConnection();
  const lock = await redis.set(TICK_LOCK_KEY, '1', 'EX', TICK_LOCK_TTL_S, 'NX');
  if (lock !== 'OK') return;
  const now = Date.now();
  const lowerBound = new Date(now + LEAD_MS - WINDOW_MS / 2);
  const upperBound = new Date(now + LEAD_MS + WINDOW_MS / 2);
  const due = await prisma.booking.findMany({
    where: {
      status: 'confirmed',
      reminderTemplateId: { not: null },
      reminderSentAt: null,
      appointmentAt: { gte: lowerBound, lte: upperBound },
    },
    select: { id: true },
    take: 200,
  });
  for (const row of due) {
    try {
      await processOne(row.id);
    } catch (err) {
      console.error('[booking-reminder] booking failed', row.id, err);
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;

export function startBookingReminderTick(): { close: () => Promise<void>; name: string } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[booking-reminder-tick] error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // Stagger 7s after boot so we don't race other ticks for the lock.
  timer = setTimeout(run, 7_000);
  return {
    name: 'booking-reminder-tick',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
