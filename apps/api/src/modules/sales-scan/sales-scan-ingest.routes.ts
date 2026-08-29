// PUBLIC receiver for the Sales Scan capture service (apps/wa-ingest).
//
// The capture service runs OFF-BOX on AlignDesk, so these endpoints are internet-facing:
// every one requires an HMAC-SHA256 signature over <timestamp>.<rawBody>, a 5-minute skew
// window, AND a single-use replay nonce. Without the nonce a captured request stays
// replayable for the whole window — duplicating /messages rows, or forging a /purged
// "credentials destroyed" record.
//
// These routes are NOT JWT-authed and carry no org context of their own: the grant id is
// the capability, and the org is read from the grant row under RLS bypass with an explicit
// organizationId filter (mirroring shopify-webhook.routes.ts).
import { encryptSecret, secretCryptoEnabled } from '@platform/db';
import { ApiErrorCode } from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withRlsBypass } from '../../lib/db.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import {
  claimIngestNonce,
  clearLiveSessionState,
  counterpartyHash,
  recordIngestHeartbeat,
  setLiveSessionState,
  stripPaymentCredentials,
  verifyIngestSignature,
} from '../../lib/sales-scan-ingest.js';
import { effectiveEndsAt } from '../../lib/sales-scan-window.js';

const LIVE = ['pending', 'linking', 'active'] as const;
type LiveStatus = (typeof LIVE)[number];

