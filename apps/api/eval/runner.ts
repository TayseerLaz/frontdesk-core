// Eval harness — CLI runner.
//
// Drives the REAL bot engine against a golden set and scores each reply on
// three axes: retrieval hit-rate (were the expected SKUs surfaced?),
// deterministic checks (hallucination / language / formatting — the REQUIRED
// gate), and a binary LLM judge (advisory). Prints a report and exits non-zero
// when the pass rate drops below --threshold, so it can gate CI / a deploy.
//
// Run from apps/api (needs the source condition so it imports TS, not stale dist):
//   set -a; . ../../.env.production; set +a   # or your staging env
//   ./node_modules/.bin/tsx --conditions=source eval/runner.ts --org aseer-time
//
// Flags:
//   --org <slug>        which org + golden set (default: aseer-time)
//   --retrieval-only    compileOnly: score retrieval hit-rate only, no LLM
//                       generation and no judge (cheap — embeddings only)
//   --no-judge          run generation + deterministic checks, skip the judge
//   --threshold <0..1>  min overall pass rate before exit 0 (default 0.8)
//   --json              emit the raw EvalSummary as JSON
//   --persist           write the run to the eval_runs table so it shows up on
//                       the /hq/eval dashboard (use on pre-deploy /
//                       manual runs against prod). --trigger / --note tag it.
//   --trigger <label>   'manual' | 'pre-deploy' | 'ci' | 'cli' (default cli)
//   --note <text>       free-text note stored with a persisted run

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '@platform/db';

import { buildBotResponse, formatOperatingHours, gatherBotData } from '../src/lib/bot-engine.js';
import { scanReply, type ScanCandidates } from '../src/lib/provenance-scanner.js';

import { judgeReply } from './judge.js';
import { scoreDeterministic, scoreRetrieval, stripInternalMarkers } from './scorers.js';
import type { EvalSummary, GoldenScenario, ScenarioResult } from './types.js';

function formatMoney(minor: number | null, currency: string | null): string {
  if (minor == null) return '';
  const threeDp = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'].includes(currency ?? '');
  const major = minor / (threeDp ? 1000 : 100);
  return ` · ${major.toFixed(threeDp ? 3 : 2)} ${currency ?? ''}`.trimEnd();
}

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// Build the scanner's candidate bundle from gatherBotData output (mirrors the
// kb the whatsapp route hands validateReply/recordProvenance).
function toScanCandidates(data: Awaited<ReturnType<typeof gatherBotData>>): ScanCandidates {
  return {
    products: data.products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      priceMinor: p.priceMinor ?? null,
      currency: p.currency ?? null,
    })),
    services: data.services.map((s) => ({
      id: s.id,
      name: s.name,
      basePriceMinor: s.basePriceMinor ?? null,
      currency: s.currency ?? null,
    })),
    faqs: data.faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
    policies: data.policies.map((p) => ({ kind: p.kind, title: p.title, content: p.content })),
    biz: data.biz
      ? {
          legalName: data.biz.legalName ?? null,
          websiteUrl: data.biz.websiteUrl ?? null,
          operatingHours: (data.biz as { operatingHours?: unknown }).operatingHours ?? null,
          currency: data.biz.currency ?? 'USD',
          menuUrl: data.shopForm?.menuUrl ?? null,
        }
      : null,
    config: { greeting: data.config?.greeting ?? null },
    customer: null,
  };
}

