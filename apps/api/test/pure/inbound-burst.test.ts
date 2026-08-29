// Pure-logic gate for the WhatsApp inbound-burst rules. Runs with NO database
// and NO environment (vitest.pure.config.ts), so it's runnable on a developer
// machine before pushing.
//
// Two production incidents are pinned here (both found 2026-08-10):
//
// 1. After the 2026-08-05→08-08 outage, Meta redelivered outage-era messages
//    for days and the bot answered each at a random hour — customers got AI
//    replies to 4-day-old greetings at 2 AM. `isStaleInbound` is the gate
//    that stops auto-replies to late redeliveries; if it fails OPEN on a
//    valid old timestamp, ghost replies come back.
//
// 2. A customer sending two messages 2–20s apart got two parallel replies,
//    the second re-greeting from scratch (aseer-time, 2026-08-09).
//    `aggregateUnansweredTail` folds the unanswered tail into ONE turn; if
//    it drops a message or double-counts the current one, either an inquiry
//    goes unanswered or the model sees it twice.
import { describe, expect, it } from 'vitest';

import {
  aggregateUnansweredTail,
  isStaleInbound,
  sentEpochFromRaw,
  type BurstHistoryRow,
} from '../../src/lib/inbound-burst.js';

const NOW = 1_760_000_000; // arbitrary fixed epoch seconds
const MAX_AGE = 15 * 60;

describe('isStaleInbound', () => {
  it('is NOT stale for a fresh message', () => {
    expect(isStaleInbound(NOW - 30, NOW, MAX_AGE)).toBe(false);
  });
  it('is stale past the max age', () => {
    expect(isStaleInbound(NOW - MAX_AGE - 1, NOW, MAX_AGE)).toBe(true);
  });
  it('a 4-day-old outage redelivery is stale (the 2026-08-10 incident shape)', () => {
    expect(isStaleInbound(NOW - 4 * 24 * 3600, NOW, MAX_AGE)).toBe(true);
  });
  it('fails OPEN (not stale) on missing timestamp — a fresh message must never lose its reply', () => {
    expect(isStaleInbound(null, NOW, MAX_AGE)).toBe(false);
    expect(isStaleInbound(undefined, NOW, MAX_AGE)).toBe(false);
    expect(isStaleInbound(Number.NaN, NOW, MAX_AGE)).toBe(false);
  });
  it('fails OPEN on future clock skew', () => {
    expect(isStaleInbound(NOW + 3600, NOW, MAX_AGE)).toBe(false);
  });
  it('exactly at the boundary is NOT stale', () => {
    expect(isStaleInbound(NOW - MAX_AGE, NOW, MAX_AGE)).toBe(false);
  });
});

describe('sentEpochFromRaw', () => {
  it('reads Meta epoch-second strings', () => {
    expect(sentEpochFromRaw({ timestamp: '1754400000' })).toBe(1_754_400_000);
  });
  it('reads numeric timestamps', () => {
    expect(sentEpochFromRaw({ timestamp: 1_754_400_000 })).toBe(1_754_400_000);
  });
  it('returns null for missing/garbled/empty payloads', () => {
    expect(sentEpochFromRaw(null)).toBe(null);
    expect(sentEpochFromRaw({})).toBe(null);
    expect(sentEpochFromRaw({ timestamp: 'abc' })).toBe(null);
    expect(sentEpochFromRaw({ timestamp: '' })).toBe(null);
    expect(sentEpochFromRaw('not-an-object')).toBe(null);
  });
});

function row(
  direction: string,
  body: string | null,
  metaMessageId: string | null = null,
  sentEpochSeconds: number | null = NOW - 10,
): BurstHistoryRow {
  return { direction, body, metaMessageId, sentEpochSeconds };
}

