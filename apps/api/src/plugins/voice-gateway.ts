// Voice gateway auth — the SHARED multi-tenant mode for the Aseer-time
// voicebot.
//
// Unlike X-Api-Key (org-scoped, one key per phone line), this is a
// single PLATFORM secret held only by the trusted voicebot infrastructure. A
// caller bearing it may act across tenants — it's how one voicebot instance
// fronts many tenants' DIDs. The routes that accept it (GET /voice/resolve and
// the lifecycle endpoints in gateway mode) resolve the tenant from the dialed
// number / X-Phone-Integration-Id, never from the secret itself.
//
// 503 when the secret isn't configured (feature disabled), 401 on mismatch.
// The compare is constant-time over SHA-256 digests so neither the value nor
// its length leaks via timing.
import { createHash, timingSafeEqual } from 'node:crypto';

import { ApiErrorCode } from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { env } from '../lib/env.js';
import { serviceUnavailable, unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Throws 503 if VOICE_GATEWAY_SECRET is unset, or 401 unless a valid
     * X-Voice-Gateway-Secret header is present. On success the request is
     * trusted to act cross-tenant via an explicit phone-integration reference.
     */
    requireVoiceGateway: (req: FastifyRequest) => Promise<void>;
  }
}

const HEADER = 'x-voice-gateway-secret';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export default fp(async function voiceGatewayPlugin(app: FastifyInstance) {
  app.decorate('requireVoiceGateway', async (req: FastifyRequest) => {
    const expected = env.VOICE_GATEWAY_SECRET;
    if (!expected) {
      throw serviceUnavailable('Voice gateway mode is not configured on this deployment.');
    }
    const raw = req.headers[HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided) {
      throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Missing X-Voice-Gateway-Secret header.');
    }
    // Hash both sides to a fixed 32-byte digest so timingSafeEqual never throws
    // on a length mismatch and the secret's length isn't observable.
    if (!timingSafeEqual(sha256(provided), sha256(expected))) {
      throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'Voice gateway secret invalid.');
    }
  });
});
