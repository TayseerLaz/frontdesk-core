// F10 — website product-feed mapping: pure logic (roadmap 2026-08-26).
// Runs in the pure HARD gate — no env, no db (imports the built shared dist).
import { describe, expect, it } from 'vitest';

import {
  applyMappingV2,
  extractRecords,
  getPath,
  isMappingV2,
  listLeafPaths,
  previewProblems,
  suggestArrayPaths,
  suggestFieldMapping,
  type MappingV2,
} from '@platform/shared';

const FEED = {
  meta: { page: 1 },
  result: {
    items: [
      {
        id: 'SKU-1',
        title: 'Glow Serum',
        price: { amount: '12.50', currency: 'USD' },
        stock: 7,
        images: [{ url: 'https://x.com/a.jpg' }, { url: 'https://x.com/b.jpg' }],
        category: 'skincare',
        active: true,
      },
      { id: 'SKU-2', title: 'Night Cream', price: { amount: 30, currency: 'USD' }, stock: 0, images: [], active: false },
    ],
  },
};

describe('getPath / extractRecords / suggestArrayPaths', () => {
  it('walks dot paths incl. array indices', () => {
    expect(getPath(FEED, 'result.items.0.price.amount')).toBe('12.50');
    expect(getPath(FEED, 'result.items.9.title')).toBeUndefined();
    expect(getPath(FEED, 'nope.deep')).toBeUndefined();
  });

  it('explicit arrayPath wins; auto-detect finds nested wrappers', () => {
    expect(extractRecords(FEED, 'result.items')).toHaveLength(2);
    expect(extractRecords(FEED)).toHaveLength(2); // result.items via common keys
    expect(extractRecords([{ a: 1 }])).toHaveLength(1); // root array
    expect(extractRecords({ data: [{ a: 1 }] })).toHaveLength(1); // legacy .data
    expect(extractRecords({ nothing: 'here' })).toEqual([]);
    expect(extractRecords([1, 2, 3])).toEqual([]); // array of scalars ≠ records
  });

  it('suggests candidate paths, most likely first', () => {
    expect(suggestArrayPaths(FEED)).toContain('result.items');
    expect(suggestArrayPaths([{ a: 1 }])).toContain('');
  });
});

describe('listLeafPaths / suggestFieldMapping', () => {
  const paths = listLeafPaths(FEED.result.items[0]!);
  it('flattens a record incl. array children, exposing both forms', () => {
    expect(paths).toContain('title');
    expect(paths).toContain('price.amount');
    expect(paths).toContain('images'); // whole array pickable
    expect(paths).toContain('images.0.url');
  });

  it('auto-maps the obvious fields', () => {
    const m = suggestFieldMapping(paths);
    expect(m.name).toBe('title');
    expect(m.sku).toBe('id');
    expect(m.priceMinor).toBe('price.amount');
    expect(m.stockQuantity).toBe('stock');
    expect(m.imageUrls).toBe('images');
    expect(m.isAvailable).toBe('active');
  });
});

describe('applyMappingV2', () => {
  const mapping: MappingV2 = {
    __v: 2,
    arrayPath: 'result.items',
    priceUnit: 'major',
    fields: {
      name: 'title',
      sku: 'id',
      priceMinor: 'price.amount',
      currency: 'price.currency',
      stockQuantity: 'stock',
      imageUrls: 'images',
      categorySlug: 'category',
      isAvailable: 'active',
    },
  };

  it('maps nested paths, converts major prices to minor, joins image objects', () => {
    const rec = extractRecords(FEED, mapping.arrayPath)[0]!;
    const mapped = applyMappingV2(rec, mapping);
    expect(mapped).toMatchObject({
      name: 'Glow Serum',
      sku: 'SKU-1',
      priceMinor: 1250,
      currency: 'USD',
      stockQuantity: 7,
      imageUrls: 'https://x.com/a.jpg, https://x.com/b.jpg',
      categorySlug: 'skincare',
      isAvailable: true,
    });
    expect(previewProblems(mapped)).toEqual([]);
  });

  it('priceUnit minor passes integers through untouched', () => {
    const mapped = applyMappingV2(
      { p: 4050 },
      { __v: 2, fields: { priceMinor: 'p' }, priceUnit: 'minor' },
    );
    expect(mapped.priceMinor).toBe(4050);
  });

  it('unparseable price is dropped and flagged, empty sources are skipped', () => {
    const mapped = applyMappingV2(
      { p: 'call us', t: '' },
      { __v: 2, fields: { priceMinor: 'p', name: 't', sku: 'missing' } },
    );
    expect(mapped.priceMinor).toBeUndefined();
    expect(previewProblems(mapped)).toEqual(
      expect.arrayContaining(['Name is missing', 'SKU / unique id is missing', 'Price is missing']),
    );
  });

  it('isMappingV2 rejects the legacy flat shape', () => {
    expect(isMappingV2({ source_col: 'name' })).toBe(false);
    expect(isMappingV2({ __v: 2, fields: {} })).toBe(true);
    expect(isMappingV2(null)).toBe(false);
  });
});
