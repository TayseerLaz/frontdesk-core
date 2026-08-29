// Pure-logic gate for contact sync. Runs with NO database and NO environment, via
// vitest.pure.config.ts — so unlike the rest of apps/api/test, this file can actually be
// executed on a developer machine before pushing.
//
// The rules asserted here used to live as inline comments inside importContacts, which
// meant the only specification of "never resurrect a deleted contact" was a sentence.
import { describe, expect, it } from 'vitest';

import {
  classifyEntry,
  planRevert,
  shouldStageSync,
  summarizeContactSync,
  normalizeSyncLabel,
  syncRunTag,
  whatsappFallbackLabel,
  MAX_CONTACT_TAG_CHARS,
  STAGE_THRESHOLD,
  SYNC_RUN_TAG_PREFIX,
  type ContactSyncStats,
  type RevertCurrentContact,
} from '../../src/lib/contact-sync-plan.js';
import { CONTACT_SYNC_LABEL_MAX_CHARS } from '@platform/shared';

const CONTACT = (over: Partial<RevertCurrentContact> = {}): RevertCurrentContact => ({
  id: 'c1',
  displayName: 'From Phone',
  email: null,
  lastInboundAt: null,
  optedOutAt: null,
  blockedAt: null,
  hasPhoneSyncTag: true,
  hasSequenceEnrollment: false,
  ...over,
});

describe('classifyEntry', () => {
  it('creates when the contact is new', () => {
    const p = classifyEntry(null, { displayName: 'Rami', email: 'r@x.com' });
    expect(p.effect).toBe('created');
    expect(p.filledDisplayName).toBe('Rami');
    expect(p.filledEmail).toBe('r@x.com');
  });

  it('never resurrects a soft-deleted contact', () => {
    // A bulk address-book dump must not silently undo a deletion the operator made.
    const p = classifyEntry(
      { id: 'c1', displayName: null, email: null, deletedAt: new Date() },
      { displayName: 'Rami', email: null },
    );
    expect(p.effect).toBe('skipped_deleted');
    expect(p.filledDisplayName).toBeNull();
  });

  it('fills only gaps — an operator-set name outranks the address book', () => {
    const p = classifyEntry(
      { id: 'c1', displayName: 'Operator Name', email: null, deletedAt: null },
      { displayName: 'Phone Name', email: 'p@x.com' },
    );
    expect(p.effect).toBe('updated');
    expect(p.filledDisplayName).toBeNull(); // name kept
    expect(p.filledEmail).toBe('p@x.com'); // email gap filled
  });

  it('reports unchanged when there is nothing to fill', () => {
    const p = classifyEntry(
      { id: 'c1', displayName: 'Known', email: 'k@x.com', deletedAt: null },
      { displayName: 'Phone Name', email: 'other@x.com' },
    );
    expect(p.effect).toBe('unchanged');
    expect(p.filledDisplayName).toBeNull();
    expect(p.filledEmail).toBeNull();
  });

  it('treats a nameless address-book entry as unchanged, not updated', () => {
    const p = classifyEntry(
      { id: 'c1', displayName: null, email: null, deletedAt: null },
      { displayName: null, email: null },
    );
    expect(p.effect).toBe('unchanged');
  });
});

describe('shouldStageSync', () => {
  it('stages anything above the threshold', () => {
    expect(shouldStageSync({ count: STAGE_THRESHOLD + 1, attested: false })).toBe(true);
    expect(shouldStageSync({ count: STAGE_THRESHOLD, attested: false })).toBe(false);
  });

  it('ALWAYS stages an attested sync, however small', () => {
    // Attesting sets optedInAt on every created row, which makes the whole book eligible
    // for broadcasts. That is the one action here that reaches real people and is hard to
    // walk back, so it gets a review screen regardless of size.
    expect(shouldStageSync({ count: 1, attested: true })).toBe(true);
  });

  it('honours an explicit request', () => {
    expect(shouldStageSync({ count: 1, attested: false, requested: true })).toBe(true);
  });
});

