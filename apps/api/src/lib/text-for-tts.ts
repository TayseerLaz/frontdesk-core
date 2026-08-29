// Rewrites a bot reply so ElevenLabs pronounces prices naturally in
// the matching language. The bot's text uses ISO codes (e.g.
// "0.150 KWD") because that's what looks right in chat. In voice,
// ElevenLabs reads "KWD" as English letters ("kay-double-yoo-dee"),
// which breaks an Arabic sentence and sounds robotic in English too.
// Arabic digit pronunciation is also unreliable in many ElevenLabs
// voices, so for Arabic replies we spell numbers out as words.
//
// This helper:
//   - detects the surrounding language (Arabic if any Arabic letters
//     appear, else English)
//   - replaces each "<number> <CODE>" match with the spoken currency
//     name in that language ("Kuwaiti Dinar" / "دينار كويتي")
//   - English: strips trailing zeros ("0.150" → "0.15"); ElevenLabs
//     handles English digits well
//   - Arabic: spells the number as words ("1.5" → "واحد فاصلة خمسة")
//     so the model never has to interpret Western digits in Arabic
//     context
//
// Only used on the TTS path — the original `reply` text is still
// saved to the inbox and sent in the text-fallback branch.

const CURRENCY_NAMES: Record<string, { en: string; ar: string }> = {
  KWD: { en: 'Kuwaiti Dinar', ar: 'دينار كويتي' },
  BHD: { en: 'Bahraini Dinar', ar: 'دينار بحريني' },
  OMR: { en: 'Omani Rial', ar: 'ريال عماني' },
  JOD: { en: 'Jordanian Dinar', ar: 'دينار أردني' },
  AED: { en: 'UAE Dirham', ar: 'درهم إماراتي' },
  SAR: { en: 'Saudi Riyal', ar: 'ريال سعودي' },
  QAR: { en: 'Qatari Riyal', ar: 'ريال قطري' },
  USD: { en: 'US dollars', ar: 'دولار أمريكي' },
  EUR: { en: 'euros', ar: 'يورو' },
  GBP: { en: 'pounds', ar: 'جنيه إسترليني' },
  EGP: { en: 'Egyptian pounds', ar: 'جنيه مصري' },
  LBP: { en: 'Lebanese pounds', ar: 'ليرة لبنانية' },
  TRY: { en: 'Turkish Lira', ar: 'ليرة تركية' },
};

function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

// "0.150" → "0.15", "5.000" → "5", "5" → "5", "5.50" → "5.5"
function stripTrailingZeros(num: string): string {
  if (!num.includes('.') && !num.includes(',')) return num;
  const sep = num.includes('.') ? '.' : ',';
  const [intPart, fracPart = ''] = num.split(sep);
  const trimmed = fracPart.replace(/0+$/, '');
  return trimmed ? `${intPart}${sep}${trimmed}` : intPart!;
}

// --- Arabic spelling of integers 0..9999 ----------------------------
// Sufficient for prices in any currency we support. Beyond 9999 we
// fall back to digit-by-digit so we never panic.
const AR_ONES = [
  'صفر', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة',
  'ستة', 'سبعة', 'ثمانية', 'تسعة',
];
const AR_TEENS = [
  'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر',
  'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر',
];
const AR_TENS = [
  '', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون',
  'ستون', 'سبعون', 'ثمانون', 'تسعون',
];
const AR_HUNDREDS = [
  '', 'مئة', 'مئتان', 'ثلاثمئة', 'أربعمئة', 'خمسمئة',
  'ستمئة', 'سبعمئة', 'ثمانمئة', 'تسعمئة',
];

function arabicIntUnder1000(n: number): string {
  if (n < 10) return AR_ONES[n]!;
  if (n < 20) return AR_TEENS[n - 10]!;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? AR_TENS[tens]! : `${AR_ONES[ones]} و${AR_TENS[tens]}`;
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return rest === 0
    ? AR_HUNDREDS[hundreds]!
    : `${AR_HUNDREDS[hundreds]} و${arabicIntUnder1000(rest)}`;
}

function arabicInteger(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1000) return arabicIntUnder1000(n);
  if (n < 10_000) {
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    const thousandsWord =
      thousands === 1
        ? 'ألف'
        : thousands === 2
          ? 'ألفان'
          : `${arabicIntUnder1000(thousands)} آلاف`;
    return rest === 0 ? thousandsWord : `${thousandsWord} و${arabicIntUnder1000(rest)}`;
  }
  // Unlikely for prices; spell each digit so we never panic.
  return String(n)
    .split('')
    .map((d) => AR_ONES[Number(d)] ?? d)
    .join(' ');
}

// "1.5" → "واحد فاصلة خمسة", "0.15" → "صفر فاصلة خمسة عشر",
// "0.05" → "صفر فاصلة صفر خمسة" (leading-zero fractional digits read
// individually so we don't lose the magnitude).
function arabicNumber(num: string): string {
  const cleaned = num.replace(',', '.').trim();
  if (!cleaned.includes('.')) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? arabicInteger(n) : cleaned;
  }
  const [intPart = '0', fracPart = ''] = cleaned.split('.');
  const intWords = arabicInteger(Number(intPart));
  if (!fracPart) return intWords;
  // Leading zeros in the fractional part change the magnitude
  // (e.g. 0.05 vs 0.5); read them out one-by-one if present, else
  // read the trailing portion as a single number.
  const leadingZeros = (fracPart.match(/^0+/) ?? [''])[0]!.length;
  const tail = fracPart.slice(leadingZeros);
  const parts: string[] = [intWords, 'فاصلة'];
  for (let i = 0; i < leadingZeros; i++) parts.push('صفر');
  if (tail) parts.push(arabicInteger(Number(tail)));
  return parts.join(' ');
}

export function rewriteForTts(text: string): string {
  if (!text) return text;
  const lang: 'en' | 'ar' = isArabic(text) ? 'ar' : 'en';
  const codes = Object.keys(CURRENCY_NAMES).join('|');

  // First: replace "<number> <CODE>" patterns with the spoken form in
  // the matching language. Strip trailing fractional zeros in both
  // languages first so "1.500" reads as "one point five" / "واحد
  // فاصلة خمسة" instead of "one point five hundred" — then spell out
  // for Arabic.
  const priceRe = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${codes})\\b`, 'g');
  let out = text.replace(priceRe, (_full, num: string, code: string) => {
    const names = CURRENCY_NAMES[code];
    if (!names) return _full;
    const trimmed = stripTrailingZeros(num);
    const spokenNum = lang === 'ar' ? arabicNumber(trimmed) : trimmed;
    return `${spokenNum} ${names[lang]}`;
  });

  // Arabic only: spell out any remaining standalone numbers in the text
  // so quantities ("3× Oreo Milkshake") and other digits don't fall back
  // to English digit reading. We deliberately skip "3×" → "3 ×" style
  // multipliers by not touching numbers immediately followed by ×, x, X.
  if (lang === 'ar') {
    out = out.replace(/(?<![\w.])(\d+(?:[.,]\d+)?)(?![×xX\d.])/g, (_m, num: string) =>
      arabicNumber(num),
    );
  }

  return out;
}
