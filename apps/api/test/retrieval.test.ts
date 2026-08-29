import { describe, expect, it } from 'vitest';

import { rrfFuse, sparseRank, trigramSim, trigrams } from '../src/lib/retrieval.js';

describe('trigrams / trigramSim', () => {
  it('shares trigrams between a plural and its singular (Arabic)', () => {
    // "البوكسات" (the boxes) vs "بوكس الزوارة" — the reason pure token overlap
    // fails but trigram catches "بوكس".
    const sim = trigramSim(trigrams('البوكسات'), trigrams('بوكس الزوارة'));
    expect(sim).toBeGreaterThan(0.06);
  });
  it('scores an exact-name overlap high', () => {
    const sim = trigramSim(trigrams('عصير فراولة'), trigrams('عصير فراولة - صغير'));
    expect(sim).toBeGreaterThan(0.4);
  });
  it('scores unrelated strings ~0', () => {
    expect(trigramSim(trigrams('عصير فراولة'), trigrams('بان كيك تكميم'))).toBeLessThan(0.1);
  });
});

describe('sparseRank', () => {
  const docs = [
    { id: 'a', text: 'عصير فراولة - صغير' },
    { id: 'b', text: 'عصير فراولة - الوسط' },
    { id: 'c', text: 'بان كيك تكميم' },
    { id: 'd', text: 'بوكس الزوارة' },
  ];
  it('ranks the strawberry juices for a strawberry query', () => {
    const top = sparseRank('بدي عصير فراولة', docs, 10);
    expect(top.slice(0, 2).sort()).toEqual(['a', 'b']);
  });
  it('surfaces the box for a plural "boxes" query', () => {
    expect(sparseRank('شنو البوكسات عندكم', docs, 10)).toContain('d');
  });
  it('returns [] for an empty query', () => {
    expect(sparseRank('', docs, 10)).toEqual([]);
  });
});

describe('rrfFuse', () => {
  it('rewards items ranked well in either list', () => {
    // x is #1 in dense, absent in sparse; y is #1 in sparse, #3 in dense.
    const fused = rrfFuse([['x', 'a', 'y'], ['y', 'b']]);
    expect(fused[0]).toBe('y'); // strong in both beats strong in one
    expect(fused).toContain('x');
    expect(fused).toContain('b');
  });
  it('is order-stable and dedupes across lists', () => {
    const fused = rrfFuse([['a', 'b'], ['a', 'c']]);
    expect(fused[0]).toBe('a');
    expect(new Set(fused).size).toBe(fused.length);
  });
});
