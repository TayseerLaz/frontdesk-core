/**
 * Money is stored as integer minor units. The minor-per-major ratio
 * varies by currency: 100 for the common 2-decimal currencies (USD,
 * EUR, AED, SAR …) and 1000 for the 3-decimal Gulf dinars (KWD, BHD,
 * OMR, JOD). Helpers here always take a currency so the form input
 * stores the right amount and the display reads it back correctly.
 *
 * Pre-fix, the helpers hardcoded /100 and *100, so typing "1.500"
 * into a KWD form stored 150 minor units (≈ 0.15 KWD), and the bot
 * later read it as 0.150 KWD. After the fix, "1.500" stores 1500
 * minor units = 1.500 KWD as intended.
 */
const THREE_DECIMAL_CURRENCIES = new Set(['KWD', 'BHD', 'OMR', 'JOD']);

export function minorPerMajor(currency: string | null | undefined): number {
  const code = (currency ?? 'USD').toUpperCase();
  return THREE_DECIMAL_CURRENCIES.has(code) ? 1000 : 100;
}

export function decimalsFor(currency: string | null | undefined): number {
  return minorPerMajor(currency) === 1000 ? 3 : 2;
}

export function formatMoney(
  minor: number | null | undefined,
  currency: string = 'USD',
  locale = 'en-US',
): string {
  if (minor === null || minor === undefined) return '—';
  const mpm = minorPerMajor(currency);
  const dec = decimalsFor(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: dec,
      maximumFractionDigits: dec,
    }).format(minor / mpm);
  } catch {
    return `${(minor / mpm).toFixed(dec)} ${currency}`;
  }
}

export function parseMoneyMajor(
  input: string,
  currency?: string | null,
): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const num = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * minorPerMajor(currency));
}

export function minorToMajorString(
  minor: number | null | undefined,
  currency?: string | null,
): string {
  if (minor === null || minor === undefined) return '';
  return (minor / minorPerMajor(currency)).toFixed(decimalsFor(currency));
}

/** Convert minutes-since-midnight (0..1440) to "HH:MM" string. */
export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60).toString().padStart(2, '0');
  const m = (min % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

/** "HH:MM" → minutes since midnight (0..1440). */
export function timeToMinutes(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
}

export function formatRelative(iso: string | null | undefined, locale = 'en-US'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(-days, 'day');
  return date.toLocaleDateString(locale);
}

/**
 * "1,204" — locale-aware thousands separator. Used across dashboard
 * widgets where readability of a count matters more than the exact
 * number being typographically tight.
 */
export function formatThousands(n: number | null | undefined, locale = 'en-US'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale).format(n);
}

/**
 * Seconds → "Xm Ys" / "Ys" / "Xh Ym". Used by dashboard widgets that
 * surface response times. Keeps the result terse so the metric fits
 * inside a stat tile without wrapping.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
}
