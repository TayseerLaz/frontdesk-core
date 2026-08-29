// The PWA manifest is generated, not a static file: its name, colours and icon
// paths all come from the brand, so a rebrand is an env change rather than a
// hand-edited JSON file. Served at /app/manifest.webmanifest via basePath.
import { brand } from '@/lib/brand';

export const dynamic = 'force-static';

export function GET() {
  const manifest = {
    name: brand.name,
    short_name: brand.name,
    description: brand.tagline || `${brand.name} — customer conversations in one place.`,
    id: '/app/',
    start_url: '/app/dashboard',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait-primary',
    background_color: '#ffffff',
    theme_color: brand.accentHex,
    lang: 'en',
    dir: 'ltr',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/app/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/app/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/app/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { 'content-type': 'application/manifest+json' },
  });
}
