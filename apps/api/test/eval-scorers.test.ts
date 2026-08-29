import { describe, expect, it } from 'vitest';

import {
  buildJudgePrompt,
  detectScript,
  hasFormattingLeak,
  scoreDeterministic,
  scoreRetrieval,
  stripInternalMarkers,
} from '../eval/scorers.js';
import type { GoldenScenario } from '../eval/types.js';

const scen = (o: Partial<GoldenScenario>): GoldenScenario => ({
  key: 'k',
  prompt: 'p',
  expectation: 'e',
  ...o,
});

describe('detectScript', () => {
  it('detects Arabic script', () => {
    expect(detectScript('عصير فراولة صغير')).toBe('ar');
  });
  it('detects English', () => {
    expect(detectScript('Yes, we deliver to Riyadh')).toBe('en');
  });
  it('ignores emoji/punctuation-only', () => {
    expect(detectScript('👍!!')).toBe('other');
  });
  it('classifies Arabic even with a Latin loanword', () => {
    expect(detectScript('عندنا delivery خلال ساعة')).toBe('ar');
  });
});

describe('hasFormattingLeak', () => {
  it('flags markdown bold', () => expect(hasFormattingLeak('this is **bold**')).toBe(true));
  it('flags ATX heading', () => expect(hasFormattingLeak('## Menu')).toBe(true));
  it('flags leftover markers', () => expect(hasFormattingLeak('here [IMAGE: MENU-1]')).toBe(true));
  it('flags unresolved template token', () =>
    expect(hasFormattingLeak('Order {{cart_id_short}} done')).toBe(true));
  it('passes clean plain text', () =>
    expect(hasFormattingLeak('عصير فراولة صغير · 0.095 KWD')).toBe(false));
  it('does not flag a single asterisk (WhatsApp bold)', () =>
    expect(hasFormattingLeak('this is *bold* only')).toBe(false));
});

describe('scoreRetrieval', () => {
  it('hit when all expected SKUs present (case-insensitive)', () => {
    const r = scoreRetrieval(['MENU-340', 'menu-341', 'MENU-342'], ['MENU-341', 'MENU-342']);
    expect(r.hit).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.expected).toBe(2);
  });
  it('miss reports the absent SKUs', () => {
    const r = scoreRetrieval(['MENU-340'], ['MENU-340', 'MENU-341']);
    expect(r.hit).toBe(false);
    expect(r.missing).toEqual(['menu-341']);
  });
  it('no expectation → vacuously hit, not scored', () => {
    const r = scoreRetrieval(['MENU-1'], undefined);
    expect(r.hit).toBe(true);
    expect(r.expected).toBe(0);
  });
});

describe('scoreDeterministic', () => {
  it('passes a clean Arabic reply', () => {
    const r = scoreDeterministic('عصير فراولة صغير 0.095 دينار', [], scen({ expectLanguage: 'ar' }));
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });
  it('fails on a critical hallucination', () => {
    const r = scoreDeterministic(
      'عندنا برجر لحم بـ 2 دينار',
      [{ type: 'unknown_product', matchedText: 'برجر لحم', context: '', severity: 'critical', reason: 'x' }],
      scen({ mustNotHallucinate: true }),
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toContain('critical hallucination');
  });
  it('ignores warning-severity hallucinations', () => {
    const r = scoreDeterministic(
      'clean',
      [{ type: 'price_drift', matchedText: 'x', context: '', severity: 'warning', reason: 'y' }],
      scen({}),
    );
    expect(r.passed).toBe(true);
  });
  it('fails when the reply is in the wrong language', () => {
    const r = scoreDeterministic('Yes we deliver', [], scen({ expectLanguage: 'ar' }));
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toContain('language');
  });
  it('fails on a formatting leak', () => {
    const r = scoreDeterministic('**bold** reply', [], scen({}));
    expect(r.passed).toBe(false);
  });
});

describe('stripInternalMarkers', () => {
  it('removes image + cart + button markers the send-path strips', () => {
    const out = stripInternalMarkers('عصير فراولة\n[IMAGE: MENU-286]\n[BUTTONS: A | B]');
    expect(out).toBe('عصير فراولة');
  });
  it('removes a multiline [CART: {...}] payload', () => {
    expect(stripInternalMarkers('done [CART: {"items":[\n{"sku":"X"}\n]}] ')).toBe('done');
  });
  it('leaves clean text untouched', () => {
    expect(stripInternalMarkers('عصير فراولة صغير 0.095 KWD')).toBe('عصير فراولة صغير 0.095 KWD');
  });
});

describe('buildJudgePrompt', () => {
  it('includes criteria, message, and reply; binary JSON instruction', () => {
    const { system, user } = buildJudgePrompt(
      scen({ prompt: 'شي ثاني كم حجم؟', expectation: 'lists all sizes' }),
      'عندنا صغير ووسط وكبير',
    );
    expect(system).toContain('binary');
    expect(user).toContain('شي ثاني كم حجم؟');
    expect(user).toContain('lists all sizes');
    expect(user).toContain('عندنا صغير ووسط وكبير');
  });
  it('includes catalog facts as ground truth when provided', () => {
    const { system, user } = buildJudgePrompt(
      scen({ prompt: 'كم سعر عوار قلب؟', expectation: 'quotes the real price' }),
      'عوار قلب صغير 0.130 KWD',
      '- عوار قلب - صغير · 0.130 KWD',
    );
    expect(system).toContain('ground truth');
    expect(user).toContain('CATALOG FACTS');
    expect(user).toContain('0.130 KWD');
  });
  it('threads prior turns when present', () => {
    const { user } = buildJudgePrompt(
      scen({ history: [{ role: 'user', content: 'مرحبا' }] }),
      'أهلا',
    );
    expect(user).toContain('CONVERSATION SO FAR');
    expect(user).toContain('مرحبا');
  });
});
