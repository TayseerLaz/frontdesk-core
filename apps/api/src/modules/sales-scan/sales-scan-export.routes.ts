// Sales Scan — tenant CSV export of the captured corpus.
//
// This is the ONE surface where the raw capture leaves the platform in readable form, so it
// is deliberately the most restricted read in the feature:
//
//   • ADMIN ONLY. Every other Sales Scan read is viewer-level; this one is not, because
//     the file contains third-party phone numbers and verbatim customer text. Handing
//     that to a viewer seat is not the same decision as showing them the summary.
//   • Feature-gated (assertOrgFeature) like every mutating Sales Scan route.
//   • RLS-scoped: every read goes through app.tenant(), and the org filter is explicit
//     on top of the policy.
//
// The corpus is payment-credential-stripped, NOT redacted or anonymised — it is
// identifiable personal data about the tenant's customers. No copy here may imply
// otherwise (blocker B7/M1). The tenant is the controller of it; we are the processor;
// this endpoint is how they exercise that (their own subject-access / portability
// obligations run through it).
//
// Streaming: rows are paged with a keyset cursor and yielded batch-by-batch through a
// Readable, so a 100k-row corpus never materialises as one string in memory and a
// client disconnect tears the DB loop down with the stream.
import { Readable } from 'node:stream';

import { decryptSecret } from '@platform/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { assertOrgFeature } from '../../lib/org-feature-guard.js';

/** Rows per DB round-trip. Small enough to bound memory, large enough to be cheap. */
const BATCH = 1_000;

/** Excel needs a BOM to read UTF-8 — without it Arabic bodies render as mojibake. */
const BOM = '﻿';

const HEADER = ['sent_at', 'chat_kind', 'chat_name', 'direction', 'sender', 'receiver', 'kind', 'body'];

/**
 * Shown as sender/receiver for the tenant's own side when the grant never recorded the
 * linked number (a window that ended before `phoneE164` was learned). Deliberately not
 * blank, and deliberately not phone-shaped, so it can't be mistaken for a real number.
 */
const SELF_UNKNOWN = 'me';

/**
 * A `+961…` phone is not a formula. Without this exemption the neutraliser below would
 * apostrophe-prefix every single sender/receiver cell — the two columns this export
 * exists for — and any non-Excel reader (pandas, a CRM import) would ingest the quote as
 * part of the number. A value that is only digits/spaces with an optional leading sign
 * cannot carry a formula or DDE payload, so exempting it costs nothing.
 */
const PLAIN_NUMBER = /^[+-]?[\d\s]+$/;

/**
 * One CSV cell, always quoted.
 *
 * Two deliberate deviations from "just RFC 4180":
 *  - CR/LF (and tabs) collapse to a space. A quoted field may legally contain newlines,
 *    but a multi-line WhatsApp message then breaks every naive line-splitting parser (and
 *    the row structure in a lot of tooling). Bodies are prose, so a space loses nothing.
 *  - Cells opening with a spreadsheet formula sigil are prefixed with an apostrophe.
 *    The bodies here are written by third parties we do not control; a body starting
 *    `=cmd|...` is a live formula-injection payload the moment the tenant double-clicks
 *    the file in Excel (OWASP CSV injection). The apostrophe is the standard neutraliser
 *    and Excel hides it again on display.
 */
