// The address-book import itself, split out of contact-sync.ts because it now writes a
// per-row ledger as well as contacts and had outgrown its home.
//
// The DECISION for each row lives in contact-sync-plan.ts, which is pure and tested. This
// file is the impure half: transactions, chunking, and failure isolation.
import type { NormalizedContact } from './contact-sync-normalize.js';
import {
  classifyEntry,
  normalizeSyncLabel,
  syncRunTag,
  type ContactEffect,
} from './contact-sync-plan.js';
import { withTenant, type Tx } from './db.js';

/** Applied to every contact this feature creates, so a bad import is findable + undoable. */
export const PHONE_SYNC_TAG = 'phone-sync';

/** Transaction chunk size — keeps any single write transaction short. */
const CHUNK = 200;

export interface ImportRowResult {
  phoneE164: string;
  effect: ContactEffect;
  contactId: string | null;
  filledDisplayName: string | null;
  filledEmail: string | null;
  displayName: string | null;
  email: string | null;
  company: string | null;
  existingContactId: string | null;
  errorMessage: string | null;
}

export interface ImportOptions {
  marketingAttested: boolean;
  log?: { warn?: (o: unknown, m: string) => void };
  /**
   * When set, a ledger row is written for every contact. That ledger is what makes undo,
   * staged review and the enrichment breakdown possible — all three are readings of the
   * same fact: what did this run do to this number.
   */
  sessionId?: string;
  /**
   * True only on the WhatsApp path, where every harvested JID is a WhatsApp account by
   * construction. NEVER written as false: `whatsappReachable` is nullable precisely so
   * that "never established" stays distinguishable from "checked, and not reachable".
   */
  waReachable?: boolean;
  /**
   * "Whose phone is this?", as typed on the confirm screen. Becomes a second ContactTag on
   * every contact this run CREATES — which is what makes the provenance outlive the session
   * and its ledger, both of which the reaper prunes after 7 days. Without it, a week-old
   * import is indistinguishable from any other: source='phone_sync' and nothing else.
   */
  syncedByLabel?: string | null;
}

/**
 * Upsert normalised contacts for one org.
 *
 * Three deliberate refusals, all enforced by classifyEntry and all of which a naive
 * "just upsert everything" gets wrong in ways invisible until a customer complains:
 *
 *  - `optedOutAt` is NEVER cleared. If someone sent STOP to this business, having their
 *    number still sitting in the owner's phone is not a withdrawal of that STOP.
 *  - `blockedAt` is NEVER cleared, for the same reason on the operator's side.
 *  - Soft-deleted contacts are NOT resurrected. The CSV importer does resurrect them,
 *    which is defensible for a file a human curated for this purpose; it is not
 *    defensible for a bulk address-book dump that would silently undo a deletion.
 *
 * Opt-in is granted ONLY on newly created contacts and ONLY when the tenant attested, so
 * a second sync cannot quietly opt in people imported without it the first time.
 */
