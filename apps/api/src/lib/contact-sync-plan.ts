// Pure decision logic for "Sync contacts with phone".
//
// Everything here is a pure function of its arguments. It imports nothing that touches env
// or the database (only @platform/shared, which is Zod + constants) — so it can be executed
// by a test runner with no Postgres, no Redis and no configured environment.
//
// That is not stylistic. apps/api/vitest.config.ts applies test/setup.ts as a GLOBAL
// setupFile, and that file imports the server, which imports env.ts, which calls
// process.exit(1) on a missing variable. So the ordinary test suite cannot run on a
// developer machine at all. Combined with tsconfig.json excluding test/ from tsc, a
// broken test file passed every local check and only failed in CI — which has already
// happened once on this feature. This module plus vitest.pure.config.ts is the seam that
// makes the rules below verifiable before a push.
//
// The rules themselves were previously inline in importContacts, where nothing tested
// them and their comments were the only specification.

/** What a single address-book entry did to the contacts table. */
export type ContactEffect =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'skipped_deleted'
  | 'skipped_failed';

/** The subset of an existing Contact row the decision depends on. */
export interface ExistingContact {
  id: string;
  displayName: string | null;
  email: string | null;
  deletedAt: Date | null;
}

export interface IncomingContact {
  displayName: string | null;
  email: string | null;
}

export interface EntryPlan {
  effect: Extract<ContactEffect, 'created' | 'updated' | 'unchanged' | 'skipped_deleted'>;
  /** The name this run supplied, when it filled a gap. Null when it changed nothing. */
  filledDisplayName: string | null;
  /** The email this run supplied, when it filled a gap. */
  filledEmail: string | null;
}

/**
 * Decide what to do with one entry.
 *
 * Encodes the three refusals that were previously comments in importContacts:
 *  - a soft-deleted contact is NOT resurrected (the CSV importer does that; defensible
 *    for a file a human curated, not for a bulk address-book dump),
 *  - an existing name set by the operator outranks whatever the address book calls them,
 *  - the same for email.
 *
 * `unchanged` matters for two reasons: it lets the caller skip a pointless UPDATE that
 * would bump updatedAt on every row of a re-sync, and it is the honest bucket for "you
 * already had this person, with a better name than the phone has".
 */
export function classifyEntry(
  existing: ExistingContact | null,
  incoming: IncomingContact,
): EntryPlan {
  if (!existing) {
    return {
      effect: 'created',
      filledDisplayName: incoming.displayName,
      filledEmail: incoming.email,
    };
  }
  if (existing.deletedAt) {
    return { effect: 'skipped_deleted', filledDisplayName: null, filledEmail: null };
  }

  // Only ever NULL -> value. Never value -> different value. This is what makes the undo
  // field-revert safe without storing a snapshot: the prior value is provably null.
  const fillsName = existing.displayName === null && incoming.displayName !== null;
  const fillsEmail = existing.email === null && incoming.email !== null;

  if (!fillsName && !fillsEmail) {
    return { effect: 'unchanged', filledDisplayName: null, filledEmail: null };
  }
  return {
    effect: 'updated',
    filledDisplayName: fillsName ? incoming.displayName : null,
    filledEmail: fillsEmail ? incoming.email : null,
  };
}

/** Above this many contacts, a sync is reviewed before it lands. */
export const STAGE_THRESHOLD = 50;

/**
 * Should this sync be staged for review rather than imported straight away?
 *
 * `attested` always stages, regardless of size. Ticking the attestation box sets
 * optedInAt on every created row, which makes the entire address book eligible for
 * broadcasts — the one action in this feature that is hard to walk back and that reaches
 * real people. The cost of that choice is one extra screen on a 12-contact attested sync,
 * carrying an "Add all 12" button.
 */
