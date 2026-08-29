/**
 * The ONE place a brand exists.
 *
 * Nothing else in this codebase names a product. Every user-visible mention of
 * the brand — page titles, emails, the PWA manifest, system copy — reads from
 * here, and every value comes from the environment. Standing up a second brand
 * is therefore a `.env` file and a handful of image files, never a rename.
 *
 * Defaults are deliberately generic and safe for localhost, so a fresh clone
 * runs with none of these set.
 *
 * Web note: `process.env` is inlined at build time in the browser bundle, so
 * client components must read the NEXT_PUBLIC_* twins (see `webBrand()`).
 */

function env(key: string, fallback: string): string {
  const v = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  const trimmed = v?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function list(key: string): string[] {
  return env(key, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const BRAND = {
  /** Product name as customers read it. Used in titles, emails, system copy. */
  name: env('BRAND_NAME', 'Platform'),
  /** Legal entity, for terms/policy footers. */
  legalName: env('BRAND_LEGAL_NAME', 'Platform'),
  /** One line under the name in emails. Empty string renders nothing. */
  tagline: env('BRAND_TAGLINE', ''),
  /** Bare host, no scheme — e.g. "example.com". */
  domain: env('BRAND_DOMAIN', 'localhost'),
  /** Where customers reply. Also the From: name's address in dev. */
  supportEmail: env('BRAND_SUPPORT_EMAIL', 'support@localhost'),
  /** Internal recipients for handoff / operational alerts. */
  teamEmails: list('BRAND_TEAM_EMAILS'),
  /** Primary accent, hex. Feeds the --color-brand-* token block. */
  accentHex: env('BRAND_ACCENT_HEX', '#1F5E8C'),
  /** Swap the FILES at these paths; never edit the paths. */
  logoPath: '/brand/wordmark.png',
  iconPath: '/brand/icon.png',
} as const;

export type Brand = typeof BRAND;

/**
 * The subset safe to inline into the browser bundle. Next replaces
 * `process.env.NEXT_PUBLIC_*` at build time, so these must be referenced as
 * static property accesses — not computed lookups.
 */
export function webBrand() {
  return {
    name: process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || BRAND.name,
    domain: process.env.NEXT_PUBLIC_BRAND_DOMAIN?.trim() || BRAND.domain,
    tagline: process.env.NEXT_PUBLIC_BRAND_TAGLINE?.trim() || BRAND.tagline,
    accentHex: process.env.NEXT_PUBLIC_BRAND_ACCENT_HEX?.trim() || BRAND.accentHex,
    logoPath: BRAND.logoPath,
    iconPath: BRAND.iconPath,
  };
}
