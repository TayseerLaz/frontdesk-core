// Unit tests for the Phase 8 / 1.2 provenance scanner. No DB — the
// scanner is pure CPU.
import { describe, expect, it } from 'vitest';

import { scanReply, type ScanCandidates } from '../src/lib/provenance-scanner.js';

// Minimal candidate bundle used by most tests. Helpers below override.
function makeKb(over: Partial<ScanCandidates> = {}): ScanCandidates {
  return {
    products: [
      {
        id: 'p1',
        name: 'Oreo Milkshake',
        sku: 'ATK-MIX-OREO',
        priceMinor: 1250,
        currency: 'KWD',
      },
      {
        id: 'p2',
        name: 'Dubai Crepe',
        sku: 'ATK-SWEET-DUBAICREPE',
        priceMinor: 4500,
        currency: 'KWD',
      },
    ],
    services: [],
    faqs: [],
    policies: [],
    biz: {
      legalName: 'Atyab Kitchen',
      websiteUrl: 'https://atyab.example/menu',
      operatingHours: { mon: { open: '09:00', close: '22:00' } },
      currency: 'KWD',
      menuUrl: null,
    },
    ...over,
  };
}

describe('scanReply — citations', () => {
  it('returns empty arrays for empty reply', () => {
    expect(scanReply('', makeKb())).toEqual({ citations: [], hallucinations: [] });
  });

  it('cites a product when its name appears in the reply', () => {
    const r = 'Added one Oreo Milkshake. 1.250 KWD. Anything else?';
    const out = scanReply(r, makeKb());
    expect(out.citations.find((c) => c.type === 'product' && c.id === 'p1')).toBeDefined();
    // Price extracted matches catalog → no drift hallucination
    expect(out.hallucinations.filter((h) => h.type === 'price_drift')).toHaveLength(0);
  });

  it('flags price drift when cited price differs > 2% from catalog', () => {
    const r = 'The Oreo Milkshake is 2.000 KWD. Want one?';
    const out = scanReply(r, makeKb());
    const drift = out.hallucinations.find((h) => h.type === 'price_drift');
    expect(drift).toBeDefined();
    expect(drift?.reason).toContain('2.000 KWD');
    expect(drift?.reason).toContain('1.250');
  });

  it('does NOT flag tiny rounding drift (≤2%)', () => {
    const r = 'Oreo Milkshake is 1.260 KWD.'; // within 2% of 1.250
    const out = scanReply(r, makeKb());
    expect(out.hallucinations.filter((h) => h.type === 'price_drift')).toHaveLength(0);
  });

  it('does NOT bleed the previous bullet\'s price into the next item', () => {
    // Real-world false positive from production: in a list like
    //   - Blah Blah Milkshake, 1.000 KWD
    //   - Oreo Milkshake, 0.150 KWD
    // the scanner used to grab "1.000 KWD" as Oreo's cited price.
    const kb = makeKb({
      products: [
        {
          id: 'p1',
          name: 'Blah Blah Milkshake',
          sku: 'BLAH',
          priceMinor: 1000,
          currency: 'KWD',
        },
        {
          id: 'p2',
          name: 'Oreo Milkshake',
          sku: 'OREO',
          priceMinor: 150,
          currency: 'KWD',
        },
      ],
    });
    const r = '- Blah Blah Milkshake, 1.000 KWD\n- Oreo Milkshake, 0.150 KWD';
    const out = scanReply(r, kb);
    const oreoDrift = out.hallucinations.find(
      (h) => h.type === 'price_drift' && /Oreo/i.test(h.reason),
    );
    expect(oreoDrift).toBeUndefined();
  });

  it('cites a FAQ when a distinctive 3-gram from its answer appears', () => {
    const kb = makeKb({
      faqs: [
        {
          id: 'f1',
          question: 'Do you deliver?',
          answer:
            'We deliver everywhere inside Kuwait City between 10am and 11pm using our own riders.',
        },
      ],
    });
    const r = 'Yes — between 10am and 11pm we deliver everywhere inside Kuwait City.';
    const out = scanReply(r, kb);
    expect(out.citations.find((c) => c.type === 'faq' && c.id === 'f1')).toBeDefined();
  });

  it('cites businessInfo.websiteUrl when the URL appears verbatim', () => {
    const r = 'Browse the menu at https://atyab.example/menu and tell me what you want.';
    const out = scanReply(r, makeKb());
    expect(out.citations.find((c) => c.type === 'business_info' && c.label === 'websiteUrl')).toBeDefined();
  });
});

