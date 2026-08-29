import { z } from 'zod';

import { uuidSchema } from './common.js';

/**
 * "Sync contacts with phone" — the tenant pushes their own address book into Hader
 * from the device that holds it, mediated by a QR code shown in the portal.
 *
 * The desktop mints a session and renders its token as a QR. The tenant's phone opens
 * that token in a browser and posts contacts back. The phone is NOT logged in, so the
 * token IS the credential — hence the short TTL, the single-use status machine, and
 * storing only the token's SHA-256.
 */

/**
 * Short by design. The QR is on screen in front of the person who will scan it; there
 * is no legitimate reason for the credential to outlive that moment, and a leaked
 * screenshot in a support thread should be inert by the time anyone reads it.
 */
export const CONTACT_SYNC_TTL_MINUTES = 15;

/**
 * How long a session lives, by path. 15 minutes was sized for the Android picker, which
 * takes about twenty seconds end to end. The iOS path tells the tenant to leave the page,
 * open Contacts, find an Export menu they have never used, save to Files and come back;
 * the WhatsApp path is a multi-screen trip through Linked devices. A first-timer will
 * blow fifteen minutes on either, and discovers it only after doing all the work.
 */
export function contactSyncTtlMinutes(kind: ContactSyncDeviceKind): number {
  return kind === 'android' ? CONTACT_SYNC_TTL_MINUTES : 30;
}

/**
 * How long a finished sync can still be undone — and therefore how long its per-row
 * ledger is kept.
 *
 * ONE constant, imported by BOTH the revert route and the reaper, deliberately. If the
 * button's window and the data's retention were separate numbers they would drift, and
 * the failure is silent: the tenant clicks Undo and gets a 404 on a run whose rows were
 * pruned an hour earlier.
 */
export const CONTACT_SYNC_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Upper bound on one sync. Comfortably above a large personal address book. */
export const CONTACT_SYNC_MAX_CONTACTS = 5_000;

/**
 * Cap on .vcf text. A 5,000-contact export is ~1 MB once photos are gone, so this is
 * generous — but it is deliberately BELOW the route's own bodyLimit so an oversized
 * upload fails as a readable validation error instead of a bare 413 with no explanation.
 *
 * Photos are the reason this needs saying: an iOS "export all contacts" embeds every
 * contact photo as base64 and can exceed 50 MB. The phone page strips PHOTO/LOGO before
 * uploading — smaller, and we have no business receiving people's faces.
 */
export const CONTACT_SYNC_MAX_VCARD_CHARS = 6_000_000;

export const contactSyncDeviceKindSchema = z.enum(['android', 'ios', 'whatsapp']);
export type ContactSyncDeviceKind = z.infer<typeof contactSyncDeviceKindSchema>;

/**
 * The WhatsApp path is materially different from the other two and needs saying so.
 *
 * android/ios hand the tenant a QR that opens a web page; the phone's OS decides what is
 * shared and we never hold a credential. 'whatsapp' links their account as a device via
 * an unofficial client, which (a) can get that number banned by WhatsApp, (b) consumes
 * one of their four linked-device slots, and (c) means the contact list arrives from
 * WhatsApp rather than from a picker they controlled.
 *
 * The sales-scan feature in this repo had its ban-risk paragraph quietly deleted from the
 * consent copy while the code kept the risk. Do not repeat that here: if the mechanism
 * changes, change this text and bump the version.
 *
 * RULE: any edit must bump CONTACT_SYNC_WA_NOTICE_VERSION.
 */
export const CONTACT_SYNC_WA_NOTICE_VERSION = '2026-08-03.1';

export const CONTACT_SYNC_WA_NOTICE_TEXT = [
  'Linking WhatsApp connects your account to Hader as an extra device, the same way',
  'WhatsApp Web does — but through an unofficial connection.',
  '',
  'Before you continue:',
  '- WhatsApp does not officially allow this, and in rare cases it can suspend the number.',
  '- It uses one of your four linked-device slots. We release it as soon as we are done.',
  '- We read your contact list only. We do not read, send, or store any messages.',
  '- We unlink automatically the moment your contacts have been copied, usually under a minute.',
].join('\n');

export const contactSyncStatusSchema = z.enum([
  'pending',
  'opened',
  // 'review' = staged, waiting for the tenant. 'importing' = an apply is in flight.
  // BOTH must be listed here: the route serializer .parse()s every reply, so a status the
  // Zod enum does not know about 500s the very poll the review page depends on.
  'review',
  'importing',
  'completed',
  'expired',
  'failed',
]);
export type ContactSyncStatus = z.infer<typeof contactSyncStatusSchema>;

