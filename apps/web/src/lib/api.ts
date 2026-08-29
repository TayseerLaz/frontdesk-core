/**
 * Browser API client. Holds the access token in memory (refreshes via cookie),
 * automatically retries once on 401.
 */
import type { ApiErrorPayload } from '@platform/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

let accessToken: string | null = null;
let accessTokenExpiresAt: number | null = null;
let refreshInFlight: Promise<void> | null = null;

// Cross-tab auth coordination. The full-screen inbox opens its own browser
// tab, so >1 tab is now the norm. Each tab's SessionProvider fires its own
// POST /auth/refresh on mount; the server ROTATES the shared refresh-token
// family on every call and runs reuse-detection, so two tabs refreshing
// close together (or a backgrounded tab's throttled refresh landing late)
// trips reuse-detection and REVOKES the session — the "logged out
// frequently" bug. We fix it two ways:
//   1. serialize refreshes across ALL tabs with the Web Locks API, and
//   2. broadcast each freshly-minted access token so sibling tabs ADOPT it
//      instead of firing their own refresh.
// The token stays in memory only (never localStorage), so this adds no
// XSS-persistence surface.
const authChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('aligned-auth') : null;

function applyAccessToken(token: string, expiresAtMs: number) {
  accessToken = token;
  accessTokenExpiresAt = expiresAtMs;
}

// Adopt a token a sibling tab just minted (no network, no extra rotation).
authChannel?.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { accessToken?: string; expiresAt?: number } | null;
  if (d && typeof d.accessToken === 'string' && typeof d.expiresAt === 'number') {
    applyAccessToken(d.accessToken, d.expiresAt);
  }
});

export function setAccessToken(token: string, expiresAtIso: string) {
  const ms = new Date(expiresAtIso).getTime();
  applyAccessToken(token, ms);
  // Share with sibling tabs so they don't each refresh + rotate the family.
  authChannel?.postMessage({ accessToken: token, expiresAt: ms });
}

export function clearAccessToken() {
  accessToken = null;
  accessTokenExpiresAt = null;
}

// Run `fn` while holding a browser-wide exclusive lock so only ONE tab
// refreshes at a time. Falls back to running directly where Web Locks
// isn't available (older Safari) — no worse than today's behaviour.
async function withRefreshLock(fn: () => Promise<void>): Promise<void> {
  const locks =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined;
  if (locks?.request) {
    await locks.request('aligned-auth-refresh', async () => {
      await fn();
    });
  } else {
    await fn();
  }
}

export function getAccessToken() {
  return accessToken;
}

// Event the API client emits when the refresh cookie is dead and the
// session can no longer be revived without a fresh login. Used by the
// SessionProvider to flip state → 'unauthenticated' which triggers the
// dashboard layout's redirect to /login. Without this, every polling
// useQuery on the page would keep firing every refetchInterval forever,
// each hitting 401 → silent refresh failure → 401 again, producing the
// console-wall the operator saw on 2026-06-01.
export const SESSION_EXPIRED_EVENT = 'aligned:session-expired';

function notifySessionExpired() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

/**
 * Single-flight POST /auth/refresh. EVERY caller that needs the access
 * token rotated MUST go through this function, never call `/auth/refresh`
 * directly via api.post. Why: the server rotates the refresh-token family
 * on every call AND runs reuse-detection — if two concurrent /refresh
 * calls fire from the same browser (e.g. SessionProvider.bootstrap +
 * any useQuery's 401-retry on a hard-refresh), the second arrives with
 * the just-rotated previous-token-hash, gets flagged as REPLAY, and the
 * whole session family is revoked. The user lands on /login mid-session.
 *
 * Exported so apps/web/src/lib/session.tsx can call THROUGH this lock
 * instead of `api.post('/api/v1/auth/refresh', ...)` which would dodge
 * the dedupe entirely.
 */
export async function tryRefresh(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      await withRefreshLock(async () => {
        // A sibling tab may have refreshed (and broadcast a token) while we
        // waited for the lock. If our token is now comfortably valid, skip
        // the network call entirely — no second rotation, no reuse race.
        if (
          accessToken &&
          accessTokenExpiresAt &&
          Date.now() < accessTokenExpiresAt - 30_000
        ) {
          return;
        }
        const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) {
          clearAccessToken();
          notifySessionExpired();
          return;
        }
        const json = (await res.json()) as { accessToken: string; expiresAt: string };
        setAccessToken(json.accessToken, json.expiresAt);
      });
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ApiErrorPayload['error'],
  ) {
    super(payload.message);
    this.name = 'ApiError';
  }
}

interface RequestOpts extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip auth header even if a token is set. */
  anonymous?: boolean;
  /** If true and the access token is missing/expired, attempt a refresh first. */
  ensureAuth?: boolean;
}

export async function apiFetch<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { body, anonymous, ensureAuth, headers, ...rest } = opts;

  if (ensureAuth && (!accessToken || (accessTokenExpiresAt && accessTokenExpiresAt < Date.now() + 5_000))) {
    await tryRefresh();
  }

  const finalHeaders = new Headers(headers);
  if (body !== undefined) finalHeaders.set('Content-Type', 'application/json');
  if (!anonymous && accessToken) finalHeaders.set('Authorization', `Bearer ${accessToken}`);

  const doFetch = () =>
    fetch(`${API_URL}${path}`, {
      ...rest,
      credentials: 'include',
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch();

  // One-shot retry on 401 (e.g. access token just expired).
  if (res.status === 401 && !anonymous) {
    await tryRefresh();
    if (accessToken) {
      finalHeaders.set('Authorization', `Bearer ${accessToken}`);
      res = await doFetch();
    }
  }

  if (!res.ok) {
    let payload: ApiErrorPayload;
    try {
      payload = (await res.json()) as ApiErrorPayload;
    } catch {
      payload = { error: { code: 'INTERNAL', message: res.statusText } };
    }
    throw new ApiError(res.status, payload.error);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, opts: RequestOpts = {}) => apiFetch<T>(path, { ...opts, method: 'GET', ensureAuth: true }),
  // Authenticated POSTs proactively refresh a near-expired token BEFORE sending
  // (like GET/PUT/PATCH/DELETE). Previously POST only refreshed reactively after
  // a 401 — so a long form (e.g. the broadcast wizard) could submit with an
  // expired token, the reactive refresh could fail, and the user got logged out
  // mid-flow (broadcast created but not sent). Anonymous POSTs (login/signup/
  // refresh) never pre-refresh.
  post: <T>(path: string, body?: unknown, opts: RequestOpts = {}) =>
    apiFetch<T>(path, {
      ...opts,
      method: 'POST',
      body,
      ensureAuth: opts.ensureAuth ?? !opts.anonymous,
    }),
  put: <T>(path: string, body?: unknown, opts: RequestOpts = {}) =>
    apiFetch<T>(path, { ...opts, method: 'PUT', body, ensureAuth: true }),
  patch: <T>(path: string, body?: unknown, opts: RequestOpts = {}) =>
    apiFetch<T>(path, { ...opts, method: 'PATCH', body, ensureAuth: true }),
  delete: <T>(path: string, opts: RequestOpts = {}) =>
    apiFetch<T>(path, { ...opts, method: 'DELETE', ensureAuth: true }),
};
