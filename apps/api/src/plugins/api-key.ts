// X-Api-Key auth middleware for the chatbot read API.
//
// Validates the key header, looks up the row by hash (constant-time-ish via
// indexed unique lookup), checks revocation/expiry, sets req.apiKey on success.
// On the very first use, records an audit event so admins can confirm a key
// "went live" in production.
import { ApiErrorCode } from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { recordAudit } from '../lib/audit.js';
import { hashToken } from '../lib/crypto.js';
import { withRlsBypass } from '../lib/db.js';
import { unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: {
      id: string;
      organizationId: string;
      scopes: string[];
    };
  }
  interface FastifyInstance {
    /** Throws 401 unless a valid X-Api-Key header is present. */
    requireApiKey: (req: FastifyRequest) => Promise<void>;
    /** Stronger check: requires the key to include a specific scope. */
    requireApiKeyScope: (scope: string) => (req: FastifyRequest) => Promise<void>;
  }
}

const HEADER = 'x-api-key';

export default fp(async function apiKeyPlugin(app: FastifyInstance) {
  app.decorate('requireApiKey', async (req: FastifyRequest) => {
    if (req.apiKey) return;
    const raw = req.headers[HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Missing X-Api-Key header.');

    const keyHash = hashToken(value);
    const key = await withRlsBypass((tx) =>
      tx.apiKey.findFirst({
        where: { keyHash, revokedAt: null },
        select: { id: true, organizationId: true, scopes: true, expiresAt: true, lastUsedAt: true },
      }),
    );
    if (!key) throw unauthorized(ApiErrorCode.AUTH_TOKEN_INVALID, 'API key invalid.');
    if (key.expiresAt && key.expiresAt < new Date()) {
      throw unauthorized(ApiErrorCode.AUTH_TOKEN_EXPIRED, 'API key expired.');
    }

    req.apiKey = {
      id: key.id,
      organizationId: key.organizationId,
      scopes: key.scopes,
    };

    // Record first-use + bump lastUsedAt (best-effort, never blocks).
    void (async () => {
      try {
        await withRlsBypass((tx) =>
          tx.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }),
        );
        if (!key.lastUsedAt) {
          await recordAudit({
            action: 'api_key_used_first_time',
            organizationId: key.organizationId,
            entityType: 'api_key',
            entityId: key.id,
            ipAddress: req.ip,
          });
        }
      } catch (err) {
        req.log.warn({ err }, '[api-key] failed to record use');
      }
    })();
  });

  app.decorate('requireApiKeyScope', (scope: string) => async (req: FastifyRequest) => {
    await app.requireApiKey(req);
    if (!req.apiKey!.scopes.includes(scope)) {
      throw unauthorized(ApiErrorCode.ROLE_INSUFFICIENT, `Missing required scope: ${scope}`);
    }
  });
});
