// F2 — post-conversation feedback: pure decision logic (roadmap 2026-08-26).
// Runs in the pure HARD gate — no env, no db.
import { describe, expect, it } from 'vitest';

import {
  computeHandlerMix,
  containsArabic,
  feedbackAskText,
  feedbackStampFresh,
  feedbackThanksText,
  parseFeedbackConfig,
  parseRating,
  withinSessionWindow,
} from '../../src/lib/feedback.js';

describe('parseRating', () => {
  it('accepts a bare 1-5 digit', () => {
    expect(parseRating('4')).toBe(4);
    expect(parseRating(' 5 ')).toBe(5);
    expect(parseRating('1')).toBe(1);
  });

  it('rejects out-of-range digits and non-ratings', () => {
    expect(parseRating('0')).toBeNull();
    expect(parseRating('6')).toBeNull();
    expect(parseRating('10')).toBeNull();
    expect(parseRating('yes')).toBeNull();
    expect(parseRating('')).toBeNull();
    expect(parseRating(null)).toBeNull();
    expect(parseRating(undefined)).toBeNull();
  });

  it('accepts Arabic-Indic and Eastern Arabic-Indic digits', () => {
    expect(parseRating('٤')).toBe(4); // U+0664
    expect(parseRating('٥')).toBe(5);
    expect(parseRating('۳')).toBe(3); // U+06F3
    expect(parseRating('٠')).toBeNull(); // zero is not a rating
  });

  it('accepts "n/5" forms in both digit systems', () => {
    expect(parseRating('4/5')).toBe(4);
    expect(parseRating('5 / 5')).toBe(5);
    expect(parseRating('٣/٥')).toBe(3);
    expect(parseRating('4/10')).toBeNull();
  });

  it('accepts star words and star emoji', () => {
    expect(parseRating('5 stars')).toBe(5);
    expect(parseRating('٥ نجوم')).toBe(5);
    expect(parseRating('⭐⭐⭐')).toBe(3);
    expect(parseRating('★★★★★')).toBe(5);
    expect(parseRating('⭐⭐⭐⭐⭐⭐')).toBeNull(); // six stars is not a scale
  });

  it('a real message that happens to contain a digit is NOT a rating', () => {
    expect(parseRating('I ordered 2 days ago, where is my package?')).toBeNull();
    expect(parseRating('can I get 5 of the gel')).toBeNull();
  });
});

describe('language + copy', () => {
  it('detects Arabic script', () => {
    expect(containsArabic('كيف كانت تجربتك')).toBe(true);
    expect(containsArabic('great thanks')).toBe(false);
    expect(containsArabic(null)).toBe(false);
  });

  it('ask + thanks copy exist in both languages and mention the 1-5 scale', () => {
    expect(feedbackAskText('en')).toMatch(/1.*5/);
    expect(feedbackAskText('ar')).toMatch(/١.*٥/);
    expect(feedbackThanksText('en', 5)).toMatch(/[Tt]hank/);
    expect(feedbackThanksText('ar', 5).length).toBeGreaterThan(5);
  });

  it('a low rating gets the apologetic variant', () => {
    expect(feedbackThanksText('en', 1)).toMatch(/sorry/i);
    expect(feedbackThanksText('en', 4)).not.toMatch(/sorry/i);
  });
});

describe('handler mix — the customer/AI split', () => {
  it('classifies ai-only, human-only, and mixed threads', () => {
    expect(computeHandlerMix(4, 0)).toBe('ai');
    expect(computeHandlerMix(0, 3)).toBe('human');
    expect(computeHandlerMix(2, 1)).toBe('mixed');
  });
});

describe('time windows', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  it('24h session window is half-open and null-safe', () => {
    expect(withinSessionWindow(new Date('2026-08-27T11:00:00Z'), now)).toBe(true);
    expect(withinSessionWindow(new Date('2026-08-26T11:59:00Z'), now)).toBe(false);
    expect(withinSessionWindow(null, now)).toBe(false);
  });
  it('a stale ask stamp (>7d) no longer captures replies', () => {
    expect(feedbackStampFresh(new Date('2026-08-26T12:00:00Z'), now)).toBe(true);
    expect(feedbackStampFresh(new Date('2026-08-19T12:00:00Z'), now)).toBe(false);
    expect(feedbackStampFresh(null, now)).toBe(false);
  });
});

describe('parseFeedbackConfig', () => {
  it('only an explicit enabled:true enables', () => {
    expect(parseFeedbackConfig({ enabled: true })).toEqual({ enabled: true });
    expect(parseFeedbackConfig({ enabled: 'yes' })).toEqual({ enabled: false });
    expect(parseFeedbackConfig(null)).toEqual({ enabled: false });
    expect(parseFeedbackConfig(undefined)).toEqual({ enabled: false });
    expect(parseFeedbackConfig('on')).toEqual({ enabled: false });
  });
});
