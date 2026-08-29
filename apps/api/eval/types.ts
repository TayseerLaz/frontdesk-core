// Eval harness — shared types.
//
// A "golden scenario" is one real customer message plus the criteria a correct
// bot reply must satisfy. Sets live in ./golden/<org-slug>.json and are meant to
// be seeded from real conversations (mine MessageProvenance) so they track live
// traffic. This is the Phase-0 slice: retrieval hit-rate + deterministic checks
// + a binary LLM judge. Multi-turn simulation + the CI wiring come in Phase 2.

export type Channel = 'whatsapp' | 'instagram' | 'messenger';
export type Lang = 'ar' | 'en';

export interface GoldenScenario {
  /** Stable id, unique within the set. */
  key: string;
  /** Channel the phrasing belongs to (affects markdown expectations). */
  channel?: Channel;
  /** Dialect tag, for slicing results (e.g. 'kuwaiti', 'lebanese', 'arabizi', 'english'). */
  dialect?: string;
  /** The customer's message. */
  prompt: string;
  /** Plain-English pass criteria, handed verbatim to the LLM judge. */
  expectation: string;
  /** Optional prior turns for light multi-turn context. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Deterministic: the reply must be in this language/script. */
  expectLanguage?: Lang;
  /** Retrieval + citation: these catalog SKUs should be surfaced to the model
   *  (retrieval hit) and ideally cited in the reply. */
  expectCitesSku?: string[];
  /** Deterministic: the reply must NOT assert a product/price outside the
   *  catalog (a critical hallucination). Defaults true. */
  mustNotHallucinate?: boolean;
}

export interface DeterministicResult {
  passed: boolean;
  /** Human-readable failure reasons; empty when passed. */
  failures: string[];
}

export interface RetrievalResult {
  /** True when every expected SKU was in the packed candidate set. */
  hit: boolean;
  found: string[];
  missing: string[];
  /** Expected-SKU count; 0 when the scenario has no retrieval expectation. */
  expected: number;
}

export interface JudgeResult {
  pass: boolean;
  critique: string;
}

export interface ScenarioResult {
  key: string;
  dialect?: string;
  reply: string;
  candidateSkus: string[];
  retrieval: RetrievalResult;
  /** 1-based position of the best-ranked expected SKU in the packed candidate
   *  list (lower = nearer the top of what the model sees). null when the
   *  scenario has no retrieval expectation or none were found. */
  bestRank: number | null;
  deterministic: DeterministicResult;
  judge?: JudgeResult;
  /** Model that actually generated the reply (from the engine). */
  model?: string;
}

export interface EvalSummary {
  org: string;
  total: number;
  retrievalScored: number;
  retrievalHits: number;
  deterministicPass: number;
  judgeScored: number;
  judgePass: number;
  /** Overall pass = deterministic passed AND (judge passed OR judge not run). */
  overallPass: number;
  results: ScenarioResult[];
}
