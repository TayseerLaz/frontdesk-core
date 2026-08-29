// One-off: correct provenance rows written BEFORE the prompt-cache token fix,
// where only the uncached input (the user message, ~9-228 tokens) was recorded
// instead of the true input (the full ~4,200-token system prompt was cached and
// dropped). We recompute the real input from each row's stored system-prompt
// snapshot + user prompt + history and update promptTokens. Cost then prices at
// the base rate (cache split left 0 — a fair mid-estimate for history; new rows
// carry the exact split going forward).
//
// Scope: rows where promptTokens is implausibly low for a cached-prompt model.
// Default targets hader-support; pass an org slug as argv[2] for another tenant,
// or "ALL" to sweep every org's Anthropic/OpenAI rows under the threshold.
//
//   cd /opt/aligned/app && set -a; . ./.env.production; set +a
//   pnpm --filter @platform/db exec tsx --conditions=source packages/db/scripts/backfill-provenance-tokens.ts [slug|ALL]
import { prisma } from '@platform/db';

// Mixed EN/AR system prompts run ~3.7 chars per token in practice (validated
// against a live count of ~4,247 tokens for the current hader-support prompt).
const CHARS_PER_TOKEN = 3.7;
const estTokens = (s: string) => Math.ceil((s?.length ?? 0) / CHARS_PER_TOKEN);

// Only touch rows this far below a real cached-prompt input — the pre-fix rows
// logged <300; genuine full-count rows are thousands. 1000 cleanly separates.
const UNDERCOUNT_THRESHOLD = 1000;

async function main() {
  const arg = process.argv[2] ?? 'hader-support';
  const orgFilter =
    arg === 'ALL'
      ? {}
      : { organizationId: (await slugToId(arg)) };

  const rows = await prisma.messageProvenance.findMany({
    where: {
      ...orgFilter,
      // Cached-prompt providers only (Groq basic has no cache, its counts are
      // already the full input).
      OR: [{ model: { contains: 'anthropic' } }, { model: { contains: 'gpt-4o' } }],
      promptTokens: { lt: UNDERCOUNT_THRESHOLD },
    },
    select: {
      id: true,
      promptTokens: true,
      userPrompt: true,
      historyJson: true,
      systemPromptSnapshotId: true,
    },
  });
  console.log(`Found ${rows.length} under-counted provenance row(s) to backfill.`);

  let updated = 0;
  for (const r of rows) {
    const snap = await prisma.systemPromptSnapshot.findUnique({
      where: { id: r.systemPromptSnapshotId },
      select: { body: true },
    });
    if (!snap) {
      console.log(`  SKIP ${r.id.slice(0, 8)} — snapshot missing`);
      continue;
    }
    let histLen = 0;
    try {
      histLen = JSON.stringify(r.historyJson ?? []).length;
    } catch {
      histLen = 0;
    }
    const trueInput = estTokens(snap.body) + estTokens(r.userPrompt) + Math.ceil(histLen / CHARS_PER_TOKEN);
    if (trueInput <= r.promptTokens) {
      console.log(`  SKIP ${r.id.slice(0, 8)} — recomputed ${trueInput} <= current ${r.promptTokens}`);
      continue;
    }
    await prisma.messageProvenance.update({
      where: { id: r.id },
      data: { promptTokens: trueInput },
    });
    updated += 1;
    console.log(`  ${r.id.slice(0, 8)}: promptTokens ${r.promptTokens} -> ${trueInput}`);
  }
  console.log(`Backfilled ${updated} row(s).`);
}

async function slugToId(slug: string): Promise<string> {
  const org = await prisma.organization.findFirst({ where: { slug }, select: { id: true } });
  if (!org) throw new Error(`org '${slug}' not found`);
  return org.id;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
