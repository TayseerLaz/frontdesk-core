// Sales Scan — the summary pipeline.
//
// Runs in the API process (not the worker) for the reason the review recorded: both
// dependencies of this pipeline — `complete()` and the clustering/embedding helpers —
// live in `apps/api`, and there is no worker->API business-logic RPC anywhere in this
// repo. A tick is also the only trigger that survives the thing it depends on being
// down: a window whose LLM call failed is simply still due on the next pass.
//
// When a capture window closes (`endedAt` set) this produces the one artifact the
// tenant actually sees — the `SalesScanSummary` row the portal already renders.
//
// The order of the stages is a privacy decision, not an implementation detail:
//
//   1. LOAD the window (background job -> `withRlsBypass` + an explicit
//      `organizationId` filter; there is no request, so there is no tenant context).
//   2. COUNT deterministically. Every number the tenant sees is computed in code. No
//      model is ever asked for a statistic it could hallucinate.
//   3. CLUSTER LOCALLY (sales-clustering.ts). Blocker B6: the raw corpus must never be
//      embedded or shipped anywhere wholesale. Nothing in stage 3 makes a network call.
//   4. ANSWER each cluster from the tenant's OWN next outbound message. Blocker B7:
//      verbatim text in the summary comes only from `direction === 'out'`.
//   5. ONE LLM call, given a digest ONLY: cluster keyword bags (every token seen in >= 2
//      distinct messages) + counts + a bucketed sample of the tenant's OUTBOUND
//      messages. No inbound message body is in the prompt. Everything placed in the
//      prompt is run through `stripPaymentCredentials` again — bodies were stripped at
//      insert, this is the belt to that braces.
//   6. UPSERT the row (unique on grantId), with model + token counts + priced cost. A
//      failure writes `status: 'failed'` carrying the deterministic half, because a
//      tenant staring at a spinner forever is worse than a partial report.
//
// The corpus is payment-credential-stripped. It is NOT anonymised, redacted or
// pseudonymised, and no string in this file may say otherwise (blocker B7 / M1).

import type { Prisma } from '@platform/db';
import { z } from 'zod';

import { salesScanSummaryPayloadSchema } from '@platform/shared';
import type { SalesScanSummaryPayload } from '@platform/shared';

import { costUsdWithCache } from './ai-pricing.js';
import { withRlsBypass } from './db.js';
import { env } from './env.js';
import { complete } from './openai.js';
import {
  clusterInboundQuestions,
  computeSalesStats,
  pickOutboundSamples,
  scriptMix,
  truncateWords,
} from './sales-clustering.js';
import type { SalesMessageForAnalysis, SalesQuestionCluster } from './sales-clustering.js';
import { stripPaymentCredentials } from './sales-scan-ingest.js';

const INTERVAL_MS = Number(process.env.SALES_INSIGHT_TICK_INTERVAL_MS ?? 2 * 60 * 1000);
/** Grants summarised per pass. Small on purpose: each one is a paid LLM call. */
const GRANTS_PER_TICK = Number(process.env.SALES_INSIGHT_PER_TICK ?? 3);
/** A `pending` row older than this lost its worker (deploy, crash) — reclaim it. */
const STALE_CLAIM_MS = 15 * 60 * 1000;
/** How long before we retry a summary that failed WITHOUT spending any tokens. */
const FAILED_RETRY_MS = 6 * 60 * 60 * 1000;
/** Hard ceiling on rows loaded for one window. */
const MAX_MESSAGES = 20_000;
/** Below this many outbound messages there is no voice to analyse — skip the LLM. */
const MIN_OUTBOUND_FOR_LLM = 3;
/** Topics surfaced in the payload. */
const MAX_TOPICS = 12;
/** Total prompt budget for outbound samples, in characters. */
const MAX_SAMPLE_CHARS = 12_000;

// ---------------------------------------------------------------------------
// The one LLM call — strict JSON, validated locally before it is trusted
// ---------------------------------------------------------------------------