export async function importContacts(
  organizationId: string,
  contacts: NormalizedContact[],
  opts: ImportOptions,
): Promise<{ created: number; updated: number; skipped: number; rows: ImportRowResult[] }> {
  const log = opts.log;
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const optedInAt = opts.marketingAttested ? new Date() : null;
  const rows: ImportRowResult[] = [];

  // Derived ONCE, outside the loop: it is a pure function of a value that cannot change
  // mid-run, and it is namespaced so it can never equal PHONE_SYNC_TAG — which matters
  // because both are created in the SAME nested write, and contact_tags is
  // @@unique([contactId, tag]). A collision there would not degrade gracefully: the INSERT
  // fails, the 200-row chunk aborts, the row-by-row retry fails identically, and the whole
  // import lands in skipped_failed. See syncRunTag for the full reasoning.
  const runTag = syncRunTag(opts.syncedByLabel);
  // The SAME cleaner the tag uses. Previously the column took a bare `.trim() || null`, which
  // does not strip format characters — so a label of only RTL marks stored a truthy string,
  // produced no tag, and rendered as a confident empty "from " on the contacts list.
  const runLabel = normalizeSyncLabel(opts.syncedByLabel);

  /**
   * One contact, inside whatever transaction it is handed. Returns a FULL per-row result,
   * not just a bucket, because undo needs the contact id this run produced and the exact
   * fields it filled. Throws on a real write failure so the caller can isolate it.
   */
  async function importOne(tx: Tx, c: NormalizedContact): Promise<ImportRowResult> {
    const existing = await tx.contact.findUnique({
      where: { organizationId_phoneE164: { organizationId, phoneE164: c.phoneE164 } },
      select: {
        id: true,
        displayName: true,
        email: true,
        deletedAt: true,
        whatsappReachable: true,
      },
    });

    const plan = classifyEntry(existing, { displayName: c.displayName, email: c.email });
    const base = {
      phoneE164: c.phoneE164,
      displayName: c.displayName,
      email: c.email,
      company: c.organization,
      existingContactId: existing?.id ?? null,
      filledDisplayName: plan.filledDisplayName,
      filledEmail: plan.filledEmail,
      errorMessage: null,
    };

    if (plan.effect === 'skipped_deleted') {
      return { ...base, effect: 'skipped_deleted', contactId: null };
    }

    // Reachability is new information even for a row nothing else changed, so it fills a
    // gap on every branch — but only a gap. It never flips an established value.
    const fillReach =
      opts.waReachable === true && existing !== null && existing.whatsappReachable === null;

    /**
     * PRESENCE. This number is in THIS phone — true whether or not the run created the row.
     *
     * The case that forces this: Rita syncs and creates the contact, then Sami syncs and the
     * same number is in his book too. Tagging only on create left Sami's sync with no trace
     * at all, so "whose phone is this number in?" answered "Rita" and stopped — true, but
     * half the story. Overwriting the origin instead would have been worse: it would claim
     * Sami introduced them.
     *
     * So presence accumulates as tags (a person really can be in several phones), while
     * ORIGIN below is written once and never touched. Idempotent: contact_tags is
     * @@unique([contactId, tag]), so re-syncing the same phone adds nothing.
     */
    async function tagPresence(contactId: string): Promise<void> {
      if (!runTag) return;
      await tx.contactTag.createMany({
        data: [{ organizationId, contactId, tag: runTag }],
        skipDuplicates: true,
      });
    }

    if (plan.effect === 'unchanged') {
      // Deliberately no write unless reachability is new. The previous shape issued an
      // UPDATE for every row of a re-sync, bumping updatedAt on contacts nothing changed.
      if (fillReach) {
        await tx.contact.update({ where: { id: existing!.id }, data: { whatsappReachable: true } });
      }
      await tagPresence(existing!.id);
      return { ...base, effect: 'unchanged', contactId: existing!.id };
    }

    if (plan.effect === 'updated') {
      await tx.contact.update({
        where: { id: existing!.id },
        data: {
          ...(plan.filledDisplayName !== null ? { displayName: plan.filledDisplayName } : {}),
          ...(plan.filledEmail !== null ? { email: plan.filledEmail } : {}),
          ...(fillReach ? { whatsappReachable: true } : {}),
        },
      });
      await tagPresence(existing!.id);
      return { ...base, effect: 'updated', contactId: existing!.id };
    }

    const row = await tx.contact.create({
      data: {
        organizationId,
        phoneE164: c.phoneE164,
        displayName: c.displayName,
        email: c.email,
        source: 'phone_sync',
        optedInAt,
        whatsappReachable: opts.waReachable === true ? true : null,
        // ORIGIN — who first brought this person in. Only ever set here, on create, so it can
        // never be rewritten by a later sync from a different phone. Survives a tag edit,
        // which the matching tag does not: PATCH /contacts/:id replace-sets tags.
        syncedFromLabel: runLabel,
        syncedFromSessionId: opts.sessionId ?? null,
        attributes: (c.organization ? { company: c.organization } : {}) as never,
        // Tag every row so a bad import is findable and reversible with UI that already
        // exists. Without it, an address book normalised under the wrong dial code is
        // 1,200 rows a tenant can only delete one at a time.
        //
        // The run tag rides alongside, never instead of, PHONE_SYNC_TAG: planRevert gates
        // undo eligibility on hasPhoneSyncTag, so replacing it would quietly make every
        // contact of a labelled run un-undoable.
        //
        // CREATED rows only, matching PHONE_SYNC_TAG. A run that merely filled a missing
        // name on someone's existing customer did not put that person in the address book,
        // and tagging them "Phone: Rita's iPhone" would claim it did.
        tags: {
          create: [
            { organizationId, tag: PHONE_SYNC_TAG },
            ...(runTag ? [{ organizationId, tag: runTag }] : []),
          ],
        },
      },
      select: { id: true },
    });
    return { ...base, effect: 'created', contactId: row.id };
  }

  const bump = (r: ImportRowResult) => {
    rows.push(r);
    if (r.effect === 'created') created += 1;
    else if (r.effect === 'updated') updated += 1;
    // 'unchanged' counts as neither. contactsUpdated keeps the meaning it shipped with —
    // redefining a tenant-visible number mid-flight would make the dialog read
    // "Updated 412 / Named 3". `unchanged` is reported as its own bucket instead.
    else if (r.effect !== 'unchanged') skipped += 1;
  };

  /** Ledger rows, written INSIDE the same transaction as the contact writes. */
  async function writeLedger(tx: Tx, batch: ImportRowResult[]): Promise<void> {
    if (!opts.sessionId || batch.length === 0) return;
    await tx.contactSyncStagedItem.createMany({
      data: batch.map((r) => ({
        organizationId,
        sessionId: opts.sessionId!,
        phoneE164: r.phoneE164,
        displayName: r.displayName,
        email: r.email,
        company: r.company,
        status: r.effect === 'skipped_failed' ? ('failed' as const) : ('applied' as const),
        existingContactId: r.existingContactId,
        effect: r.effect,
        contactId: r.contactId,
        filledDisplayName: r.filledDisplayName,
        filledEmail: r.filledEmail,
        errorMessage: r.errorMessage,
        appliedAt: new Date(),
      })),
      skipDuplicates: true,
    });
  }

  for (let i = 0; i < contacts.length; i += CHUNK) {
    const chunk = contacts.slice(i, i + CHUNK);

    // Fast path: the whole chunk in one transaction.
    //
    // The original shape put a per-row `catch { skipped++ }` INSIDE this transaction,
    // which isolates nothing: Postgres aborts the entire transaction on the first error,
    // every later row fails 25P02 and is miscounted as "skipped", and rows already counted
    // as created are rolled back — while COMMIT on an aborted transaction returns ROLLBACK
    // without throwing. The reported numbers were of work that did not persist.
    try {
      const results = await withTenant(organizationId, async (tx) => {
        const out: ImportRowResult[] = [];
        for (const c of chunk) out.push(await importOne(tx, c));
        // Same transaction as the writes above: if the chunk rolls back so does its
        // ledger, and the two can never disagree about what happened.
        await writeLedger(tx, out);
        return out;
      });
      results.forEach(bump);
    } catch (err) {
      // Slow path, only for a chunk that actually failed: retry row-by-row in its own
      // transaction so one bad contact costs one contact instead of two hundred.
      log?.warn?.(
        { err, chunkStart: i, chunkSize: chunk.length },
        '[contact-sync] chunk failed — retrying row by row',
      );
      for (const c of chunk) {
        try {
          const r = await withTenant(organizationId, async (tx) => {
            const one = await importOne(tx, c);
            await writeLedger(tx, [one]);
            return one;
          });
          bump(r);
        } catch (rowErr) {
          // A genuine per-row failure. Logged and recorded as its own bucket — a systemic
          // problem must not be indistinguishable from address-book noise.
          log?.warn?.({ err: rowErr, phone: c.phoneE164 }, '[contact-sync] contact failed');
          const failed: ImportRowResult = {
            phoneE164: c.phoneE164,
            effect: 'skipped_failed',
            contactId: null,
            filledDisplayName: null,
            filledEmail: null,
            displayName: c.displayName,
            email: c.email,
            company: c.organization,
            existingContactId: null,
            errorMessage: rowErr instanceof Error ? rowErr.message.slice(0, 200) : 'unknown',
          };
          bump(failed);
          // Best effort, in its own transaction since the row's own one is gone.
          if (opts.sessionId) {
            await withTenant(organizationId, (tx) => writeLedger(tx, [failed])).catch(() => {});
          }
        }
      }
    }
  }

  return { created, updated, skipped, rows };
}
