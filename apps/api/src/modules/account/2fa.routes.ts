// Phase 5.5 — TOTP 2FA self-service endpoints.
//
// Flow (Sprint 1 M-3 hardening — two-step recovery-code persistence):
//   1. POST /account/2fa/setup → server generates a secret, stores it in
//      Redis under a short-lived key tied to userId, returns the
//      `otpauth://` URI for QR display in the UI. NOT persisted to the
//      user row yet.
//   2. POST /account/2fa/enable {code} → verifies the code against the
//      pending secret. On success: GENERATES 10 recovery codes, STASHES
//      the secret + hashed codes in Redis under another key, and returns
//      the plaintext codes. **2FA is NOT yet enabled on the user record.**
//      This prevents the lock-out failure mode where the API committed
//      `totpEnabled=true` but the response carrying the recovery codes
//      never reached the client.
//   3. POST /account/2fa/confirm-recovery-codes → the user has saved the
//      codes; persist the stashed secret + hashes to the user record and
//      flip `totpEnabled=true`. Until this lands, the user can retry
//      step 2 to regenerate a fresh pending set.
//   4. POST /account/2fa/disable {password|code} → clears all 2FA fields.
//   5. POST /account/2fa/regenerate-recovery {code} → generates new codes
//      + stashes pending; the existing codes remain valid until step 6.
//   6. POST /account/2fa/confirm-regenerate-recovery → swaps the live
//      hashes for the freshly stashed ones.
import { decryptSecret, encryptSecret } from '@platform/db';
import { ApiErrorCode, itemEnvelopeSchema, successSchema } from '@platform/shared';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { verifyPassword } from '../../lib/crypto.js';
import { withRlsBypass } from '../../lib/db.js';
import { badRequest, notFound, tooMany, unauthorized } from '../../lib/errors.js';
import { getRedis } from '../../lib/redis.js';
import {
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  verifyTotpCode,
} from '../../lib/totp.js';

const PENDING_KEY = (userId: string) => `2fa:pending:${userId}`;
const PENDING_TTL = 600; // 10 minutes to scan + verify

// Sprint 1 M-3 — pending recovery-code / secret payload key. Holds the data
// the user must "confirm receipt" of before the 2FA state actually flips on
// their account record.
const PENDING_RECOVERY_KEY = (userId: string) => `2fa:pending-recovery:${userId}`;
const PENDING_RECOVERY_TTL = 900; // 15 minutes

type PendingRecoveryPayload =
  | { kind: 'enable'; totpSecret: string; recoveryCodesHashed: string[] }
  | { kind: 'regenerate-recovery'; recoveryCodesHashed: string[] };

function hashRecovery(code: string): string {
  return createHash('sha256').update(code.toUpperCase()).digest('hex');
}

// I-3 — brute-force guard for the step-up TOTP / password checks below
// (/enable, /disable, /regenerate-recovery). These run inside an already-
// authenticated session, so they bypass the login-time lockout; without their
// own counter a hijacked session could grind the 6-digit TOTP space or the
// account password. Lock per user after N failures for a cool-off window.
// Fail-OPEN on Redis errors so an outage never traps a legitimate user.
const STEPUP_MAX_FAILURES = 5;
const STEPUP_WINDOW_SECONDS = 900; // 15 minutes
const STEPUP_FAIL_KEY = (userId: string) => `2fa:stepup-fail:${userId}`;

async function assertStepUpUnlocked(userId: string): Promise<void> {
  let count = 0;
  try {
    const raw = await getRedis().get(STEPUP_FAIL_KEY(userId));
    count = raw ? Number(raw) : 0;
  } catch {
    return; // Redis unavailable — fail open.
  }
  if (count >= STEPUP_MAX_FAILURES) {
    throw tooMany('Too many failed attempts. Wait 15 minutes and try again.');
  }
}

async function recordStepUpFailure(userId: string): Promise<void> {
  try {
    const redis = getRedis();
    const key = STEPUP_FAIL_KEY(userId);
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, STEPUP_WINDOW_SECONDS);
  } catch {
    // best-effort; never block the request on the counter
  }
}

async function clearStepUpFailures(userId: string): Promise<void> {
  try {
    await getRedis().del(STEPUP_FAIL_KEY(userId));
  } catch {
    // best-effort
  }
}

