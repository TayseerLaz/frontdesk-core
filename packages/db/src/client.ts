import { PrismaClient } from '@prisma/client';

import { withSecretCrypto } from './secret-crypto.js';

declare global {
  // eslint-disable-next-line no-var
  var __alignedPrisma: PrismaClient | undefined;
}

export function createPrisma(): PrismaClient {
  // withSecretCrypto transparently encrypts/decrypts whatsapp_channels secrets.
  // It returns the client unchanged when SECRET_ENCRYPTION_KEY is unset, so
  // this is a no-op until the key is configured.
  return withSecretCrypto(
    new PrismaClient({
      log:
        process.env.NODE_ENV === 'production'
          ? ['warn', 'error']
          : ['warn', 'error'], // queries logged via Fastify pino, not Prisma
    }),
  );
}

/**
 * Process-singleton Prisma client. Use this from API/worker entry points.
 * Per-request tenant scoping is applied via `withTenant()` (see api/src/lib/db).
 */
export const prisma: PrismaClient =
  globalThis.__alignedPrisma ?? (globalThis.__alignedPrisma = createPrisma());
