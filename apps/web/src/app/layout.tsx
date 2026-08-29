import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import { headers } from 'next/headers';

import { Providers } from '@/components/providers';
import { PwaRegister } from '@/components/pwa-register';
import '@/styles/globals.css';

// Two-font system (neutral-minimal design language):
//   • Plus Jakarta Sans — all UI, body, headings.
//   • JetBrains Mono — SKUs, prices, IDs, quantities, timestamps (tabular).
// Mono numerics make data read as *precise* — a core part of the
// "professional instrument" feel. Scoped to numerics/IDs via the `font-mono`
// utility, so the woff2 only matters where data density lives.
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  // 300 dropped — `font-light` is used 0× in the app; trimming the weight
  // shrinks the woff2 payload (faster LCP) with zero visual change.
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Hader AI',
    template: '%s · Hader AI',
  },
  description: 'The AI ops layer for your business. WhatsApp catalogs, conversations, and intelligence in one place.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  applicationName: 'Hader AI',
  // The manifest <link> is added manually in <head> below with the explicit
  // /app basePath prefix (Next's metadata.manifest path handling vs. basePath
  // is ambiguous, so we keep it explicit).
  appleWebApp: {
    capable: true,
    title: 'Hader',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#360516',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// Inline script that runs before React hydrates: reads the persisted theme
// (or OS preference) and sets the `dark` class on <html> so the page never
// flashes the wrong theme.
const themeBootstrap = `
(function () {
  try {
    var stored = localStorage.getItem('aligned:theme');
    var system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var target = stored && stored !== 'system' ? stored : system;
    var root = document.documentElement;
    if (target === 'dark') root.classList.add('dark');
    root.style.colorScheme = target;
  } catch (e) {}
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Sprint 2 #17 — CSP nonce flows from the middleware. The inline theme
  // bootstrap script below must carry it so the browser doesn't block it
  // under the no-`unsafe-inline` policy.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* PWA manifest — explicit /app basePath prefix (see metadata note). */}
        <link rel="manifest" href="/app/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/app/icons/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
        <PwaRegister />
      </body>
    </html>
  );
}
