// Phase 12.1 — currency-code expansion for TTS input.
import { describe, expect, it } from 'vitest';

import { normalizeCurrencyForTts } from '../src/lib/tts-text-normalizer.js';

describe('normalizeCurrencyForTts — English replies', () => {
  it('expands KWD to "Kuwaiti dinar"', () => {
    expect(normalizeCurrencyForTts('The Oreo Milkshake is 0.150 KWD.')).toBe(
      'The Oreo Milkshake is 0.150 Kuwaiti dinar.',
    );
  });

  it('expands USD to "US dollar"', () => {
    expect(normalizeCurrencyForTts('Subtotal is 12.50 USD today.')).toBe(
      'Subtotal is 12.50 US dollar today.',
    );
  });

  it('expands AED to "UAE dirham"', () => {
    expect(normalizeCurrencyForTts('That comes to 45 AED.')).toBe(
      'That comes to 45 UAE dirham.',
    );
  });

  it('leaves already-spelled-out prices alone', () => {
    expect(normalizeCurrencyForTts('The price is 0.150 Kuwaiti dinar.')).toBe(
      'The price is 0.150 Kuwaiti dinar.',
    );
  });

  it('expands multiple currency mentions in one sentence', () => {
    expect(
      normalizeCurrencyForTts('Three milkshakes at 0.150 KWD each is 0.450 KWD.'),
    ).toBe('Three milkshakes at 0.150 Kuwaiti dinar each is 0.450 Kuwaiti dinar.');
  });

  it('does NOT match currency codes embedded in SKUs', () => {
    // SKU pattern "KWD-LATTE-001" must not be expanded
    expect(normalizeCurrencyForTts('Available SKU: KWD-LATTE-001')).toBe(
      'Available SKU: KWD-LATTE-001',
    );
  });
});

describe('normalizeCurrencyForTts — Arabic replies', () => {
  it('expands KWD to "دينار كويتي" when text contains Arabic', () => {
    const out = normalizeCurrencyForTts('سعر الميلكشيك هو 0.150 KWD.');
    expect(out).toContain('0.150 دينار كويتي');
    expect(out).not.toContain('KWD');
  });

  it('expands SAR to "ريال سعودي" in Arabic context', () => {
    const out = normalizeCurrencyForTts('المجموع 45 SAR.');
    expect(out).toContain('ريال سعودي');
  });

  it('handles Arabic punctuation as a terminator', () => {
    const out = normalizeCurrencyForTts('السعر 0.150 KWD،');
    expect(out).toContain('0.150 دينار كويتي');
  });
});

describe('normalizeCurrencyForTts — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeCurrencyForTts('')).toBe('');
  });

  it('is idempotent (running twice produces the same result)', () => {
    const once = normalizeCurrencyForTts('Order total is 1.500 KWD.');
    const twice = normalizeCurrencyForTts(once);
    expect(twice).toBe(once);
  });

  it('handles comma-decimal prices', () => {
    expect(normalizeCurrencyForTts('Subtotal is 12,50 EUR.')).toBe(
      'Subtotal is 12,50 euro.',
    );
  });
});
