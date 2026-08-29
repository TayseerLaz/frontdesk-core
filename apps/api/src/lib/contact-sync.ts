// "Sync contacts with phone" — session lifecycle + the address-book import itself.
//
// The trust model, because it is unusual for this codebase: the device that posts the
// contacts is NOT logged in. A phone scanning a QR has no session cookie and no JWT, so
// the token carried in the QR *is* the credential. That is only acceptable because the
// token is 32 random bytes, stored only as a SHA-256, single-use, and dead in minutes.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  CONTACT_SYNC_ATTESTATION_TEXT,
  CONTACT_SYNC_ATTESTATION_VERSION,
  contactSyncTtlMinutes,
  type ContactSyncDeviceKind,
  type ContactSyncStatus as ContactSyncStatusValue,
} from '@platform/shared';

// Re-exported so callers keep importing pure + impure halves from one place, while the
// pure half stays independently testable (no env/db in its import graph).
export {
  buildPhoneSyncUrl,
  entriesFromVCard,
  normalizeEntries,
  type NormalizedContact,
  type NormalizeSummary,
  type RawEntry,
} from './contact-sync-normalize.js';
import { withRlsBypass, withTenant } from './db.js';

export interface MintedToken {
  token: string;
  tokenSha256: string;
}

export function hashSyncToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintSyncToken(): MintedToken {
  // base64url of 32 bytes — URL-safe, so it survives being embedded in a QR payload
  // without percent-encoding, which some phone camera apps handle badly.
  const token = randomBytes(32).toString('base64url');
  return { token, tokenSha256: hashSyncToken(token) };
}

/** Constant-time compare so a token lookup cannot be narrowed by timing. */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function syncExpiryFrom(now: Date, kind: ContactSyncDeviceKind): Date {
  return new Date(now.getTime() + contactSyncTtlMinutes(kind) * 60_000);
}

export const CONTACT_SYNC_ATTESTATION_RECORD = `${CONTACT_SYNC_ATTESTATION_VERSION}\n${CONTACT_SYNC_ATTESTATION_TEXT}`;

export interface SyncSessionRow {
  id: string;
  organizationId: string;
  status: string;
  deviceKind: string;
  defaultDialCode: string | null;
  marketingAttestedAt: Date | null;
  /** "Whose phone is this?" — typed on the confirm screen. Null when left blank. */
  syncedByLabel: string | null;
  expiresAt: Date;
}

/**
 * Resolve a presented token to its session. Runs under RLS bypass because there is no
 * org context yet — the token is what establishes it. Returns null for unknown,
 * expired, or already-consumed tokens without distinguishing between them.
 */
export async function resolveSyncSession(token: string): Promise<SyncSessionRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const tokenSha256 = hashSyncToken(token);

  const row = await withRlsBypass((tx) =>
    tx.contactSyncSession.findUnique({
      where: { tokenSha256 },
      select: {
        id: true,
        organizationId: true,
        status: true,
        deviceKind: true,
        defaultDialCode: true,
        marketingAttestedAt: true,
        syncedByLabel: true,
        expiresAt: true,
        completedAt: true,
      },
    }),
  );

  if (!row) return null;
  // Terminal states are not re-enterable: a completed session must not accept a second
  // upload, which is what makes the token single-use in practice.
  if (row.status !== 'pending' && row.status !== 'opened') return null;
  // completedAt is stamped the moment an import is CLAIMED, before it finishes. Checking
  // it here is what makes the claim single-use even while status is still 'opened'.
  if (row.completedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

export interface ImportOutcome {
  received: number;
  created: number;
  updated: number;
  skipped: number;
}

// The import itself now lives in contact-sync-import.ts — it writes a per-row ledger
// as well as contacts, and had outgrown this file. Re-exported so every existing
// caller keeps a single import site.
export {
  importContacts,
  PHONE_SYNC_TAG,
  type ImportRowResult,
  type ImportOptions,
} from './contact-sync-import.js';

export function serializeSyncSession(row: {
  id: string;
  status: string;
  deviceKind: string;
  defaultDialCode: string | null;
  waQr: string | null;
  waPhone: string | null;
  marketingAttestedAt: Date | null;
  syncedByLabel: string | null;
  expiresAt: Date;
  openedAt: Date | null;
  completedAt: Date | null;
  importedAt?: Date | null;
  failureReason: string | null;
  contactsReceived: number;
  contactsCreated: number;
  contactsUpdated: number;
  contactsSkipped: number;
  revertedAt?: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    status: row.status as ContactSyncStatusValue,
    deviceKind: row.deviceKind as ContactSyncDeviceKind,
    defaultDialCode: row.defaultDialCode,
    waQr: row.waQr,
    waPhone: row.waPhone,
    marketingAttested: row.marketingAttestedAt !== null,
    // Passed through verbatim, including null. The client renders null as "Not recorded" —
    // it must never be backfilled here from the session's creator, which is a different fact.
    syncedByLabel: row.syncedByLabel,
    expiresAt: row.expiresAt.toISOString(),
    openedAt: row.openedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    importedAt: row.importedAt?.toISOString() ?? null,
    failureReason: row.failureReason,
    contactsReceived: row.contactsReceived,
    contactsCreated: row.contactsCreated,
    contactsUpdated: row.contactsUpdated,
    contactsSkipped: row.contactsSkipped,
    // Filled in by the poll route from the ledger; null for sessions predating it.
    breakdown: null as null | {
      named: number;
      unchanged: number;
      skippedUnusable: number;
      skippedDeleted: number;
      skippedFailed: number;
      waReachable: number;
    },
    undoableCount: null as number | null,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Claim a session for import. Atomic, single-use, and — importantly — does NOT yet say
 * "completed".
 *
 * The first shipped version set status='completed' here and wrote the counts in a later
 * transaction. The desktop polls every 2s and jumps to its done screen on the first
 * sighting of 'completed', which stops the poll; for any import longer than one poll
 * interval (~1,000 contacts, since each is two serial round trips) the tenant was left
 * staring at "Added 0 / Updated 0 / Skipped 0" permanently, while their phone showed the
 * true numbers. Two screens, contradicting each other, no way to refresh.
 *
 * So: claim by stamping completedAt, finish by writing status + counts together.
 */
export async function claimSessionForImport(
  organizationId: string,
  sessionId: string,
): Promise<boolean> {
  const claimed = await withTenant(organizationId, (tx) =>
    tx.contactSyncSession.updateMany({
      where: {
        id: sessionId,
        organizationId,
        status: { in: ['pending', 'opened'] },
        completedAt: null,
      },
      data: { completedAt: new Date() },
    }),
  );
  return claimed.count > 0;
}

/** Publish the result. 'completed' and the counts land in ONE write, or neither does. */
export async function finishSessionImport(
  organizationId: string,
  sessionId: string,
  result: { received: number; created: number; updated: number; skipped: number },
): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.contactSyncSession.updateMany({
      where: { id: sessionId, organizationId },
      data: {
        status: 'completed',
        waQr: null,
        // The undo clock starts HERE, not when the QR was minted — a staged run may have sat
        // in review for days, and measuring from createdAt made the on-screen "7 days"
        // promise false by exactly that long.
        importedAt: new Date(),
        contactsReceived: result.received,
        contactsCreated: result.created,
        contactsUpdated: result.updated,
        contactsSkipped: result.skipped,
      },
    }),
  );
}

/**
 * Publish a failure. Without this an import that threw left the row 'opened' with
 * completedAt set — invisible to both the poll and the reaper, and the tenant's token
 * burned with no explanation.
 */
export async function failSessionImport(
  organizationId: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.contactSyncSession.updateMany({
      where: { id: sessionId, organizationId },
      data: { status: 'failed', failureReason: reason.slice(0, 200), waQr: null },
    }),
  );
}