describe('planRevert', () => {
  const created = { contactId: 'c1', effect: 'created' as const, filledDisplayName: 'From Phone', filledEmail: null };

  it('deletes a contact this run created and nobody has touched', () => {
    expect(planRevert(created, CONTACT())).toEqual({ action: 'delete' });
  });

  it('keeps a contact who has since messaged the business', () => {
    expect(planRevert(created, CONTACT({ lastInboundAt: new Date() }))).toEqual({
      action: 'keep',
      reason: 'messaged',
    });
  });

  it('keeps opted-out, blocked, and sequence-enrolled contacts', () => {
    expect(planRevert(created, CONTACT({ optedOutAt: new Date() })).action).toBe('keep');
    expect(planRevert(created, CONTACT({ blockedAt: new Date() })).action).toBe('keep');
    expect(planRevert(created, CONTACT({ hasSequenceEnrollment: true })).action).toBe('keep');
  });

  it('keeps a contact the operator renamed or merged after the import', () => {
    expect(planRevert(created, CONTACT({ displayName: 'Renamed By Hand' }))).toEqual({
      action: 'keep',
      reason: 'renamed',
    });
    expect(planRevert(created, CONTACT({ hasPhoneSyncTag: false }))).toEqual({
      action: 'keep',
      reason: 'untagged',
    });
  });

  it('treats an already-deleted contact as done, not an error', () => {
    expect(planRevert(created, null)).toEqual({ action: 'keep', reason: 'gone' });
  });

  it('never deletes a contact this run merely updated — it reverts the fields it filled', () => {
    const updated = {
      contactId: 'c1',
      effect: 'updated' as const,
      filledDisplayName: 'From Phone',
      filledEmail: null,
    };
    expect(planRevert(updated, CONTACT())).toEqual({
      action: 'revert_fields',
      clearDisplayName: true,
      clearEmail: false,
    });
    // …and leaves it alone if the operator has since changed that field.
    expect(planRevert(updated, CONTACT({ displayName: 'Edited Later' })).action).toBe('keep');
  });

  it('does nothing for rows that changed nothing', () => {
    for (const effect of ['unchanged', 'skipped_deleted', 'skipped_failed'] as const) {
      expect(
        planRevert({ contactId: null, effect, filledDisplayName: null, filledEmail: null }, null),
      ).toEqual({ action: 'noop' });
    }
  });
});

describe('summarizeContactSync', () => {
  const base: ContactSyncStats = {
    received: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    named: 0,
    skippedUnusable: 0,
    skippedDeleted: 0,
    skippedFailed: 0,
    waReachable: 0,
  };

  it('leads with what was added and what was improved', () => {
    const out = summarizeContactSync({ ...base, received: 400, created: 380, named: 340 });
    expect(out[0]!.text).toContain('380 contacts added');
    expect(out[1]!.text).toContain('Named 340 contacts you only had numbers for');
  });

  it('does not read as a failure when a re-sync changed nothing', () => {
    const out = summarizeContactSync({ ...base, received: 1200, unchanged: 1200 });
    expect(out.every((l) => l.tone !== 'warning')).toBe(true);
    expect(out.some((l) => l.text.includes('already saved'))).toBe(true);
  });

  it('says nothing at all was found when nothing was', () => {
    expect(summarizeContactSync(base)[0]!.text).toContain('No contacts were found');
  });

  it('raises write failures as a WARNING, never as address-book noise', () => {
    // The shipped UI folded genuine write failures into "no usable phone number", which
    // made a systemic problem look like ordinary junk in the address book.
    const out = summarizeContactSync({ ...base, received: 10, created: 8, skippedFailed: 2 });
    const failed = out.find((l) => l.text.includes('could not be saved'));
    expect(failed).toBeDefined();
    expect(failed!.tone).toBe('warning');
  });

  it('distinguishes the three reasons a contact was skipped', () => {
    const out = summarizeContactSync({
      ...base,
      received: 9,
      skippedUnusable: 3,
      skippedDeleted: 4,
      skippedFailed: 2,
    });
    expect(out.some((l) => l.text.includes('no usable phone number'))).toBe(true);
    expect(out.some((l) => l.text.includes('you deleted them before'))).toBe(true);
    expect(out.some((l) => l.text.includes('could not be saved'))).toBe(true);
  });

  it('uses singular wording for one', () => {
    const out = summarizeContactSync({ ...base, received: 1, created: 1 });
    expect(out[0]!.text).toBe('1 contact added.');
  });
});