describe('aggregateUnansweredTail', () => {
  it('single message: turn = current text, its history row excluded (no double-vision)', () => {
    const res = aggregateUnansweredTail({
      history: [row('inbound', 'hi', 'A'), row('outbound', 'hello!'), row('inbound', 'menu?', 'B')],
      currentMetaId: 'B',
      currentText: 'menu?',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('menu?');
    expect(res.burstSize).toBe(1);
    expect(res.historyBeforeBurst).toBe(2); // 'hi' + 'hello!' stay history
  });

  it('folds a stacked burst into one turn, order preserved, current last (the aseer 2026-08-09 shape)', () => {
    const res = aggregateUnansweredTail({
      history: [
        row('outbound', 'welcome!'),
        row('inbound', 'حبيبي', 'A'),
        row('inbound', 'ابي اطلب', 'B'),
      ],
      currentMetaId: 'B',
      currentText: 'ابي اطلب',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('حبيبي\nابي اطلب');
    expect(res.burstSize).toBe(2);
    expect(res.historyBeforeBurst).toBe(1);
  });

  it('stops at the last outbound — answered inquiries are history, not the turn', () => {
    const res = aggregateUnansweredTail({
      history: [
        row('inbound', 'old question', 'A'),
        row('outbound', 'old answer'),
        row('inbound', 'new question', 'B'),
      ],
      currentMetaId: 'B',
      currentText: 'new question',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('new question');
    expect(res.historyBeforeBurst).toBe(2);
  });

  it('does NOT fold stale outage-era rows — they stay context, not active questions', () => {
    const res = aggregateUnansweredTail({
      history: [
        row('inbound', 'السلام', 'OLD', NOW - 4 * 24 * 3600), // redelivered days late
        row('inbound', 'fresh hi', 'B', NOW - 5),
      ],
      currentMetaId: 'B',
      currentText: 'fresh hi',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('fresh hi');
    expect(res.burstSize).toBe(1);
    expect(res.historyBeforeBurst).toBe(1); // the stale row remains history
  });

  it('substitutes the voice transcript for the "[audio]" placeholder row', () => {
    const res = aggregateUnansweredTail({
      history: [
        row('outbound', 'hello!'),
        row('inbound', 'do you deliver?', 'A'),
        row('inbound', '[audio]', 'B'),
      ],
      currentMetaId: 'B',
      currentText: 'I want two chocolate boxes',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('do you deliver?\nI want two chocolate boxes');
  });

  it('noise like "." rides along as context instead of being its own turn', () => {
    const res = aggregateUnansweredTail({
      history: [
        row('outbound', 'anything else?'),
        row('inbound', 'send me photos of the medium size', 'A'),
        row('inbound', '.', 'B'),
      ],
      currentMetaId: 'B',
      currentText: '.',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('send me photos of the medium size\n.');
    expect(res.burstSize).toBe(2);
  });

  it('appends the current text when its row is outside the bounded history slice', () => {
    const res = aggregateUnansweredTail({
      history: [row('outbound', 'hi')],
      currentMetaId: 'MISSING',
      currentText: 'am I invisible?',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('am I invisible?');
    expect(res.burstSize).toBe(1);
  });

  it('with no wamid to match, the newest row is treated as the trigger (no duplication)', () => {
    const res = aggregateUnansweredTail({
      history: [row('outbound', 'hi'), row('inbound', 'question', null)],
      currentMetaId: null,
      currentText: 'question',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('question');
    expect(res.burstSize).toBe(1);
  });

  it('skips empty-bodied rows in the fold', () => {
    const res = aggregateUnansweredTail({
      history: [row('inbound', '  ', 'A'), row('inbound', 'real question', 'B')],
      currentMetaId: 'B',
      currentText: 'real question',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('real question');
  });

  it('empty history still yields the current text', () => {
    const res = aggregateUnansweredTail({
      history: [],
      currentMetaId: 'A',
      currentText: 'first ever message',
      nowEpochSeconds: NOW,
    });
    expect(res.userTurn).toBe('first ever message');
    expect(res.burstSize).toBe(1);
    expect(res.historyBeforeBurst).toBe(0);
  });
});
