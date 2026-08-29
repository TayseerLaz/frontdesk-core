// Phase 4 — Segment evaluator.
// Converts the segment filter AST (validated by Zod in shared) into a Prisma
// `where` clause for the Contact model. Used by:
//   - GET /segments/:id/preview — count + sample rows
//   - Broadcast fanout worker — materializing recipients from a segment
//
// The evaluator only emits filters that join on the Contact model itself or
// its `tags` relation, so it stays inside a single tenant transaction with
// `app.current_org_id` already set (RLS adds tenant scoping for free).
import type { Prisma } from '@platform/db';
import type { SegmentClause, SegmentFilter } from '@platform/shared';

function clauseToWhere(clause: SegmentClause): Prisma.ContactWhereInput {
  switch (clause.field) {
    case 'tag': {
      if (clause.op === 'in') {
        return { tags: { some: { tag: { in: clause.value } } } };
      }
      // not_in: contacts that have NO tag from the list. Use NOT { some }.
      return { NOT: { tags: { some: { tag: { in: clause.value } } } } };
    }
    case 'attribute': {
      // Postgres JSONB path filter. Prisma exposes `path` + `equals|string_contains`.
      // For `eq` we use equals on the string; for `contains` we use string_contains;
      // for `neq` we wrap in NOT.
      if (clause.op === 'contains') {
        return {
          attributes: { path: [clause.key], string_contains: clause.value },
        };
      }
      const eq: Prisma.ContactWhereInput = {
        attributes: { path: [clause.key], equals: clause.value },
      };
      return clause.op === 'neq' ? { NOT: eq } : eq;
    }
    case 'locale': {
      const eq: Prisma.ContactWhereInput = { locale: clause.value };
      return clause.op === 'neq' ? { NOT: eq } : eq;
    }
    case 'last_inbound_at': {
      const cutoff = new Date(Date.now() - clause.value * 24 * 60 * 60 * 1000);
      if (clause.op === 'within_days') {
        return { lastInboundAt: { gte: cutoff } };
      }
      return {
        OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: cutoff } }],
      };
    }
    case 'source': {
      const eq: Prisma.ContactWhereInput = { source: clause.value };
      return clause.op === 'neq' ? { NOT: eq } : eq;
    }
  }
}

export function buildContactWhereForSegment(filter: SegmentFilter): Prisma.ContactWhereInput {
  const base: Prisma.ContactWhereInput = { deletedAt: null };
  if (!filter.clauses || filter.clauses.length === 0) return base;
  const clauses = filter.clauses.map(clauseToWhere);
  if (filter.mode === 'any') {
    return { ...base, OR: clauses };
  }
  return { ...base, AND: clauses };
}
