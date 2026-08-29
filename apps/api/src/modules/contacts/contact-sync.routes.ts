// "Sync contacts with phone" — QR-mediated address-book import.
//
// TWO SURFACES WITH DIFFERENT TRUST MODELS, deliberately in one file so they stay
// visibly paired:
//
//   1. Portal routes (JWT + requireRole) — the desktop mints a session and polls it.
//   2. PUBLIC routes under /contact-sync/s/:token — hit by the tenant's PHONE, which is
//      not logged in. The token is the capability. It is 32 random bytes, stored only
//      as a SHA-256, usable once, and dead in CONTACT_SYNC_TTL_MINUTES.
//
// The public routes carry no org context of their own: the org is read from the session
// row under RLS bypass, then every write runs under withTenant so RLS is enforced for
// the actual contact inserts (the F-02 lesson — bypass only for the lookup that
// establishes tenancy, never for the business writes).
import {
  ApiErrorCode,
  CONTACT_SYNC_ATTESTATION_TEXT,
  CONTACT_SYNC_ATTESTATION_VERSION,
  CONTACT_SYNC_MAX_CONTACTS,
  contactSyncPublicSessionSchema,
  contactSyncResultSchema,
  contactSyncSessionSchema,
  contactSyncUploadBodySchema,
  contactSyncVCardBodySchema,
  createContactSyncSessionBodySchema,
  createContactSyncSessionResponseSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  contactSyncStagedItemSchema,
  contactSyncDecideBodySchema,
  contactSyncLabelBodySchema,
  contactSyncStagedSummarySchema,
} from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import {
  CONTACT_SYNC_ATTESTATION_RECORD,
  buildPhoneSyncUrl,
  claimSessionForImport,
  sessionBreakdown,
  failSessionImport,
  finishSessionImport,
  entriesFromVCard,
  importContacts,
  mintSyncToken,
  normalizeEntries,
  resolveSyncSession,
  serializeSyncSession,
  syncExpiryFrom,
  type RawEntry,
} from '../../lib/contact-sync.js';
import { withRlsBypass, withTenant } from '../../lib/db.js';
import { excludeOwnNumbers, loadOrgOwnNumbers } from '../../lib/org-own-numbers.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../../lib/errors.js';
import {
  revertSession,
  undoClockStart,
  undoWindowStart,
  withinUndoWindow,
} from '../../lib/contact-sync-revert.js';
import {
  clearStagedRows,
  includedContacts,
  stageContacts,
} from '../../lib/contact-sync-stage.js';
import { shouldStageSync } from '../../lib/contact-sync-plan.js';
import { isWaContactsConfigured } from '../../lib/wa-contacts.js';
import { env } from '../../lib/env.js';

const SESSION_SELECT = {
  id: true,
  status: true,
  deviceKind: true,
  defaultDialCode: true,
  waQr: true,
  waPhone: true,
  marketingAttestedAt: true,
  syncedByLabel: true,
  expiresAt: true,
  openedAt: true,
  completedAt: true,
  importedAt: true,
  failureReason: true,
  contactsReceived: true,
  contactsCreated: true,
  contactsUpdated: true,
  contactsSkipped: true,
  createdAt: true,
} as const;

