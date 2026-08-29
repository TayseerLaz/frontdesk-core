// Phase 1 — LLM latency + prompt measurement.
//
// Pulls the last N MessageProvenance rows and reports:
//   • Provider distribution (is Groq actually firing?)
//   • Token percentiles (p50/p95/p99 for input + output)
//   • Latency percentiles
//   • System-prompt size distribution (chars + estimated tokens)
//   • Top 30 user messages by frequency — eyeball intent clusters
//   • A coarse "intent class" tag per message via lightweight regex
//
// Usage:
//   pnpm --filter @platform/api exec tsx scripts/measure-llm-latency.ts \
//     [--limit 500] [--days 7]
import { PrismaClient } from '@platform/db';

const prisma = new PrismaClient();

// Token estimator. Matches the conservative "chars / 4" estimate used in
// openai.ts so percentages here line up with what consumeDailyTokens charges.
const approxTokens = (s: string) => Math.ceil(s.length / 4);

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

// Crude intent tagging — buckets a user message so we can see which
// fraction of turns is FAQ-like vs cart-op vs free-form. Order matters:
// the first matching tag wins.
function classifyIntent(text: string): string {
  const t = text.toLowerCase().trim();
  if (t.length < 3) return 'noise';
  if (/^(hi|hello|hey|hola|bonjour|salam|salaam|مرحبا|اهلا|أهلاً|hala|halaa)\b/i.test(t)) return 'greeting';
  if (/(hours?|opening|closed?|open|when|time|الدوام|متى|متى تفتح|متى تسكر)/i.test(t)) return 'faq_hours';
  if (/(where|address|location|map|delivery|deliver|توصيل|ايد|اين|وين)/i.test(t)) return 'faq_location_delivery';
  if (/(phone|contact|number|whatsapp|تلفون|رقم)/i.test(t)) return 'faq_contact';
  if (/(price|cost|how much|كم|بكم|كم سعر)/i.test(t)) return 'faq_price';
  if (/(menu|list|catalog|what.*sell|what.*have|قائمة|منيو)/i.test(t)) return 'faq_menu';
  if (/^(yes|yep|yeah|sure|ok|okay|نعم|اي|تمام|اوكي|طيب|اوكيه)\b/i.test(t)) return 'confirm';
  if (/^(no|nope|nah|لا|مو|مش)\b/i.test(t)) return 'negate';
  if (/(add|i want|i'?ll have|give me|أبي|أريد|بدي|عاوز)/i.test(t)) return 'cart_add';
  if (/(remove|delete|cancel|احذف|الغي)/i.test(t)) return 'cart_remove';
  if (/(total|order|cart|checkout|الفاتورة|المجموع)/i.test(t)) return 'cart_total';
  if (/(speak|talk|human|agent|operator|تكلم|بدي اتكلم)/i.test(t)) return 'escalate';
  if (t.split(/\s+/).length <= 3) return 'short_freeform';
  return 'long_freeform';
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const args = process.argv.slice(2);
  const limit = Number(args[args.indexOf('--limit') + 1]) || 500;
  const days = Number(args[args.indexOf('--days') + 1]) || 7;

  console.log(`\n── LLM latency + prompt audit · last ${days} days, up to ${limit} rows ──\n`);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.messageProvenance.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      systemPromptSnapshot: { select: { body: true, sha256: true } },
      message: { select: { body: true } },
    },
  });

  if (rows.length === 0) {
    console.log('No provenance rows in window. Bot replies in the last ' + days + ' days produced none.');
    console.log('That usually means either the bot is disabled, or no messages came in.');
    await prisma.$disconnect();
    return;
  }

  // ── Provider + model split ─────────────────────────────────────────────
  const byModel = new Map<string, number>();
  for (const r of rows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);

  console.log(`── Provider / model split (${rows.length} rows) ──`);
  for (const [model, count] of [...byModel.entries()].sort((a, b) => b[1] - a[1])) {
    const looksLikeGroq = /llama|mixtral|gemma|qwen/i.test(model);
    const looksLikeOpenAI = /gpt|o1|o3/i.test(model);
    const tag = looksLikeGroq ? '← Groq' : looksLikeOpenAI ? '← OpenAI (SHOULD NOT BE USED)' : '';
    console.log(`  ${model.padEnd(40)} ${String(count).padStart(5)}  (${((count / rows.length) * 100).toFixed(1)}%) ${tag}`);
  }
  console.log();

  // ── Latency + token percentiles ────────────────────────────────────────
  const latency = rows.map((r) => r.latencyMs);
  const inTok = rows.map((r) => r.promptTokens);
  const outTok = rows.map((r) => r.completionTokens);

  console.log('── Latency (ms) ──');
  console.log(`  p50: ${pct(latency, 0.5).toLocaleString()}   p95: ${pct(latency, 0.95).toLocaleString()}   p99: ${pct(latency, 0.99).toLocaleString()}   max: ${Math.max(...latency).toLocaleString()}`);
  console.log();
  console.log('── Input tokens (TTFT-driving) ──');
  console.log(`  p50: ${pct(inTok, 0.5).toLocaleString()}   p95: ${pct(inTok, 0.95).toLocaleString()}   p99: ${pct(inTok, 0.99).toLocaleString()}   max: ${Math.max(...inTok).toLocaleString()}`);
  console.log();
  console.log('── Output tokens (generation-driving) ──');
  console.log(`  p50: ${pct(outTok, 0.5).toLocaleString()}   p95: ${pct(outTok, 0.95).toLocaleString()}   p99: ${pct(outTok, 0.99).toLocaleString()}   max: ${Math.max(...outTok).toLocaleString()}`);
  console.log();

  // ── System prompt size analysis ────────────────────────────────────────
  const uniquePrompts = new Map<string, { body: string; uses: number }>();
  for (const r of rows) {
    const sha = r.systemPromptSnapshot.sha256;
    const cur = uniquePrompts.get(sha);
    if (cur) cur.uses++;
    else uniquePrompts.set(sha, { body: r.systemPromptSnapshot.body, uses: 1 });
  }
  console.log(`── Distinct system prompts in window: ${uniquePrompts.size} ──`);
  for (const [sha, info] of [...uniquePrompts.entries()].sort((a, b) => b[1].uses - a[1].uses).slice(0, 5)) {
    const chars = info.body.length;
    const tokens = approxTokens(info.body);
    console.log(
      `  sha=${sha.slice(0, 10)}…  ${String(info.uses).padStart(4)} uses  ` +
        `${fmtBytes(chars).padStart(8)}  ~${tokens.toLocaleString().padStart(6)} tokens`,
    );
  }
  console.log();

  // ── Intent buckets ─────────────────────────────────────────────────────
  const intentCounts = new Map<string, number>();
  const intentSamples = new Map<string, string[]>();
  for (const r of rows) {
    const msg = r.userPrompt.trim();
    const intent = classifyIntent(msg);
    intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1);
    const samples = intentSamples.get(intent) ?? [];
    if (samples.length < 3 && !samples.includes(msg)) samples.push(msg);
    intentSamples.set(intent, samples);
  }

  console.log(`── Intent distribution (${rows.length} messages) ──`);
  const sorted = [...intentCounts.entries()].sort((a, b) => b[1] - a[1]);
  const fastPathCandidates = new Set([
    'greeting',
    'faq_hours',
    'faq_location_delivery',
    'faq_contact',
    'faq_menu',
    'confirm',
    'negate',
    'cart_remove',
    'cart_total',
    'escalate',
  ]);
  let fastPathTotal = 0;
  for (const [intent, count] of sorted) {
    const pctOfAll = ((count / rows.length) * 100).toFixed(1);
    const tag = fastPathCandidates.has(intent) ? ' ⚡ fast-path candidate' : '';
    console.log(`  ${intent.padEnd(24)} ${String(count).padStart(5)}  (${pctOfAll.padStart(5)}%)${tag}`);
    if (fastPathCandidates.has(intent)) fastPathTotal += count;
  }
  console.log();
  console.log(
    `  ⚡ Fast-path opportunity: ${fastPathTotal} of ${rows.length} turns (${((fastPathTotal / rows.length) * 100).toFixed(1)}%) ` +
      'could skip the LLM entirely if we built a deterministic intent path.',
  );
  console.log();

  // ── Sample user messages per intent (sanity check) ─────────────────────
  console.log('── Sample messages per intent (for sanity-checking the classifier) ──');
  for (const [intent, samples] of intentSamples) {
    if (samples.length === 0) continue;
    console.log(`  [${intent}]`);
    for (const s of samples) console.log(`    > ${s.length > 100 ? s.slice(0, 97) + '…' : s}`);
  }
  console.log();

  // ── Headline diagnosis ─────────────────────────────────────────────────
  const onGroq = [...byModel.entries()].filter(([k]) => /llama|mixtral|gemma|qwen/i.test(k)).reduce((s, [, c]) => s + c, 0);
  const onOpenAI = rows.length - onGroq;
  const medianInTok = pct(inTok, 0.5);
  const medianOutTok = pct(outTok, 0.5);
  const medianLat = pct(latency, 0.5);
  console.log('── Headline diagnosis ──');
  if (onOpenAI > 0) {
    console.log(`  ❌ ${onOpenAI} of ${rows.length} turns ran on OpenAI. Confirm GROQ_API_KEY is set in the runtime env and restart.`);
  } else {
    console.log(`  ✓ All ${rows.length} turns ran on Groq.`);
  }
  if (medianInTok > 4000) {
    console.log(`  ❌ Median input is ${medianInTok.toLocaleString()} tokens — that's the dominant TTFT driver. Prompt decomposition will move the needle here.`);
  } else if (medianInTok > 1500) {
    console.log(`  ⚠ Median input is ${medianInTok.toLocaleString()} tokens — there's room to trim but you're not starving.`);
  } else {
    console.log(`  ✓ Median input is ${medianInTok.toLocaleString()} tokens — already lean.`);
  }
  console.log(`  Median reply: ${medianOutTok} tokens / ${medianLat} ms. Tightening max_tokens to ~${Math.ceil(medianOutTok * 1.5)} would not affect typical replies.`);
  console.log(
    `  ${((fastPathTotal / rows.length) * 100).toFixed(0)}% of turns are deterministic-looking → building the intent fast-path saves ` +
      `${((fastPathTotal / rows.length) * medianLat / 1000).toFixed(1)}s of LLM time per ` +
      `${rows.length} turns at current latency.`,
  );
  console.log();

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('measure-llm-latency crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
