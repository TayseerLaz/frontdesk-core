// PUBLIC receiver for the WhatsApp contact-sync service (apps/wa-ingest, contacts mode).
//
// The ingest service runs OFF-BOX, so these endpoints are internet-facing: every one
// requires an HMAC-SHA256 signature over `<timestamp>.<rawBody>`, a 5-minute skew window,
// AND a single-use replay nonce. Without the nonce a captured request stays replayable for
// the whole window — enough to re-push a contact batch or forge an "ended".
//
// Pull model, mirroring sales-scan: the ingest service asks what work exists and pushes
// results back. the platform never dials out, so the ingest host needs no inbound connectivity.
//
// These routes are NOT JWT-authed and carry no org context of their own. The session id is
// the capability, and the org is read from the session row under RLS bypass with an
// explicit organizationId filter; every business write then runs under withTenant.
import {
  ApiErrorCode,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  waContactsEndedBodySchema,
  waContactsPendingSessionSchema,
  waContactsPushBodySchema,
  waContactsQrBodySchema,
} from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import {
  claimSessionForImport,
  failSessionImport,
  finishSessionImport,
  importContacts,
  normalizeEntries,
} from '../../lib/contact-sync.js';
import { shouldStageSync, whatsappFallbackLabel } from '../../lib/contact-sync-plan.js';
import { stageContacts } from '../../lib/contact-sync-stage.js';
import { withRlsBypass, withTenant } from '../../lib/db.js';
import { excludeOwnNumbers, loadOrgOwnNumbers } from '../../lib/org-own-numbers.js';
import { unauthorized } from '../../lib/errors.js';
import { claimWaContactsNonce, verifyWaContactsSignature } from '../../lib/wa-contacts.js';

/** States a WhatsApp session may still be worked on in. */
const LIVE = ['pending', 'opened'] as const;