export default async function twoFactorRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /account/2fa/status --------------------------------------
  r.get(
    '/account/2fa/status',
    {
      schema: {
        tags: ['account'],
        summary: 'Whether 2FA is enabled + recovery codes remaining.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              enabled: z.boolean(),
              enrolledAt: z.string().datetime().nullable(),
              recoveryCodesRemaining: z.number().int().nonnegative(),
            }),
          ),
        },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const user = await withRlsBypass((tx) =>
        tx.user.findUnique({
          where: { id: userId },
          select: { totpEnabled: true, totpEnrolledAt: true, recoveryCodesHashed: true },
        }),
      );
      if (!user) throw notFound('User not found.');
      return {
        data: {
          enabled: user.totpEnabled,
          enrolledAt: user.totpEnrolledAt?.toISOString() ?? null,
          recoveryCodesRemaining: user.recoveryCodesHashed.length,
        },
      };
    },
  );

  // ---------- POST /account/2fa/setup --------------------------------------
  r.post(
    '/account/2fa/setup',
    {
      schema: {
        tags: ['account'],
        summary: 'Begin 2FA enrolment — returns an otpauth URI for QR display.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              secret: z.string(),
              otpauthUri: z.string(),
            }),
          ),
        },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const user = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId }, select: { email: true, totpEnabled: true } }),
      );
      if (!user) throw notFound('User not found.');
      if (user.totpEnabled) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, '2FA is already enabled. Disable first to re-enrol.');
      }
      const secret = generateTotpSecret();
      const redis = getRedis();
      await redis.set(PENDING_KEY(userId), secret, 'EX', PENDING_TTL);
      const otpauthUri = buildOtpAuthUri({
        secretBase32: secret,
        accountName: user.email,
        issuer: 'ALIGNED',
      });
      return { data: { secret, otpauthUri } };
    },
  );

  // ---------- POST /account/2fa/enable -------------------------------------
  // Sprint 1 M-3 — STAGES recovery codes; does NOT yet enable 2FA. The
  // client must follow up with POST /account/2fa/confirm-recovery-codes to
  // commit. Until that lands, the user's account is in its original state.
  r.post(
    '/account/2fa/enable',
    {
      schema: {
        tags: ['account'],
        summary: 'Verify TOTP code; stage recovery codes; client must confirm to commit.',
        body: z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              recoveryCodes: z.array(z.string()),
              pendingConfirmation: z.literal(true),
              expiresInSeconds: z.number().int().positive(),
            }),
          ),
        },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      await assertStepUpUnlocked(userId);
      const redis = getRedis();
      const pending = await redis.get(PENDING_KEY(userId));
      if (!pending) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Setup expired or never started. Call /account/2fa/setup again.',
        );
      }
      if (!verifyTotpCode(pending, req.body.code)) {
        await recordStepUpFailure(userId);
        throw unauthorized(ApiErrorCode.TOTP_INVALID, 'Invalid code. Try again.');
      }
      await clearStepUpFailures(userId);
      const recoveryCodes = generateRecoveryCodes();
      const recoveryCodesHashed = recoveryCodes.map(hashRecovery);
      const payload: PendingRecoveryPayload = {
        kind: 'enable',
        totpSecret: pending,
        recoveryCodesHashed,
      };
      await redis.set(
        PENDING_RECOVERY_KEY(userId),
        JSON.stringify(payload),
        'EX',
        PENDING_RECOVERY_TTL,
      );
      // Note: PENDING_KEY (the un-confirmed secret) is NOT deleted yet. If
      // the user re-calls /enable they get a fresh pending recovery batch.
      // The setup key is GC'd by confirm-recovery-codes on success.
      return {
        data: {
          recoveryCodes,
          pendingConfirmation: true as const,
          expiresInSeconds: PENDING_RECOVERY_TTL,
        },
      };
    },
  );

  // ---------- POST /account/2fa/confirm-recovery-codes ---------------------
  // Sprint 1 M-3 — the user has saved the recovery codes returned by the
  // previous /enable or /regenerate-recovery call. NOW we commit the change
  // to the user record. If the user never confirms (browser closed, network
  // drop), the pending payload expires and the account remains in its
  // original state — no permanent lock-out.
  r.post(
    '/account/2fa/confirm-recovery-codes',
    {
      schema: {
        tags: ['account'],
        summary: 'Confirm receipt of staged recovery codes; commit 2FA state.',
        response: { 200: successSchema },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      const redis = getRedis();
      const raw = await redis.get(PENDING_RECOVERY_KEY(userId));
      if (!raw) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'No pending recovery codes to confirm — start enrolment again.',
        );
      }
      let payload: PendingRecoveryPayload;
      try {
        payload = JSON.parse(raw) as PendingRecoveryPayload;
      } catch {
        await redis.del(PENDING_RECOVERY_KEY(userId));
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Pending payload corrupted — start enrolment again.',
        );
      }

      if (payload.kind === 'enable') {
        await withRlsBypass((tx) =>
          tx.user.update({
            where: { id: userId },
            data: {
              totpEnabled: true,
              // Encrypt the TOTP shared secret at rest (AES-256-GCM) so a DB
              // read can't derive valid codes and defeat 2FA for every user.
              totpSecret: encryptSecret(payload.totpSecret),
              totpEnrolledAt: new Date(),
              recoveryCodesHashed: payload.recoveryCodesHashed,
            },
          }),
        );
        await redis.del(PENDING_KEY(userId));
        await recordAudit({
          action: 'password_changed', // closest existing audit action
          actorUserId: userId,
          metadata: { event: '2fa_enabled' },
        });
      } else if (payload.kind === 'regenerate-recovery') {
        await withRlsBypass((tx) =>
          tx.user.update({
            where: { id: userId },
            data: { recoveryCodesHashed: payload.recoveryCodesHashed },
          }),
        );
        await recordAudit({
          action: 'password_changed',
          actorUserId: userId,
          metadata: { event: '2fa_recovery_codes_regenerated' },
        });
      }
      await redis.del(PENDING_RECOVERY_KEY(userId));
      return { ok: true as const };
    },
  );

  // ---------- POST /account/2fa/disable ------------------------------------
  r.post(
    '/account/2fa/disable',
    {
      schema: {
        tags: ['account'],
        summary: 'Disable 2FA. Requires either a current TOTP code or the account password.',
        body: z.object({
          code: z.string().trim().optional(),
          password: z.string().optional(),
        }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      await assertStepUpUnlocked(userId);
      const user = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId } }),
      );
      if (!user || !user.totpEnabled || !user.totpSecret) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, '2FA is not enabled.');
      }
      let ok = false;
      if (req.body.code && verifyTotpCode(decryptSecret(user.totpSecret), req.body.code)) {
        ok = true;
      } else if (req.body.password && (await verifyPassword(req.body.password, user.passwordHash))) {
        ok = true;
      }
      if (!ok) {
        await recordStepUpFailure(userId);
        throw unauthorized(
          ApiErrorCode.TOTP_INVALID,
          'Provide a current 6-digit code or the account password.',
        );
      }
      await clearStepUpFailures(userId);
      await withRlsBypass((tx) =>
        tx.user.update({
          where: { id: userId },
          data: {
            totpEnabled: false,
            totpSecret: null,
            totpEnrolledAt: null,
            recoveryCodesHashed: [],
          },
        }),
      );
      await recordAudit({
        action: 'password_changed',
        actorUserId: userId,
        metadata: { event: '2fa_disabled' },
      });
      return { ok: true as const };
    },
  );

  // ---------- POST /account/2fa/regenerate-recovery ------------------------
  // Sprint 1 M-3 — stages a new batch of recovery codes; the existing codes
  // stay live until the client confirms receipt via /confirm-recovery-codes.
  r.post(
    '/account/2fa/regenerate-recovery',
    {
      schema: {
        tags: ['account'],
        summary: 'Regenerate 10 recovery codes. Requires current code; client must confirm to commit.',
        body: z.object({ code: z.string().trim().regex(/^\d{6}$/) }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              recoveryCodes: z.array(z.string()),
              pendingConfirmation: z.literal(true),
              expiresInSeconds: z.number().int().positive(),
            }),
          ),
        },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;
      await assertStepUpUnlocked(userId);
      const user = await withRlsBypass((tx) =>
        tx.user.findUnique({ where: { id: userId } }),
      );
      if (!user?.totpEnabled || !user.totpSecret) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, '2FA is not enabled.');
      }
      if (!verifyTotpCode(decryptSecret(user.totpSecret), req.body.code)) {
        await recordStepUpFailure(userId);
        throw unauthorized(ApiErrorCode.TOTP_INVALID, 'Invalid code.');
      }
      await clearStepUpFailures(userId);
      const recoveryCodes = generateRecoveryCodes();
      const payload: PendingRecoveryPayload = {
        kind: 'regenerate-recovery',
        recoveryCodesHashed: recoveryCodes.map(hashRecovery),
      };
      const redis = getRedis();
      await redis.set(
        PENDING_RECOVERY_KEY(userId),
        JSON.stringify(payload),
        'EX',
        PENDING_RECOVERY_TTL,
      );
      return {
        data: {
          recoveryCodes,
          pendingConfirmation: true as const,
          expiresInSeconds: PENDING_RECOVERY_TTL,
        },
      };
    },
  );
}
