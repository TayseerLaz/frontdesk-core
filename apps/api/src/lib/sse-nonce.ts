// Short-lived, single-use credential for EventSource (SSE) authentication.
//
// EventSource cannot set Authorization headers, so historically the access
// token was passed via `?token=` — which writes it to access logs, browser
// history, and Referer headers. To eliminate that leak, the client first
// performs a normal authenticated POST /auth/sse-nonce to exchange its
// session for an opaque nonce, then connects the EventSource with
// `?nonce=<value>`. The nonce is consumed atomically (GETDEL) on first use
// and expires after 30 seconds, so even a leaked URL is worthless after the
// SSE connection is established.
import type { OrgRole } from '@platform/shared';

import { generateOpaqueToken } from './crypto.js';
import { getRedis } from './redis.js';

const NONCE_PREFIX = 'sse-nonce:';
const NONCE_TTL_SECONDS = 30;

export type SseAuthClaims = {
  userId: string;
  organizationId: string;
  role: OrgRole;
  isSuperAdmin: boolean;
  sessionId: string;
};

export async function issueSseNonce(claims: SseAuthClaims): Promise<string> {
  const nonce = generateOpaqueToken(24);
  await getRedis().set(
    `${NONCE_PREFIX}${nonce}`,
    JSON.stringify(claims),
    'EX',
    NONCE_TTL_SECONDS,
  );
  return nonce;
}

// Atomic GET+DEL via Lua so it works on Redis < 6.2 (the native GETDEL command
// only exists from 6.2.0; prod runs 6.0.x, where calling getdel throws
// "unknown command" — which previously 500'd every SSE/EventSource connection).
const GETDEL_LUA =
  "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v";

export async function consumeSseNonce(nonce: string): Promise<SseAuthClaims | null> {
  if (!nonce || typeof nonce !== 'string' || nonce.length < 16) return null;
  // Atomic single-use consume — guarantees single-use semantics across replicas.
  const raw = (await getRedis().eval(GETDEL_LUA, 1, `${NONCE_PREFIX}${nonce}`)) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SseAuthClaims;
  } catch {
    return null;
  }
}