/**
 * The enrichment breakdown, derived from the ledger rather than stored as columns.
 *
 * Six counter columns were proposed and cut: every number here is a groupBy over rows we
 * already write, both prune on the same schedule, so the columns bought nothing but
 * schema creep on a table three features already touch.
 */
export async function sessionBreakdown(
  organizationId: string,
  sessionId: string,
  /**
   * The session's TOTAL `contactsSkipped`, not the unusable count on its own.
   *
   * Callers only have the total, and the previous signature asked for the unusable count
   * while every call site handed it that total — so entries skipped as deleted-or-failed
   * were counted twice: once inside "N entries had no usable phone number" and again in
   * their own line. A 3-unusable/2-deleted run read as 5 unusable + 2 deleted.
   *
   * This function is the one place that knows the deleted and failed counts, so the
   * subtraction belongs here rather than at three call sites that would each have to
   * re-derive it.
   */
  totalSkipped: number,
): Promise<{
  breakdown: {
    named: number;
    unchanged: number;
    skippedUnusable: number;
    skippedDeleted: number;
    skippedFailed: number;
    waReachable: number;
  };
  undoableCount: number;
} | null> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.contactSyncStagedItem.findMany({
      where: { sessionId, organizationId },
      select: { effect: true, filledDisplayName: true, contactId: true, revertedAt: true },
    }),
  );
  if (rows.length === 0) return null;

  // How many of this run's contacts are known-reachable on WhatsApp. Read from the
  // contacts themselves rather than inferred from the device kind, so a re-sync of the
  // same book by a different route still reports the truth.
  const ids = rows.map((r) => r.contactId).filter((id): id is string => id !== null);
  const waReachable =
    ids.length === 0
      ? 0
      : await withTenant(organizationId, (tx) =>
          tx.contact.count({
            where: { id: { in: ids }, organizationId, whatsappReachable: true },
          }),
        );

  let named = 0;
  let unchanged = 0;
  let skippedDeleted = 0;
  let skippedFailed = 0;
  let undoableCount = 0;

  for (const r of rows) {
    if (r.filledDisplayName !== null) named += 1;
    if (r.effect === 'unchanged') unchanged += 1;
    else if (r.effect === 'skipped_deleted') skippedDeleted += 1;
    else if (r.effect === 'skipped_failed') skippedFailed += 1;
    // Undo can only remove what this run CREATED, and only while not already reverted.
    if (r.effect === 'created' && r.contactId !== null && r.revertedAt === null) undoableCount += 1;
  }

  return {
    breakdown: {
      named,
      unchanged,
      skippedDeleted,
      skippedFailed,
      // Entries with no usable number never reach the ledger — they are dropped during
      // normalisation, so they can only be inferred: whatever the session counted as
      // skipped, minus the skips the ledger can account for. Clamped at zero so a
      // pre-existing row with inconsistent counters degrades to "none" rather than to a
      // negative number rendered as "-2 entries had no usable phone number".
      skippedUnusable: Math.max(0, totalSkipped - skippedDeleted - skippedFailed),
      waReachable,
    },
    undoableCount,
  };
}