// ---------------------------------------------------------------------------
// syncRunTag — "whose phone is this?" turned into a ContactTag.
//
// The two collision cases below are the whole reason this function exists rather than the
// label being used raw. Neither degrades gracefully in production, and neither is visible
// in a smoke test with three contacts.
// ---------------------------------------------------------------------------
describe('syncRunTag', () => {
  it('namespaces the label so it can never collide with the phone-sync tag', () => {
    // 'phone-sync' is created on the SAME row in the same nested write, and contact_tags is
    // @@unique([contactId, tag]). An unprefixed collision fails the INSERT, aborts the
    // 200-row chunk, fails the row-by-row retry identically, and lands the ENTIRE import in
    // skipped_failed — one typed word destroying the whole sync.
    expect(syncRunTag('phone-sync')).not.toBe('phone-sync');
    expect(syncRunTag('phone-sync')).toBe('Phone: phone-sync');
  });

  it("namespaces away from 'unsubscribed', which is trigger-maintained", () => {
    // migration 20260804150000 keeps the 'unsubscribed' tag in lockstep with
    // contacts.opted_out_at. Its AFTER INSERT trigger runs BEFORE Prisma's nested tag
    // insert, so the trigger's cleanup DELETE cannot see a tag we add afterwards: the row
    // would render as unsubscribed on /contacts while opted_out_at is NULL.
    expect(syncRunTag('unsubscribed')).not.toBe('unsubscribed');
    expect(syncRunTag('unsubscribed')!.startsWith(SYNC_RUN_TAG_PREFIX)).toBe(true);
  });

  it('returns null for nothing to record, so a blank label produces NO tag', () => {
    // Not an empty tag, and emphatically not a placeholder: "not recorded" is true, and a
    // tag reading "Phone: " is not.
    expect(syncRunTag(null)).toBeNull();
    expect(syncRunTag(undefined)).toBeNull();
    expect(syncRunTag('')).toBeNull();
    expect(syncRunTag('   ')).toBeNull();
    expect(syncRunTag('\u200e \u200f')).toBeNull();
  });

  it('collapses whitespace and strips directional marks so one run is one bucket', () => {
    // Arabic-locale keyboards scatter RTL/LTR marks through pasted text. Two labels that
    // look identical must not split a run across two tag filters.
    expect(syncRunTag('  Rita\u2019s   iPhone  ')).toBe('Phone: Rita’s iPhone');
    expect(syncRunTag('Rita\u200e iPhone')).toBe('Phone: Rita iPhone');
    expect(syncRunTag('Rita\niPhone')).toBe('Phone: Rita iPhone');
  });

  it('never exceeds the 40-char ceiling every tag route enforces', () => {
    const long = 'x'.repeat(CONTACT_SYNC_LABEL_MAX_CHARS + 40);
    expect(syncRunTag(long)!.length).toBeLessThanOrEqual(MAX_CONTACT_TAG_CHARS);
  });

  it('a label at the Zod maximum still fits without truncation', () => {
    // The reason the label cap is 32 and not 40: a tenant who types the longest accepted
    // label must not silently lose characters from the tag they will filter by.
    const atMax = 'y'.repeat(CONTACT_SYNC_LABEL_MAX_CHARS);
    expect(syncRunTag(atMax)).toBe(`${SYNC_RUN_TAG_PREFIX}${atMax}`);
    expect(syncRunTag(atMax)!.length).toBeLessThanOrEqual(MAX_CONTACT_TAG_CHARS);
  });

  it('truncates by code point, never mid-surrogate', () => {
    // Slicing UTF-16 units in half yields a lone surrogate, which Postgres rejects outright
    // — turning a too-long name into a failed write rather than a shortened tag.
    const tag = syncRunTag('👨‍👩‍👧‍👦'.repeat(20))!;
    expect(tag.length).toBeLessThanOrEqual(MAX_CONTACT_TAG_CHARS);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(tag)).toBe(
      false,
    );
  });

  it('is deterministic — the same label always lands in the same bucket', () => {
    expect(syncRunTag('Shop counter phone')).toBe(syncRunTag(' Shop  counter phone '));
  });
});

describe('normalizeSyncLabel', () => {
  it('is the SAME cleaner the tag uses, so column and tag can never disagree', () => {
    // They disagreed: the tag ran this strip, the stored column ran a bare `.trim() || null`.
    // String.trim() does NOT remove format characters, so a label of only RTL marks stored a
    // truthy string, produced NO tag, and rendered on /contacts as a confident, empty
    // "from " with an invisible character after it.
    for (const junk of ['\u200e', '\u200f\u200e', '\u00ad', '\u0000', '  \u200f  ']) {
      expect(normalizeSyncLabel(junk)).toBeNull();
      expect(syncRunTag(junk)).toBeNull();
    }
  });

  it('agrees with syncRunTag on every real label', () => {
    for (const label of ["Rita's iPhone", '  Shop   counter  ', 'مكتب ريتا']) {
      const cleaned = normalizeSyncLabel(label)!;
      expect(syncRunTag(label)).toBe(`${SYNC_RUN_TAG_PREFIX}${cleaned}`);
    }
  });

  it('returns null for absent input rather than an empty string', () => {
    expect(normalizeSyncLabel(null)).toBeNull();
    expect(normalizeSyncLabel(undefined)).toBeNull();
    expect(normalizeSyncLabel('')).toBeNull();
  });
});

describe('whatsappFallbackLabel', () => {
  it('identifies the phone without storing a dialable number', () => {
    // The middle path: enough to tell one linked phone from another, not enough to call.
    expect(whatsappFallbackLabel('96170123456')).toBe('WhatsApp ending 3456');
    expect(whatsappFallbackLabel('+961 70 123 456')).toBe('WhatsApp ending 3456');
  });

  it('returns null rather than a stub when there is no usable number', () => {
    // linkedPhone is .nullish() on the wire and can arrive as ''. A label reading
    // "WhatsApp ending" would be worse than no label at all.
    for (const bad of [null, undefined, '', '12', 'abc']) {
      expect(whatsappFallbackLabel(bad as string | null | undefined)).toBeNull();
    }
  });

  it('produces a tag that is namespaced like any other label', () => {
    expect(syncRunTag(whatsappFallbackLabel('96170123456'))).toBe(
      `${SYNC_RUN_TAG_PREFIX}WhatsApp ending 3456`,
    );
  });
});
