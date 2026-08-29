// Phase 8 — AI message provenance.
//
// Persists, fire-and-forget, the audit trail for every outbound bot reply:
//   • the exact system prompt we sent the LLM (content-addressed via
//     system_prompt_snapshots so identical prompts are stored once)
//   • the user message + history we packed
//   • the candidate set of catalog/business-info rows we surfaced
//   • LLM call metadata (model, temperature, tokens, latency)
//
// Phase 1.2 will fill `citations` + `hallucinations` columns from a
// post-LLM scanner. Phase 1.1 (this file) ships the capture path only.
//
// Called from whatsapp.routes.ts after the bot reply is sent + the
// whatsapp_messages row is created. NEVER awaited — failures here must
// not affect the customer-facing reply path.

import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { withTenant } from './db.js';
import type { BotResponseInputs } from './bot-engine.js';
import type { PipelineSnapshot } from './pipeline-timer.js';
import {
  normalisePhraseForSuppression,
  scanReply,
  type ScanCandidates,
  type SuppressionSet,
} from './provenance-scanner.js';

export interface RecordProvenanceArgs {
  organizationId: string;
  // The id of the whatsapp_messages row created for this bot reply.
  messageId: string;
  inputs: BotResponseInputs;
  // The final outbound text (markers stripped, fallbacks applied) — what
  // the customer actually sees on their phone. The Phase 1.2 scanner walks
  // this to produce citations + hallucinations.
  reply: string;
  // In-memory KB snapshot used to build the prompt. Passed instead of
  // re-fetched so the scanner is pure CPU (no DB round-trip).
  kb: ScanCandidates;
  // Phase 13 — per-station pipeline trace captured by the stopwatch
  // threaded through maybeReplyAsBot. Optional; older callers can
  // still skip it and the column stays NULL.
  pipelineTimings?: PipelineSnapshot | null;
  // Grounding gate decision for this reply (lib/grounding-gate.ts). blocked =
  // the gate flagged an ungrounded assertion (in shadow the reply still went
  // out; in enforce the sent reply is the fallback). Defaulted so old callers
  // record blocked=false.
  blocked?: boolean;
  blockReason?: string | null;
  log?: FastifyBaseLogger | Pick<FastifyBaseLogger, 'warn' | 'info'>;
}

/**
 * Phase 8 / 1.7 — load the suppression list the scanner should consult
 * for this org. Union of GLOBAL rows (organization_id IS NULL — apply to
 * every tenant) + this org's rows. Returned as a normalised Set the
 * scanner can membership-test in O(1).
 *
 * Read inside withTenant so RLS auto-filters to (global OR this org).
 * The provenance_suppressions policy explicitly allows reading global
 * rows even when current_org_id is set, so this returns BOTH halves
 * with a single SELECT.
 */
async function loadSuppressionSet(organizationId: string): Promise<SuppressionSet> {
  try {
    const rows = await withTenant(organizationId, async (tx) => {
      return tx.provenanceSuppression.findMany({
        select: { phrase: true },
      });
    });
    const s = new Set<string>();
    for (const r of rows) s.add(normalisePhraseForSuppression(r.phrase));
    return s;
  } catch {
    // Never block a provenance write on this — empty set falls through
    // to the scanner's hardcoded stoplist (which still catches the
    // common cases). The settings UI will show "0 suppressions" until
    // the next successful write.
    return new Set<string>();
  }
}

/**
 * Upsert a SystemPromptSnapshot for the (org, sha256) pair and return its id.
 * The unique index on (organization_id, sha256) means concurrent inserts
 * for the same prompt either return the existing row or no-op safely.
 */
async function upsertSystemPromptSnapshot(
  organizationId: string,
  promptBody: string,
): Promise<string> {
  const sha256 = createHash('sha256').update(promptBody, 'utf8').digest('hex');
  return withTenant(organizationId, async (tx) => {
    const existing = await tx.systemPromptSnapshot.findUnique({
      where: { organizationId_sha256: { organizationId, sha256 } },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await tx.systemPromptSnapshot.create({
      data: { organizationId, sha256, body: promptBody },
      select: { id: true },
    });
    return created.id;
  });
}

/**
 * Fire-and-forget. Awaiting the returned promise is optional; the bot reply
 * path should NOT block on it. Errors are logged at WARN and swallowed.
 */
export async function recordProvenance(args: RecordProvenanceArgs): Promise<void> {
  const { organizationId, messageId, inputs, reply, kb, pipelineTimings, blocked, blockReason, log } = args;
  try {
    const snapshotId = await upsertSystemPromptSnapshot(organizationId, inputs.systemPrompt);
    // Phase 8 / 1.7 — load operator-curated suppression list before
    // scanning. The scanner drops any flag whose normalised text matches.
    const suppressed = await loadSuppressionSet(organizationId);
    // Phase 1.2 — pure-CPU pass: extract citations + hallucinations from
    // the final reply so the admin UI has them on the same row as the
    // inputs. Never throws; on empty/odd input it returns empty arrays.
    const scan = scanReply(reply, kb, suppressed);
    await withTenant(organizationId, async (tx) => {
      await tx.messageProvenance.create({
        data: {
          organizationId,
          messageId,
          systemPromptSnapshotId: snapshotId,
          userPrompt: inputs.userPrompt,
          historyJson: inputs.historyJson as never,
          candidateProductIds: inputs.candidateProductIds,
          candidateServiceIds: inputs.candidateServiceIds,
          candidateFaqIds: inputs.candidateFaqIds,
          candidatePolicyKinds: inputs.candidatePolicyKinds,
          businessInfoFields: inputs.businessInfoFields,
          citations: scan.citations as never,
          hallucinations: scan.hallucinations as never,
          model: inputs.model,
          temperature: inputs.temperature,
          promptTokens: inputs.promptTokens,
          cacheReadTokens: inputs.cacheReadTokens ?? 0,
          cacheWriteTokens: inputs.cacheWriteTokens ?? 0,
          completionTokens: inputs.completionTokens,
          latencyMs: inputs.latencyMs,
          blocked: blocked ?? false,
          blockReason: blockReason ?? null,
          pipelineTimings: (pipelineTimings ?? undefined) as never,
        },
      });
    });
    if (scan.hallucinations.length > 0) {
      log?.warn?.(
        {
          organizationId,
          messageId,
          hallucinationCount: scan.hallucinations.length,
          sample: scan.hallucinations.slice(0, 3),
        },
        '[provenance] scanner flagged potential hallucinations',
      );
    }
  } catch (err) {
    log?.warn?.(
      { err, organizationId, messageId },
      '[provenance] failed to persist message provenance — bot reply unaffected',
    );
  }
}