/**
 * The marketing attestation. Stored verbatim on the session row when ticked, so the
 * claim the tenant made is reproducible later.
 *
 * RULE: any edit here must bump CONTACT_SYNC_ATTESTATION_VERSION. This is the same
 * discipline as SALES_SCAN_CONSENT_VERSION — the point of keeping the text in a
 * constant rather than in TSX is that the record survives a UI reword.
 */
export const CONTACT_SYNC_ATTESTATION_VERSION = '2026-08-03.1';

export const CONTACT_SYNC_ATTESTATION_TEXT = [
  'I confirm these contacts agreed to receive messages from my business.',
  '',
  'Ticking this marks every imported contact as opted in, which makes them eligible for',
  'broadcast campaigns. An address book on its own is not consent: if these people simply',
  'have my number, leave this unticked. They can still be messaged individually, and they',
  'become broadcast-eligible as soon as they message you first.',
].join('\n');

/** A dial code is digits only, no '+' (e.g. '961'). */
export const dialCodeSchema = z
  .string()
  .regex(/^\d{1,4}$/, 'Dial code must be 1-4 digits, without a "+".');

/**
 * Cap on the "whose phone is this?" label.
 *
 * 32, not 40, deliberately: the label becomes a ContactTag, and every tag route in
 * contacts.routes.ts caps `tag` at 40 chars. Leaving headroom means the tag can never be
 * the thing that fails — a label the tenant typed and saw accepted must not then vanish
 * because the derived tag was one character too long.
 */
export const CONTACT_SYNC_LABEL_MAX_CHARS = 32;

/**
 * Who/what phone this run came from, as typed by the person minting the QR.
 *
 * An ASSERTION, never a measurement. The android/ios phone is unauthenticated and never
 * identifies itself, so no path except WhatsApp can observe a device identity — which is
 * exactly why this is free text rather than something we pretend to derive. It is optional,
 * and absent must render as "not recorded" rather than as a guess.
 *
 * The question the UI asks is "Whose phone is this?", NOT "your name": the person clicking
 * on the desktop is frequently not the person holding the phone, and prefilling the session
 * user's name into a field labelled as the author would manufacture a confident wrong
 * answer — the failure mode this codebase keeps re-learning.
 */
export const contactSyncLabelSchema = z.string().trim().min(1).max(CONTACT_SYNC_LABEL_MAX_CHARS);

export const createContactSyncSessionBodySchema = z.object({
  deviceKind: contactSyncDeviceKindSchema,
  /**
   * Applied to LOCAL-format numbers, which is how address books actually store them.
   * Optional: without it, locally-formatted entries are skipped rather than guessed at.
   */
  defaultDialCode: dialCodeSchema.nullish(),
  /** Whether the tenant ticked the attestation above. Drives opt-in on import. */
  marketingAttested: z.boolean().default(false),
  /** Free-text provenance label. See contactSyncLabelSchema — an assertion, not a fact. */
  syncedByLabel: contactSyncLabelSchema.nullish(),
});
export type CreateContactSyncSessionBody = z.input<typeof createContactSyncSessionBodySchema>;

