// Eval harness — PURE scoring functions.
//
// No DB, no network — everything here is deterministic and unit-tested
// (apps/api/test/eval-scorers.test.ts). The runner feeds these the engine's
// output (reply text + packed candidate SKUs + the provenance scan) and gets
// back pass/fail with reasons.

import type { Hallucination } from '../src/lib/provenance-scanner.js';

import type {
  DeterministicResult,
  GoldenScenario,
  Lang,
  RetrievalResult,
} from './types.js';

const AR_SCRIPT_RE = /[؀-ۿ]/;
const LATIN_LETTER_RE = /[A-Za-z]/;

/** Dominant script of a reply, ignoring URLs/emoji/punctuation. */
export function detectScript(text: string): Lang | 'other' {
  const core = (text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}]/gu, '');
  if (core.length < 2) return 'other';
  if (AR_SCRIPT_RE.test(core)) return 'ar';
  if (LATIN_LETTER_RE.test(core)) return 'en';
  return 'other';
}

/**
 * Remove the internal markers the send-path strips before the customer sees
 * the message ([IMAGE:], [CART:], [BUTTONS:], [HANDOFF], [BOOKING:],
 * [CLEAR_CART], [PAYMENT_LINK]). The engine returns raw text WITH these; the
 * eval must score what the customer actually receives.
 */
export function stripInternalMarkers(text: string): string {
  return (text ?? '')
    .replace(/\[IMAGE:[^\]]*\]/gi, '')
    // CART / BOOKING payloads are JSON with nested [] {} — match greedily to the
    // closing "}]" so the inner brackets don't end the match early.
    .replace(/\[CART:[\s\S]*\}\s*\]/gi, '')
    .replace(/\[BUTTONS:[^\]]*\]/gi, '')
    .replace(/\[BOOKING:[\s\S]*\}\s*\]/gi, '')
    .replace(/\[HANDOFF\]/gi, '')
    .replace(/\[CLEAR_CART\]/gi, '')
    .replace(/\[PAYMENT_LINK\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True if the reply leaks Markdown or an unstripped internal marker. */
export function hasFormattingLeak(reply: string): boolean {
  if (/\*\*/.test(reply)) return true; // double-asterisk bold
  if (/^[ \t]{0,3}#{1,6}\s/m.test(reply)) return true; // ATX heading
  if (/\[(IMAGE|CART|BOOKING|BUTTONS|HANDOFF|PAYMENT_LINK|CLEAR_CART)\b/i.test(reply)) return true;
  if (/\{\{.*?\}\}/.test(reply)) return true; // unresolved template token
  return false;
}

/**
 * Retrieval hit-rate: were the expected SKUs surfaced to the model?
 * `candidateSkus` is the packed candidate set (engine `candidateProductIds`
 * mapped to SKUs). Case-insensitive.
 */
export function scoreRetrieval(
  candidateSkus: string[],
  expected: string[] | undefined,
): RetrievalResult {
  const exp = (expected ?? []).map((s) => s.toLowerCase());
  if (exp.length === 0) return { hit: true, found: [], missing: [], expected: 0 };
  const have = new Set(candidateSkus.map((s) => s.toLowerCase()));
  const found = exp.filter((s) => have.has(s));
  const missing = exp.filter((s) => !have.has(s));
  return { hit: missing.length === 0, found, missing, expected: exp.length };
}

/**
 * Deterministic pass/fail — the REQUIRED gate (the judge is advisory on top).
 * Checks: no critical hallucination, language matches, no formatting leak.
 * Retrieval misses are reported by scoreRetrieval, not here, so a retrieval
 * regression is visible separately from a generation regression.
 */
export function scoreDeterministic(
  reply: string,
  hallucinations: Hallucination[],
  scenario: GoldenScenario,
): DeterministicResult {
  const failures: string[] = [];

  const mustNotHallucinate = scenario.mustNotHallucinate !== false;
  if (mustNotHallucinate) {
    const critical = hallucinations.filter((h) => h.severity === 'critical');
    if (critical.length > 0) {
      failures.push(
        `critical hallucination(s): ${critical.map((h) => `"${h.matchedText}"`).join(', ')}`,
      );
    }
  }

  if (scenario.expectLanguage) {
    const got = detectScript(reply);
    if (got !== scenario.expectLanguage) {
      failures.push(`language: expected ${scenario.expectLanguage}, replied ${got}`);
    }
  }

  if (hasFormattingLeak(reply)) {
    failures.push('formatting leak (markdown/marker/template token in visible reply)');
  }

  return { passed: failures.length === 0, failures };
}

/** The binary judge instruction. Kept pure so it can be reviewed + tested.
 *  `catalogFacts` (optional) is a short list of the real catalog rows the reply
 *  could cite (name · price), given as ground truth so the judge can verify a
 *  quoted product/price instead of abstaining on "I can't see the catalog". */
export function buildJudgePrompt(
  scenario: GoldenScenario,
  reply: string,
  catalogFacts?: string,
): { system: string; user: string } {
  const system = [
    'You are a strict QA reviewer for a business chatbot.',
    'Decide if the bot REPLY satisfies the PASS CRITERIA for the CUSTOMER MESSAGE.',
    'Judge ONLY against the criteria given — do not invent extra requirements.',
    'Treat the CATALOG FACTS block, when present, as ground truth: a product or',
    'price the reply states is correct if and only if it matches those facts.',
    'Be binary: the reply either meets the criteria or it does not.',
    'Respond with ONLY a minified JSON object: {"pass": true|false, "critique": "<one sentence>"}.',
  ].join(' ');
  const history = (scenario.history ?? [])
    .map((h) => `${h.role === 'user' ? 'Customer' : 'Bot'}: ${h.content}`)
    .join('\n');
  const user = [
    history ? `CONVERSATION SO FAR:\n${history}\n` : '',
    catalogFacts ? `CATALOG FACTS (ground truth):\n${catalogFacts}\n` : '',
    `CUSTOMER MESSAGE:\n${scenario.prompt}`,
    `\nPASS CRITERIA:\n${scenario.expectation}`,
    `\nBOT REPLY:\n${reply || '(empty reply)'}`,
  ]
    .filter(Boolean)
    .join('\n');
  return { system, user };
}
