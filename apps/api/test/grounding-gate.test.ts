import { describe, expect, it } from 'vitest';

import { buildScanCandidates, groundingGate } from '../src/lib/grounding-gate.js';
import type { ScanCandidates } from '../src/lib/provenance-scanner.js';

const candidates: ScanCandidates = {
  products: [
    { id: 'p1', name: 'Strawberry Juice', sku: 'SJ-1', priceMinor: 500, currency: 'KWD' },
  ],
  services: [],
  faqs: [],
  policies: [],
  biz: { legalName: 'Aseer', websiteUrl: null, operatingHours: null, currency: 'KWD', menuUrl: null },
  config: { greeting: null },
  customer: null,
};

describe('groundingGate', () => {
  it('passes a grounded reply (real product + price)', () => {
    const r = groundingGate('Strawberry Juice is 0.500 KWD', candidates, 'enforce');
    expect(r.wouldBlock).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('flags an ungrounded product+price (shadow: flags but still ok)', () => {
    const r = groundingGate('We have Chocolate Cake for 2.000 KWD', candidates, 'shadow');
    expect(r.wouldBlock).toBe(true);
    expect(r.ok).toBe(true); // shadow never withholds
    expect(r.reason).toContain('ungrounded');
  });

  it('blocks an ungrounded product+price in enforce mode', () => {
    const r = groundingGate('We have Chocolate Cake for 2.000 KWD', candidates, 'enforce');
    expect(r.wouldBlock).toBe(true);
    expect(r.ok).toBe(false); // enforce withholds
  });

  it('is a no-op when off', () => {
    const r = groundingGate('We have Chocolate Cake for 2.000 KWD', candidates, 'off');
    expect(r.wouldBlock).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('passes an empty reply', () => {
    expect(groundingGate('', candidates, 'enforce').ok).toBe(true);
  });
});

describe('buildScanCandidates', () => {
  it('maps gatherBotData shape into the scanner bundle + menuUrl from shopForm', () => {
    const c = buildScanCandidates(
      {
        products: [{ id: 'p1', name: 'Juice', sku: 'J1', priceMinor: 500, currency: 'KWD' }],
        services: [],
        faqs: [],
        policies: [],
        biz: { legalName: 'X', websiteUrl: 'https://x.co', operatingHours: null, currency: 'KWD' },
        config: { greeting: 'Hi' },
        shopForm: { menuUrl: 'https://menu' },
      },
      'Fadi',
    );
    expect(c.products[0]!.sku).toBe('J1');
    expect(c.biz!.menuUrl).toBe('https://menu');
    expect(c.customer!.whatsappName).toBe('Fadi');
  });
});