export default async function salesScanIngestRoutes(app: FastifyInstance) {
  /** Signature + skew + single-use nonce. Throws 401 on any failure. */
  async function auth(req: FastifyRequest): Promise<void> {
    // Require the original bytes: hashing a JSON.stringify(req.body) re-serialization
    // reorders keys and silently breaks the signature check — reject instead. (L-10)
    const raw = (req as unknown as { rawBody?: string }).rawBody;
    if (raw === undefined) throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Missing raw request body.');
    const sig = req.headers['x-wa-ingest-signature'] as string | undefined;
    const ok = verifyIngestSignature({
      rawBody: raw,
      timestamp: req.headers['x-wa-ingest-timestamp'] as string | undefined,
      signature: sig,
    });
    if (!ok) throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Invalid ingest signature.');
    if (!sig || !(await claimIngestNonce(sig)))
      throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Replayed ingest request.');
  }

  // Which grants may currently be captured. This is the authority the capture service
  // re-derives from on every sweep, so it must return ONLY live, unexpired grants.
  app.post('/wa-ingest/authorised-grants', async (req) => {
    await auth(req);
    const now = new Date();
    const rows = await withRlsBypass((tx) =>
      tx.salesScanGrant.findMany({
        where: { status: { in: [...LIVE] } },
        select: {
          id: true,
          organizationId: true,
          status: true,
          grantExpiresAt: true,
          captureEndsAt: true,
        },
      }),
    );
    return {
      data: rows
        .filter((g) => effectiveEndsAt(g) > now)
        .map((g) => ({
          grantId: g.id,
          organizationId: g.organizationId,
          status: g.status,
          effectiveEndsAt: effectiveEndsAt(g).toISOString(),
          pairPhone: null as string | null,
        })),
    };
  });

  // Session status incl. the rotating QR. Cached in Redis with a short TTL — the tenant's
  // page reads it from there rather than us keeping a column we would have to clear.
  app.post('/wa-ingest/status', async (req) => {
    await auth(req);
    const body = z
      .object({
        grantId: z.string().uuid(),
        status: z.string().min(1),
        qr: z.string().nullish(),
        pairingCode: z.string().nullish(),
        phone: z.string().nullish(),
      })
      .parse(req.body);

    await setLiveSessionState(body.grantId, {
      status: body.status,
      qr: body.qr ?? null,
      pairingCode: body.pairingCode ?? null,
      phone: body.phone ?? null,
    });

    if (body.status === 'open') {
      // First successful link starts the tenant-facing window. captureEndsAt is clamped to
      // grantExpiresAt, so linking late can never extend the compliance deadline.
      await withRlsBypass(async (tx) => {
        const g = await tx.salesScanGrant.findUnique({
          where: { id: body.grantId },
          select: { id: true, status: true, windowDays: true, grantExpiresAt: true, linkedAt: true },
        });
        if (!g || !LIVE.includes(g.status as LiveStatus)) return;
        const now = new Date();
        const proposed = new Date(now.getTime() + g.windowDays * 24 * 60 * 60 * 1000);
        await tx.salesScanGrant.update({
          where: { id: g.id },
          data: {
            status: 'active',
            linkedAt: g.linkedAt ?? now,
            // Only set on the FIRST link; a reconnect must not slide the deadline.
            captureEndsAt: g.linkedAt
              ? undefined
              : proposed < g.grantExpiresAt
                ? proposed
                : g.grantExpiresAt,
            phoneE164: body.phone ?? undefined,
          },
        });
      });
    } else if (body.status === 'qr' || body.status === 'pairing') {
      await withRlsBypass((tx) =>
        tx.salesScanGrant.updateMany({
          where: { id: body.grantId, status: 'pending' },
          data: { status: 'linking' },
        }),
      );
    }
    return { ok: true as const };
  });

  // Captured messages. Payment credentials are stripped and the counterparty hashed BEFORE
  // anything is written, so raw card/IBAN/OTP text never reaches the table.
  app.post('/wa-ingest/messages', async (req) => {
    await auth(req);
    const body = z
      .object({
        grantId: z.string().uuid(),
        messages: z
          .array(
            z.object({
              waMsgId: z.string().min(1),
              counterpartyPhone: z.string().min(1),
              direction: z.enum(['in', 'out']),
              kind: z.string().min(1),
              body: z.string().nullish(),
              /**
               * Group chats are captured as well as DMs (owner decision 2026-07-30).
               * Defaulted so a capture service older than this column keeps working — an
               * absent tag can only mean "the sender only ever sent DMs".
               */
              isGroup: z.boolean().default(false),
              chatName: z.string().max(512).nullish(),
              sentAt: z.string(),
            }),
          )
          .max(500),
      })
      .parse(req.body);

    const stored = await withRlsBypass(async (tx) => {
      const grant = await tx.salesScanGrant.findUnique({
        where: { id: body.grantId },
        select: {
          id: true,
          organizationId: true,
          status: true,
          grantExpiresAt: true,
          captureEndsAt: true,
        },
      });
      if (!grant) throw notFound('Unknown grant.');
      // Refuse writes for a window that is over — belt to the capture service's braces.
      if (!LIVE.includes(grant.status as LiveStatus) || effectiveEndsAt(grant) <= new Date()) {
        return 0;
      }

      const rows = body.messages.map((m) => ({
        organizationId: grant.organizationId,
        grantId: grant.id,
        waMsgId: m.waMsgId,
        counterpartyHash: counterpartyHash(grant.organizationId, m.counterpartyPhone),
        // Reversible companion to the one-way hash, so a tenant's own CSV export can name
        // the real sender/receiver. Gated on the key actually being configured:
        // encryptSecret is deliberately INERT without one, and silently writing plaintext
        // numbers into this column is the exact outcome it exists to prevent. No key ->
        // null, and the export falls back to the hash prefix.
        counterpartyPhoneEnc: secretCryptoEnabled()
          ? encryptSecret(m.counterpartyPhone.replace(/\D/g, ''))
          : null,
        direction: m.direction,
        kind: m.kind,
        body: stripPaymentCredentials(m.body ?? null),
        isGroup: m.isGroup,
        // A group subject is third-party free text on the same footing as a body, so it
        // goes through the same stripper before it is ever stored.
        chatName: stripPaymentCredentials(m.chatName ?? null),
        sentAt: new Date(m.sentAt),
      }));
      // skipDuplicates makes redelivery harmless on top of the (grantId, waMsgId) unique.
      const res = await tx.salesMessage.createMany({ data: rows, skipDuplicates: true });
      if (res.count) {
        await tx.salesScanGrant.update({
          where: { id: grant.id },
          data: { messageCount: { increment: res.count } },
        });
      }
      return res.count;
    });
    return { data: { stored } };
  });

  // Capture stopped. Status only — the credential purge is reported separately, because
  // bundling them means a failed purge could never be retried (blocker B1).
  app.post('/wa-ingest/ended', async (req) => {
    await auth(req);
    const body = z
      .object({ grantId: z.string().uuid(), reason: z.string().min(1) })
      .parse(req.body);
    const terminal = body.reason === 'logged_out' ? 'failed' : 'completed';
    await withRlsBypass((tx) =>
      tx.salesScanGrant.updateMany({
        where: { id: body.grantId, status: { in: [...LIVE] } },
        data: { status: terminal, endedAt: new Date(), endReason: body.reason },
      }),
    );
    await clearLiveSessionState(body.grantId);
    return { ok: true as const };
  });

  // Credentials verifiably destroyed. The ONLY writer of authPurgedAt — the capture
  // service calls this only after confirming the bytes are gone.
  app.post('/wa-ingest/purged', async (req) => {
    await auth(req);
    const body = z.object({ grantId: z.string().uuid() }).parse(req.body);
    await withRlsBypass((tx) =>
      tx.salesScanGrant.updateMany({
        where: { id: body.grantId, authPurgedAt: null },
        data: { authPurgedAt: new Date() },
      }),
    );
    await clearLiveSessionState(body.grantId);
    return { ok: true as const };
  });

  /**
   * Liveness beat from the capture service, every 60s.
   *
   * This used to be thrown away — `await auth(req); return { ok: true }`, body never read,
   * nothing stored. That was the missing half of a real problem: the tenant UI decided
   * whether to offer a QR code by checking whether config vars were SET, so production
   * promised QRs for a week while the capture service sat with capture switched off.
   * Recording the beat turns "is the address written down?" into "is anyone home?".
   *
   * Best-effort storage: a Redis failure must not make the capture service treat its own
   * heartbeat as broken and retry-storm. Missing beats simply read as "not live", which is
   * the safe direction.
   */
  app.post('/wa-ingest/heartbeat', async (req) => {
    await auth(req);
    const body = (req.body ?? {}) as { active?: unknown };
    const active = typeof body.active === 'number' && Number.isFinite(body.active) ? body.active : 0;
    await recordIngestHeartbeat(active).catch((err) =>
      req.log.warn({ err }, '[sales-scan] could not record ingest heartbeat'),
    );
    return { ok: true as const };
  });
}
