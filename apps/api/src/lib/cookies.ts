import type { CookieSerializeOptions } from '@fastify/cookie';

import { env } from './env.js';

export const REFRESH_COOKIE_NAME = 'aligned_refresh';

// Browsers reject `Domain=localhost` (RFC 6265 — domain attribute must be a
// real registrable domain). Omit the domain entirely for `localhost` so the
// cookie stays host-only, which is what we want in dev anyway.
function cookieDomain(): string | undefined {
  if (!env.COOKIE_DOMAIN || env.COOKIE_DOMAIN === 'localhost') return undefined;
  return env.COOKIE_DOMAIN;
}

export function refreshCookieOptions(maxAgeSeconds = env.JWT_REFRESH_TTL_SECONDS): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: cookieDomain(),
    // Must cover every auth endpoint that needs the cookie:
    //   /api/v1/auth/refresh, /api/v1/auth/logout, /api/v1/auth/switch-org
    path: '/api/v1/auth',
    maxAge: maxAgeSeconds,
    signed: false,
  };
}

export function clearRefreshCookieOptions(): CookieSerializeOptions {
  return { ...refreshCookieOptions(0), maxAge: 0 };
}
