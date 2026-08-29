// Sprint 2 #17 — Nonce-based Content-Security-Policy.
//
// The static CSP shipped in next.config.ts had to allow `'unsafe-inline'` and
// `'unsafe-eval'` on script-src because Next.js injects its own hydration
// bootstrap as inline JS. That defeats the point of CSP for stored-XSS
// protection.
//
// This middleware generates a per-request nonce. The response carries a CSP
// header that trusts that nonce on script-src, plus `'strict-dynamic'` so
// chunks loaded by Next.js's runtime inherit the trust. The nonce is also
// forwarded into the request via `x-nonce` so the root layout (and any other
// server component) can attach it to inline `<script>` elements.
//
// Style-src keeps `'unsafe-inline'` because Tailwind v4 + Next.js inject
// inline styles that are not nonce-aware. Style-based attacks are far less
// powerful than script-based ones, so this is an acceptable trade-off.
import { NextResponse, type NextRequest } from 'next/server';

const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// ---- Meta WhatsApp Embedded Signup ----------------------------------------
// The one route allowed to talk to Facebook. Everything below is gated on it,
// so no other portal page's policy changes by a single byte.
//
// NO '/app' PREFIX: `request.nextUrl.pathname` is basePath-STRIPPED. Next's
// NextURL.analyze() removes the basePath and parks it on nextUrl.basePath
// (next/dist/shared/lib/router/utils/get-next-pathname-info.js). The page's
// real URL is https://hader.ai/app/whatsapp/connect; this is what the
// middleware sees. Writing '/app/whatsapp/connect' here matches NOTHING and
// the widening silently never applies.
const EMBEDDED_SIGNUP_PATH = '/whatsapp/connect';

// Facebook origins the JS SDK touches, named once so the directives below
// cannot drift apart:
//   connect.facebook.net    - sdk.js itself.
//   staticxx.facebook.com   - the SDK's hidden cross-domain arbiter iframe.
//                             This is the ONLY reason frame-src is needed; the
//                             login POPUP is a top-level browsing context and
//                             no CSP directive governs window.open at all.
//   www./web.facebook.com   - the login + Embedded Signup surfaces.
//   graph.facebook.com      - the SDK's own XHRs.
const FB_FRAME =
  'https://www.facebook.com https://web.facebook.com https://staticxx.facebook.com https://connect.facebook.net';
const FB_CONNECT =
  'https://www.facebook.com https://web.facebook.com https://graph.facebook.com https://connect.facebook.net';
const FB_IMG = 'https://www.facebook.com https://web.facebook.com';

function buildCsp(nonce: string, embeddedSignup: boolean): string {
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets Next.js's own bootstrap script load further
    // scripts without each needing an explicit allowlist entry.
    //
    // DO NOT add https://connect.facebook.net here for Embedded Signup - it
    // would be DEAD CODE. Per CSP Level 3, when 'strict-dynamic' is present
    // the browser IGNORES every host-source and scheme-source in script-src
    // (including 'self'). The flip side is what the flow relies on:
    // 'strict-dynamic' propagates trust to scripts CREATED by already-trusted
    // code, so the page injects sdk.js with document.createElement and needs
    // neither a nonce nor an allowlist entry.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Style sources stay inline-permissive for the framework's CSS-in-JS.
    "style-src 'self' 'unsafe-inline'",
    // Service worker (/app/sw.js). Without an explicit worker-src, the browser
    // falls back to script-src — whose 'strict-dynamic' drops 'self' and would
    // block the same-origin SW from registering. Pin it to 'self' here.
    "worker-src 'self'",
    // PWA manifest is same-origin; keep it explicit alongside default-src.
    "manifest-src 'self'",
    // Alinia real-estate mirror: listing photos are served from the Alinia
    // seed host. Without these, CSP blocks the mirrored <img> thumbnails.
    // The Facebook hosts are only for the SDK's logging pixel. Nothing depends
    // on them, but without them the console fills with CSP violations during
    // the one flow we most need to be able to diagnose.
    `img-src 'self' data: blob: https://*.wasabisys.com https://images.unsplash.com${
      embeddedSignup ? ` ${FB_IMG}` : ''
    }`,
    // Wasabi is in connect-src AND in img-src/media-src below: the browser
    // does a presigned PUT (fetch → connect-src) when uploading images +
    // voice notes, then loads the resulting URL as <img>/<audio>
    // (→ img-src/media-src). Without connect-src here, CSP blocks the
    // upload itself even though the asset is allowed to render.
    `connect-src 'self' ${API_ORIGIN} https://*.sentry.io https://*.wasabisys.com${
      embeddedSignup ? ` ${FB_CONNECT}` : ''
    }`,
    "media-src 'self' blob: https://*.wasabisys.com",
    "font-src 'self' data:",
    // frame-src is absent on every other route ON PURPOSE - it falls back to
    // default-src 'self' there. It appears only for the SDK's arbiter iframe,
    // so this cannot regress any other page. frame-ancestors stays 'none'
    // everywhere: we still refuse to BE framed.
    ...(embeddedSignup ? [`frame-src 'self' ${FB_FRAME}`] : []),
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  // Meta's Embedded Signup popup postMessages back to its opener, and
  // Cross-Origin-Opener-Policy: same-origin SEVERS window.opener for a
  // cross-origin popup - so the session-info event and the FB.login callback
  // both die with no console error. Facebook serves those popup documents with
  // `Cross-Origin-Opener-Policy: unsafe-none`, which is exactly the condition
  // `same-origin-allow-popups` requires to keep them in our browsing-context
  // group. Incoming isolation is unchanged; only popups this document itself
  // opens keep their opener.
  //
  // COOP is evaluated at DOCUMENT LOAD, so the link into this page must be a
  // plain <a href="/app/whatsapp/connect">. A next/link soft navigation keeps
  // the previous document's `same-origin` and the popup dies silently.
  const isEmbeddedSignup = request.nextUrl.pathname === EMBEDDED_SIGNUP_PATH;
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = buildCsp(nonce, isEmbeddedSignup);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set('Content-Security-Policy', csp);
  // Surface the nonce to downstream callers (Sentry, etc.) without leaking
  // a secret — the nonce is per-request and useless after the response.
  response.headers.set('x-nonce', nonce);
  // Moved out of next.config.ts so it can vary by path, and set HERE ONLY so
  // there is exactly one writer and no bet on header-override ordering. The
  // matcher below skips _next/static, _next/image, favicon.ico and RSC
  // prefetches - none of those are top-level documents, which is the only
  // thing COOP governs.
  response.headers.set(
    'Cross-Origin-Opener-Policy',
    isEmbeddedSignup ? 'same-origin-allow-popups' : 'same-origin',
  );
  return response;
}

export const config = {
  // Skip CSP for Next.js internal asset paths + the favicon/static folder.
  // Skip for prefetched RSC requests too — those don't render <head> so
  // there's no inline script to nonce.
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
