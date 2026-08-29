// What a confirmed booking says to the customer, and when.
//
// Pure — no env, no db, no network (env.ts process.exit(1)s, which would make
// this untestable). The I/O half lives in booking-confirm.ts.
//
// The message is deliberately deterministic rather than LLM-written: it carries
// a meeting link or an address, and a model that paraphrases a URL or invents a
// time is worse than no message at all.

export type MeetingMode = 'online' | 'onsite';

export interface ConfirmDecision {
  /** Write the booking to the tenant's Google Calendar. */
  push: boolean;
  /** Ask Google for a Meet link. */
  withMeet: boolean;
  /** Move the booking straight to confirmed instead of leaving it for a human. */
  confirm: boolean;
}

/**
 * Whether this booking gets the calendar treatment, given the tenant's setup.
 *
 * A booking with no resolved date+time can't become a calendar event at all —
 * there's nothing to put on the calendar — so it stays as it is today and an
 * operator picks it up. That's the same rule the sync tick already applies.
 */
export function decideConfirm(args: {
  connected: boolean;
  pushBookings: boolean;
  meetingMode: MeetingMode;
  autoConfirm: boolean;
  hasAppointment: boolean;
}): ConfirmDecision {
  const push = args.connected && args.pushBookings && args.hasAppointment;
  return {
    push,
    withMeet: push && args.meetingMode === 'online',
    // Auto-confirmation is tied to the calendar, per the product decision:
    // "if it is added to google calendar, the AI approves". Without a calendar
    // the booking keeps waiting for a human, exactly as before.
    confirm: push && args.autoConfirm,
  };
}

/** The first email-looking answer on the booking form, or null. */
export function pickAttendeeEmail(
  fields: { key?: string; type?: string; value?: unknown }[] | null | undefined,
): string | null {
  for (const f of fields ?? []) {
    const v = typeof f?.value === 'string' ? f.value.trim() : '';
    if (!v) continue;
    const looksEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
    if (looksEmail && (f.type === 'email' || /mail/i.test(f.key ?? '') || looksEmail)) return v;
  }
  return null;
}

/**
 * Does this text contain Arabic? The bot mirrors the customer's language, so
 * the confirmation should too — a customer who wrote in Arabic getting an
 * English confirmation reads as a different system talking.
 */
export function isArabic(text: string | null | undefined): boolean {
  return /[؀-ۿ]/.test(text ?? '');
}

export interface ConfirmTextArgs {
  when: string;
  arabic: boolean;
  meetLink?: string | null;
  address?: string | null;
  businessName?: string | null;
}

/**
 * The confirmation the customer receives. One short block: what's confirmed,
 * when, and how to attend.
 */
export function confirmationText(a: ConfirmTextArgs): string {
  const lines: string[] = [];
  if (a.arabic) {
    lines.push(`✅ تم تأكيد موعدك${a.businessName ? ` مع ${a.businessName}` : ''}.`);
    lines.push(`🗓 ${a.when}`);
    if (a.meetLink) lines.push(`💻 رابط الاجتماع: ${a.meetLink}`);
    else if (a.address) lines.push(`📍 العنوان: ${a.address}`);
  } else {
    lines.push(`✅ Your booking is confirmed${a.businessName ? ` with ${a.businessName}` : ''}.`);
    lines.push(`🗓 ${a.when}`);
    if (a.meetLink) lines.push(`💻 Join here: ${a.meetLink}`);
    else if (a.address) lines.push(`📍 Address: ${a.address}`);
  }
  return lines.join('\n');
}

/** Appointment instant → a human label in the tenant's timezone. */
export function formatWhen(at: Date, timezone: string, arabic: boolean): string {
  try {
    return new Intl.DateTimeFormat(arabic ? 'ar' : 'en-GB', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: !arabic,
    }).format(at);
  } catch {
    return at.toISOString();
  }
}
