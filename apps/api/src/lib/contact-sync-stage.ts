// Staged review: put contacts in front of the tenant before they land.
//
// Same ledger table as undo and the enrichment breakdown — a staged row and an applied row
// are the same row at different points in its life, which is why there is one table and
// not three.
//
// Gate policy lives in the pure shouldStageSync (contact-sync-plan.ts). Note that an
// ATTESTED sync always stages regardless of size: ticking that box sets optedInAt on every
// created row, which makes the whole address book broadcast-eligible. That is the one
// action in this feature that reaches real people and is hard to walk back, so it earns a
// screen even for twelve contacts.
import type { NormalizedContact } from './contact-sync-normalize.js';
import { withTenant } from './db.js';

/** Batch size for the existence lookup and the insert. */
const CHUNK = 500;

export interface StageResult {
  staged: number;
  alreadyKnown: number;
}

/**
 * Write the run's contacts as staged rows and move the session to 'review'.
 *
 * Decision support (does this number already exist here?) is computed ONCE, in batched
 * findMany calls — a per-row findUnique would be N round trips inside a POST the phone is
 * waiting on, and the review page would otherwise have to re-derive it on every render.
 */
export async function stageContacts(
  organizationId: string,
  sessionId: string,
  contacts: NormalizedContact[],
  /**
   * Entries that yielded no usable number at all. Measured during normalisation, which
   * happens BEFORE staging, so if it is not persisted here it is gone: the apply only ever
   * sees rows that made it into the queue. Losing it made a staged run report zero unusable
   * entries no matter how much junk the address book held.
   */
  unusable = 0,
): Promise<StageResult> {
  let staged = 0;
  let alreadyKnown = 0;

  for (let i = 0; i < contacts.length; i += CHUNK) {
    const chunk = contacts.slice(i, i + CHUNK);
    const phones = chunk.map((c) => c.phoneE164);

    const existing = await withTenant(organizationId, (tx) =>
      tx.contact.findMany({
        where: { organizationId, phoneE164: { in: phones }, deletedAt: null },
        select: { id: true, phoneE164: true },
      }),
    );
    const byPhone = new Map(existing.map((e) => [e.phoneE164, e.id]));

    const written = await withTenant(organizationId, (tx) =>
      tx.contactSyncStagedItem.createMany({
        data: chunk.map((c) => ({
          organizationId,
          sessionId,
          phoneE164: c.phoneE164,
          displayName: c.displayName,
          email: c.email,
          company: c.organization,
          // Included by default. This is a REVIEW, not an approval queue — the tenant
          // asked for these contacts, so the burden is on deselecting the ones they do
          // not want, not on hand-approving 1,200 they already chose to send.
          status: 'included' as const,
          existingContactId: byPhone.get(c.phoneE164) ?? null,
        })),
        skipDuplicates: true,
      }),
    );
    staged += written.count;
    alreadyKnown += chunk.filter((c) => byPhone.has(c.phoneE164)).length;
  }

  await withTenant(organizationId, (tx) =>
    tx.contactSyncSession.updateMany({
      where: { id: sessionId, organizationId },
      data: {
        status: 'review',
        reviewMode: true,
        stagedAt: new Date(),
        // Nothing else on the staged path clears the pairing payload — finishSessionImport,
        // failSessionImport and the reaper all do, and none of them run here. A live
        // WhatsApp pairing code must not sit on the row for a multi-day review window.
        waQr: null,
        contactsReceived: contacts.length,
        contactsSkipped: unusable,
      },
    }),
  );

  return { staged, alreadyKnown };
}

/** The contacts a tenant has left selected, in the shape importContacts expects. */
export async function includedContacts(
  organizationId: string,
  sessionId: string,
): Promise<NormalizedContact[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.contactSyncStagedItem.findMany({
      where: { organizationId, sessionId, status: 'included' },
      select: { phoneE164: true, displayName: true, email: true, company: true },
      orderBy: { phoneE164: 'asc' },
    }),
  );
  return rows.map((r) => ({
    phoneE164: r.phoneE164,
    displayName: r.displayName,
    email: r.email,
    organization: r.company,
  }));
}

/**
 * Clear the staged rows for a session once they have been turned into contacts.
 *
 * importContacts rewrites the ledger from scratch on apply, so the staging rows must go
 * first or the unique (sessionId, phoneE164) index rejects every insert and the apply
 * silently stores nothing.
 */
export async function clearStagedRows(organizationId: string, sessionId: string): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.contactSyncStagedItem.deleteMany({ where: { organizationId, sessionId } }),
  );
}
