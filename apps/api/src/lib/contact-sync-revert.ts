// Undo one sync run.
//
// The DECISION for each row is the pure, tested planRevert (contact-sync-plan.ts). This
// file is the impure half: loading current state, executing, and recording the outcome.
//
// The governing rule, worth restating where the deletes actually happen: undo reverses
// THIS RUN, not the customer relationship that may have formed since. A contact who has
// messaged the business, opted out, been blocked, joined a sequence, or been renamed by
// the operator has acquired a life of its own, and destroying that to tidy up an import
// would be a worse outcome than the import.
import { CONTACT_SYNC_UNDO_WINDOW_MS } from '@platform/shared';

import { PHONE_SYNC_TAG } from './contact-sync-import.js';
import {
  planRevert,
  type RevertKeepReason,
  type ContactEffect,
} from './contact-sync-plan.js';
import { withTenant } from './db.js';

export interface RevertResult {
  removed: number;
  fieldsReverted: number;
  kept: number;
  keptReasons: Partial<Record<RevertKeepReason, number>>;
}

/** Rows are processed in batches so one undo can never hold a long transaction. */
const CHUNK = 100;

export function undoWindowStart(now: Date): Date {
  return new Date(now.getTime() - CONTACT_SYNC_UNDO_WINDOW_MS);
}

/**
 * The instant a run's undo clock starts: when its contacts actually LANDED.
 *
 * Not createdAt. A staged run — anything over 50 contacts, or any attested one — sits in
 * review until someone comes back to it, sometimes for days, and the clock used to start when
 * the QR was minted. A tenant who reviewed a big export for five days was shown "can be
 * undone for 7 days" while holding two, and the reaper pruned the ledger recording what to
 * undo the day after. The failure was silent: the button just stopped appearing.
 *
 * Falls back to createdAt for rows imported before importedAt existed, which is exactly the
 * behaviour those rows already had.
 */
export function undoClockStart(row: { importedAt?: Date | null; createdAt: Date }): Date {
  return row.importedAt ?? row.createdAt;
}

/**
 * Prisma cannot express COALESCE in a `where`, so "effective timestamp within the window"
 * becomes an explicit two-branch OR. Shared by the list route and the reaper so the button's
 * window and the data's retention can never drift apart — the failure mode that made this
 * one constant in the first place.
 */
export function withinUndoWindow(boundary: Date) {
  return [
    { importedAt: { gte: boundary } },
    { importedAt: null, createdAt: { gte: boundary } },
  ];
}

/** The inverse, for the reaper: effective timestamp older than the boundary. */
export function beyondUndoWindow(boundary: Date) {
  return [
    { importedAt: { lt: boundary } },
    { importedAt: null, createdAt: { lt: boundary } },
  ];
}

/**
 * Reverse a run. Idempotent and resumable: every row is stamped with `revertedAt` and its
 * outcome as it is handled, so a crashed revert resumes where it stopped rather than
 * reporting "removed 0" on a second attempt.
 */
export async function revertSession(
  organizationId: string,
  sessionId: string,
): Promise<RevertResult> {
  const result: RevertResult = { removed: 0, fieldsReverted: 0, kept: 0, keptReasons: {} };

  for (;;) {
    // Only rows not yet handled. Ordering by id keeps the batches deterministic.
    const rows = await withTenant(organizationId, (tx) =>
      tx.contactSyncStagedItem.findMany({
        where: { sessionId, organizationId, revertedAt: null },
        select: {
          id: true,
          contactId: true,
          effect: true,
          filledDisplayName: true,
          filledEmail: true,
        },
        orderBy: { id: 'asc' },
        take: CHUNK,
      }),
    );
    if (rows.length === 0) break;

    const contactIds = rows.map((r) => r.contactId).filter((id): id is string => id !== null);

    // One batched read for the whole chunk — a per-row findUnique here would be 100 round
    // trips inside a request the tenant is watching.
    const current = await withTenant(organizationId, (tx) =>
      tx.contact.findMany({
        where: { id: { in: contactIds }, organizationId },
        select: {
          id: true,
          displayName: true,
          email: true,
          lastInboundAt: true,
          optedOutAt: true,
          blockedAt: true,
          tags: { where: { tag: PHONE_SYNC_TAG }, select: { id: true }, take: 1 },
          _count: { select: { enrollments: true } },
        },
      }),
    );
    const byId = new Map(current.map((c) => [c.id, c]));

    for (const row of rows) {
      const c = row.contactId ? byId.get(row.contactId) : undefined;
      const decision = planRevert(
        {
          contactId: row.contactId,
          effect: row.effect as ContactEffect,
          filledDisplayName: row.filledDisplayName,
          filledEmail: row.filledEmail,
        },
        c
          ? {
              id: c.id,
              displayName: c.displayName,
              email: c.email,
              lastInboundAt: c.lastInboundAt,
              optedOutAt: c.optedOutAt,
              blockedAt: c.blockedAt,
              hasPhoneSyncTag: c.tags.length > 0,
              hasSequenceEnrollment: c._count.enrollments > 0,
            }
          : null,
      );

      let outcome = decision.action as string;
      try {
        if (decision.action === 'delete') {
          // HARD delete, deliberately diverging from the soft DELETE /contacts/:id.
          // A soft-deleted row still occupies @@unique([organizationId, phoneE164]) and
          // classifyEntry refuses to resurrect it — so a soft undo would make the
          // corrected re-sync return 1,200 skips instead of 1,200 contacts.
          await withTenant(organizationId, (tx) =>
            tx.contact.deleteMany({ where: { id: row.contactId!, organizationId } }),
          );
          result.removed += 1;
        } else if (decision.action === 'revert_fields') {
          // Guarded by the current value: if the operator has since edited the field,
          // the updateMany matches nothing and their edit survives. No snapshot needed —
          // the import only ever writes NULL -> value, so the prior value is provably null.
          const res = await withTenant(organizationId, (tx) =>
            tx.contact.updateMany({
              where: {
                id: row.contactId!,
                organizationId,
                ...(decision.clearDisplayName ? { displayName: row.filledDisplayName } : {}),
                ...(decision.clearEmail ? { email: row.filledEmail } : {}),
              },
              data: {
                ...(decision.clearDisplayName ? { displayName: null } : {}),
                ...(decision.clearEmail ? { email: null } : {}),
              },
            }),
          );
          if (res.count > 0) result.fieldsReverted += 1;
          else outcome = 'keep:renamed';
        } else if (decision.action === 'keep') {
          result.kept += 1;
          result.keptReasons[decision.reason] = (result.keptReasons[decision.reason] ?? 0) + 1;
          outcome = `keep:${decision.reason}`;
        }
      } catch {
        outcome = 'error';
      }

      // Stamped whatever happened, including keeps — that is what makes a resumed revert
      // pick up where it left off instead of re-walking rows it already decided.
      await withTenant(organizationId, (tx) =>
        tx.contactSyncStagedItem.updateMany({
          where: { id: row.id, organizationId },
          data: { revertedAt: new Date(), revertOutcome: outcome.slice(0, 60) },
        }),
      );
    }
  }

  await withTenant(organizationId, (tx) =>
    tx.contactSyncSession.updateMany({
      where: { id: sessionId, organizationId },
      data: { revertedAt: new Date() },
    }),
  );

  return result;
}
