// F2 — post-conversation feedback (roadmap 2026-08-26). Pure decision logic:
// parsing a 1-5 rating out of a customer reply, the deterministic ask/thanks
// copy, and the handler-mix split. NO env/db imports — runs in the pure HARD
// gate (test/pure/feedback.test.ts).
//
// Rating scale is a 1-5 TYPED reply (owner decision 2026-08-26) — no buttons.

export interface FeedbackConfig {
  enabled: boolean;
}

/** Defensive parse of BotConfig.feedback JSONB. */
export function parseFeedbackConfig(raw: unknown): FeedbackConfig {
  if (!raw || typeof raw !== 'object') return { enabled: false };
  return { enabled: (raw as { enabled?: unknown }).enabled === true };
}

// Arabic-Indic (٠-٩, U+0660) and Eastern Arabic-Indic (۰-۹, U+06F0) digits →
// ASCII, so "٤" and "۵" rate like "4" and "5".
function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

/**
 * Parse a rating reply. Accepts: a bare 1-5 digit (Western or Arabic-Indic),
 * "4/5"-style forms, "4 stars"/"٥ نجوم", and 1-5 star emoji. Anything longer
 * than a short reply is a real message, not a rating — return null and let
 * the bot handle it.
 */
export function parseRating(text: string | null | undefined): number | null {
  const raw = (text ?? '').trim();
  if (!raw || raw.length > 24) return null;
  // Star emoji: count them (⭐ U+2B50, ★ U+2605, 🌟 U+1F31F).
  const stars = [...raw].filter((c) => c === '⭐' || c === '★' || c === '🌟').length;
  if (stars >= 1 && stars <= 5 && [...raw].every((c) => c === '⭐' || c === '★' || c === '🌟' || c === ' ')) {
    return stars;
  }
  const t = normalizeDigits(raw).toLowerCase();
  const m =
    /^([1-5])$/.exec(t) ??
    /^([1-5])\s*\/\s*5$/.exec(t) ??
    /^([1-5])\s*(stars?|star|نجوم|نجمات|نجمة)\s*$/u.exec(t);
  return m ? Number(m[1]) : null;
}

/** Crude but reliable script check for picking the ask/thanks language. */
export function containsArabic(text: string | null | undefined): boolean {
  return /[؀-ۿ]/.test(text ?? '');
}

/** The rating ask — deterministic, never model-written. */
export function feedbackAskText(lang: 'ar' | 'en'): string {
  return lang === 'ar'
    ? 'قبل أن تذهب — كيف كانت تجربتك معنا اليوم؟ جاوبنا برقم من ١ (سيئة) إلى ٥ (ممتازة) 🙏'
    : 'Before you go — how was your experience with us today? Reply with a number from 1 (poor) to 5 (excellent) 🙏';
}

/** The thank-you after a rating lands — deterministic, rating-aware. */
export function feedbackThanksText(lang: 'ar' | 'en', rating: number): string {
  if (rating <= 2) {
    return lang === 'ar'
      ? 'شكراً لصراحتك 🙏 نعتذر إذا قصّرنا — سيراجع فريقنا هذه المحادثة.'
      : "Thank you for your honesty 🙏 We're sorry we fell short — our team will review this conversation.";
  }
  return lang === 'ar' ? 'شكراً جزيلاً على تقييمك! 🙏' : 'Thank you so much for your feedback! 🙏';
}

/** The owner's "split to customer and ai": who actually handled this thread. */
export function computeHandlerMix(
  aiMessageCount: number,
  humanMessageCount: number,
): 'ai' | 'human' | 'mixed' {
  if (aiMessageCount > 0 && humanMessageCount > 0) return 'mixed';
  if (humanMessageCount > 0) return 'human';
  return 'ai';
}

/** The 24h WhatsApp session window — free-form sends only inside it. */
export function withinSessionWindow(lastInboundAt: Date | null | undefined, now: Date): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < 24 * 3600 * 1000;
}

/** A stale ask (customer never answered) should not swallow a message a week later. */
export function feedbackStampFresh(stamp: Date | null | undefined, now: Date): boolean {
  if (!stamp) return false;
  return now.getTime() - stamp.getTime() < 7 * 24 * 3600 * 1000;
}
