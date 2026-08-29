// Unit tests for the voice-order item matcher (apps/api/src/lib/voice-order.ts).
//
// The phone voicebot's submit_order tool sends SPOKEN item names (the realtime
// model never sees SKUs), so the server matches them to the catalog. These lock
// the bidirectional matching: exact, name-contains-query, query-contains-name,
// and shared-token — plus "no false match" for off-menu requests.
import { describe, expect, it } from 'vitest';

import { matchProduct } from '../src/lib/voice-order.js';

const CATALOG = [
  { id: 'p1', sku: 'SWN-ZAATAR', name: 'Zaatar Manakish', priceMinor: 50_000 },
  { id: 'p2', sku: 'SWN-CHEESE', name: 'Cheese Manakish', priceMinor: 70_000 },
  { id: 'p3', sku: 'SWN-LABNEH', name: 'Labneh Sandwich', priceMinor: 90_000 },
  { id: 'p4', sku: 'SWN-OJ', name: 'Fresh Orange Juice', priceMinor: 40_000 },
];

describe('matchProduct', () => {
  it('matches an exact spoken name (case-insensitive)', () => {
    expect(matchProduct('zaatar manakish', CATALOG)?.id).toBe('p1');
  });

  it('matches when the caller says a longer phrase containing the menu name', () => {
    expect(matchProduct('one large Labneh Sandwich please', CATALOG)?.id).toBe('p3');
  });

  it('matches when the caller says a shorter phrase inside the menu name', () => {
    // "orange juice" ⊂ "Fresh Orange Juice"
    expect(matchProduct('orange juice', CATALOG)?.id).toBe('p4');
  });

  it('disambiguates between two similar items by the distinguishing token', () => {
    expect(matchProduct('cheese manousheh', CATALOG)?.id).toBe('p2');
    expect(matchProduct('zaatar', CATALOG)?.id).toBe('p1');
  });

  it('returns null for an off-menu request (no false match)', () => {
    expect(matchProduct('chicken shawarma', CATALOG)).toBeNull();
    expect(matchProduct('', CATALOG)).toBeNull();
  });
});