function csvCell(value: string | null | undefined): string {
  let s = (value ?? '').replace(/[\r\n\t]+/g, ' ');
  if (/^[=+\-@]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export default async function salesScanExportRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/sales-scan/export.csv',
    {
      schema: {
        tags: ['integrations'],
        summary:
          'Download every Sales Scan message captured for this org as CSV (admin only — contains third-party phone numbers).',
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      await assertOrgFeature(
        app,
        req,
        'sales_scan',
        'Teaching the bot with your own data is not enabled for your account. Contact support to upgrade.',
      );
      const orgId = req.auth!.organizationId;

      // The tenant's own number, per grant — sender/receiver is derived from
      // `direction` plus this, so it has to be resolved before the first row. There are
      // only ever a handful of grants per org (the window is capped and cooled down),
      // so one map beats a join on every message row.
      const phoneByGrant = new Map<string, string>();
      await app.tenant(req, async (tx) => {
        const grants = await tx.salesScanGrant.findMany({
          where: { organizationId: orgId },
          select: { id: true, phoneE164: true },
        });
        for (const g of grants) if (g.phoneE164) phoneByGrant.set(g.id, g.phoneE164);
      });

      // TODO(audit): this export has no AuditAction value yet — the enum has only
      // sales_scan_granted / sales_scan_revoked / sales_scan_data_deleted, and adding a
      // value needs its own migration (Postgres cannot use a fresh enum value in the
      // transaction that adds it), which is owned elsewhere right now. A follow-up
      // migration should add `sales_scan_data_exported` and this handler should then
      // recordAudit() it with { rows } — an unaudited export of third-party phone
      // numbers is exactly the gap review finding H4 names. Until then the structured
      // log lines below are the only trail, so do not remove them.
      req.log.info(
        { orgId, actorUserId: req.auth!.userId, feature: 'sales_scan' },
        'sales scan csv export started',
      );

      let rows = 0;
      let decryptFailed = 0;

      /** Counterparty as text: the real number when we can read it, else the join key. */
      const counterparty = (row: {
        counterpartyHash: string;
        counterpartyPhoneEnc: string | null;
      }): string => {
        const enc = row.counterpartyPhoneEnc;
        if (enc) {
          try {
            // Stored with the same at-rest envelope as the WhatsApp channel tokens, so
            // the raw numbers are not readable from the table itself.
            const plain = decryptSecret(enc);
            if (plain) return plain;
          } catch {
            // A wrong/missing SECRET_ENCRYPTION_KEY must not abort the whole download —
            // degrade this one cell to the hash and carry on. Counted, logged once at
            // the end rather than per row.
            decryptFailed += 1;
          }
        }
        // Pre-encryption rows (captured before the column existed) land here too. The
        // prefix keeps the CSV groupable by conversation even without the number.
        return `hash:${row.counterpartyHash.slice(0, 12)}`;
      };

      async function* stream(): AsyncGenerator<string> {
        try {
          yield BOM + HEADER.map(csvCell).join(',') + '\r\n';

          // Keyset cursor on (createdAt, id): index-backed by
          // @@index([organizationId, createdAt]), unlike an ORDER BY sent_at scan which
          // would re-sort the remaining corpus on every batch. Capture is forward-only,
          // so insertion order is very nearly chronological — and `sent_at` is a column
          // in the file, so the authoritative timestamp is always in the tenant's hands.
          let afterCreatedAt: Date | null = null;
          let afterId: string | null = null;

          for (;;) {
            const batch = await app.tenant(req, (tx) =>
              tx.salesMessage.findMany({
                where: {
                  organizationId: orgId,
                  ...(afterCreatedAt && afterId
                    ? {
                        OR: [
                          { createdAt: { gt: afterCreatedAt } },
                          { createdAt: afterCreatedAt, id: { gt: afterId } },
                        ],
                      }
                    : {}),
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                take: BATCH,
              }),
            );
            if (batch.length === 0) break;

            const last = batch[batch.length - 1]!;
            afterCreatedAt = last.createdAt;
            afterId = last.id;

            let chunk = '';
            for (const row of batch) {
              const self = phoneByGrant.get(row.grantId) ?? SELF_UNKNOWN;
              const other = counterparty(row);
              const outbound = row.direction === 'out';
              chunk +=
                [
                  row.sentAt.toISOString(),
                  // DERIVED, not stored: `isGroup` is the single source of truth for the
                  // group-vs-dm tag, so this label can never drift from it. chat_name is
                  // the group subject and is empty for DMs (and for groups whose subject
                  // the capture service never passively learned).
                  row.isGroup ? 'group' : 'dm',
                  row.chatName,
                  row.direction,
                  outbound ? self : other,
                  outbound ? other : self,
                  row.kind,
                  row.body,
                ]
                  .map(csvCell)
                  .join(',') + '\r\n';
            }
            rows += batch.length;
            yield chunk;

            if (batch.length < BATCH) break;
          }
        } finally {
          // Runs on completion AND on client abort (the stream calls return() on the
          // generator), so a cancelled download is still accounted for.
          req.log.info(
            { orgId, actorUserId: req.auth!.userId, rows, decryptFailed },
            'sales scan csv export finished',
          );
          if (decryptFailed > 0) {
            req.log.warn(
              { orgId, decryptFailed },
              'sales scan csv export could not decrypt some counterparty numbers — check SECRET_ENCRYPTION_KEY',
            );
          }
        }
      }

      const stamp = new Date().toISOString().slice(0, 10);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="sales-scan-${stamp}.csv"`);
      // No caching: this is personal data behind an admin-only gate.
      reply.header('Cache-Control', 'no-store');
      return reply.send(Readable.from(stream()));
    },
  );
}
