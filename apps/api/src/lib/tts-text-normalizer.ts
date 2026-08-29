// Phase 12.1 — text normalization layer that runs JUST BEFORE TTS.
//
// ElevenLabs (and Google to a lesser extent) apply "smart" number-to-
// speech conversion by default: they look at "0.150 KWD" and decide to
// say it the way a native speaker would — which in Gulf Arabic context
// means "150 fils" instead of "zero point one five zero Kuwaiti dinar".
//
// Operator policy is "always say the configured 3-letter currency code,
// never subunits." The post-LLM validator enforces this on the TEXT
// reply. But the text "0.150 KWD" still triggers TTS-side colloquial
// conversion. We sidestep by replacing the bare currency code with the
// full word + name BEFORE handing the text to TTS:
//
//   "0.150 KWD"            →  "0.150 Kuwaiti dinar"
//   "1.500 KWD"            →  "1.500 Kuwaiti dinar"   (TTS reads dinar literally)
//   "0.150 دينار كويتي"     →  unchanged (already spelled out)
//
// Combined with apply_text_normalization='off' on the TTS request,
// this gives us deterministic control over what the customer hears.

const CURRENCY_FULL_NAMES_EN: Record<string, string> = {
  KWD: 'Kuwaiti dinar',
  BHD: 'Bahraini dinar',
  OMR: 'Omani rial',
  JOD: 'Jordanian dinar',
  AED: 'UAE dirham',
  SAR: 'Saudi riyal',
  QAR: 'Qatari riyal',
  EGP: 'Egyptian pound',
  USD: 'US dollar',
  EUR: 'euro',
  GBP: 'British pound',
  JPY: 'Japanese yen',
  CNY: 'Chinese yuan',
  INR: 'Indian rupee',
  TRY: 'Turkish lira',
  CHF: 'Swiss franc',
  CAD: 'Canadian dollar',
  AUD: 'Australian dollar',
};

const CURRENCY_FULL_NAMES_AR: Record<string, string> = {
  KWD: 'دينار كويتي',
  BHD: 'دينار بحريني',
  OMR: 'ريال عماني',
  JOD: 'دينار أردني',
  AED: 'درهم إماراتي',
  SAR: 'ريال سعودي',
  QAR: 'ريال قطري',
  EGP: 'جنيه مصري',
  USD: 'دولار أمريكي',
  EUR: 'يورو',
  GBP: 'جنيه إسترليني',
};

// Conservative Arabic detection: any reply with at least one Arabic
// letter is treated as Arabic-context. Replies are normally either
// fully one language or fully the other on a per-turn basis — the bot
// detects + sticks with the customer's language.
const ARABIC_CHAR_RE = /[؀-ۿ]/;

/**
 * Rewrite "<amount> KWD" → "<amount> Kuwaiti dinar" (or Arabic equivalent
 * when the text is Arabic) so the downstream TTS reads the price literally
 * instead of converting it to colloquial fils / cents / etc.
 *
 * Idempotent — running it twice on already-expanded text is a no-op.
 * Tenant-agnostic; works for every supported currency.
 */
export function normalizeCurrencyForTts(text: string): string {
  if (!text) return text;
  const isArabic = ARABIC_CHAR_RE.test(text);
  const table = isArabic ? CURRENCY_FULL_NAMES_AR : CURRENCY_FULL_NAMES_EN;
  let out = text;
  for (const [code, name] of Object.entries(table)) {
    // Match "<digits> <code>" with optional decimal. We require a
    // whitespace boundary on the left of the code so we don't touch
    // codes embedded in identifiers (e.g. "KWD-LATTE-001").
    // Pattern allows a trailing word boundary or punctuation/end-of-line
    // because Arabic punctuation + `\b` together are tricky.
    const re = new RegExp(`(\\b\\d+(?:[.,]\\d+)?)\\s+${code}(?=$|[\\s.,!?؟،؛:;\\)\\]])`, 'g');
    out = out.replace(re, `$1 ${name}`);
  }
  return out;
}
