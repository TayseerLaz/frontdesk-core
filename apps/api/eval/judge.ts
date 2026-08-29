// Eval harness — binary LLM judge.
//
// Uses a FIXED strong model (Anthropic Sonnet via ANTHROPIC_MODEL) regardless
// of the tenant's own plan — the judge should be at least as capable as the
// model under test. Binary pass/fail only (never a 1-5 scale). If the key is
// missing or the call fails, the judge abstains (returns null) so the
// deterministic gate still stands on its own.

import Anthropic from '@anthropic-ai/sdk';

import { env } from '../src/lib/env.js';

import { buildJudgePrompt } from './scorers.js';
import type { GoldenScenario, JudgeResult } from './types.js';

let client: Anthropic | null | undefined;
function judgeClient(): Anthropic | null {
  if (client === undefined) {
    client = env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;
  }
  return client;
}

function parseVerdict(raw: string): JudgeResult | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { pass?: unknown; critique?: unknown };
    if (typeof o.pass !== 'boolean') return null;
    return { pass: o.pass, critique: typeof o.critique === 'string' ? o.critique : '' };
  } catch {
    return null;
  }
}

/** Judge a single reply. Returns null when the judge is unavailable. */
export async function judgeReply(
  scenario: GoldenScenario,
  reply: string,
  catalogFacts?: string,
): Promise<JudgeResult | null> {
  const a = judgeClient();
  if (!a) return null;
  const { system, user } = buildJudgePrompt(scenario, reply, catalogFacts);
  try {
    const res = await a.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 200,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    return parseVerdict(text);
  } catch (err) {
    console.warn('[eval] judge call failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