export const insightVoiceSchema = z.object({
  headline: z.string().min(1).max(400),
  voiceProfile: z.object({
    tone: z.string().max(200).default(''),
    formality: z.string().max(200).default(''),
    languages: z.array(z.string().max(60)).max(8).default([]),
    greetings: z.array(z.string().max(200)).max(10).default([]),
    signOffs: z.array(z.string().max(200)).max(10).default([]),
    habits: z.array(z.string().max(300)).max(12).default([]),
  }),
  /**
   * Naming the locally-built clusters. Optional: a missing or malformed entry falls
   * back to the deterministic keyword label, so a bad model response degrades the
   * wording and never the report.
   */
  topics: z
    .array(z.object({ id: z.string().max(16), question: z.string().min(1).max(200) }))
    .max(40)
    .default([]),
});

const SYSTEM_PROMPT = [
  'You analyse how a small business writes to its customers on WhatsApp.',
  '',
  'You are given ONLY:',
  '- aggregate statistics for one capture window,',
  '- topic clusters described by KEYWORDS (never the customer messages themselves),',
  '- a sample of the BUSINESS\'S OWN outbound messages, bucketed by where they occurred.',
  '',
  'Rules:',
  '1. Reply with a single JSON object and nothing else. No prose, no markdown, no code fences.',
  '2. Every value must be supported by the input. If a field has no evidence, use an empty',
  '   string or an empty array. Never invent a greeting, a habit or a language.',
  '3. "greetings" and "signOffs" must be COPIED VERBATIM from the outbound samples —',
  '   exact strings, in the original language and script, not translations or paraphrases.',
  '4. "habits" are short, concrete, observable writing habits (for example: "sends prices as',
  '   a bare number", "uses voice-note style short lines", "always confirms the order back").',
  '5. "tone" and "formality" are short phrases, not paragraphs.',
  '6. "languages" names the languages actually used (include transliterated forms such as',
  '   "Arabizi / Latin-script Arabic" when the samples show it).',
  '7. For each topic id you are given, write "question" as the short customer question those',
  '   keywords represent, phrased in the language of the keywords. Do not invent topic ids.',
  '8. "headline" is one sentence a shop owner would find useful about this window.',
  '',
  'Schema:',
  '{"headline":string,"voiceProfile":{"tone":string,"formality":string,"languages":string[],',
  '"greetings":string[],"signOffs":string[],"habits":string[]},',
  '"topics":[{"id":string,"question":string}]}',
].join('\n');

/** Everything placed in a prompt goes through the stripper again. Defence in depth. */
function scrub(text: string): string {
  return stripPaymentCredentials(text) ?? '';
}

/**
 * The ENTIRE payload that leaves the box. Exported so a test can assert the property
 * this feature lives or dies on: no inbound message body appears anywhere in it.
 */
export function buildInsightDigest(args: {
  stats: ReturnType<typeof computeSalesStats>;
  clusters: SalesQuestionCluster[];
  samples: ReturnType<typeof pickOutboundSamples>;
}): string {
  const { stats, clusters, samples } = args;
  const mix = scriptMix([...samples.openers, ...samples.middles, ...samples.closers]);

  const lines: string[] = [];
  lines.push('WINDOW STATISTICS');
  lines.push(`- conversations: ${stats.conversations}`);
  lines.push(`- messages from customers: ${stats.inbound}`);
  lines.push(`- messages from the business: ${stats.outbound}`);
  lines.push(
    `- median first-reply time: ${
      stats.medianReplyMinutes === null ? 'unknown' : `${stats.medianReplyMinutes} minutes`
    }`,
  );
  lines.push(
    `- script mix of the business's own messages: ${Math.round(mix.arabicShare * 100)}% Arabic script, ${Math.round(
      mix.latinShare * 100,
    )}% Latin script`,
  );
  lines.push('');
  lines.push('TOPIC CLUSTERS (keywords only — customer wording is deliberately withheld)');
  if (clusters.length === 0) {
    lines.push('- none');
  } else {
    for (const c of clusters) {
      lines.push(`- ${c.id} | asked ${c.count}x | keywords: ${scrub(c.keywords.join(', '))}`);
    }
  }

  // Outbound buckets, trimmed to the prompt budget.
  let budget = MAX_SAMPLE_CHARS;
  const bucket = (title: string, items: string[]): void => {
    lines.push('');
    lines.push(title);
    if (items.length === 0) {
      lines.push('- none');
      return;
    }
    let used = 0;
    for (const item of items) {
      const text = scrub(item).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (budget - text.length < 0) break;
      budget -= text.length;
      used++;
      lines.push(`- ${text}`);
    }
    if (used === 0) lines.push('- none');
  };

  bucket("THE BUSINESS'S OWN FIRST MESSAGES IN A CHAT (greetings live here)", samples.openers);
  bucket("THE BUSINESS'S OWN LAST MESSAGES IN A CHAT (sign-offs live here)", samples.closers);
  bucket("THE BUSINESS'S OWN MID-CHAT REPLIES (tone and habits live here)", samples.middles);

  return lines.join('\n');
}

