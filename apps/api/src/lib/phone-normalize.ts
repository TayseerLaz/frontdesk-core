// Normalising phone numbers that came out of a real address book.
//
// This is deliberately NOT the naive `replace(/[^\d]/g,'')` + '+' prefix used by the
// CSV importer (contacts/import-csv.ts:36). That is fine for a CSV a human prepared
// for us, where numbers are already international. It is wrong for an address book,
// where the overwhelming majority of entries are stored the way the owner dials them
// — locally. Run "03 123 456" (a normal Lebanese mobile) through the naive path and
// you get "+03123456": syntactically a phone number, matching absolutely nothing,
// silently wrong for every contact in the file.
//
// Pure + dependency-free so it is unit-testable without a DB, per the house rule that
// pure logic must not import env.ts (which process.exit(1)s on missing vars).

/** Arabic-Indic (U+0660–0669) and Eastern Arabic-Indic (U+06F0–06F9) digits. */
const ARABIC_INDIC_OFFSET = 0x0660;
const EASTERN_ARABIC_OFFSET = 0x06f0;

/**
 * Fold non-ASCII digit forms down to 0-9. Lebanese and Gulf address books routinely
 * contain these, and every downstream check (length, Luhn, dial-code match) assumes
 * ASCII, so this has to happen before anything else looks at the string.
 */
export function foldDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp >= ARABIC_INDIC_OFFSET && cp <= ARABIC_INDIC_OFFSET + 9) {
      out += String(cp - ARABIC_INDIC_OFFSET);
    } else if (cp >= EASTERN_ARABIC_OFFSET && cp <= EASTERN_ARABIC_OFFSET + 9) {
      out += String(cp - EASTERN_ARABIC_OFFSET);
    } else {
      out += ch;
    }
  }
  return out;
}

/** E.164 permits at most 15 digits; below 8 is not a dialable international number. */
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/**
 * Ceiling for the "bare subscriber number, prepend the dial code" guess.
 *
 * National subscriber numbers top out around 10-11 digits (China's 13800138000 is 11).
 * Anything longer is far more likely to be a fully international number stored without
 * its '+', where prepending a dial code invents a stranger rather than completing a
 * local number.
 */
const MAX_BARE_SUBSCRIBER_DIGITS = 11;

export interface NormalizeOptions {
  /** Digits only, no '+' (e.g. '961'). When absent, only already-international input is accepted. */
  defaultDialCode?: string | null;
}

/**
 * Returns a '+<digits>' E.164 string, or null when the input cannot responsibly be
 * turned into one. Returning null is the right outcome far more often than callers
 * expect: address books are full of short codes, service numbers and free text.
 */
export function normalizePhone(raw: string, opts: NormalizeOptions = {}): string | null {
  if (!raw) return null;

  const dialCode = (opts.defaultDialCode ?? '').replace(/\D/g, '') || null;

  // Fold exotic digits, then drop the punctuation people decorate numbers with.
  // Note   (nbsp) and ‎/‏ (LTR/RTL marks) — iOS exports are full of
  // the directional marks around numbers in Arabic-locale address books.
  let s = foldDigits(String(raw))
    .replace(/[‎‏‪-‮]/g, '')
    .trim();

  // Anything with a letter in it is a vanity/short code or free text, not a number
  // we can dial. Do this BEFORE stripping punctuation so "x1234" extensions and
  // "CALL-ME" are both rejected rather than mangled into digits.
  if (/[A-Za-z]/.test(s)) return null;

  // Service / USSD codes.
  if (/[*#]/.test(s)) return null;

  const hadPlus = s.trimStart().startsWith('+');
  s = s.replace(/[\s()\-. /]/g, '');

  // Strip a leading '+' or an international access prefix ('00', and '011' as used
  // in NANP). Both mean "what follows is already a country code".
  let international = hadPlus;
  if (s.startsWith('+')) {
    s = s.slice(1);
    international = true;
  } else if (s.startsWith('00')) {
    s = s.slice(2);
    international = true;
  }

  if (!/^\d+$/.test(s) || s.length === 0) return null;

  let digits: string;

  if (international) {
    digits = s;
  } else if (s.startsWith('0')) {
    // National format with a trunk prefix: "03 123 456" -> drop the 0, prepend the
    // country's dial code. Without a dial code we cannot know the country, and
    // guessing would be worse than skipping.
    if (!dialCode) return null;
    digits = dialCode + s.replace(/^0+/, '');
  } else if (dialCode && s.startsWith(dialCode) && s.length >= MIN_E164_DIGITS) {
    // Already carries the country code without a '+' ("96170123456").
    digits = s;
  } else if (
    dialCode &&
    s.length <= MAX_BARE_SUBSCRIBER_DIGITS &&
    // Second bound, and the one that separates the 11-digit cases: a real national number
    // plus its own country code still lands comfortably inside E.164. China's 11-digit
    // mobile under +86 totals 13; a US number stored as "12125551234" under +961 totals
    // 14, which is the tell that it was already international.
    dialCode.length + s.length <= MAX_E164_DIGITS - 2
  ) {
    // Bare subscriber number with no trunk prefix ("70 123 456" as some people store it).
    //
    // LENGTH-BOUNDED, because this branch is a guess and a wrong guess here does not fail
    // safe — it succeeds, loudly, producing a syntactically valid number for a person who
    // does not exist. An address book holding a Saudi contact as "966501234567" (no '+',
    // as people do) would otherwise become "+961966501234567": 15 digits, passes the E.164
    // ceiling, lands in the tenant's contacts, and gets counted in the green "Added" tile.
    //
    // Nothing longer than a national subscriber number can be one. 11 keeps China
    // (13800138000 + 86) working while rejecting an 11+ digit string that is far more
    // likely to be an already-international number missing its plus.
    digits = dialCode + s;
  } else {
    // The module's own rule, applied consistently: guessing is worse than skipping.
    return null;
  }

  if (digits.length < MIN_E164_DIGITS || digits.length > MAX_E164_DIGITS) return null;

  // A run of one repeated digit is placeholder junk ("00000000", "11111111"), which
  // address books accumulate from test entries and voicemail shortcuts.
  if (/^(\d)\1+$/.test(digits)) return null;

  return `+${digits}`;
}
