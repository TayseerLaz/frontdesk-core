// F5 — back-in-stock watches: pure matcher + copy (roadmap 2026-08-26).
// Runs in the pure HARD gate — no env, no db (imports the built shared dist).
import { describe, expect, it } from 'vitest';

import {
  matchUnavailableEntities,
  restockMessageText,
  stockWatchPrefersArabic,
  type WatchableEntity,
} from '@platform/shared';

const ENTITIES: WatchableEntity[] = [
  { id: 'p1', name: 'Glow Essentials Bundle', kind: 'product' },
  { id: 'p2', name: 'Firming Lotion', kind: 'product' },
  { id: 'p3', name: 'Gel', kind: 'product' }, // too short + single token — never matches
  { id: 's1', name: 'Deep Tissue Massage', kind: 'service' },
];

describe('matchUnavailableEntities', () => {
  it('matches a full name inside a sentence, case-insensitive', () => {
    expect(
      matchUnavailableEntities('hi, do you have the glow essentials bundle in stock?', ENTITIES).map(
        (e) => e.id,
      ),
    ).toEqual(['p1']);
  });

  it('matches through punctuation and extra spaces', () => {
    expect(
      matchUnavailableEntities('FIRMING   LOTION?!', ENTITIES).map((e) => e.id),
    ).toEqual(['p2']);
  });

  it('never matches a short single-token name (precision over recall)', () => {
    expect(matchUnavailableEntities('do you have the gel?', ENTITIES)).toEqual([]);
  });

  it('requires the FULL name — a partial mention is not an inquiry', () => {
    expect(matchUnavailableEntities('do you have glow essentials?', ENTITIES)).toEqual([]);
    expect(matchUnavailableEntities('any bundle available?', ENTITIES)).toEqual([]);
  });

  it('token boundaries: an embedded substring never matches', () => {
    const e: WatchableEntity[] = [{ id: 'x', name: 'Rose Oil', kind: 'product' }];
    expect(matchUnavailableEntities('I love roses oils', e)).toEqual([]);
    expect(matchUnavailableEntities('is the rose oil back?', e)).toEqual([{ id: 'x', name: 'Rose Oil', kind: 'product' }]);
  });

  it('matches services too, and caps at 3', () => {
    expect(
      matchUnavailableEntities('deep tissue massage please', ENTITIES).map((e) => e.kind),
    ).toEqual(['service']);
    const many: WatchableEntity[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      name: `special item ${i}`,
      kind: 'product' as const,
    }));
    const msg = many.map((e) => e.name).join(' and ');
    expect(matchUnavailableEntities(msg, many)).toHaveLength(3);
  });

  it('handles Arabic names with diacritics stripped', () => {
    const e: WatchableEntity[] = [{ id: 'a', name: 'كريم الشد', kind: 'product' }];
    expect(matchUnavailableEntities('عندكن كريم الشد؟', e).map((x) => x.id)).toEqual(['a']);
  });

  it('empty / null inbound matches nothing', () => {
    expect(matchUnavailableEntities('', ENTITIES)).toEqual([]);
    expect(matchUnavailableEntities(null, ENTITIES)).toEqual([]);
  });
});

describe('restock copy + language', () => {
  it('renders both languages with the entity name, price optional', () => {
    expect(restockMessageText('en', 'Firming Lotion', '40$')).toContain('Firming Lotion');
    expect(restockMessageText('en', 'Firming Lotion', '40$')).toContain('40$');
    expect(restockMessageText('en', 'Firming Lotion', null)).not.toContain('()');
    expect(restockMessageText('ar', 'كريم الشد')).toContain('كريم الشد');
  });

  it('language pick follows Arabic script', () => {
    expect(stockWatchPrefersArabic('بدي اطلب')).toBe(true);
    expect(stockWatchPrefersArabic('I want to order')).toBe(false);
    expect(stockWatchPrefersArabic(null)).toBe(false);
  });
});
