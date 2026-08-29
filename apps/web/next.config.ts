import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Portal lives at example.com/app/* so the marketing site at example.com can
  // own the root domain without a separate subdomain + DNS record. Next
  // prefixes every <Link>, router.push, and server `redirect()`
  // automatically; the API builds user-facing URLs from `WEB_PUBLIC_URL`
  // (now configured to include `/app`) so password resets, invites, and
  // billing returns all land on the right path too.
  basePath: '/app',
  // Type-checking is done by tsc in the shared/api/db build steps; skip here
  // because Next 15.5 + TS 5.9 have a compat glitch on `--ignoreDeprecations`
  // during `next build` that otherwise prevents production bundling.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  async headers() {
    // CSP is built per-request in src/middleware.ts so the nonce can change
    // each render. Static headers below cover the framework-wide constants.
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Allow same-origin microphone so MediaRecorder works in the
          // inbox voice-note composer. Camera/geolocation stay denied.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
          // Cross-Origin-Opener-Policy is deliberately NOT here. It has to VARY
          // by path: Meta's Embedded Signup popup postMessages back to its
          // opener, and `same-origin` severs window.opener with no error at
          // all. It is now set for every request in src/middleware.ts, which
          // is the only writer — grep there before adding it back here.
          { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
        ],
      },
    ];
  },
};

export default config;
