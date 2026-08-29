// Unit tests for the segment evaluator. No DB needed — we just verify the
// AST → Prisma where translation matches what we expect for each clause type.
import { describe, expect, it } from 'vitest';

import { buildContactWhereForSegment } from '../src/modules/segments/segment-evaluator.js';

describe('segment evaluator', () => {
  it('returns base where for empty filter', () => {
    const w = buildContactWhereForSegment({ mode: 'all', clauses: [] });
    expect(w).toEqual({ deletedAt: null });
  });

  it('translates tag in [...]', () => {
    const w = buildContactWhereForSegment({
      mode: 'all',
      clauses: [{ field: 'tag', op: 'in', value: ['vip', 'beta'] }],
    });
    expect(w).toMatchObject({
      deletedAt: null,
      AND: [{ tags: { some: { tag: { in: ['vip', 'beta'] } } } }],
    });
  });

  it('translates tag not_in to NOT { some }', () => {
    const w = buildContactWhereForSegment({
      mode: 'all',
      clauses: [{ field: 'tag', op: 'not_in', value: ['blocked'] }],
    });
    expect(w).toMatchObject({
      AND: [{ NOT: { tags: { some: { tag: { in: ['blocked'] } } } } }],
    });
  });

  it('translates attribute eq to JSON path equals', () => {
    const w = buildContactWhereForSegment({
      mode: 'all',
      clauses: [{ field: 'attribute', key: 'loyalty', op: 'eq', value: 'gold' }],
    });
    expect(w).toMatchObject({
      AND: [{ attributes: { path: ['loyalty'], equals: 'gold' } }],
    });
  });

  it('translates last_inbound_at within_days to gte cutoff', () => {
    const w = buildContactWhereForSegment({
      mode: 'all',
      clauses: [{ field: 'last_inbound_at', op: 'within_days', value: 30 }],
    });
    const clause = (w.AND as { lastInboundAt: { gte: Date } }[])[0]!;
    expect(clause.lastInboundAt.gte).toBeInstanceOf(Date);
    // Roughly 30 days in the past.
    const diff = Date.now() - clause.lastInboundAt.gte.getTime();
    expect(diff).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(diff).toBeLessThan(31 * 24 * 60 * 60 * 1000);
  });

  it('uses OR when mode = any', () => {
    const w = buildContactWhereForSegment({
      mode: 'any',
      clauses: [
        { field: 'tag', op: 'in', value: ['a'] },
        { field: 'locale', op: 'eq', value: 'en' },
      ],
    });
    expect(w.OR).toBeDefined();
    expect(w.AND).toBeUndefined();
  });
});