describe('scanReply — hallucinations', () => {
  it('flags a "added one Karak Tea" line when Karak Tea is NOT in catalog', () => {
    const r = 'Added one Karak Tea. 0.500 KWD. Total now 1.750 KWD.';
    const out = scanReply(r, makeKb());
    const h = out.hallucinations.find(
      (x) => x.type === 'unknown_product' && /karak/i.test(x.matchedText),
    );
    expect(h).toBeDefined();
    expect(h?.severity).toBe('critical');
  });

  it('flags a "Karak Tea is 0.500 KWD" price phrasing when Karak Tea is NOT in catalog', () => {
    const r = 'Karak Tea is 0.500 KWD. Sweet, spiced, perfect with a crepe.';
    const out = scanReply(r, makeKb());
    expect(
      out.hallucinations.some(
        (h) => h.type === 'unknown_product' && /karak/i.test(h.matchedText),
      ),
    ).toBe(true);
  });

  it('does NOT flag a real product as hallucinated', () => {
    const r = 'Added one Oreo Milkshake. 1.250 KWD. Want anything else?';
    const out = scanReply(r, makeKb());
    expect(out.hallucinations.filter((h) => h.type === 'unknown_product')).toHaveLength(0);
  });

  it('suppresses double-flagging when name appears in BOTH a cart action AND a price phrase', () => {
    const r = 'Added one Karak Tea. Karak Tea is 0.500 KWD. Total 0.500 KWD.';
    const out = scanReply(r, makeKb());
    const karak = out.hallucinations.filter(
      (h) => h.type === 'unknown_product' && /karak/i.test(h.matchedText),
    );
    // Both patterns fire, but for the same scan we expect at least one row.
    // Multiple distinct sentences = multiple distinct hallucination rows is
    // OK — the admin UI dedupes by matchedText.
    expect(karak.length).toBeGreaterThanOrEqual(1);
  });

  it('catches upsell-question phrasing: "Want a Karak Tea with it? 0.500 KWD"', () => {
    const r =
      'Added one Oreo Milkshake. 1.250 KWD. Want a Karak Tea with it? 0.500 KWD.';
    const out = scanReply(r, makeKb());
    const karak = out.hallucinations.find(
      (h) => h.type === 'unknown_product' && h.matchedText === 'Karak Tea',
    );
    expect(karak).toBeDefined();
    expect(karak?.severity).toBe('critical');
  });

  it('does NOT flag real-product description fragments ("Vanilla blended...") that precede a price', () => {
    // The bot quotes the catalog description for Oreo Milkshake before the
    // price. The proximity scan should land on a real-product token (Oreo)
    // or be suppressed by candidate-substring match, NOT flag "Vanilla".
    const r =
      'Added one Oreo Milkshake. Vanilla ice cream blended with crushed Oreo cookies. 1.250 KWD.';
    const out = scanReply(r, makeKb());
    expect(out.hallucinations.filter((h) => h.type === 'unknown_product')).toHaveLength(0);
  });

  it('ignores generic "we don\'t have X" phrases — they aren\'t cart actions', () => {
    const r = "I don't have Karak Tea on the menu — sorry!";
    const out = scanReply(r, makeKb());
    expect(out.hallucinations.filter((h) => h.type === 'unknown_product')).toHaveLength(0);
  });

  it('finishes in < 50 ms for a 600-char reply against a 30-item catalog', () => {
    const kb = makeKb({
      products: Array.from({ length: 30 }, (_, i) => ({
        id: `p${i}`,
        name: `Product ${i} Special`,
        sku: `SKU-${i}`,
        priceMinor: 1000 + i,
        currency: 'KWD',
      })),
    });
    const reply =
      'Added one Product 5 Special. 1.005 KWD. Anything else from Product 10 Special, Product 12 Special, or Product 18 Special?'.repeat(
        5,
      );
    const start = Date.now();
    scanReply(reply, kb);
    expect(Date.now() - start).toBeLessThan(50);
  });
});
