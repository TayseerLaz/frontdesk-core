/**
 * Browser-safe brand values.
 *
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time, so these must be
 * written as static property accesses — a computed lookup would come back
 * undefined in the client bundle. Server components can import BRAND from
 * @platform/shared directly instead.
 */
export const brand = {
  name: process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || 'Platform',
  domain: process.env.NEXT_PUBLIC_BRAND_DOMAIN?.trim() || 'localhost',
  tagline: process.env.NEXT_PUBLIC_BRAND_TAGLINE?.trim() || '',
  accentHex: process.env.NEXT_PUBLIC_BRAND_ACCENT_HEX?.trim() || '#1F5E8C',
  logoPath: '/brand/wordmark.png',
  iconPath: '/brand/icon.png',
} as const;
