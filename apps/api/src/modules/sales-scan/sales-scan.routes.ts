// Sales Scan — "Teach the bot with your own data" (portal routes).
//
// A tenant links the sales WhatsApp number they already use; we capture one week of
// their real customer DMs (both directions) and hand back a summary plus an analysis
// of how they speak.
//
// GATING. As of 2026-08-05 this feature is hidden when off like every other one (the
// `sales_scan` ORG_FEATURES entry lists its href, so isHrefDisabled hides the Settings
// card and bounces the route). It previously stayed visible to show "contact admin to
// upgrade"; that was reversed by owner decision.
//
// TWO ROUTES ARE DELIBERATELY NOT FEATURE-GATED, and both must stay that way:
//
//   - DELETE /sales-scan/grant    (stop capturing)
//   - DELETE /sales-scan/messages (delete the captured corpus)
//
// The consent text stored verbatim on every grant promises the tenant can stop the
// capture and delete everything "at any time". Gating these on `disabledFeatures` broke
// that promise: switching the feature off 403'd the tenant's own revocation while
// capture kept running, because POST /wa-ingest/authorised-grants (the authority the
// capture service re-derives from) never consults disabledFeatures, and HQ has no
// sales-scan admin route at all. Turning the feature off is exactly the lever an
// operator reaches for to "make it stop" — it must never be the lever that makes it
// unstoppable. A tenant without the feature simply has nothing to stop or delete.
//
// GET /sales-scan/status is also ungated: it exposes no tenant data when the feature is
// off (the grant is forced to null below), the route bounce already covers the UI, and
// it is the only surface that shows a just-disabled tenant that a capture exists. It is
// also polled by the Flutter mobile app, which is not in this repo — turning its 200
// into a 403 is a wire-contract break. Every other MUTATING route below is gated.
//
// Capture availability: /connect 503s unless isScanStartable(). See lib/sales-scan.ts
// and docs/SALES-SCAN-REVIEW-BLOCKERS.md for the blockers that gate a real number.
import {
  ApiErrorCode,
  SALES_SCAN_CONSENT_TEXT,
  SALES_SCAN_CONSENT_VERSION,
  SALES_SCAN_DEFAULT_WINDOW_DAYS,
  SALES_SCAN_MAX_WINDOW_DAYS,
  SALES_SCAN_MIN_WINDOW_DAYS,
  itemEnvelopeSchema,
  salesScanConnectBodySchema,
  salesScanGrantDtoSchema,
  salesScanStatusResponseSchema,
  salesScanSummaryDtoSchema,
  successSchema,
} from '@platform/shared';
import type { SalesScanSummaryPayload } from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../../lib/errors.js';
import { assertOrgFeature } from '../../lib/org-feature-guard.js';
import {
  getLiveSessionState,
  nudgeIngestReconcile,
  requestIngestStop,
} from '../../lib/sales-scan-ingest.js';
import { SALES_SCAN_PREVIEW_QR } from '../../lib/sales-scan-preview-qr.js';
import {
  createGrant,
  currentGrant,
  hasLiveGrant,
  isCaptureAvailable,
  isDemoMode,
  isIngestConfigured,
  isSalesScanEnabled,
  isScanStartable,
  serializeGrant,
  terminateGrant,
} from '../../lib/sales-scan.js';