export default async function waContactsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Signature + skew + single-use nonce. Throws 401 on any failure. */
  async function auth(req: FastifyRequest): Promise<void> {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    const sig = req.headers['x-wa-contacts-signature'] as string | undefined;
    const ok = verifyWaContactsSignature({
      rawBody: raw,
      timestamp: req.headers['x-wa-contacts-timestamp'] as string | undefined,
      signature: sig,
    });
    if (!ok) throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Invalid contacts-ingest signature.');
    if (!sig || !(await claimWaContactsNonce(sig)))
      throw unauthorized(ApiErrorCode.AUTH_REQUIRED, 'Replayed contacts-ingest request.');
  }

  /**
   * Which sessions may be paired right now. The ingest service re-derives its whole
   * worklist from this on every tick, so it must return ONLY live, unexpired WhatsApp
   * sessions — a stale entry here is a socket that should not exist.
   */
  r.post(
    '/wa-contacts/pending',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Machine: sessions awaiting a WhatsApp link.',
        body: z.object({}).passthrough(),
        response: { 200: listEnvelopeSchema(waContactsPendingSessionSchema) },
      },
    },
    async (req) => {
      await auth(req);
      const rows = await withRlsBypass((tx) =>
        tx.contactSyncSession.findMany({
          where: {
            deviceKind: 'whatsapp',
            status: { in: [...LIVE] },
            expiresAt: { gt: new Date() },
          },
          select: { id: true, organizationId: true, expiresAt: true },
          orderBy: { createdAt: 'asc' },
          take: 20,
        }),
      );
      return {
        data: rows.map((s) => ({
          sessionId: s.id,
          organizationId: s.organizationId,
          expiresAt: s.expiresAt.toISOString(),
        })),
        nextCursor: null,
      };
    },
  );

  /** Relay the rotating pairing QR (and, once paired, the number that linked). */
  r.post(
    '/wa-contacts/qr',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Machine: push the current WhatsApp pairing QR for a session.',
        body: waContactsQrBodySchema,
        response: { 200: successSchema },
      },
    },
    async (req) => {
      await auth(req);
      const { sessionId, qr, linkedPhone } = req.body;

      const session = await withRlsBypass((tx) =>
        tx.contactSyncSession.findUnique({
          where: { id: sessionId },
          select: { id: true, organizationId: true, status: true },
        }),
      );
      // Terminal sessions are not re-openable: a late QR push must not resurrect one.
      if (!session || !LIVE.includes(session.status as (typeof LIVE)[number])) return { ok: true as const };

      await withTenant(session.organizationId, (tx) =>
        tx.contactSyncSession.updateMany({
          where: {
            id: session.id,
            organizationId: session.organizationId,
            status: { in: [...LIVE] },
          },
          data: {
            waQr: qr,
            ...(linkedPhone ? { waPhone: linkedPhone } : {}),
            // A cleared QR means pairing succeeded — that is the moment the desktop can
            // honestly say "connected" rather than "waiting for you to scan".
            ...(qr === null ? { status: 'opened' as const, openedAt: new Date() } : {}),
          },
        }),
      );
      return { ok: true as const };
    },
  );

  /**
   * The harvest. Claims the session atomically first, for the same reason the phone
   * routes do: a retried push must not import twice and double the reported counts.
   */
  r.post(
    '/wa-contacts/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: "Machine: push a session's harvested WhatsApp contacts.",
        body: waContactsPushBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ stored: z.number().int() })) },
      },
    },
    async (req) => {
      await auth(req);
      const { sessionId, contacts, linkedPhone } = req.body;

      const session = await withRlsBypass((tx) =>
        tx.contactSyncSession.findUnique({
          where: { id: sessionId },
          select: {
            id: true,
            organizationId: true,
            status: true,
            marketingAttestedAt: true,
            syncedByLabel: true,
            // For the fallback label: a retried push may omit linkedPhone even though an
            // earlier /qr call already recorded it.
            waPhone: true,
            expiresAt: true,
          },
        }),
      );
      if (!session || !LIVE.includes(session.status as (typeof LIVE)[number]))
        return { data: { stored: 0 } };

      // Same discipline as the phone routes: claim without publishing 'completed', so
      // the counts and the status land together and the polling desktop can never freeze
      // on a zero snapshot.
      if (!(await claimSessionForImport(session.organizationId, session.id))) {
        return { data: { stored: 0 } };
      }
      if (linkedPhone) {
        await withTenant(session.organizationId, (tx) =>
          tx.contactSyncSession.updateMany({
            where: { id: session.id, organizationId: session.organizationId },
            data: { waPhone: linkedPhone },
          }),
        );
      }

      const marketingAttested = session.marketingAttestedAt !== null;
      // If the tenant typed nothing, fall back to the last four digits of the number WhatsApp
      // verified. This is the one path that MEASURES provenance instead of accepting it on
      // trust, and the session holding that number is pruned after 7 days — so without this
      // the best evidence in the product is also the most short-lived. Four digits identify
      // which phone without denormalising a personal number across thousands of rows.
      const effectiveLabel =
        session.syncedByLabel ?? whatsappFallbackLabel(linkedPhone ?? session.waPhone);
      let outcome: { created: number; updated: number; skipped: number };
      let received: number;
      let unusable: number;
      try {
        // WhatsApp JIDs are already international, so no dial code is needed or wanted —
        // passing one would risk re-prefixing an already-complete number.
        const norm = normalizeEntries(
          contacts.map((c) => ({
            name: c.name ?? null,
            phones: [`+${c.phone.replace(/\D/g, '')}`],
          })),
          null,
        );
        received = norm.received;
        unusable = norm.skipped;

        // Drop the business's own numbers, and on this path that includes the LINKED ACCOUNT
        // itself — WhatsApp hands us the account's own contact card, so without this the
        // tenant imports themselves as a customer every single time. linkedPhone is digits
        // with no '+', so it is normalised alongside the rest rather than compared raw.
        const own = await loadOrgOwnNumbers(session.organizationId, {
          extra: [linkedPhone ? `+${linkedPhone.replace(/\D/g, '')}` : null],
        });
        const excluded = excludeOwnNumbers(norm.contacts, own);
        norm.contacts = excluded.kept;
        if (excluded.removed > 0) {
          req.log.info(
            { sessionId: session.id, ownRemoved: excluded.removed },
            '[wa-contacts] skipped the business own number(s)',
          );
        }

        // Same gate as the phone paths: a big or attested run is reviewed before it
        // lands. The ingest service is told 'stored: 0' honestly — nothing has been
        // stored yet — and the desktop, which is already polling this session, gets
        // status 'review' and sends the tenant to the queue.
        if (shouldStageSync({ count: norm.contacts.length, attested: marketingAttested })) {
          const staged = await stageContacts(
            session.organizationId,
            session.id,
            norm.contacts,
            unusable,
          );
          await recordAudit({
            action: 'contact_sync_staged',
            organizationId: session.organizationId,
            entityType: 'contact_sync_session',
            entityId: session.id,
            metadata: {
              deviceKind: 'whatsapp',
              staged: staged.staged,
              alreadyKnown: staged.alreadyKnown,
              received,
              linkedPhone: linkedPhone ?? null,
            },
            ipAddress: req.ip,
          });
          return { data: { stored: 0 } };
        }
        outcome = await importContacts(session.organizationId, norm.contacts, {
          marketingAttested,
          log: req.log,
          sessionId: session.id,
          // Every number here came from a WhatsApp JID, so it is a WhatsApp account by
          // construction. This is the only place reachability is ever established — and
          // it costs no WhatsApp queries at all.
          waReachable: true,
          // The typed label, same as the phone paths. This is the ONE path that also learns
          // a real number (linkedPhone -> waPhone), but that arrives asynchronously and is
          // nullable, so the label stays the provenance the tenant can always rely on.
          syncedByLabel: effectiveLabel,
        });
        await finishSessionImport(session.organizationId, session.id, {
          received,
          created: outcome.created,
          updated: outcome.updated,
          skipped: unusable + outcome.skipped,
        });
      } catch (err) {
        req.log.error({ err, sessionId: session.id }, '[wa-contacts] import failed');
        await failSessionImport(
          session.organizationId,
          session.id,
          'Could not save those contacts.',
        );
        throw err;
      }

      await recordAudit({
        action: 'contact_sync_completed',
        organizationId: session.organizationId,
        entityType: 'contact_sync_session',
        entityId: session.id,
        metadata: {
          deviceKind: 'whatsapp',
          syncedByLabel: effectiveLabel,
          received,
          created: outcome.created,
          updated: outcome.updated,
          skipped: unusable + outcome.skipped,
          marketingAttested,
          linkedPhone: linkedPhone ?? null,
        },
        ipAddress: req.ip,
      });

      return { data: { stored: outcome.created + outcome.updated } };
    },
  );

  /** Terminal report — pairing failed, timed out, or the tenant never scanned. */
  r.post(
    '/wa-contacts/ended',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Machine: report that a WhatsApp session ended without completing.',
        body: waContactsEndedBodySchema,
        response: { 200: successSchema },
      },
    },
    async (req) => {
      await auth(req);
      const { sessionId, reason } = req.body;

      const session = await withRlsBypass((tx) =>
        tx.contactSyncSession.findUnique({
          where: { id: sessionId },
          select: { id: true, organizationId: true },
        }),
      );
      if (!session) return { ok: true as const };

      // Guarded to live rows only — a late "ended" must never overwrite a completed
      // session and tell the tenant their successful sync failed.
      await withTenant(session.organizationId, (tx) =>
        tx.contactSyncSession.updateMany({
          where: {
            id: session.id,
            organizationId: session.organizationId,
            status: { in: [...LIVE] },
          },
          data: { status: 'failed', failureReason: reason.slice(0, 200), waQr: null },
        }),
      );
      return { ok: true as const };
    },
  );
}