/** What the portal gets back. `token` and `url` are present ONLY on creation. */
export const contactSyncSessionSchema = z.object({
  id: uuidSchema,
  status: contactSyncStatusSchema,
  deviceKind: contactSyncDeviceKindSchema,
  defaultDialCode: z.string().nullable(),
  marketingAttested: z.boolean(),
  /**
   * "Whose phone is this?", as typed on the confirm screen. NULL means the tenant left it
   * blank — render that as "Not recorded", never as the session user's name. The person who
   * minted the QR is already known separately (createdByUserId); conflating the two is what
   * would turn an honest blank into a confident lie.
   */
  syncedByLabel: z.string().nullable(),
  /** WhatsApp pairing payload, present only while a 'whatsapp' session awaits a scan. */
  waQr: z.string().nullable(),
  /** The number that got linked, once known. */
  waPhone: z.string().nullable(),
  expiresAt: z.string(),
  openedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /**
   * When the contacts actually landed. The undo countdown must be measured from THIS, not
   * from createdAt — a staged run can sit in review for days, and counting from the QR mint
   * showed "7 days" to someone who really had two. Null on runs imported before this
   * existed; clients fall back to createdAt for those.
   */
  importedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  contactsReceived: z.number().int(),
  contactsCreated: z.number().int(),
  contactsUpdated: z.number().int(),
  contactsSkipped: z.number().int(),
  /**
   * Derived from the per-row ledger, not stored as columns. `contactsUpdated` keeps its
   * shipped meaning (matched an existing live contact); `unchanged` is a new sibling, not
   * a redefinition — changing a tenant-visible number's meaning mid-flight would make the
   * dialog read "Updated 412 / Named 3".
   */
  breakdown: z
    .object({
      named: z.number().int(),
      unchanged: z.number().int(),
      skippedUnusable: z.number().int(),
      skippedDeleted: z.number().int(),
      skippedFailed: z.number().int(),
      waReachable: z.number().int(),
    })
    .nullable(),
  /** Rows this run created that undo could still remove. Null once out of the window. */
  undoableCount: z.number().int().nullable(),
  revertedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ContactSyncSession = z.infer<typeof contactSyncSessionSchema>;

export const createContactSyncSessionResponseSchema = contactSyncSessionSchema.extend({
  /** Returned exactly once. Only its SHA-256 is persisted. */
  token: z.string(),
  /**
   * The URL encoded into the QR — android/ios only. Null for 'whatsapp', where the QR is
   * a WhatsApp pairing payload that arrives asynchronously on waQr instead.
   */
  url: z.string().nullable(),
});

/**
 * What the unauthenticated phone is allowed to learn from a valid token. Deliberately
 * minimal: enough to render a trustworthy page, nothing about the tenant's data.
 */
export const contactSyncPublicSessionSchema = z.object({
  status: contactSyncStatusSchema,
  deviceKind: contactSyncDeviceKindSchema,
  organizationName: z.string(),
  defaultDialCode: z.string().nullable(),
  expiresAt: z.string(),
});

/** One contact as posted by the Android flow (from the OS contact picker). */
export const contactSyncEntrySchema = z.object({
  name: z.string().max(200).nullish(),
  phones: z.array(z.string().max(64)).max(20),
  email: z.string().max(320).nullish(),
});

export const contactSyncUploadBodySchema = z.object({
  contacts: z.array(contactSyncEntrySchema).max(CONTACT_SYNC_MAX_CONTACTS),
});
export type ContactSyncUploadBody = z.infer<typeof contactSyncUploadBodySchema>;

export const contactSyncVCardBodySchema = z.object({
  vcard: z.string().min(1).max(CONTACT_SYNC_MAX_VCARD_CHARS),
});
export type ContactSyncVCardBody = z.infer<typeof contactSyncVCardBodySchema>;

/** The result the phone shows after posting, mirrored to the polling desktop. */
export const contactSyncResultSchema = z.object({
  received: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  /**
   * 'staged' means nothing has been imported yet — it is waiting for the tenant to review
   * on the desktop. The phone must say so rather than claiming contacts were added, or the
   * two screens contradict each other.
   *
   * This is the ONLY field added to the public response. The richer breakdown stays on the
   * JWT-authed session DTO: this body is returned by two unauthenticated routes, and
   * "how many people this org previously deleted" is not something a token holder needs.
   */
  mode: z.enum(['imported', 'staged']).default('imported'),
});
export type ContactSyncResult = z.infer<typeof contactSyncResultSchema>;

// ---------------------------------------------------------------------------
// Machine seam: the WhatsApp ingest service <-> Hader.
//
// Same pull model as sales-scan: the ingest service asks Hader what work exists and
// pushes results back, so it needs no inbound connectivity and can bind to localhost.
// ---------------------------------------------------------------------------

/** One session the ingest service is authorised to pair. */
export const waContactsPendingSessionSchema = z.object({
  sessionId: uuidSchema,
  organizationId: uuidSchema,
  /** Absolute deadline. The ingest service must tear the socket down at this point. */
  expiresAt: z.string(),
});

export const waContactsQrBodySchema = z.object({
  sessionId: uuidSchema,
  /** Null clears the QR — sent once the pairing succeeds. */
  qr: z.string().max(4096).nullable(),
  linkedPhone: z.string().max(32).nullish(),
});

/** A contact as harvested from WhatsApp's own contact list. */
export const waContactsEntrySchema = z.object({
  /** Digits only, no '+'. WhatsApp JIDs are already international. */
  phone: z.string().max(32),
  name: z.string().max(200).nullish(),
});

export const waContactsPushBodySchema = z.object({
  sessionId: uuidSchema,
  contacts: z.array(waContactsEntrySchema).max(CONTACT_SYNC_MAX_CONTACTS),
  linkedPhone: z.string().max(32).nullish(),
});

export const waContactsEndedBodySchema = z.object({
  sessionId: uuidSchema,
  reason: z.string().max(200),
});

// ---------------------------------------------------------------------------
// The result copy — rendered by BOTH the desktop dialog and the phone page, so it lives
// here rather than in either one. Pure.
// ---------------------------------------------------------------------------


export interface ContactSyncStats {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  named: number;
  skippedUnusable: number;
  skippedDeleted: number;
  skippedFailed: number;
  waReachable: number;
}

export interface SyncSummaryLine {
  text: string;
  tone: 'good' | 'neutral' | 'warning';
}

/**
 * The sentences a tenant reads after a sync. Shared by the desktop dialog and the phone
 * page so the two can never disagree.
 *
 * Two rules. First, only say things that are true and specific — "named 340 contacts you
 * only had numbers for" is the most valuable true sentence this feature can produce, and
 * it costs nothing because the data is already in hand. Second, a sync that changed
 * nothing must not read as a failure: re-syncing an unchanged address book is a correct
 * outcome and the copy should say so.
 */
export function summarizeContactSync(s: ContactSyncStats): SyncSummaryLine[] {
  const lines: SyncSummaryLine[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  if (s.created > 0) lines.push({ text: `${plural(s.created, 'contact', 'contacts')} added.`, tone: 'good' });

  if (s.named > 0) {
    lines.push({
      text: `Named ${plural(s.named, 'contact', 'contacts')} you only had numbers for.`,
      tone: 'good',
    });
  }

  if (s.waReachable > 0) {
    lines.push({ text: `${s.waReachable} of these are on WhatsApp.`, tone: 'good' });
  }

  if (s.unchanged > 0) {
    lines.push({
      text: `${plural(s.unchanged, 'contact was', 'contacts were')} already saved, unchanged.`,
      tone: 'neutral',
    });
  }

  if (s.skippedUnusable > 0) {
    lines.push({
      text: `${plural(s.skippedUnusable, 'entry had', 'entries had')} no usable phone number — service numbers, short codes, or contacts saved without a number.`,
      tone: 'neutral',
    });
  }

  if (s.skippedDeleted > 0) {
    lines.push({
      text: `${plural(s.skippedDeleted, 'contact was', 'contacts were')} left out because you deleted them before. Nothing was restored.`,
      tone: 'neutral',
    });
  }

  // Deliberately a warning, not grey subtext. A systemic write failure must not be
  // indistinguishable from address-book noise — the previous UI folded these into
  // "no usable phone number", which was simply false.
  if (s.skippedFailed > 0) {
    lines.push({
      text: `${plural(s.skippedFailed, 'contact', 'contacts')} could not be saved. Try syncing again — if it keeps happening, contact support.`,
      tone: 'warning',
    });
  }

  if (lines.length === 0) {
    lines.push({
      text:
        s.received > 0
          ? 'Everything on your phone was already saved in Hader. Nothing needed changing.'
          : 'No contacts were found to sync.',
      tone: 'neutral',
    });
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Staged review
// ---------------------------------------------------------------------------

/** One row in the review queue, before anything is imported. */
export const contactSyncStagedItemSchema = z.object({
  id: uuidSchema,
  phoneE164: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  included: z.boolean(),
  /** Already in this org's contacts — the most useful thing to deselect in bulk. */
  alreadyKnown: z.boolean(),
});
export type ContactSyncStagedItem = z.infer<typeof contactSyncStagedItemSchema>;

/**
 * Whole-queue totals, computed by the server.
 *
 * The review page cannot derive these from the rows it has loaded, and trying to was a real
 * defect: it requested 500 rows, counted those, and labelled the button "Add 500 contacts"
 * while apply imported every included row in the queue — 1,200 of them for a large address
 * book, the exact case staging exists for. Searching made it worse, because the count then
 * described the SEARCH RESULTS while the button still imported everything.
 *
 * So the counts come from a COUNT over the whole session, never from the page.
 */
export const contactSyncStagedSummarySchema = z.object({
  total: z.number().int(),
  included: z.number().int(),
  alreadyKnown: z.number().int(),
  noName: z.number().int(),
});
export type ContactSyncStagedSummary = z.infer<typeof contactSyncStagedSummarySchema>;

/**
 * Include or exclude rows. `ids` for an explicit selection, `scope` for the two bulk
 * actions worth having. Three named scopes rather than a predicate DSL: a second filter
 * grammar next to segmentFilterSchema would be a lot of machinery for one screen.
 */
export const contactSyncDecideBodySchema = z.object({
  action: z.enum(['include', 'exclude']),
  ids: z.array(uuidSchema).max(5_000).optional(),
  scope: z.enum(['all', 'existing', 'no_name']).optional(),
});

/**
 * Correct the provenance label before a staged run lands.
 *
 * The review screen is the first time anyone sees the queue, and therefore the first moment
 * the label can be checked against reality — "this says Layth, but it's the shop's Samsung".
 * Editable only while the run is still in review: once contacts carry the derived tag,
 * changing the label here would leave the tag and the session disagreeing, and the tag is
 * the half that outlives the 7-day prune.
 *
 * Explicitly nullable, so "actually, I don't know whose phone this was" is expressible.
 * Clearing is a valid, honest answer.
 */
export const contactSyncLabelBodySchema = z.object({
  syncedByLabel: contactSyncLabelSchema.nullable(),
});