export function shouldStageSync(args: {
  count: number;
  attested: boolean;
  requested?: boolean;
}): boolean {
  return args.requested === true || args.attested || args.count > STAGE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Provenance: "whose phone was this?"
// ---------------------------------------------------------------------------

/**
 * Namespace for the per-run provenance tag.
 *
 * PREFIXED, not raw, and that is load-bearing rather than cosmetic. The label is free text a
 * tenant types, and it is turned into a ContactTag — so an unprefixed label collides with
 * tags that already carry MEANING:
 *
 *  · 'phone-sync' — PHONE_SYNC_TAG is created on the same row in the same nested write, and
 *    contact_tags is @@unique([contactId, tag]). A tenant typing "phone-sync" would make
 *    every INSERT violate that constraint, fail the 200-row chunk, fail again row-by-row,
 *    and land the entire import in skipped_failed. One typed string, whole sync destroyed.
 *  · 'unsubscribed' — trigger-maintained (migration 20260804150000) to mirror
 *    contacts.opted_out_at. The AFTER INSERT trigger runs BEFORE Prisma's nested tag insert,
 *    so its cleanup DELETE cannot see the row we are about to add: the bogus tag survives,
 *    and every imported contact renders as unsubscribed on /contacts while opted_out_at is
 *    NULL — reviving exactly the visible-vs-authoritative drift that migration exists to end.
 *
 * A prefix makes both impossible by construction, and keeps working for any reserved tag
 * invented later. It also groups every run together in the tag facet list, and reads as a
 * sentence in the filter dropdown ("Phone: Rita's iPhone").
 */
export const SYNC_RUN_TAG_PREFIX = 'Phone: ';

/**
 * Ceiling every tag route in contacts.routes.ts enforces. Exceed it and the tag exists but
 * can never be filtered for through the API that created it.
 */
export const MAX_CONTACT_TAG_CHARS = 40;

/**
 * Derive the per-run tag from the typed label, or null when there is nothing to record.
 *
 * Null in, null out — deliberately. A blank label must produce NO tag rather than an empty
 * or placeholder one: "not recorded" is a true statement and a tag reading "Phone: " is not.
 */
/**
 * The one cleaner both halves of provenance go through.
 *
 * Extracted because the column and the tag were cleaning differently: the tag ran the
 * control/format strip below, while the stored column used a bare `.trim() || null`. A label
 * of nothing but RTL marks — which Arabic-locale keyboards emit constantly — is NOT stripped
 * by String.trim(), so it survived as a truthy string, produced NO tag, and rendered on the
 * contacts list as a confident, empty `from ` with an invisible character after it. Same
 * input, two answers, and the visible one was the wrong one.
 *
 * Control and format characters become spaces, then runs of whitespace collapse, so two
 * labels that look identical can never split one run across two filter buckets.
 */
export function normalizeSyncLabel(label: string | null | undefined): string | null {
  if (typeof label !== 'string') return null;
  const cleaned = label
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * The provenance label for a WhatsApp run whose tenant typed nothing.
 *
 * THE MIDDLE PATH between the two bad options. Storing the full linked number on every
 * contact would denormalise a staff member's personal mobile across up to 5,000 rows and turn
 * an erasure request into a fleet-wide scrub; storing nothing throws away the only provenance
 * this product ever MEASURES rather than accepts on trust, since the session holding it is
 * pruned after 7 days.
 *
 * Last four digits only. Enough to tell one linked phone from another — which is the actual
 * question ("was this the shop phone or Rita's?") — and not enough to be a dialable number.
 * Self-evidently machine-written, so it never reads as something a human typed.
 *
 * Returns null below 4 digits: linkedPhone is nullish on the wire and can arrive as '', and a
 * label reading "WhatsApp ending" would be worse than no label at all.
 */
export function whatsappFallbackLabel(linkedPhone: string | null | undefined): string | null {
  if (typeof linkedPhone !== 'string') return null;
  const digits = linkedPhone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `WhatsApp ending ${digits.slice(-4)}`;
}

export function syncRunTag(label: string | null | undefined): string | null {
  const cleaned = normalizeSyncLabel(label);
  if (cleaned === null) return null;

  const tag = `${SYNC_RUN_TAG_PREFIX}${cleaned}`;
  if (tag.length <= MAX_CONTACT_TAG_CHARS) return tag;

  // Zod caps the label below this, so overflow only reaches here from a direct caller — but
  // it has to be right, and the obvious two spellings are both wrong:
  //
  //   tag.slice(0, MAX)                    — splits a surrogate pair, leaving a lone
  //                                          surrogate that Postgres rejects outright, so a
  //                                          too-long name becomes a FAILED WRITE.
  //   [...tag].slice(0, MAX).join('')      — slices by CODE POINT while the limit is counted
  //                                          in UTF-16 units, so 40 emoji yields an 80-char
  //                                          tag: over the cap the API filters by.
  //
  // Walk code points, stop before the budget is exceeded. Both properties hold at once.
  let out = '';
  for (const ch of tag) {
    if (out.length + ch.length > MAX_CONTACT_TAG_CHARS) break;
    out += ch;
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Why a contact created by a run was kept rather than removed by undo. */
export type RevertKeepReason =
  | 'gone'
  | 'messaged'
  | 'opted_out'
  | 'blocked'
  | 'in_sequence'
  | 'untagged'
  | 'renamed';

export interface RevertLedgerRow {
  contactId: string | null;
  effect: ContactEffect;
  filledDisplayName: string | null;
  filledEmail: string | null;
}

/** The subset of a Contact that decides whether undo may remove it. */
export interface RevertCurrentContact {
  id: string;
  displayName: string | null;
  email: string | null;
  lastInboundAt: Date | null;
  optedOutAt: Date | null;
  blockedAt: Date | null;
  hasPhoneSyncTag: boolean;
  hasSequenceEnrollment: boolean;
}

export type RevertAction =
  | { action: 'delete' }
  | { action: 'revert_fields'; clearDisplayName: boolean; clearEmail: boolean }
  | { action: 'keep'; reason: RevertKeepReason }
  | { action: 'noop' };

/**
 * What undo should do with one ledger row.
 *
 * The governing rule: undo reverses THIS RUN, not the customer relationship that may have
 * formed since. A contact who has messaged the business, opted out, been blocked, been
 * enrolled in a sequence, or been edited by the operator has acquired a life of its own,
 * and deleting it would destroy real information to tidy up an import.
 *
 * Rows this run merely UPDATED are never deleted — it did not create them. Their filled
 * fields are reverted only when still exactly what the run wrote, so an operator's later
 * edit survives.
 */
export function planRevert(
  row: RevertLedgerRow,
  current: RevertCurrentContact | null,
): RevertAction {
  // Never created or touched anything reversible.
  if (row.effect === 'unchanged' || row.effect === 'skipped_deleted' || row.effect === 'skipped_failed') {
    return { action: 'noop' };
  }
  // Already deleted by someone else. Not an error — the outcome undo wanted.
  if (!current || !row.contactId) return { action: 'keep', reason: 'gone' };

  if (row.effect === 'updated') {
    const clearDisplayName =
      row.filledDisplayName !== null && current.displayName === row.filledDisplayName;
    const clearEmail = row.filledEmail !== null && current.email === row.filledEmail;
    if (!clearDisplayName && !clearEmail) return { action: 'keep', reason: 'renamed' };
    return { action: 'revert_fields', clearDisplayName, clearEmail };
  }

  // effect === 'created' — the only case undo may delete.
  if (current.lastInboundAt) return { action: 'keep', reason: 'messaged' };
  if (current.optedOutAt) return { action: 'keep', reason: 'opted_out' };
  if (current.blockedAt) return { action: 'keep', reason: 'blocked' };
  if (current.hasSequenceEnrollment) return { action: 'keep', reason: 'in_sequence' };
  // The tag is gone, so the row was merged or deliberately re-tagged by the operator.
  if (!current.hasPhoneSyncTag) return { action: 'keep', reason: 'untagged' };
  // Renamed after import — the operator invested in this contact.
  if (row.filledDisplayName !== null && current.displayName !== row.filledDisplayName) {
    return { action: 'keep', reason: 'renamed' };
  }
  return { action: 'delete' };
}

// The tenant-facing copy lives in @platform/shared (summarizeContactSync), because the
// desktop dialog and the phone page both render it and neither can import from
// apps/api. Re-exported here so this module stays the single home for sync decisions.
export {
  summarizeContactSync,
  type ContactSyncStats,
  type SyncSummaryLine,
} from '@platform/shared';
