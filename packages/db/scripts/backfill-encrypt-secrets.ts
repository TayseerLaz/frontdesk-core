// One-time backfill: encrypt existing plaintext secrets at rest.
//
// Covers: whatsapp_channels (access_token, app_secret),
//         messenger_channels (page_access_token, app_secret),
//         api_connectors    (auth_config JSONB, webhook_secret),
//         users             (totp_secret).
//
// Run AFTER SECRET_ENCRYPTION_KEY is set in the environment:
//   set -a; . ./.env.production; set +a
//   pnpm --filter @platform/db exec tsx scripts/backfill-encrypt-secrets.ts
//
// Uses a RAW PrismaClient (no crypto extension) and encrypts explicitly, so
// it can't double-encrypt. Idempotent: already-encrypted rows are skipped, so
// it is safe to re-run.
import { PrismaClient } from '@prisma/client';

import { encryptSecret, encryptJsonSecret, secretCryptoEnabled } from '../src/secret-crypto.js';

const PREFIX = 'enc:v1:';

async function backfillWhatsApp(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<
    { id: string; access_token: string | null; app_secret: string | null }[]
  >(`SELECT id, access_token, app_secret FROM whatsapp_channels`);
  let changed = 0;
  for (const r of rows) {
    const encAccess = encryptSecret(r.access_token);
    const encSecret = encryptSecret(r.app_secret);
    if (encAccess === r.access_token && encSecret === r.app_secret) continue;
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_channels SET access_token = $1, app_secret = $2 WHERE id = $3::uuid`,
      encAccess,
      encSecret,
      r.id,
    );
    changed++;
  }
  console.log(`✓ whatsapp_channels: encrypted ${changed}/${rows.length} row(s).`);
}

async function backfillMessenger(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<
    { id: string; page_access_token: string | null; app_secret: string | null }[]
  >(`SELECT id, page_access_token, app_secret FROM messenger_channels`);
  let changed = 0;
  for (const r of rows) {
    const encToken = encryptSecret(r.page_access_token);
    const encSecret = encryptSecret(r.app_secret);
    if (encToken === r.page_access_token && encSecret === r.app_secret) continue;
    await prisma.$executeRawUnsafe(
      `UPDATE messenger_channels SET page_access_token = $1, app_secret = $2 WHERE id = $3::uuid`,
      encToken,
      encSecret,
      r.id,
    );
    changed++;
  }
  console.log(`✓ messenger_channels: encrypted ${changed}/${rows.length} row(s).`);
}

async function backfillConnectors(prisma: PrismaClient): Promise<void> {
  // auth_config is JSONB: Prisma returns a parsed object for legacy plaintext
  // rows, or a string for rows we've already encrypted (stored as a JSON
  // string value). webhook_secret is plain text.
  const rows = await prisma.$queryRawUnsafe<
    { id: string; auth_config: unknown; webhook_secret: string | null }[]
  >(`SELECT id, auth_config, webhook_secret FROM api_connectors`);
  let changed = 0;
  for (const r of rows) {
    const authAlreadyEnc =
      r.auth_config == null ||
      (typeof r.auth_config === 'string' && r.auth_config.startsWith(PREFIX));
    const encAuth = authAlreadyEnc ? null : encryptJsonSecret(r.auth_config);
    const encSecret = encryptSecret(r.webhook_secret);
    const secretChanged = encSecret !== r.webhook_secret;
    if (authAlreadyEnc && !secretChanged) continue;

    if (!authAlreadyEnc) {
      // Store the opaque enc:v1: string as a JSON string value in the JSONB col.
      await prisma.$executeRawUnsafe(
        `UPDATE api_connectors SET auth_config = to_jsonb($1::text) WHERE id = $2::uuid`,
        encAuth,
        r.id,
      );
    }
    if (secretChanged) {
      await prisma.$executeRawUnsafe(
        `UPDATE api_connectors SET webhook_secret = $1 WHERE id = $2::uuid`,
        encSecret,
        r.id,
      );
    }
    changed++;
  }
  console.log(`✓ api_connectors: encrypted ${changed}/${rows.length} row(s).`);
}

async function backfillTotpSecrets(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ id: string; totp_secret: string | null }[]>(
    `SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL`,
  );
  let changed = 0;
  for (const r of rows) {
    const enc = encryptSecret(r.totp_secret);
    if (enc === r.totp_secret) continue; // already encrypted / null
    await prisma.$executeRawUnsafe(
      `UPDATE users SET totp_secret = $1 WHERE id = $2::uuid`,
      enc,
      r.id,
    );
    changed++;
  }
  console.log(`✓ users.totp_secret: encrypted ${changed}/${rows.length} row(s).`);
}

async function main(): Promise<void> {
  if (!secretCryptoEnabled()) {
    console.error('✗ SECRET_ENCRYPTION_KEY is not set — refusing to run.');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    await backfillWhatsApp(prisma);
    await backfillMessenger(prisma);
    await backfillConnectors(prisma);
    await backfillTotpSecrets(prisma);
    console.log('✓ backfill complete.');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
