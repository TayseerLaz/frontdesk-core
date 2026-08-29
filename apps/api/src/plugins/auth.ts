import { ApiErrorCode, apiPathPageKey, parsePageAccess, type OrgRole } from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { prisma } from '../lib/db.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { getRedis } from '../lib/redis.js';
import { isSessionRevoked } from '../lib/session-revocation.js';
import { consumeSseNonce } from '../lib/sse-nonce.js';

const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, editor: 2, admin: 3 };

// F1 (roadmap 2026-08-26) — per-member page access, enforced at the SAME seam
// role checks live so no module needs individual wiring. Runs only for
// non-admin members whose request path maps to a registered page key
// (apiPathPageKey — unmapped paths fall through to the role check alone).
// The membership's whitelist is cached 60s in Redis; members.routes deletes
// the key on change so edits apply within a request or two. A LOOKUP failure
// allows the request (the role check still gates — a Redis blip must not
// take a tenant's portal down); an explicit empty whitelist denies.
const PAGE_ACCESS_CACHE_TTL_S = 60;

export function pageAccessCacheKey(userId: string, organizationId: string): string {
  return `pageacc:${userId}:${organizationId}`;
}

async function enforcePageAccess(req: FastifyRequest): Promise<void> {
  const auth = req.auth!;
  if (auth.isSuperAdmin || auth.role === 'admin') return;
  const pageKey = apiPathPageKey(req.url);
  if (!pageKey) return;
  let pageAccess: string[] | null = null;
  try {
    const cacheKey = pageAccessCacheKey(auth.userId, auth.organizationId);
    const redis = getRedis();
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      pageAccess = cached === '*' ? null : (JSON.parse(cached) as string[]);
    } else {
      const membership = await prisma.membership.findFirst({
        where: { userId: auth.userId, organizationId: auth.organizationId, isActive: true },
        select: { pageAccess: true },
      });
      pageAccess = parsePageAccess(membership?.pageAccess);
      await redis.set(
        cacheKey,
        pageAccess === null ? '*' : JSON.stringify(pageAccess),
        'EX',
        PAGE_ACCESS_CACHE_TTL_S,
      );
    }
  } catch {
    return; // lookup failed → the role check alone gates this request
  }
  if (pageAccess !== null && !pageAccess.includes(pageKey)) {
    throw forbidden(
      ApiErrorCode.FORBIDDEN,
      'Your account does not have access to this page. Ask an admin to grant it on the Members page.',
    );
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Resolves req.auth from the bearer token; throws 401 if missing/invalid. */
    requireAuth: (req: FastifyRequest) => Promise<void>;
    /** Higher-order guard: ensure caller has at least the specified role in their active org. */
    requireRole: (minRole: OrgRole) => (req: FastifyRequest) => Promise<void>;
    /** Restrict to super-admins only. */
    requireSuperAdmin: (req: FastifyRequest) => Promise<void>;
  }
}

function bearerFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header) {
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token;
  }
  return null;
}

function sseNonceFrom(req: FastifyRequest): string | null {
  const q = req.query as { nonce?: string } | undefined;
  if (q?.nonce && typeof q.nonce === 'string') return q.nonce;
  return null;
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (req.auth) return;
    const token = bearerFrom(req);
    if (token) {
      const claims = await verifyAccessToken(token);
      // M-2 — reject a token whose session was revoked (logout / password reset /
      // refresh-reuse family-revoke) without waiting for the access token to expire.
      if (await isSessionRevoked(claims.sid)) {
        throw unauthorized(ApiErrorCode.AUTH_REQUIRED);
      }
      req.auth = {
        userId: claims.sub,
        organizationId: claims.org,
        role: claims.role,
        isSuperAdmin: claims.aa,
        sessionId: claims.sid,
      };
      return;
    }
    // EventSource (SSE) can't set Authorization headers, so it presents a
    // short-lived single-use nonce (issued via POST /auth/sse-nonce) on the
    // query string. The nonce is GETDEL'd from Redis so even a leaked URL
    // is worthless after the connection is established.
    const nonce = sseNonceFrom(req);
    if (nonce) {
      const claims = await consumeSseNonce(nonce);
      if (!claims) throw unauthorized(ApiErrorCode.AUTH_REQUIRED);
      req.auth = claims;
      return;
    }
    throw unauthorized(ApiErrorCode.AUTH_REQUIRED);
  });

  app.decorate('requireRole', (minRole: OrgRole) => async (req: FastifyRequest) => {
    await app.requireAuth(req);
    const have = ROLE_RANK[req.auth!.role];
    const need = ROLE_RANK[minRole];
    if (have < need) {
      throw forbidden(ApiErrorCode.ROLE_INSUFFICIENT, `Requires ${minRole} role or higher.`);
    }
    await enforcePageAccess(req);
  });

  app.decorate('requireSuperAdmin', async (req: FastifyRequest) => {
    await app.requireAuth(req);
    if (!req.auth!.isSuperAdmin) {
      throw forbidden(ApiErrorCode.FORBIDDEN, 'Super-admin role required.');
    }
  });
});
