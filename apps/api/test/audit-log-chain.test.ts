// Sprint 4 — tamper-evident audit log integration tests.
//
// Properties under test:
//   1. Every insert via recordAudit() lands with hash + prev_hash populated.
//   2. The chain is contiguous per-org (row N's prev_hash === row N-1's hash).
//   3. Hashes are deterministic — recomputing the canonical string and
//      hashing it matches what the trigger stored.
//   4. Editing a stored hash breaks verification on the NEXT row in the
//      chain (i.e. tamper detection cascades).
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { recordAudit } from '../src/lib/audit.js';
import { seedOrgAndLogin } from './helpers.js';
import { prisma } from './setup.js';

const CHR_UNIT_SEP = String.fromCharCode(31);

type RawRow = {
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
};

async function fetchOrgChain(orgId: string): Promise<RawRow[]> {
  return (await prisma.$queryRawUnsafe(
    `SELECT id, organization_id, action::text AS action, actor_user_id,
            entity_type, entity_id, ip_address::text AS ip_address,
            user_agent, created_at, prev_hash, hash,
            audit_log_canonical(
              id, organization_id, action, actor_user_id,
              entity_type, entity_id, metadata, ip_address,
              user_agent, created_at, prev_hash
            ) AS canonical
     FROM audit_logs
     WHERE organization_id = $1::uuid
     ORDER BY created_at, id`,
    orgId,
  )) as RawRow[];
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('audit log hash chain', () => {
  it('fills prev_hash + hash on every row, contiguous per-org', async () => {
    const a = await seedOrgAndLogin((await import('./setup.js')).getApp(), 'audit-chain-a');

    // Write three explicit audit entries — seedOrgAndLogin already wrote some.
    await recordAudit({ action: 'user_updated', organizationId: a.orgId, actorUserId: a.userId });
    await recordAudit({ action: 'user_updated', organizationId: a.orgId, actorUserId: a.userId });
    await recordAudit({ action: 'user_updated', organizationId: a.orgId, actorUserId: a.userId });

    const rows = await fetchOrgChain(a.orgId);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.hash).toMatch(/^[0-9a-f]{64}$/);

    // Contiguity: row[N].prev_hash === row[N-1].hash.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.prev_hash).toBe(rows[i - 1]?.hash ?? null);
    }

    // First row: prev_hash should be NULL for a freshly-truncated table.
    expect(rows[0]?.prev_hash).toBeNull();
  });

  it('the stored hash equals sha256(canonical-from-postgres)', async () => {
    const a = await seedOrgAndLogin((await import('./setup.js')).getApp(), 'audit-chain-recompute');
    await recordAudit({ action: 'user_updated', organizationId: a.orgId, actorUserId: a.userId });

    const rows = await fetchOrgChain(a.orgId);
    for (const r of rows) {
      const recomputed = sha256(r.canonical);
      expect(recomputed).toBe(r.hash);
    }
  });

  it('tampering with a row hash breaks the chain on the very next row', async () => {
    const a = await seedOrgAndLogin((await import('./setup.js')).getApp(), 'audit-chain-tamper');
    await recordAudit({ action: 'user_updated', organizationId: a.orgId, actorUserId: a.userId });
    await recordAudit({ action: 'user_updated', organizationId: a.orgId, actorUserId: a.userId });
    await recordAudit({ action: 'user_updated', organizationId: a.orgId, actorUserId: a.userId });

    const before = await fetchOrgChain(a.orgId);
    expect(before.length).toBeGreaterThanOrEqual(3);

    // Tamper: overwrite the hash on row[1] (an existing chain row, NOT the
    // last one so we can observe the cascade).
    const targetRow = before[1]!;
    const nextRow = before[2]!;
    await prisma.$executeRawUnsafe(
      `UPDATE audit_logs SET hash = 'deadbeef' || repeat('0', 56) WHERE id = $1::uuid`,
      targetRow.id,
    );

    const after = await fetchOrgChain(a.orgId);
    const after1 = after.find((r) => r.id === targetRow.id)!;
    const after2 = after.find((r) => r.id === nextRow.id)!;

    // The row we tampered with no longer matches its own recomputed hash.
    expect(after1.hash).not.toBe(sha256(after1.canonical));
    // AND the next row's stored prev_hash no longer matches the tampered
    // row's (now-mutated) hash — proving the cascade detection works.
    expect(after2.prev_hash).not.toBe(after1.hash);
  });
});
