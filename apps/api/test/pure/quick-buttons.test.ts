// F11 — configured quick buttons: pure decision logic (roadmap 2026-08-26).
// Runs in the pure HARD gate — no env, no db.
import { describe, expect, it } from 'vitest';

import {
  matchButtonReply,
  mergeQuickButtons,
  parseCustomButtons,
} from '../../src/lib/quick-buttons.js';

describe('parseCustomButtons', () => {
  it('accepts a well-formed array and normalizes it', () => {
    const parsed = parseCustomButtons([
      { label: ' Order now 🛍 ', replyText: '  Send your name + address  ', always: true },
      { label: 'FAQ', always: false },
    ]);
    expect(parsed).toEqual([
      { label: 'Order now 🛍', replyText: 'Send your name + address', always: true },
      { label: 'FAQ', replyText: null, always: false },
    ]);
  });

  it('never trusts the JSONB shape: junk in, empty out', () => {
    expect(parseCustomButtons(null)).toEqual([]);
    expect(parseCustomButtons(undefined)).toEqual([]);
    expect(parseCustomButtons('order now')).toEqual([]);
    expect(parseCustomButtons({ label: 'x' })).toEqual([]);
    expect(parseCustomButtons([null, 42, 'x', { replyText: 'no label' }])).toEqual([]);
  });

  it('drops empty and over-long labels (counting code points, not UTF-16 units)', () => {
    const twentyWithEmoji = 'Order now please 🛍🛍🛍'; // 20 code points
    expect([...twentyWithEmoji].length).toBe(20);
    const parsed = parseCustomButtons([
      { label: '' },
      { label: 'x'.repeat(21) },
      { label: twentyWithEmoji },
    ]);
    expect(parsed.map((b) => b.label)).toEqual([twentyWithEmoji]);
  });

  it('caps at 3 and dedupes case-insensitively', () => {
    const parsed = parseCustomButtons([
      { label: 'One' },
      { label: 'one' },
      { label: 'Two' },
      { label: 'Three' },
      { label: 'Four' },
    ]);
    expect(parsed.map((b) => b.label)).toEqual(['One', 'Two', 'Three']);
  });

  it('blank replyText normalizes to null (no accidental empty canned sends)', () => {
    expect(parseCustomButtons([{ label: 'Hi', replyText: '   ' }])[0]!.replyText).toBeNull();
  });
});

describe('mergeQuickButtons', () => {
  const configured = parseCustomButtons([
    { label: 'Order now 🛍', always: true },
    { label: 'Track order', replyText: 'Send your order number', always: false },
  ]);

  it("the model's own marker is authoritative — configured buttons are NOT force-merged", () => {
    expect(
      mergeQuickButtons(['See prices', 'Book a visit'], configured, { cap: 3, modelChose: true }),
    ).toEqual(['See prices', 'Book a visit']);
  });

  it('when the model offered nothing, configured always-buttons lead the fallback set', () => {
    expect(
      mergeQuickButtons(['View products', 'Talk to a human'], configured, {
        cap: 3,
        modelChose: false,
      }),
    ).toEqual(['Order now 🛍', 'View products', 'Talk to a human']);
  });

  it('non-always configured buttons are NOT injected', () => {
    expect(mergeQuickButtons([], configured, { cap: 3, modelChose: false })).toEqual(['Order now 🛍']);
  });

  it('the button the customer JUST tapped never re-renders (case-insensitive, both modes)', () => {
    expect(
      mergeQuickButtons(['Talk to an agent', 'See prices'], configured, {
        cap: 3,
        modelChose: true,
        justPressed: '  talk TO an agent ',
      }),
    ).toEqual(['See prices']);
    expect(
      mergeQuickButtons(['View products'], configured, {
        cap: 3,
        modelChose: false,
        justPressed: 'Order now 🛍',
      }),
    ).toEqual(['View products']);
  });

  it('dedupes case-insensitively and respects the caller cap', () => {
    expect(
      mergeQuickButtons(['ORDER NOW 🛍', 'See prices'], configured, { cap: 3, modelChose: false }),
    ).toEqual(['Order now 🛍', 'See prices']);
    const many = ['a', 'b', 'c', 'd', 'e'];
    expect(mergeQuickButtons(many, configured, { cap: 11, modelChose: false })).toEqual([
      'Order now 🛍',
      ...many,
    ]);
    expect(mergeQuickButtons(many, [], { cap: 3, modelChose: true })).toEqual(['a', 'b', 'c']);
  });
});

describe('matchButtonReply', () => {
  const configured = parseCustomButtons([
    { label: 'Track order', replyText: 'Send your order number 🙏', always: true },
    { label: 'Order now 🛍', always: true }, // no replyText → never canned
  ]);

  it('matches an exact tap (trim + case-insensitive) and returns the canned text', () => {
    expect(matchButtonReply('  track ORDER ', configured)).toBe('Send your order number 🙏');
  });

  it('a label without replyText falls through to the LLM', () => {
    expect(matchButtonReply('Order now 🛍', configured)).toBeNull();
  });

  it('a sentence CONTAINING the label is a real message, not a tap', () => {
    expect(matchButtonReply('hi, I want to track order 4521 please help', configured)).toBeNull();
  });

  it('empty / null inbound never matches', () => {
    expect(matchButtonReply('', configured)).toBeNull();
    expect(matchButtonReply(null, configured)).toBeNull();
    expect(matchButtonReply(undefined, configured)).toBeNull();
  });
});