export default async function contactSyncRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------------------------------------------------------------------------
  // Portal surface (JWT).
  // ---------------------------------------------------------------------------

  /**
   * What this deployment can actually offer. The WhatsApp option depends on a separate
   * service being deployed and WA_CONTACTS_SECRET being set; without it the dialog must
   * not show a third card that could only ever fail. Same degrade shape as storage.ts
   * without Wasabi keys.
   */
  r.get(
    '/contacts/sync-capabilities',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Which contact-sync device kinds this deployment can offer.',
        response: { 200: itemEnvelopeSchema(z.object({ whatsapp: z.boolean() })) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async () => ({ data: { whatsapp: isWaContactsConfigured() } }),
  );

  r.post(
    '/contacts/sync-sessions',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Mint a QR session so a phone can push its address book in.',
        body: createContactSyncSessionBodySchema,
        response: { 201: itemEnvelopeSchema(createContactSyncSessionResponseSchema) },
      },
      // Deliberately 'viewer', i.e. any member of the org. Copying the address book
      // off your own phone is not a privileged operation, and there is no
      // ORG_FEATURES key for this — unlike Sales Scan it is on for every tenant with
      // no HQ activation step. The write it performs is still fully tenant-scoped.
      preHandler: [app.requireRole('viewer')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const { deviceKind, defaultDialCode, marketingAttested, syncedByLabel } = req.body;

      // Refuse rather than mint a WhatsApp session no service will ever pick up — the
      // tenant would sit watching a spinner that can never resolve.
      if (deviceKind === 'whatsapp' && !isWaContactsConfigured()) {
        throw serviceUnavailable('WhatsApp contact sync is not available on this deployment.');
      }

      const { token, tokenSha256 } = mintSyncToken();
      const now = new Date();

      const row = await withTenant(orgId, (tx) =>
        tx.contactSyncSession.create({
          data: {
            organizationId: orgId,
            tokenSha256,
            deviceKind,
            defaultDialCode: defaultDialCode ?? null,
            marketingAttestedAt: marketingAttested ? now : null,
            marketingAttestText: marketingAttested ? CONTACT_SYNC_ATTESTATION_RECORD : null,
            // Stored as typed. Blank stays NULL rather than becoming the creator's name —
            // createdByUserId below already records who clicked, and the two answer
            // different questions ("who started this" vs "whose phone was scanned").
            syncedByLabel: syncedByLabel ?? null,
            createdByUserId: req.auth!.userId,
            expiresAt: syncExpiryFrom(now, deviceKind),
          },
          select: SESSION_SELECT,
        }),
      );

      await recordAudit({
        action: 'contact_sync_started',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact_sync_session',
        entityId: row.id,
        metadata: {
          deviceKind,
          defaultDialCode: defaultDialCode ?? null,
          marketingAttested,
          attestationVersion: marketingAttested ? CONTACT_SYNC_ATTESTATION_VERSION : null,
          // In the audit trail as well as on the row: audit_logs is the only artefact of a
          // run that the reaper never prunes, so this is where "whose phone" survives after
          // the session and its ledger are gone.
          syncedByLabel: syncedByLabel ?? null,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return reply.code(201).send({
        data: {
          ...serializeSyncSession(row),
          token,
          // The WhatsApp flow has no phone web page — its QR is a pairing payload that
          // the ingest service pushes onto waQr moments later.
          url: deviceKind === 'whatsapp' ? null : buildPhoneSyncUrl(env.WEB_PUBLIC_URL, token),
        },
      });
    },
  );

  r.get(
    '/contacts/sync-sessions/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Poll a sync session from the desktop that created it.',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: itemEnvelopeSchema(contactSyncSessionSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const row = await withTenant(orgId, (tx) =>
        tx.contactSyncSession.findFirst({
          where: { id: req.params.id, organizationId: orgId },
          select: SESSION_SELECT,
        }),
      );
      if (!row) throw notFound('Sync session not found.');

      // Surface expiry as a state rather than making the client compare clocks.
      if (
        (row.status === 'pending' || row.status === 'opened') &&
        row.expiresAt.getTime() <= Date.now()
      ) {
        return { data: { ...serializeSyncSession(row), status: 'expired' as const } };
      }

      // The enrichment breakdown is derived from the per-row ledger, not stored. Only
      // worth reading once the run is terminal — mid-import it would be a partial count
      // that changes under the tenant.
      const base = serializeSyncSession(row);
      if (row.status !== 'completed') return { data: base };

      const derived = await sessionBreakdown(orgId, row.id, row.contactsSkipped);
      if (!derived) return { data: base };
      return {
        data: {
          ...base,
          breakdown: derived.breakdown,
          undoableCount: derived.undoableCount,
        },
      };
    },
  );

  /**
   * Runs still inside the undo window. Nothing listed sessions before — undo has no
   * surface without this, and the tenant needs to find a sync they closed the dialog on.
   */
  r.get(
    '/contacts/sync-sessions',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Recent contact-sync runs that can still be undone.',
        response: { 200: listEnvelopeSchema(contactSyncSessionSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const rows = await withTenant(orgId, (tx) =>
        tx.contactSyncSession.findMany({
          where: {
            organizationId: orgId,
            status: 'completed',
            // Measured from when the contacts LANDED, not when the QR was minted — a staged
            // run may have sat in review for days.
            OR: withinUndoWindow(undoWindowStart(new Date())),
          },
          select: SESSION_SELECT,
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      );
      const data = [];
      for (const row of rows) {
        const derived = await sessionBreakdown(orgId, row.id, row.contactsSkipped);
        data.push({
          ...serializeSyncSession(row),
          breakdown: derived?.breakdown ?? null,
          undoableCount: derived?.undoableCount ?? null,
        });
      }
      return { data, nextCursor: null };
    },
  );

  /**
   * Undo a run.
   *
   * 'editor', matching POST /contacts/merge — the other route in this module that hard
   * deletes. Deliberately stricter than the 'viewer' that may START a sync: creating
   * contacts is recoverable, removing them is the destructive direction.
   */
  r.post(
    '/contacts/sync-sessions/:id/revert',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Undo a sync run — removes only what it created, and only if untouched.',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: itemEnvelopeSchema(
            z.object({
              removed: z.number().int(),
              fieldsReverted: z.number().int(),
              kept: z.number().int(),
              keptReasons: z.record(z.string(), z.number().int()),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const row = await withTenant(orgId, (tx) =>
        tx.contactSyncSession.findFirst({
          where: { id: req.params.id, organizationId: orgId },
          select: {
            id: true,
            createdAt: true,
            importedAt: true,
            revertedAt: true,
            status: true,
          },
        }),
      );
      if (!row) throw notFound('Sync session not found.');
      if (row.revertedAt) throw conflict('That sync has already been undone.');
      if (row.status !== 'completed') throw conflict('That sync has not finished.');
      // The ledger is pruned on exactly this boundary, so refuse rather than silently
      // "undo" a run whose rows are already gone and report removing nothing. Measured from
      // the IMPORT, not the QR mint — see undoClockStart.
      if (undoClockStart(row) < undoWindowStart(new Date())) {
        throw conflict('That sync is too old to undo.');
      }

      const result = await revertSession(orgId, row.id);

      await recordAudit({
        action: 'contact_sync_reverted',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact_sync_session',
        entityId: row.id,
        metadata: { ...result },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return { data: result };
    },
  );

  /** The review queue for one run. */
  r.get(
    '/contacts/sync-sessions/:id/staged',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Contacts staged for review, before anything is imported.',
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          q: z.string().max(120).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: listEnvelopeSchema(contactSyncStagedItemSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const { q, limit, offset } = req.query;
      const rows = await withTenant(orgId, (tx) =>
        tx.contactSyncStagedItem.findMany({
          where: {
            organizationId: orgId,
            sessionId: req.params.id,
            ...(q
              ? {
                  OR: [
                    { displayName: { contains: q, mode: 'insensitive' as const } },
                    { phoneE164: { contains: q } },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            phoneE164: true,
            displayName: true,
            email: true,
            status: true,
            existingContactId: true,
          },
          orderBy: [{ displayName: 'asc' }, { phoneE164: 'asc' }],
          take: limit,
          skip: offset,
        }),
      );
      return {
        data: rows.map((r2) => ({
          id: r2.id,
          phoneE164: r2.phoneE164,
          displayName: r2.displayName,
          email: r2.email,
          included: r2.status === 'included',
          alreadyKnown: r2.existingContactId !== null,
        })),
        // Offset cursor. This was hardcoded null, which made every row past the first page
        // unreachable — invisible to the tenant but still imported by apply.
        nextCursor: rows.length === limit ? String(offset + limit) : null,
      };
    },
  );

  /**
   * Whole-queue totals.
   *
   * Separate from the paged list on purpose. The page can only ever count the rows it
   * fetched, and the review screen was doing exactly that: labelling its button from a
   * 500-row page while apply imported the entire queue. For a 1,200-contact address book —
   * the case staging exists for — that meant 700 contacts the tenant never saw, could not
   * deselect, and was never told about.
   */
  r.get(
    '/contacts/sync-sessions/:id/staged/summary',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Whole-queue counts for a staged run, independent of paging or search.',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: itemEnvelopeSchema(contactSyncStagedSummarySchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const where = { organizationId: orgId, sessionId: req.params.id };
      const [total, included, alreadyKnown, noName] = await withTenant(orgId, (tx) =>
        Promise.all([
          tx.contactSyncStagedItem.count({ where }),
          tx.contactSyncStagedItem.count({ where: { ...where, status: 'included' } }),
          tx.contactSyncStagedItem.count({ where: { ...where, existingContactId: { not: null } } }),
          tx.contactSyncStagedItem.count({ where: { ...where, displayName: null } }),
        ]),
      );
      return { data: { total, included, alreadyKnown, noName } };
    },
  );

  /**
   * Include or exclude rows. ONE route with a scope, not two — the alternative was a
   * predicate DSL, which would invent a second filter grammar next to segmentFilterSchema
   * for a screen with three useful selections.
   */
  r.post(
    '/contacts/sync-sessions/:id/staged/decide',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Include or exclude staged contacts before importing.',
        params: z.object({ id: z.string().uuid() }),
        body: contactSyncDecideBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ changed: z.number().int() })) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const { action, ids, scope } = req.body;
      const status = action === 'include' ? ('included' as const) : ('excluded' as const);

      const where = {
        organizationId: orgId,
        sessionId: req.params.id,
        ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
        ...(scope === 'existing' ? { existingContactId: { not: null } } : {}),
        ...(scope === 'no_name' ? { displayName: null } : {}),
      };

      const res = await withTenant(orgId, (tx) =>
        tx.contactSyncStagedItem.updateMany({ where, data: { status } }),
      );
      return { data: { changed: res.count } };
    },
  );

  /**
   * Correct "whose phone is this?" before the run lands.
   *
   * The review screen is the first time anyone sees the queue, and so the first moment the
   * label can be checked against reality — "this says Layth, but it's the shop's Samsung".
   *
   * Guarded to status 'review' on purpose. Once a run is applied, its contacts carry the
   * DERIVED TAG, and the tag is the half that outlives the 7-day prune; letting the label
   * change afterwards would leave the two disagreeing with no way to reconcile them, and the
   * session is the copy that disappears.
   */
  r.patch(
    '/contacts/sync-sessions/:id/label',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Correct the "whose phone is this?" label while a run is still in review.',
        params: z.object({ id: z.string().uuid() }),
        body: contactSyncLabelBodySchema,
        response: { 200: itemEnvelopeSchema(contactSyncSessionSchema) },
      },
      // 'editor', matching the apply route this feeds. Starting a sync is 'viewer' because
      // copying your own address book is not privileged — but this value is stamped onto
      // every contact the apply creates, so it belongs to whoever is allowed to run the
      // apply. A viewer who cannot import must not get to relabel an editor's import.
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const updated = await withTenant(orgId, (tx) =>
        tx.contactSyncSession.updateMany({
          where: { id: req.params.id, organizationId: orgId, status: 'review' },
          data: { syncedByLabel: req.body.syncedByLabel },
        }),
      );
      if (updated.count === 0) {
        throw conflict('That sync is no longer waiting for review, so its label is fixed.');
      }

      // AUDIT THE CORRECTION. Every other mutating route in this file records one, and this
      // one is not optional bookkeeping: contact_sync_sessions is pruned after 7 days, so
      // audit_logs is the ONLY permanent record of a run. Without this row, a label changed
      // from "Layth" to "Shop Samsung" and then stamped onto 900 contacts had no actor, no
      // timestamp and no before/after anywhere — while the pre-correction value lived on in
      // contact_sync_started, making the permanent trail actively misleading.
      await recordAudit({
        action: 'contact_sync_staged',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact_sync_session',
        entityId: req.params.id,
        metadata: { relabelled: true, syncedByLabel: req.body.syncedByLabel },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      const row = await withTenant(orgId, (tx) =>
        tx.contactSyncSession.findFirst({
          where: { id: req.params.id, organizationId: orgId },
          select: SESSION_SELECT,
        }),
      );
      if (!row) throw notFound('Sync session not found.');
      return { data: serializeSyncSession(row) };
    },
  );

  /** Import everything still selected. */
  r.post(
    '/contacts/sync-sessions/:id/apply',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Import the staged contacts the tenant kept selected.',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: itemEnvelopeSchema(contactSyncResultSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const row = await withTenant(orgId, (tx) =>
        tx.contactSyncSession.findFirst({
          where: { id: req.params.id, organizationId: orgId },
          select: {
            id: true,
            status: true,
            marketingAttestedAt: true,
            deviceKind: true,
            syncedByLabel: true,
            contactsSkipped: true,
          },
        }),
      );
      if (!row) throw notFound('Sync session not found.');
      if (row.status !== 'review') throw conflict('That sync is not waiting for review.');

      // CLAIM IT. The check above is not enough on its own: two tabs (or a phone and a
      // desktop) both read 'review', both proceed, and because clearStagedRows runs before
      // the import, the SECOND run deletes the ledger the FIRST just wrote. Those rows are
      // what undo reads, so every contact the first apply created silently becomes
      // un-undoable. 'importing' has been in the status enum since this feature shipped,
      // documented as "an apply is in flight", and was never actually used — this is it.
      const claimed = await withTenant(orgId, (tx) =>
        tx.contactSyncSession.updateMany({
          where: { id: row.id, organizationId: orgId, status: 'review' },
          data: { status: 'importing' },
        }),
      );
      if (claimed.count === 0) throw conflict('That sync is already being imported.');

      let outcome: { created: number; updated: number; skipped: number };
      let chosen: Awaited<ReturnType<typeof includedContacts>>;
      try {
        chosen = await includedContacts(orgId, row.id);
        // Clear the staged rows FIRST: importContacts rewrites the ledger, and the unique
        // (sessionId, phoneE164) index would reject every insert otherwise — the apply would
        // appear to work while storing nothing.
        await clearStagedRows(orgId, row.id);

        outcome = await importContacts(orgId, chosen, {
          marketingAttested: row.marketingAttestedAt !== null,
          log: req.log,
          sessionId: row.id,
          waReachable: row.deviceKind === 'whatsapp',
          // Read at APPLY time, not at stage time, so a label corrected on the review screen
          // is the one that reaches the tags.
          syncedByLabel: row.syncedByLabel,
        });
      } catch (err) {
        // Without this the row is stranded in 'importing' forever: the desktop polls it as
        // still-in-flight, the reaper's review sweep no longer matches it, and the tenant
        // has no way to retry or discard.
        req.log.error({ err, sessionId: row.id }, '[contact-sync] apply failed');
        await failSessionImport(orgId, row.id, 'Could not import those contacts.');
        throw err;
      }

      const result = {
        received: chosen.length,
        created: outcome.created,
        updated: outcome.updated,
        // The unusable count was measured during normalisation, BEFORE staging, and stored
        // on the row then. Dropping it here would lose it: outcome.skipped only knows about
        // rows that reached the import.
        skipped: row.contactsSkipped + outcome.skipped,
        mode: 'imported' as const,
      };
      await finishSessionImport(orgId, row.id, result);

      await recordAudit({
        action: 'contact_sync_applied',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact_sync_session',
        entityId: row.id,
        // The label AS APPLIED — the value actually stamped onto these contacts, which may
        // differ from the one at mint time if the review screen corrected it. A staged run
        // never emits contact_sync_completed (that branch returns earlier), so this is the
        // ONLY terminal audit row it produces, and therefore the only permanent record of
        // what provenance those contacts carry once the session is pruned. deviceKind too,
        // so the path is recoverable without the session row.
        metadata: { ...result, syncedByLabel: row.syncedByLabel, deviceKind: row.deviceKind },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return { data: result };
    },
  );

  /** Throw the whole queue away without importing anything. */
  r.delete(
    '/contacts/sync-sessions/:id/staged',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Discard a review queue without importing.',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      await clearStagedRows(orgId, req.params.id);
      await withTenant(orgId, (tx) =>
        tx.contactSyncSession.updateMany({
          where: { id: req.params.id, organizationId: orgId, status: 'review' },
          data: { status: 'failed', failureReason: 'Discarded without importing.' },
        }),
      );
      return { ok: true as const };
    },
  );

  // ---------------------------------------------------------------------------
  // Public surface — the phone. NO JWT. The token in the path is the credential.
  // ---------------------------------------------------------------------------

  /**
   * Rate limit is per-IP and tight: these routes are internet-facing and the only thing
   * standing between them and a brute-force is the token's entropy. 32 random bytes is
   * not brute-forceable, but a cheap limiter removes the incentive to try and caps the
   * damage from a leaked-token scanner.
   */
  const publicLimit = {
    rateLimit: { max: 30, timeWindow: '1 minute' },
  } as const;

  /**
   * Above CONTACT_SYNC_MAX_VCARD_CHARS so Zod's limit is the one that binds and the
   * caller gets a readable error, but still bounded — this is an unauthenticated route,
   * and the body is parsed before the token is ever checked.
   */
  const VCARD_BODY_LIMIT = 8 * 1024 * 1024;

  r.get(
    '/contact-sync/s/:token',
    {
      config: publicLimit,
      schema: {
        tags: ['contacts'],
        summary: 'Public: what the scanning phone is allowed to know about this session.',
        params: z.object({ token: z.string().min(20).max(200) }),
        response: { 200: itemEnvelopeSchema(contactSyncPublicSessionSchema) },
      },
    },
    async (req) => {
      const session = await resolveSyncSession(req.params.token);
      // Unknown / expired / already-used are one indistinguishable outcome on purpose.
      if (!session) throw notFound('This sync link is no longer valid.');

      const org = await withRlsBypass((tx) =>
        tx.organization.findUnique({
          where: { id: session.organizationId },
          select: { name: true },
        }),
      );

      // First contact from the phone flips pending -> opened, which is what makes the
      // desktop's "Phone connected" state real rather than optimistic.
      if (session.status === 'pending') {
        await withTenant(session.organizationId, (tx) =>
          tx.contactSyncSession.updateMany({
            where: { id: session.id, organizationId: session.organizationId, status: 'pending' },
            data: { status: 'opened', openedAt: new Date() },
          }),
        );
      }

      return {
        data: {
          status: 'opened' as const,
          deviceKind: session.deviceKind as 'android' | 'ios',
          organizationName: org?.name ?? 'your business',
          defaultDialCode: session.defaultDialCode,
          expiresAt: session.expiresAt.toISOString(),
        },
      };
    },
  );

  /** Shared tail: normalise, import, close out the session, audit. */
  async function completeSync(req: FastifyRequest, token: string, entries: RawEntry[]) {
    const ip = req.ip;
    const session = await resolveSyncSession(token);
    if (!session) throw notFound('This sync link is no longer valid.');

    if (entries.length > CONTACT_SYNC_MAX_CONTACTS) {
      throw badRequest(
        ApiErrorCode.VALIDATION_ERROR,
        `This sync carries more than ${CONTACT_SYNC_MAX_CONTACTS} contacts.`,
      );
    }

    // Claim first — atomic, single-use. Note it does NOT yet publish 'completed': the
    // counts and the status must land together, or the polling desktop stops on a zero
    // snapshot it can never refresh.
    if (!(await claimSessionForImport(session.organizationId, session.id))) {
      throw notFound('This sync link is no longer valid.');
    }

    const marketingAttested = session.marketingAttestedAt !== null;
    let result: {
      received: number;
      created: number;
      updated: number;
      skipped: number;
      mode: 'imported' | 'staged';
    };
    try {
      const norm = normalizeEntries(entries, session.defaultDialCode);
      const { received, skipped: unusable } = norm;

      // Never import the business as its own customer. An iOS "All Contacts" export always
      // carries the owner's own card, and every address book holds the shop's own line —
      // imported, those land in broadcast audiences, so a campaign can message the bot's own
      // number and, on a metered wallet, bill the tenant for it.
      const own = await loadOrgOwnNumbers(session.organizationId, {
        defaultDialCode: session.defaultDialCode,
      });
      const { kept: contacts, removed: ownRemoved } = excludeOwnNumbers(norm.contacts, own);
      if (ownRemoved > 0) {
        req.log.info(
          { sessionId: session.id, ownRemoved },
          '[contact-sync] skipped the business own number(s)',
        );
      }

      // Big, or attested? Stage it for review instead of importing. The phone still gets a
      // clear ending — it just says "sent for review" rather than "added", because nothing
      // has been added yet and telling it otherwise would be a lie the desktop contradicts.
      if (shouldStageSync({ count: contacts.length, attested: marketingAttested })) {
        const staged = await stageContacts(session.organizationId, session.id, contacts, unusable);
        await recordAudit({
          action: 'contact_sync_staged',
          organizationId: session.organizationId,
          entityType: 'contact_sync_session',
          entityId: session.id,
          metadata: { staged: staged.staged, alreadyKnown: staged.alreadyKnown, received },
          ipAddress: req.ip,
        });
        return {
          received,
          created: 0,
          updated: 0,
          skipped: unusable,
          mode: 'staged' as const,
        };
      }
      const outcome = await importContacts(session.organizationId, contacts, {
        marketingAttested,
        log: req.log,
        // Writes the per-row ledger that undo and the enrichment breakdown read.
        sessionId: session.id,
        syncedByLabel: session.syncedByLabel,
      });
      result = {
        received,
        created: outcome.created,
        updated: outcome.updated,
        skipped: unusable + outcome.skipped,
        mode: 'imported' as const,
      };
      await finishSessionImport(session.organizationId, session.id, result);
    } catch (err) {
      // An import that throws must say so. Leaving the row mid-claim would make it
      // invisible to the poll AND the reaper, with the tenant's token already spent.
      req.log.error({ err, sessionId: session.id }, '[contact-sync] import failed');
      await failSessionImport(session.organizationId, session.id, 'Could not save those contacts.');
      throw err;
    }

    await recordAudit({
      action: 'contact_sync_completed',
      organizationId: session.organizationId,
      entityType: 'contact_sync_session',
      entityId: session.id,
      metadata: {
        ...result,
        deviceKind: session.deviceKind,
        syncedByLabel: session.syncedByLabel,
        marketingAttested,
        // The verbatim claim the tenant made, kept as evidence rather than a boolean.
        attestation: marketingAttested ? CONTACT_SYNC_ATTESTATION_TEXT : null,
        attestationVersion: marketingAttested ? CONTACT_SYNC_ATTESTATION_VERSION : null,
      },
      ipAddress: ip,
    });

    return result;
  }

  r.post(
    '/contact-sync/s/:token/contacts',
    {
      config: publicLimit,
      schema: {
        tags: ['contacts'],
        summary: 'Public: push contacts picked from the Android OS contact picker.',
        params: z.object({ token: z.string().min(20).max(200) }),
        body: contactSyncUploadBodySchema,
        response: { 200: itemEnvelopeSchema(contactSyncResultSchema) },
      },
    },
    async (req) => {
      const entries: RawEntry[] = req.body.contacts.map((c) => ({
        name: c.name ?? null,
        phones: c.phones,
        email: c.email ?? null,
      }));
      return { data: await completeSync(req, req.params.token, entries) };
    },
  );

  r.post(
    '/contact-sync/s/:token/vcard',
    {
      config: publicLimit,
      bodyLimit: VCARD_BODY_LIMIT,
      schema: {
        tags: ['contacts'],
        summary: 'Public: push a .vcf export (the iOS flow, and the universal fallback).',
        params: z.object({ token: z.string().min(20).max(200) }),
        body: contactSyncVCardBodySchema,
        response: { 200: itemEnvelopeSchema(contactSyncResultSchema) },
      },
    },
    async (req) => {
      // RESOLVE THE TOKEN BEFORE PARSING. The vCard parser is the most expensive thing on
      // an unauthenticated route in a single-threaded process, so an anonymous caller must
      // not be able to hand it megabytes. (The real, single-use claim still happens inside
      // completeSync — this is only a cheap "is this token worth any work at all" gate.)
      if (!(await resolveSyncSession(req.params.token))) {
        throw notFound('This sync link is no longer valid.');
      }
      // Then parse: a truncated AirDrop transfer or a wrong file should fail as
      // "no contacts found", not as a half-finished import.
      const entries = entriesFromVCard(req.body.vcard, CONTACT_SYNC_MAX_CONTACTS + 1);
      if (entries.length === 0) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          "That file didn't contain any contacts. Make sure you exported a .vcf contact card.",
        );
      }
      return { data: await completeSync(req, req.params.token, entries) };
    },
  );
}
