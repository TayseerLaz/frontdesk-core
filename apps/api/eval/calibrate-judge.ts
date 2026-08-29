// Judge calibration — align the LLM judge to a human reviewer so the full eval
// run can become a HARD gate (not just advisory). Two steps ("critique
// shadowing", per the plan):
//
//   1) Generate a review file of real replies + the judge's verdict:
//        pnpm exec tsx --conditions=source eval/calibrate-judge.ts --generate --org aseer-time
//      → writes eval/labels/<slug>.json with "humanPass": null on each row.
//
//   2) A human fills each "humanPass" (true/false), then:
//        pnpm exec tsx --conditions=source eval/calibrate-judge.ts --org aseer-time
//      → reports precision, recall, and Cohen's κ of judge-vs-human. κ > 0.7 =
//        the judge is trustworthy; wire the full run into the deploy gate.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '@platform/db';

import { buildBotResponse, gatherBotData } from '../src/lib/bot-engine.js';

import { judgeReply } from './judge.js';
import { stripInternalMarkers } from './scorers.js';
import type { GoldenScenario } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface LabelRow {
  key: string;
  prompt: string;
  reply: string;
  judgePass: boolean | null;
  judgeCritique: string;
  /** Filled by a human reviewer: did this reply actually meet the criteria? */
  humanPass: boolean | null;
}

function money(minor: number | null, cur: string | null): string {
  if (minor == null) return '';
  const three = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'].includes(cur ?? '');
  return ` · ${(minor / (three ? 1000 : 100)).toFixed(three ? 3 : 2)} ${cur ?? ''}`.trimEnd();
}

async function generate(slug: string, orgId: string) {
  const golden = JSON.parse(readFileSync(join(HERE, 'golden', `${slug}.json`), 'utf8')) as GoldenScenario[];
  const rows: LabelRow[] = [];
  for (const sc of golden) {
    const data = await prisma.$transaction((tx) => gatherBotData(tx as never, orgId));
    const res = await buildBotResponse({
      organizationId: orgId,
      userMessage: sc.prompt,
      history: sc.history ?? [],
      data,
      replyMode: 'text',
      customerSpokeAudio: false,
      customerName: null,
      cartState: null,
      channelLabel: 'WhatsApp',
      temperature: 0,
    } as never);
    const reply = stripInternalMarkers(res.text);
    const facts = (res.inputs.candidateProductIds ?? [])
      .map((id: string) => data.products.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => `- ${p!.name}${money(p!.priceMinor ?? null, p!.currency ?? null)}`)
      .join('\n');
    const verdict = await judgeReply(sc, reply, facts || undefined);
    rows.push({
      key: sc.key,
      prompt: sc.prompt,
      reply,
      judgePass: verdict?.pass ?? null,
      judgeCritique: verdict?.critique ?? '',
      humanPass: null,
    });
  }
  const dir = join(HERE, 'labels');
  if (!existsSync(dir)) mkdirSync(dir);
  const out = join(dir, `${slug}.json`);
  writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`\nWrote ${rows.length} rows to ${out}.\nFill in each "humanPass" (true/false), then re-run without --generate.\n`);
}

function kappa(rows: { judgePass: boolean; humanPass: boolean }[]): {
  n: number;
  agreement: number;
  precision: number;
  recall: number;
  kappa: number;
} {
  const n = rows.length;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let agree = 0;
  let judgeYes = 0;
  let humanYes = 0;
  for (const r of rows) {
    if (r.judgePass === r.humanPass) agree++;
    if (r.judgePass) judgeYes++;
    if (r.humanPass) humanYes++;
    if (r.judgePass && r.humanPass) tp++;
    if (r.judgePass && !r.humanPass) fp++;
    if (!r.judgePass && r.humanPass) fn++;
  }
  const po = agree / n;
  const pJ = judgeYes / n;
  const pH = humanYes / n;
  const pe = pJ * pH + (1 - pJ) * (1 - pH);
  return {
    n,
    agreement: po,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    kappa: pe === 1 ? 1 : (po - pe) / (1 - pe),
  };
}

async function main() {
  const slug = arg('org') ?? 'aseer-time';
  const org = await prisma.organization.findFirst({ where: { slug }, select: { id: true } });
  if (!org) {
    console.error(`No org "${slug}"`);
    process.exit(2);
  }

  if (process.argv.includes('--generate')) {
    await generate(slug, org.id);
    await prisma.$disconnect();
    return;
  }

  const file = join(HERE, 'labels', `${slug}.json`);
  if (!existsSync(file)) {
    console.error(`No labels file at ${file}. Run with --generate first, then fill in humanPass.`);
    process.exit(2);
  }
  const rows = (JSON.parse(readFileSync(file, 'utf8')) as LabelRow[]).filter(
    (r): r is LabelRow & { judgePass: boolean; humanPass: boolean } =>
      typeof r.judgePass === 'boolean' && typeof r.humanPass === 'boolean',
  );
  if (rows.length === 0) {
    console.error('No rows with both judgePass and humanPass set — fill in humanPass first.');
    process.exit(2);
  }
  const m = kappa(rows);
  console.log(`\n=== judge calibration: ${slug} (n=${m.n}) ===\n`);
  console.log(`  agreement : ${(m.agreement * 100).toFixed(0)}%`);
  console.log(`  precision : ${(m.precision * 100).toFixed(0)}%  (of judge-pass, how many humans passed)`);
  console.log(`  recall    : ${(m.recall * 100).toFixed(0)}%  (of human-pass, how many judge passed)`);
  console.log(`  Cohen's κ : ${m.kappa.toFixed(2)}  ${m.kappa > 0.7 ? '✓ aligned (>0.7) — safe as a hard gate' : '✗ not aligned yet — refine the judge prompt / facts'}`);
  console.log('');
  await prisma.$disconnect();
}

void main().catch((e) => {
  console.error(e);
  process.exit(2);
});