async function main() {
  const slug = arg('org') ?? 'aseer-time';
  const retrievalOnly = flag('retrieval-only');
  const noJudge = flag('no-judge');
  const threshold = Number(arg('threshold') ?? '0.8');

  // --plan basic|middle|max|ultra runs every scenario on THAT model tier instead
  // of each tenant's configured plan — the plan × tenant quality matrix.
  const plan = arg('plan') as 'basic' | 'middle' | 'max' | 'ultra' | undefined;
  if (plan) console.log(`\n  [plan override: ${plan}]`);
  const opts = { retrievalOnly, noJudge, plan };
  const startedAt = Date.now();

  // --all runs every tenant that has a golden set (eval/golden/*.json). This is
  // the point of the gate: a change that improves the average can silently
  // regress ONE tenant (a non-standard language, a tuned prompt), so we fail if
  // ANY tenant drops below threshold — never an average that hides it.
  const slugs = flag('all')
    ? readdirSync(join(HERE, 'golden'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort()
    : [slug];

  const summaries: EvalSummary[] = [];
  for (const s of slugs) {
    const summary = await runOrg(s, opts);
    if (!summary) continue;
    summaries.push(summary);
    if (flag('json')) console.log(JSON.stringify(summary, null, 2));
    else printReport(summary, retrievalOnly);
  }

  const rateOf = (su: EvalSummary) =>
    retrievalOnly
      ? su.retrievalScored === 0
        ? 1
        : su.retrievalHits / su.retrievalScored
      : su.total === 0
        ? 1
        : su.overallPass / su.total;
  const failures = summaries.filter((su) => rateOf(su) + 1e-9 < threshold);

  // --persist writes the run to eval_runs so it surfaces on /hq/eval.
  // Fail-soft: a persistence error must never change the gate's exit code.
  if (flag('persist') && summaries.length > 0) {
    try {
      await prisma.evalRun.create({
        data: {
          trigger: arg('trigger') ?? 'cli',
          mode: retrievalOnly ? 'retrieval' : 'full',
          threshold,
          passed: failures.length === 0,
          tenantCount: summaries.length,
          passedCount: summaries.length - failures.length,
          summaries: summaries as unknown as object,
          gitSha: process.env.EVAL_GIT_SHA ?? process.env.GITHUB_SHA ?? null,
          note: arg('note') ?? null,
          durationMs: Date.now() - startedAt,
        },
      });
      console.log('\n  ↳ persisted to eval_runs (visible on /hq/eval)');
    } catch (e) {
      console.error('  ↳ persist failed (gate result unaffected):', (e as Error).message);
    }
  }

  await prisma.$disconnect();

  if (summaries.length > 1) {
    console.log(
      `\n=== gate: ${summaries.length - failures.length}/${summaries.length} tenants passed (threshold ${threshold}) ===`,
    );
    for (const su of failures) console.log(`  ✗ ${su.org}: ${(rateOf(su) * 100).toFixed(0)}%`);
    if (failures.length === 0) console.log('  ✓ all tenants passed');
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

async function runOrg(
  slug: string,
  opts: { retrievalOnly: boolean; noJudge: boolean; plan?: 'basic' | 'middle' | 'max' | 'ultra' },
): Promise<EvalSummary | null> {
  const { retrievalOnly, noJudge } = opts;
  const org = await prisma.organization.findFirst({ where: { slug }, select: { id: true } });
  if (!org) {
    console.error(`(skip) no org with slug "${slug}"`);
    return null;
  }
  let golden: GoldenScenario[];
  try {
    golden = JSON.parse(readFileSync(join(HERE, 'golden', `${slug}.json`), 'utf8')) as GoldenScenario[];
  } catch {
    console.error(`(skip) no golden set file for "${slug}"`);
    return null;
  }

  const results: ScenarioResult[] = [];

  for (const sc of golden) {
    const data = await prisma.$transaction((tx) => gatherBotData(tx as never, org.id));
    const skuById = new Map(data.products.map((p) => [p.id, p.sku]));

    const res = await buildBotResponse({
      organizationId: org.id,
      userMessage: sc.prompt,
      history: sc.history ?? [],
      data,
      replyMode: 'text',
      customerSpokeAudio: false,
      customerName: null,
      cartState: null,
      channelLabel: 'WhatsApp',
      compileOnly: retrievalOnly,
      // Greedy decoding so a full run is reproducible — a regression gate must
      // not flip on sampling noise.
      temperature: 0,
      planOverride: opts.plan,
    } as never);

    const candidateSkus = (res.inputs.candidateProductIds ?? [])
      .map((id: string) => skuById.get(id))
      .filter((s): s is string => Boolean(s));

    const retrieval = scoreRetrieval(candidateSkus, sc.expectCitesSku);

    // Best (lowest) position of an expected SKU in the packed candidate list —
    // this is what a reranker moves: not "is it in the set" but "is it near the
    // top of what the model sees".
    const wantLower = (sc.expectCitesSku ?? []).map((s) => s.toLowerCase());
    const positions = wantLower
      .map((s) => candidateSkus.findIndex((c) => c.toLowerCase() === s))
      .filter((i) => i >= 0);
    const bestRank = positions.length > 0 ? Math.min(...positions) + 1 : null;

    // Score the CUSTOMER-FACING reply (markers stripped, as the send-path does),
    // not the engine's raw output.
    const customerReply = stripInternalMarkers(res.text);

    let deterministic = { passed: true, failures: [] as string[] };
    let judge;
    if (!retrievalOnly) {
      const scan = scanReply(res.text, toScanCandidates(data));
      deterministic = scoreDeterministic(customerReply, scan.hallucinations, sc);
      if (!noJudge) {
        // Ground-truth facts for the judge = the SAME knowledge the bot had:
        // candidate products (with FULL descriptions — nutrition/spec details
        // like "65g protein" live there), candidate services, candidate FAQs,
        // and business hours. Products-only + a 160-char cut used to wrongly flag
        // GROUNDED claims (protein grams from the description, opening hours from
        // Business Info, an FAQ-sourced answer) as invented hallucinations.
        const clean = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const factLines: string[] = [];
        for (const id of res.inputs.candidateProductIds ?? []) {
          const p = data.products.find((x) => x.id === id);
          if (!p) continue;
          const desc = clean(
            (p as { description?: string | null; shortDescription?: string | null }).description ??
              (p as { shortDescription?: string | null }).shortDescription ??
              '',
          ).slice(0, 400);
          factLines.push(`- ${p.name}${formatMoney(p.priceMinor ?? null, p.currency ?? null)}${desc ? ` — ${desc}` : ''}`);
        }
        for (const id of res.inputs.candidateServiceIds ?? []) {
          const s = data.services.find((x) => x.id === id);
          if (!s) continue;
          const desc = clean((s as { shortDescription?: string | null }).shortDescription ?? '').slice(0, 300);
          factLines.push(
            `- [service] ${s.name}${formatMoney(s.basePriceMinor ?? null, s.currency ?? null)}${desc ? ` — ${desc}` : ''}`,
          );
        }
        for (const id of res.inputs.candidateFaqIds ?? []) {
          const f = data.faqs.find((x) => x.id === id);
          if (!f) continue;
          factLines.push(`- [FAQ] Q: ${clean(f.question)} — A: ${clean(f.answer).slice(0, 300)}`);
        }
        if (data.biz) {
          const b = data.biz as { legalName?: string | null; operatingHours?: unknown };
          if (b.legalName) factLines.push(`- [business] Name: ${b.legalName}`);
          if (b.operatingHours) {
            const hrs = clean(formatOperatingHours(b.operatingHours));
            if (hrs) factLines.push(`- [business hours] ${hrs}`);
          }
        }
        // Locations + contact channels — the bot legitimately quotes a real
        // branch address or phone when asked "do you deliver to X / where are you";
        // without these the judge wrongly calls a real branch/phone "invented".
        for (const loc of data.locations ?? []) {
          const addr = [loc.addressLine1, loc.addressLine2, loc.city, loc.region, loc.country]
            .filter(Boolean)
            .join(', ');
          factLines.push(`- [location] ${loc.name}${addr ? ` — ${addr}` : ''}${loc.phone ? ` — tel ${loc.phone}` : ''}`);
        }
        for (const ch of data.contactChannels ?? []) {
          factLines.push(`- [contact] ${ch.kind}${ch.label ? ` (${ch.label})` : ''}: ${ch.value}`);
        }
        const facts = factLines.join('\n');
        judge = (await judgeReply(sc, customerReply, facts || undefined)) ?? undefined;
      }
    }

    results.push({
      key: sc.key,
      dialect: sc.dialect,
      reply: customerReply,
      candidateSkus,
      retrieval,
      bestRank,
      deterministic,
      judge,
      model: res.inputs.model,
    });
  }

  const retrievalScored = results.filter((r) => r.retrieval.expected > 0);
  const judgeScored = results.filter((r) => r.judge);
  return {
    org: slug,
    total: results.length,
    retrievalScored: retrievalScored.length,
    retrievalHits: retrievalScored.filter((r) => r.retrieval.hit).length,
    deterministicPass: results.filter((r) => r.deterministic.passed).length,
    judgeScored: judgeScored.length,
    judgePass: judgeScored.filter((r) => r.judge!.pass).length,
    overallPass: results.filter((r) => r.deterministic.passed && (!r.judge || r.judge.pass)).length,
    results,
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${Math.round((100 * n) / d)}%`.padStart(5);
}

function printReport(s: EvalSummary, retrievalOnly: boolean) {
  console.log(`\n=== eval: ${s.org} ${retrievalOnly ? '(retrieval-only)' : ''} ===\n`);
  for (const r of s.results) {
    const marks: string[] = [];
    marks.push(
      r.retrieval.expected === 0
        ? 'ret —'
        : r.retrieval.hit
          ? `ret ✓ @${r.bestRank ?? '?'}`
          : `ret ✗(${r.retrieval.missing.join(',')})`,
    );
    if (!retrievalOnly) {
      marks.push(r.deterministic.passed ? 'det ✓' : `det ✗(${r.deterministic.failures.join('; ')})`);
      if (r.judge) marks.push(r.judge.pass ? 'judge ✓' : `judge ✗(${r.judge.critique})`);
    }
    console.log(`  ${r.key.padEnd(30)} ${marks.join('  ')}`);
  }
  console.log('');
  const ranks = s.results.map((r) => r.bestRank).filter((n): n is number => n != null);
  const avgRank = ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1) : 'n/a';
  console.log(`  retrieval hit-rate : ${pct(s.retrievalHits, s.retrievalScored)}  (${s.retrievalHits}/${s.retrievalScored})`);
  console.log(`  avg best-rank      : ${avgRank.padStart(5)}  (position of the top expected item; lower = better)`);
  if (!retrievalOnly) {
    console.log(`  deterministic pass : ${pct(s.deterministicPass, s.total)}  (${s.deterministicPass}/${s.total})`);
    console.log(`  judge pass         : ${pct(s.judgePass, s.judgeScored)}  (${s.judgePass}/${s.judgeScored})`);
    console.log(`  OVERALL pass       : ${pct(s.overallPass, s.total)}  (${s.overallPass}/${s.total})`);
  }
  console.log('');
}

void main().catch((err) => {
  console.error(err);
  process.exit(2);
});
