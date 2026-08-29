// M-2 — immediate access-token revocation.
//
// Access tokens are stateless and short-lived (JWT_ACCESS_TTL_SECONDS), so on
// their own a logout / password reset / refresh-reuse family-revoke only takes
// effect on the NEXT refresh — up to the access-token TTL later. That lag
// undercuts the theft response the refresh reuse-detection exists to provide.
//
// This adds a cheap Redis check keyed by the JWT `sid` (session id): every place
// that revokes a session marks its sid here, and requireAuth rejects a token
// whose sid is marked. The flag only needs to outlive a still-valid access
// token, so its TTL is the access-token TTL plus a small skew margin.
//
// Fail-open by design: if Redis is unavailable the check degrades to the
// previous behaviour (the ≤TTL lag) rather than locking every user out — the
// durable record of revocation is always the session row's `revokedAt`.
import { env } from './env.js';
import { getRedis } from './redis.js';

const KEY = (sessionId: string) => `revoked-sid:${sessionId}`;
const TTL_SECONDS = env.JWT_ACCESS_TTL_SECONDS + 60;

/** Mark a session's access tokens as revoked (call wherever a session is revoked). */
export async function markSessionRevoked(sessionId: string): Promise<void> {
  try {
    await getRedis().set(KEY(sessionId), '1', 'EX', TTL_SECONDS);
  } catch {
    // Best-effort — `revokedAt` in the DB remains the durable record.
  }
}

/** Mark several sessions revoked at once (password reset/change revokes all). */
export async function markSessionsRevoked(sessionIds: string[]): Promise<void> {
  await Promise.all(sessionIds.map((id) => markSessionRevoked(id)));
}

/** True if the session's access tokens have been revoked within the TTL window. */
export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  try {
    return (await getRedis().get(KEY(sessionId))) !== null;
  } catch {
    return false; // Redis down → fall back to the pre-existing ≤TTL lag, never a lockout.
  }
}