export default async function salesScanRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  const limits = {
    minWindowDays: SALES_SCAN_MIN_WINDOW_DAYS,
    maxWindowDays: SALES_SCAN_MAX_WINDOW_DAYS,
    defaultWindowDays: SALES_SCAN_DEFAULT_WINDOW_DAYS,
  };

  // NOT feature-gated on purpose — see the header. Returns featureEnabled:false and a
  // null grant for a disabled org, so it leaks nothing, and it is what lets a tenant
  // whose feature was just switched off still SEE that a capture exists.
  r.get(
    '/sales-scan/status',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Sales Scan activation + current capture state for the caller\'s org.',
        response: { 200: itemEnvelopeSchema(salesScanStatusResponseSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const orgId = req.auth!.organizationId;
        const featureEnabled = await isSalesScanEnabled(tx, orgId);
        const grant = featureEnabled ? await currentGrant(tx, orgId) : null;
        const hasSummary = grant
          ? (await tx.salesScanSummary.count({ where: { organizationId: orgId, grantId: grant.id } })) > 0
          : false;

        // The QR rotates every ~20s, so the capture service pushes it into a
        // short-TTL Redis key and we relay whatever is current.
        const liveState =
          grant && ['pending', 'linking', 'active'].includes(grant.status)
            ? await getLiveSessionState(grant.id)
            : null;

        // DEMO MODE. Walks the real state machine so the flow looks and behaves like the
        // real thing, but no session exists and nothing is ever captured — messageCount
        // stays 0 by construction because no writer runs.
        let demoGrant = grant;
        let demoQr: string | null = null;
        if (isDemoMode() && grant) {
          if (grant.status === 'pending' || grant.status === 'linking') {
            demoQr = SALES_SCAN_PREVIEW_QR;
            // After a beat, advance as though the code had been scanned, so the demo
            // reaches the "recording" state instead of sitting on a code forever.
            const ageMs = Date.now() - grant.grantedAt.getTime();
            if (ageMs > 25_000) {
              const now = new Date();
              const proposed = new Date(now.getTime() + grant.windowDays * 24 * 60 * 60 * 1000);
              demoGrant = await tx.salesScanGrant.update({
                where: { id: grant.id },
                data: {
                  status: 'active',
                  linkedAt: now,
                  captureEndsAt: proposed < grant.grantExpiresAt ? proposed : grant.grantExpiresAt,
                },
              });
              demoQr = null;
            } else if (grant.status === 'pending') {
              demoGrant = await tx.salesScanGrant.update({
                where: { id: grant.id },
                data: { status: 'linking' },
              });
            }
          }
        }

        return {
          data: {
            featureEnabled,
            // Reports whether capture is genuinely ALIVE (a recent heartbeat), not merely
            // configured — see isCaptureAvailable(). Demo mode presents as available so
            // the flow stays walkable end to end.
            ingestAvailable: await isCaptureAvailable(),
            // Operator-visible honesty marker: the tenant UI reads as real, but the API
            // never claims a demo grant is a real capture. Keep this.
            isPreview: isDemoMode() && !isIngestConfigured(),
            grant: demoGrant ? serializeGrant(demoGrant) : null,
            qr: demoQr ?? liveState?.qr ?? null,
            pairingCode: liveState?.pairingCode ?? null,
            hasSummary,
            consent: { version: SALES_SCAN_CONSENT_VERSION, text: SALES_SCAN_CONSENT_TEXT },
            limits,
          },
        };
      }),
  );

  // Start a capture window. Admin-only: it authorises reading every customer DM on a
  // live business number, which is not an editor-level decision.
  r.post(
    '/sales-scan/connect',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Record consent and open a Sales Scan capture window.',
        body: salesScanConnectBodySchema,
        response: { 201: itemEnvelopeSchema(salesScanGrantDtoSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      await assertOrgFeature(
        app,
        req,
        'sales_scan',
        'Teaching the bot with your own data is not enabled for your account. Contact ALIGNED to upgrade.',
      );

      // Reject stale consent copy outright rather than recording an agreement to
      // text the tenant never saw.
      if (req.body.consentVersion !== SALES_SCAN_CONSENT_VERSION) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'The consent terms have been updated. Reload the page and review them again.',
        );
      }

      // The capture service is what produces the QR. Without a LIVE one a grant would sit
      // in `pending` forever while the UI promised a code — which is exactly what happened
      // in production for six days — so fail loudly instead.
      if (!(await isScanStartable())) {
        throw serviceUnavailable(
          'WhatsApp scanning is not available yet. Your account is activated — we will let you know as soon as scanning goes live.',
        );
      }

      const grant = await app.tenant(req, async (tx) => {
        const orgId = req.auth!.organizationId;
        if (await hasLiveGrant(tx, orgId)) {
          throw conflict('A scan is already running for this organization. Stop it before starting another.');
        }
        return createGrant(tx, {
          organizationId: orgId,
          windowDays: req.body.windowDays,
          grantedByUserId: req.auth!.userId,
        });
      });

      await recordAudit({
        action: 'sales_scan_granted',
        organizationId: req.auth!.organizationId,
        actorUserId: req.auth!.userId,
        entityType: 'sales_scan_grant',
        entityId: grant.id,
        metadata: {
          windowDays: grant.windowDays,
          consentVersion: grant.consentVersion,
          consentTextSha256: grant.consentTextSha256,
          grantExpiresAt: grant.grantExpiresAt.toISOString(),
        },
      });

      // Nudge the capture service so a QR appears in seconds rather than on its next
      // sweep. Fire-and-forget: the reaper would pick the grant up regardless.
      void nudgeIngestReconcile().catch((err) =>
        req.log.warn({ err, grantId: grant.id }, 'ingest reconcile nudge failed'),
      );

      reply.code(201);
      return { data: serializeGrant(grant) };
    },
  );

  // Stop capturing. Named "stop", not "delete" — deleting the corpus is the separate
  // route below, and the two must never be conflated in either label or effect.
  r.delete(
    '/sales-scan/grant',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Stop the active Sales Scan capture window (does NOT delete captured messages).',
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      // NOT feature-gated — withdrawing consent must work even after HQ switches the
      // feature off. See the header of this file.
      const orgId = req.auth!.organizationId;

      const grantId = await app.tenant(req, async (tx) => {
        const grant = await currentGrant(tx, orgId);
        if (!grant) throw notFound('No Sales Scan window found.');
        const moved = await terminateGrant(tx, {
          organizationId: orgId,
          grantId: grant.id,
          status: 'revoked',
          endReason: 'tenant_revoked',
        });
        // Already terminal — treat as success so a double click is harmless.
        return moved > 0 ? grant.id : null;
      });

      if (grantId) {
        // Ask the capture service to disconnect and purge. If it is unreachable the
        // Hader-side purge-retry reaper keeps trying — the DB row is already terminal,
        // so capture is authoritatively revoked either way.
        void requestIngestStop(grantId, 'tenant_revoked').catch((err) =>
          req.log.warn({ err, grantId }, 'ingest stop request failed — reaper will retry'),
        );
        await recordAudit({
          action: 'sales_scan_revoked',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'sales_scan_grant',
          entityId: grantId,
        });
      }
      return { ok: true as const };
    },
  );

  // Delete the captured corpus. Separate from "stop" on purpose.
  r.delete(
    '/sales-scan/messages',
    {
      schema: {
        tags: ['integrations'],
        summary: 'Delete every message captured by Sales Scan for this org.',
        response: { 200: itemEnvelopeSchema(z.object({ deleted: z.number().int() })) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      // NOT feature-gated — erasure must work even after HQ switches the feature off.
      // See the header of this file.
      const orgId = req.auth!.organizationId;

      const deleted = await app.tenant(req, async (tx) => {
        const res = await tx.salesMessage.deleteMany({ where: { organizationId: orgId } });
        await tx.salesScanGrant.updateMany({
          where: { organizationId: orgId },
          data: { messageCount: 0 },
        });
        return res.count;
      });

      await recordAudit({
        action: 'sales_scan_data_deleted',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'sales_message',
        metadata: { deleted },
      });
      return { data: { deleted } };
    },
  );

  // The report the tenant actually came for.
  r.get(
    '/sales-scan/summary',
    {
      schema: {
        tags: ['integrations'],
        summary: 'The latest Sales Scan summary (chat digest + how they speak).',
        response: { 200: itemEnvelopeSchema(salesScanSummaryDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      await assertOrgFeature(app, req, 'sales_scan');
      const orgId = req.auth!.organizationId;

      return app.tenant(req, async (tx) => {
        const row = await tx.salesScanSummary.findFirst({
          where: { organizationId: orgId },
          orderBy: { generatedAt: 'desc' },
        });
        if (!row) throw notFound('No summary yet. It is generated when the capture window closes.');
        return {
          data: {
            id: row.id,
            grantId: row.grantId,
            status: row.status,
            // Stored as JSONB; the response schema validates its shape on the way out.
            payload: row.payload as unknown as SalesScanSummaryPayload,
            messagesAnalyzed: row.messagesAnalyzed,
            generatedAt: row.generatedAt.toISOString(),
          },
        };
      });
    },
  );
}