/** Pull the JSON object out of a model reply. `parseJsonLoose` in openai.ts is private. */
export function parseInsightJson(raw: string): unknown {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s) as unknown;
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

const EMPTY_VOICE = {
  tone: '',
  formality: '',
  languages: [] as string[],
  greetings: [] as string[],
  signOffs: [] as string[],
  habits: [] as string[],
};

function buildTopQuestions(
  clusters: SalesQuestionCluster[],
  namedById: Map<string, string>,
): SalesScanSummaryPayload['topQuestions'] {
  return clusters.map((c) => ({
    question: namedById.get(c.id) ?? c.label,
    count: c.count,
    // Outbound-only verbatim, re-stripped on the way out.
    bestAnswer: c.bestAnswer ? truncateWords(scrub(c.bestAnswer), 400) : null,
  }));
}

// ---------------------------------------------------------------------------
// One grant
// ---------------------------------------------------------------------------

interface DueGrant {
  id: string;
  organizationId: string;
  messageCount: number;
}

type Log = {
  info: (o: unknown, m: string) => void;
  warn: (o: unknown, m: string) => void;
  error: (o: unknown, m: string) => void;
};

async function loadWindow(grant: DueGrant): Promise<SalesMessageForAnalysis[]> {
  // Explicit `select`: this pipeline is the one place the raw corpus is read in bulk, so
  // it names exactly the columns it needs. `counterpartyPhoneEnc` is deliberately NOT
  // among them — the decryptable phone exists only for the tenant's own CSV export, and
  // must never be within reach of a code path that builds a model prompt.
  const rows = await withRlsBypass((tx) =>
    tx.salesMessage.findMany({
      where: { organizationId: grant.organizationId, grantId: grant.id },
      select: {
        id: true,
        direction: true,
        body: true,
        sentAt: true,
        counterpartyHash: true,
        isGroup: true,
        kind: true,
      },
      orderBy: { sentAt: 'asc' },
      take: MAX_MESSAGES,
    }),
  );
  return rows.map(
    (r) =>
      ({
        id: r.id,
        direction: r.direction === 'out' ? 'out' : 'in',
        body: r.body,
        sentAt: r.sentAt,
        counterpartyHash: r.counterpartyHash,
        // Groups are captured alongside DMs; the consumers below exclude them from
        // clustering deliberately rather than by accident.
        isGroup: r.isGroup,
        kind: r.kind,
      }) satisfies SalesMessageForAnalysis,
  );
}

