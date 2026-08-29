import { jwtVerify, SignJWT } from 'jose';

import { env } from './env.js';
import { unauthorized } from './errors.js';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

export interface AccessTokenClaims {
  sub: string; // user id
  org: string; // organization id (active)
  role: 'admin' | 'editor' | 'viewer';
  aa: boolean; // is aligned admin
  sid: string; // session id
}

export interface RefreshTokenClaims {
  sub: string;
  sid: string;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + env.JWT_ACCESS_TTL_SECONDS * 1000);
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('aligned-api')
    .setAudience('aligned-web')
    .setExpirationTime(expiresAt)
    .sign(accessSecret);
  return { token, expiresAt };
}

export async function signRefreshToken(claims: RefreshTokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_SECONDS * 1000);
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('aligned-api')
    .setAudience('aligned-refresh')
    .setExpirationTime(expiresAt)
    .sign(refreshSecret);
  return { token, expiresAt };
}

// Pin the verification algorithm to HS256 explicitly. `jose` validates the
// alg against the key type by default, but an explicit allowlist makes the
// "alg: none" / RS256-vs-HS256 confusion classes impossible even if a future
// refactor changes how the key is constructed.
const VERIFY_ALGORITHMS = ['HS256'] as const;

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessSecret, {
      issuer: 'aligned-api',
      audience: 'aligned-web',
      algorithms: [...VERIFY_ALGORITHMS],
    });
    return payload as unknown as AccessTokenClaims;
  } catch {
    throw unauthorized();
  }
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, refreshSecret, {
      issuer: 'aligned-api',
      audience: 'aligned-refresh',
      algorithms: [...VERIFY_ALGORITHMS],
    });
    return payload as unknown as RefreshTokenClaims;
  } catch {
    throw unauthorized();
  }
}
