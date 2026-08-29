// Grounding gate — turn the provenance hallucination scanner from a post-hoc
// AUDIT into a pre-send GATE. A reply that asserts a product or price not in the
// candidate catalog is a critical hallucination; rather than send it and merely
// log it, the gate can refuse it and hand the conversation to a human ("won't
// guess — escalates").
//
// Layer A (this version): the deterministic critical-hallucination check the
// provenance scanner already computes — free, high-precision, zero added
// latency beyond one pure scan. A cheap Haiku groundedness verifier (Layer B)
// is a documented follow-up for subtler cases.
//
// Modes (GROUNDING_GATE_MODE):
//   off     — disabled.
//   shadow  — compute + LOG what it would block, but send the reply unchanged
//             (default; used to tune before enforcing).
//   enforce — replace an ungrounded reply with a safe fallback + escalate.

import { env } from './env.js';
import { scanReply, type ScanCandidates } from './provenance-scanner.js';

export type GateMode = 'off' | 'shadow' | 'enforce';

export function gateMode(): GateMode {
  return (env.GROUNDING_GATE_MODE ?? 'shadow') as GateMode;
}

export interface GateResult {
  /** Safe to send the reply as-is. False only in enforce mode on a block. */
  ok: boolean;
  /** The gate detected an ungrounded product/price assertion. */
  wouldBlock: boolean;
  /** Short human-readable reason; null when clean. */
  reason: string | null;
}

// Structural subset of gatherBotData output the scanner needs — kept structural
// to avoid an import cycle with bot-engine.
export interface BotDataLike {
  products: { id: string; name: string; sku: string; priceMinor: number | null; currency: string | null }[];
  services: { id: string; name: string; basePriceMinor: number | null; currency: string | null }[];
  faqs: { id: string; question: string; answer: string }[];
  policies: { kind: string; title: string; content: string }[];
  biz: {
    legalName: string | null;
    websiteUrl: string | null;
    operatingHours: unknown;
    currency: string;
  } | null;
  config: { greeting: string | null } | null;
  shopForm?: { menuUrl: string | null } | null;
}

/** Build the scanner's candidate bundle from gatherBotData output. Single
 *  source of truth reused by the gate (pre-send) and recordProvenance
 *  (post-send) so both judge the reply against the exact same catalog. */
export function buildScanCandidates(data: BotDataLike, customerName?: string | null): ScanCandidates {
  return {
    products: data.products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      priceMinor: p.priceMinor,
      currency: p.currency,
    })),
    services: data.services.map((s) => ({
      id: s.id,
      name: s.name,
      basePriceMinor: s.basePriceMinor,
      currency: s.currency,
    })),
    faqs: data.faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
    policies: data.policies.map((p) => ({ kind: p.kind, title: p.title, content: p.content })),
    biz: data.biz
      ? {
          legalName: data.biz.legalName,
          websiteUrl: data.biz.websiteUrl,
          operatingHours: data.biz.operatingHours,
          currency: data.biz.currency,
          menuUrl: data.shopForm?.menuUrl ?? null,
        }
      : null,
    config: data.config ? { greeting: data.config.greeting } : null,
    customer: { whatsappName: customerName ?? null, operatorNickname: null },
  };
}

const DEFAULT_FALLBACK = 'Let me double-check that with the team and get right back to you 🙏';

/** The message sent in place of an ungrounded reply (enforce mode). */
export function safeFallback(): string {
  return env.GROUNDING_GATE_FALLBACK?.trim() || DEFAULT_FALLBACK;
}

/**
 * Run the gate. Pure + synchronous (Layer A). `wouldBlock` is always accurate;
 * `ok` is false only in enforce mode so callers can branch on mode with one
 * value. Empty reply / off mode → pass.
 */
export function groundingGate(
  reply: string,
  candidates: ScanCandidates,
  mode: GateMode = gateMode(),
): GateResult {
  if (mode === 'off' || !reply.trim()) return { ok: true, wouldBlock: false, reason: null };
  const scan = scanReply(reply, candidates);
  const critical = scan.hallucinations.filter((h) => h.severity === 'critical');
  if (critical.length === 0) return { ok: true, wouldBlock: false, reason: null };
  const reason = `ungrounded: ${critical.map((h) => h.matchedText).slice(0, 3).join(' | ')}`;
  return { ok: mode !== 'enforce', wouldBlock: true, reason };
}