async function summariseGrant(grant: DueGrant, log: Log): Promise<void> {
  const messages = await loadWindow(grant);
  const stats = computeSalesStats(messages);

  // Clustering + answers run on DMs only: a group's inbound messages are cross-talk
  // between many senders, not enquiries to the business, and mixing them in would both
  // inflate topic counts and pair a question with an unrelated person's reply.
  const dm = messages.filter((m) => !m.isGroup);
  // Only the topics we are going to show are worth naming, so the same slice feeds the
  // digest and the payload — the model never sees an id that cannot be rendered.
  const clusters = clusterInboundQuestions(dm).slice(0, MAX_TOPICS);
  const samples = pickOutboundSamples(messages);

  const deterministicQuestions = buildTopQuestions(clusters, new Map());
  let payload: SalesScanSummaryPayload = salesScanSummaryPayloadSchema.parse({
    headline: deterministicHeadline(stats, grant.messageCount, deterministicQuestions.length),
    voiceProfile: EMPTY_VOICE,
    topQuestions: deterministicQuestions,
    stats,
  });

  let model: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let status = 'ready';

  const outboundSampled =
    samples.openers.length + samples.closers.length + samples.middles.length;

  if (stats.outbound >= MIN_OUTBOUND_FOR_LLM && outboundSampled > 0) {
    try {
      const digest = buildInsightDigest({ stats, clusters, samples });
      const res = await complete({
        organizationId: grant.organizationId,
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: digest }],
        maxTokens: 1200,
        temperature: 0.2,
      });
      model = res.model;
      promptTokens = res.inputTokens;
      completionTokens = res.outputTokens;
      cacheReadTokens = res.cacheReadTokens;
      cacheWriteTokens = res.cacheWriteTokens;

      const parsed = insightVoiceSchema.parse(parseInsightJson(res.text));
      const named = new Map<string, string>();
      for (const t of parsed.topics) {
        // Only ids we generated; a hallucinated id is dropped, never rendered.
        if (clusters.some((c) => c.id === t.id)) named.set(t.id, t.question.trim());
      }
      payload = salesScanSummaryPayloadSchema.parse({
        headline: parsed.headline.trim(),
        voiceProfile: parsed.voiceProfile,
        topQuestions: buildTopQuestions(clusters, named),
        stats,
      });
    } catch (err) {
      // The deterministic half is already in `payload`; keep it and mark the row failed
      // so the state is honest and (when no tokens were spent) retryable.
      status = 'failed';
      log.error(
        { grantId: grant.id, err },
        '[sales-scan] voice analysis failed — storing deterministic summary only',
      );
    }
  }

  const costUsd = model
    ? costUsdWithCache(model, promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens)
    : 0;

  await withRlsBypass((tx) =>
    tx.salesScanSummary.update({
      where: { grantId: grant.id },
      data: {
        payload: payload as unknown as Prisma.InputJsonObject,
        status,
        model,
        promptTokens,
        completionTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costMicros: BigInt(Math.round(costUsd * 1_000_000)),
        messagesAnalyzed: stats.messagesAnalyzed,
        generatedAt: new Date(),
      },
    }),
  );

  log.info(
    {
      grantId: grant.id,
      status,
      messagesAnalyzed: stats.messagesAnalyzed,
      topics: payload.topQuestions.length,
      model,
      costUsd: Number(costUsd.toFixed(6)),
    },
    '[sales-scan] summary generated',
  );
}

/**
 * Headline for the paths where no model runs, and the fallback when one fails.
 *
 * The "messages were deleted" case matters: a tenant who used "delete everything" and
 * then saw "no messages were captured" would reasonably conclude the capture never
 * worked. `grant.messageCount` is the counter the ingest receiver kept, so we can tell
 * the two apart.
 */
