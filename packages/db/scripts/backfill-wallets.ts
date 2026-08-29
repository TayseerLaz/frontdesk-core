// One-time backfill: give every existing organization a TenantWallet at the
// $0.08 default per-message price, with METERING OFF so nothing breaks.
//
// The wallet is otherwise created lazily (on the first HQ top-up / price set),
// and a tenant with no wallet already reads as unmetered at the $0.08 default.
// This backfill just materializes the rows so the ALIGNED admin panel and the
// tenant Billing page show a concrete wallet from day one.
//
// Idempotent: skips orgs that already have a wallet. Safe to re-run.
//   pnpm --filter @platform/db exec tsx scripts/backfill-wallets.ts
import { PrismaClient } from '@prisma/client';

const DEFAULT_PRICE_MICROS = 80_000n; // $0.08
const DEFAULT_META_COST_MICROS = 37_500n; // $0.0375

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const orgs = await prisma.$queryRawUnsafe<{ id: string; slug: string }[]>(
      `SELECT o.id, o.slug FROM organizations o
        WHERE NOT EXISTS (SELECT 1 FROM tenant_wallets w WHERE w.organization_id = o.id)`,
    );
    if (orgs.length === 0) {
      console.log('[backfill-wallets] all organizations already have a wallet — nothing to do.');
      return;
    }
    for (const o of orgs) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenant_wallets
           (id, organization_id, available_micros, held_micros, price_per_message_micros,
            metering_enabled, low_balance_threshold_micros, meta_cost_micros,
            lifetime_topped_up_micros, lifetime_spent_micros, lifetime_messages, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, 0, 0, $2, false, 0, $3, 0, 0, 0, now(), now())
         ON CONFLICT (organization_id) DO NOTHING`,
        o.id,
        DEFAULT_PRICE_MICROS,
        DEFAULT_META_COST_MICROS,
      );
      console.log(`[backfill-wallets] created wallet for ${o.slug} ($0.08, metering OFF)`);
    }
    console.log(`[backfill-wallets] done — ${orgs.length} wallet(s) created.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[backfill-wallets] failed:', err);
  process.exit(1);
});
