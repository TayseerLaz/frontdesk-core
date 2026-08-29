// Sprint 4 — quarterly audit log integrity check.
//
// Walks every per-org audit chain (and the global NULL-org chain) in order
// and confirms that for each row:
//   • the recomputed sha256(canonical(row) || prev_hash) === stored hash
//   • the stored prev_hash matches the previous row's stored hash
//
// Exit 0 on full integrity. Exit 1 on the first divergence (with details).
//
// Usage (from repo root):
//   pnpm --filter @platform/api exec tsx scripts/verify-audit-chain.ts
//
// Add to RUNBOOK.md quarterly checklist alongside secret rotation.
import { createHash } from 'node:crypto';

import { PrismaClient } from '@platform/db';

const CHR_UNIT_SEP = String.fromCharCode(31);
const prisma = new PrismaClient();

type Row = {
  id: string;
  organization_id: string | null;
  action: string;
  actor_user_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
  prev_hash: string | null;
  hash: string | null;
};

function canonicalize(row: Row, prevHash: string | null): string {
  return [
    row.id,
    row.organization_id ?? '',
    row.action,
    row.actor_user_id ?? '',
    row.entity_type ?? '',
    row.entity_id ?? '',
    // Postgres canonicalises JSONB key order alphabetically. JSON.stringify
    // does NOT — and the trigger uses metadata::text which is JSONB
    // canonical. So we re-serialise via the DB instead of trusting JS.
    typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata ?? null),
    row.ip_address ?? '',
    row.user_agent ?? '',
    (row.created_at.getTime() / 1000).toString(),
    prevHash ?? '',
  ].join(CHR_UNIT_SEP);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function main(): Promise<void> {
  // Fetch rows already canonicalised by Postgres (avoids JS/jsonb-text drift
  // and inet host() quirks). Each row arrives with prev_hash + hash + the
  // exact canonical string the trigger computed.
  const rows = (await prisma.$queryRawUnsafe(`
    SELECT
      id,
      organization_id,
      action::text AS action,
      actor_user_id,
      entity_type,
      entity_id,
      ip_address::text AS ip_address,
      user_agent,
      created_at,
      prev_hash,
      hash,
      audit_log_canonical(
        id, organization_id, action, actor_user_id,
        entity_type, entity_id, metadata, ip_address,
        user_agent, created_at, prev_hash
      ) AS canonical
    FROM audit_logs
    ORDER BY (organization_id IS NULL), organization_id, created_at, id
  `)) as Array<{
    id: string;
    organization_id: string | null;
    action: string;
    actor_user_id: string | null;
    entity_type: string | null;
    entity_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
    created_at: Date;
    prev_hash: string | null;
    hash: string | null;
    canonical: string;
  }>;

  const stats = {
    chainsSeen: 0,
    rowsChecked: 0,
    rowsWithoutHash: 0,
    breaks: [] as Array<{
      rowId: string;
      reason: string;
      expected: string | null;
      actual: string | null;
    }>,
  };

  // Walk in the same order the migration backfilled.
  let prevOrg: string | null | undefined;
  let prevHash: string | null = null;
  let firstInChain = true;

  for (const row of rows) {
    if (prevOrg === undefined || row.organization_id !== prevOrg) {
      stats.chainsSeen++;
      prevHash = null;
      firstInChain = true;
      prevOrg = row.organization_id;
    } else {
      firstInChain = false;
    }

    stats.rowsChecked++;
    if (!row.hash) {
      stats.rowsWithoutHash++;
      continue;
    }

    if (!firstInChain && row.prev_hash !== prevHash) {
      stats.breaks.push({
        rowId: row.id,
        reason: 'prev_hash does not match preceding row hash',
        expected: prevHash,
        actual: row.prev_hash,
      });
      // Keep walking — we want to surface every break, not just the first.
    }

    const expected = sha256(row.canonical);
    if (expected !== row.hash) {
      stats.breaks.push({
        rowId: row.id,
        reason: 'stored hash does not match recomputed canonical',
        expected,
        actual: row.hash,
      });
    }

    prevHash = row.hash;
  }

  console.log(
    `Audit chain check: ${stats.rowsChecked} rows / ${stats.chainsSeen} chains. ` +
      `Rows without hash (pre-trigger): ${stats.rowsWithoutHash}.`,
  );

  if (stats.breaks.length === 0) {
    console.log('✔ Chain intact.');
    await prisma.$disconnect();
    process.exit(0);
  }

  console.error(`✘ ${stats.breaks.length} integrity break(s):`);
  for (const b of stats.breaks.slice(0, 50)) {
    console.error(
      `  row=${b.rowId}\n    reason=${b.reason}\n    expected=${b.expected}\n    actual=${b.actual}`,
    );
  }
  if (stats.breaks.length > 50) {
    console.error(`  (… and ${stats.breaks.length - 50} more)`);
  }
  await prisma.$disconnect();
  process.exit(1);
}

main().catch((err) => {
  console.error('Verifier crashed:', err);
  prisma.$disconnect().finally(() => process.exit(2));
});