function deterministicHeadline(
  stats: ReturnType<typeof computeSalesStats>,
  capturedCounter: number,
  topics: number,
): string {
  if (stats.messagesAnalyzed === 0) {
    return capturedCounter > 0
      ? 'The captured messages were deleted before a summary could be generated.'
      : 'No messages were captured during this window.';
  }
  const parts = [
    `${stats.messagesAnalyzed} messages across ${stats.conversations} chats`,
    topics > 0 ? `${topics} recurring topics` : null,
    stats.medianReplyMinutes !== null
      ? `median first reply ${stats.medianReplyMinutes} min`
      : null,
  ].filter((p): p is string => p !== null);
  return `${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Due-work selection + claiming
// ---------------------------------------------------------------------------

/**
 * A window is due when it has ended, it actually linked (a grant that never linked
 * captured nothing, so a summary would be noise), and it has no usable summary yet.
 *
 * The retry rules are deliberately asymmetric:
 *   * `pending` older than STALE_CLAIM_MS — a previous pass died mid-flight. Free to retry.
 *   * `failed` with zero prompt tokens — the provider never answered, so a retry costs
 *     nothing that was already paid for. Retried after FAILED_RETRY_MS.
 *   * `failed` WITH tokens spent — the call happened and produced something unusable.
 *     Not retried automatically: an unattended loop that bills a tenant every few hours
 *     for the same broken response is worse than a stale report an operator can see.
 */
async function findDue(now: Date): Promise<DueGrant[]> {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const retryBefore = new Date(now.getTime() - FAILED_RETRY_MS);
  return withRlsBypass((tx) =>
    tx.salesScanGrant.findMany({
      where: {
        endedAt: { not: null },
        linkedAt: { not: null },
        OR: [
          { summary: { is: null } },
          { summary: { status: 'pending', updatedAt: { lt: staleBefore } } },
          { summary: { status: 'failed', promptTokens: 0, updatedAt: { lt: retryBefore } } },
        ],
      },
      select: { id: true, organizationId: true, messageCount: true },
      orderBy: { endedAt: 'asc' },
      take: GRANTS_PER_TICK,
    }),
  );
}

/**
 * Claim the grant by taking its summary row. The unique index on `grantId` is the lock:
 * if another API instance is mid-flight on the same window, one of the two upserts loses
 * and that pass simply skips it.
 */
async function claim(grant: DueGrant, log: Log): Promise<boolean> {
  try {
    await withRlsBypass((tx) =>
      tx.salesScanSummary.upsert({
        where: { grantId: grant.id },
        create: {
          organizationId: grant.organizationId,
          grantId: grant.id,
          payload: {} as Prisma.InputJsonObject,
          status: 'pending',
          messagesAnalyzed: 0,
        },
        update: { status: 'pending' },
      }),
    );
    return true;
  } catch (err) {
    // A lost race (unique violation on grantId) is the expected, boring outcome and is
    // not worth a log line. Anything else means the DB is unhappy, and swallowing that
    // silently is how a pipeline ends up looking alive while producing nothing.
    const code = (err as { code?: string }).code;
    if (code !== 'P2002') {
      log.warn({ grantId: grant.id, err }, '[sales-scan] could not claim summary row');
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

async function sweep(log: Log): Promise<void> {
  const due = await findDue(new Date());
  for (const grant of due) {
    if (!(await claim(grant, log))) continue;
    try {
      await summariseGrant(grant, log);
    } catch (err) {
      // Reaching here means even the deterministic path failed (DB trouble, an
      // impossible payload). Record the failure so the row is not left `pending`
      // forever, and let the next sweep decide whether to retry.
      log.error({ grantId: grant.id, err }, '[sales-scan] summary generation failed');
      await withRlsBypass((tx) =>
        tx.salesScanSummary.update({
          where: { grantId: grant.id },
          data: { status: 'failed' },
        }),
      ).catch(() => undefined);
    }
  }
}

/**
 * Start the summary pipeline.
 *
 * Dormant unless `WA_INGEST_SECRET` is set: without the capture service no grant can
 * ever end with messages, so the sweep would be a pointless query every two minutes.
 *
 * A supervised while-loop, not `setInterval` — blocker B3's lesson. One rejected promise
 * inside a `setInterval` callback silently ends the schedule, and the failure mode is a
 * pipeline that looks alive and produces nothing.
 */
export function startSalesInsightTick(log: Log): void {
  if (!env.WA_INGEST_SECRET) return;

  void (async () => {
    for (;;) {
      try {
        await sweep(log);
      } catch (err) {
        log.error({ err }, '[sales-scan] insight sweep failed — retrying next interval');
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  })();

  log.info({ intervalMs: INTERVAL_MS }, '[sales-scan] insight tick started');
}
