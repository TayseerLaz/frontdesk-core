// F5 — back-in-stock watches (roadmap 2026-08-26). Pure decision logic shared
// by the API's capture hook and the worker's notify tick. NO env/db imports —
// runs in the pure HARD gate (apps/api/test/pure/stock-watch.test.ts).
//
// Capture is AUTOMATIC (owner decision): a customer message that names an
// unavailable product/service flags them — no opt-in button. The matcher is
// deliberately conservative: an exact (normalized) name occurrence, never
// fuzzy guessing. A false negative costs one missed alert; a false positive
// spams a customer — so precision wins.

export interface WatchableEntity {
  id: string;
  name: string;
  kind: 'product' | 'service';
}

// Lowercase, unify Arabic presentation quirks lightly, collapse punctuation
// to single spaces so "gel!" matches "gel" and "الجل؟" matches "الجل".
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '') // Arabic diacritics + tatweel
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Which unavailable entities does this inbound message name?
 * Match rule: the FULL normalized entity name appears in the normalized
 * message on token boundaries. Names shorter than 4 characters AND a single
 * token never match (too ambiguous — "gel" alone would false-positive
 * constantly). Cap 3 — a message naming more is a list, not an inquiry.
 */
export function matchUnavailableEntities(
  inbound: string | null | undefined,
  entities: WatchableEntity[],
): WatchableEntity[] {
  const msg = normalize(inbound ?? '');
  if (!msg || msg.length < 3) return [];
  const padded = ` ${msg} `;
  const out: WatchableEntity[] = [];
  for (const e of entities) {
    const name = normalize(e.name);
    if (!name) continue;
    const tokens = name.split(' ');
    if (name.length < 4 && tokens.length < 2) continue;
    if (padded.includes(` ${name} `)) {
      out.push(e);
      if (out.length >= 3) break;
    }
  }
  return out;
}

/** Free-text restock notification (inside the 24h session window). */
export function restockMessageText(
  lang: 'ar' | 'en',
  entityName: string,
  priceLabel?: string | null,
): string {
  const price = priceLabel ? ` (${priceLabel})` : '';
  return lang === 'ar'
    ? `خبر حلو! 🔔 "${entityName}"${price} رجع متوفر عنا. اكتبلنا هون إذا بتحب تطلبه 🙏`
    : `Good news! 🔔 "${entityName}"${price} is back in stock. Reply here if you'd like to order 🙏`;
}

/** Arabic-script check shared with the tick's language pick. */
export function stockWatchPrefersArabic(text: string | null | undefined): boolean {
  return /[؀-ۿ]/.test(text ?? '');
}
