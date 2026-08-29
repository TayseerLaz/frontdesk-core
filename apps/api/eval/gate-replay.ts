// Replay the CURRENT grounding gate over recent real bot replies to measure the
// would-block rate AFTER the scanner precision fixes — the data that decides
// whether GROUNDING_GATE_MODE can move shadow → enforce. Unlike reading the
// stored hallucinations (computed by the scanner AT SEND TIME, before the
// fixes), this re-scans each reply with today's scanner.
//
//   cd apps/api; set -a; . ../../.env.production; set +a
//   ./node_modules/.bin/tsx --conditions=source eval/gate-replay.ts [--days 30] [--show]

import { prisma } from '@platform/db';

import { groundingGate } from '../src/lib/grounding-gate.js';
import type { ScanCandidates } from '../src/lib/provenance-scanner.js';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

async function main() {
  const days = argNum('days', 30);
  const show = process.argv.includes('--show');

  const rows = await prisma.$queryRawUnsafe<
    Array<{ org: string; slug: string; body: string; candidate_product_ids: string[]; cust_name: string | null }>
  >(
    `select mp.organization_id as org, o.slug, m.body, mp.candidate_product_ids,
            t.customer_whatsapp_name as cust_name
     from message_provenances mp
     join organizations o on o.id = mp.organization_id
     join whatsapp_messages m on m.id = mp.message_id
     left join whatsapp_threads t on t.id = m.thread_id
     where mp.created_at > now() - ($1 || ' days')::interval
       and m.body is not null and length(m.body) > 3`,
    String(days),
  );

  // The real gate checks against ctx.data.products — the FULL gathered catalog
  // (gatherBotData loads up to 600), NOT that turn's retrieved slice. So replay
  // against each org's full current catalog, or a cart-confirm reply listing a
  // real item that wasn't retrieved this turn would false-positive (a bug the
  // live gate doesn't have).
  const orgIds = [...new Set(rows.map((r) => r.org))];
  const candByOrg = new Map<string, ScanCandidates>();
  for (const orgId of orgIds) {
    const prods = await prisma.product.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { id: true, name: true, sku: true, priceMinor: true, currency: true },
      take: 600,
    });
    const biz = await prisma.businessInfo.findFirst({
      where: { organizationId: orgId },
      select: { currency: true },
    });
    candByOrg.set(orgId, {
      products: prods.map((p) => ({ id: p.id, name: p.name, sku: p.sku, priceMinor: p.priceMinor, currency: p.currency })),
      services: [],
      faqs: [],
      policies: [],
      biz: { legalName: null, websiteUrl: null, operatingHours: null, currency: biz?.currency ?? 'USD', menuUrl: null },
      config: { greeting: null },
      customer: null,
    });
  }

  const perTenant = new Map<string, { total: number; block: number }>();
  const samples: { slug: string; reason: string; body: string }[] = [];

  for (const r of rows) {
    const base = candByOrg.get(r.org)!;
    // Pass the thread's customer name so the replay reflects the live gate's
    // customer-name suppression (otherwise "…under Tayseer, total X" false-blocks).
    const candidates: ScanCandidates = r.cust_name
      ? { ...base, customer: { whatsappName: r.cust_name, operatorNickname: null } }
      : base;
    const gate = groundingGate(r.body, candidates, 'enforce');
    const t = perTenant.get(r.slug) ?? { total: 0, block: 0 };
    t.total++;
    if (gate.wouldBlock) {
      t.block++;
      if (samples.length < 25) samples.push({ slug: r.slug, reason: gate.reason ?? '', body: r.body.slice(0, 80) });
    }
    perTenant.set(r.slug, t);
  }

  const total = rows.length;
  const block = [...perTenant.values()].reduce((a, b) => a + b.block, 0);
  console.log(`\n=== grounding-gate replay (last ${days}d, CURRENT scanner) ===\n`);
  console.log(`  total replies : ${total}`);
  console.log(`  would-block   : ${block}  (${((100 * block) / Math.max(total, 1)).toFixed(2)}%)\n`);
  console.log('  per tenant:');
  for (const [slug, t] of [...perTenant.entries()].sort((a, b) => b[1].block - a[1].block)) {
    console.log(`    ${slug.padEnd(18)} ${t.block}/${t.total}  (${((100 * t.block) / Math.max(t.total, 1)).toFixed(1)}%)`);
  }
  if (show && samples.length) {
    console.log('\n  sample would-blocks:');
    for (const s of samples) console.log(`    [${s.slug}] ${s.reason}\n       “${s.body}”`);
  }
  await prisma.$disconnect();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
