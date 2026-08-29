// Sales Scan — LOCAL clustering + deterministic statistics.
//
// This is the half of the summary pipeline that must never touch the network.
//
// Blocker B6 (docs/SALES-SCAN-REVIEW-BLOCKERS.md): the original plan embedded every
// inbound message, which shipped the ENTIRE raw customer corpus to OpenAI and so
// nullified its own "we send a digest, not the corpus" argument. The corpus is
// therefore clustered HERE, on the box, with no I/O at all:
//
//   * character trigrams via `trigrams()` from retrieval.ts — the same in-memory
//     pg_trgm equivalent that took bot retrieval from 60% to 100% hit-rate, and the
//     reason this works on Arabic morphology without a tokeniser;
//   * hashed into a fixed 256-dim unit vector so `cosineSimilarity()` from
//     embedding.ts (which is a dot product of unit vectors — exactly its documented
//     precondition) can score a message against a running cluster centroid;
//   * confirmed with the EXACT trigram Jaccard of the cluster's representative, so a
//     hash collision can never merge two unrelated topics.
//
// What is allowed to leave this module, and therefore the box (blocker B7):
//   * counts, timestamps and ids;
//   * keyword bags where every token occurs in >= 2 DISTINCT inbound messages of the
//     window (`MIN_KEYWORD_DOC_FREQ`) — an aggregation floor, so a token that appears
//     once (a customer's name, a street, a landmark) can never surface as a label;
//   * `bestAnswer`, which is taken from `direction === 'out'` ONLY — the tenant's own
//     words, which is where "how they speak" lives anyway.
//
// What deliberately never leaves: any inbound message body. The cluster representative
// is used only to compute the Jaccard confirmation and is returned as an ID, never as
// text — so there is no way for a caller to accidentally put customer prose into a
// prompt or into the stored summary payload.
//
// Group chats are captured as well as DMs, so every input row carries `isGroup` and
// callers decide what to feed in. `clusterInboundQuestions` is designed to be given the
// DM subset (a group's "questions" are cross-talk between many senders, not customer
// enquiries to the business), while `computeSalesStats` is given everything.

import { cosineSimilarity } from './embedding.js';
import { trigramSim, trigrams } from './retrieval.js';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * The projection of a `SalesMessage` row this module needs. Kept as a local interface
 * rather than the Prisma row type so the pure logic is trivially testable and does not
 * move when the table gains columns.
 */
export interface SalesMessageForAnalysis {
  id: string;
  direction: 'in' | 'out';
  body: string | null;
  sentAt: Date;
  /**
   * Conversation key. A salted hash — a join/erasure key, NOT de-identification (M1);
   * used here purely to group a thread and to pair a question with the reply that
   * followed it.
   */
  counterpartyHash: string;
  /** True for `@g.us` chats. Groups are captured too and must stay distinguishable. */
  isGroup: boolean;
  kind: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hashed-trigram vector width. 256 is ample for short chat lines and keeps the
 *  greedy pass at ~10^8 multiply-adds worst case (sub-second) instead of ~10^9. */
const VECTOR_DIM = 256;
/** Most recent inbound messages considered for clustering. Bounds CPU and memory. */
const DEFAULT_MAX_INPUT = 2500;
/** Cluster count ceiling. Beyond this, further messages only join existing clusters. */
const DEFAULT_MAX_CLUSTERS = 300;
/** Hashed-cosine floor to consider joining a cluster. */
const DEFAULT_COSINE_MIN = 0.6;
/** Exact-Jaccard floor that CONFIRMS the join (kills hash-collision merges). */
const DEFAULT_JACCARD_MIN = 0.26;
/** How long after a question we still treat an outbound message as its answer. */
const DEFAULT_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Longest answer we will quote back to the tenant. */
const DEFAULT_MAX_ANSWER_CHARS = 400;
/** A keyword must appear in at least this many distinct inbound messages. */
const MIN_KEYWORD_DOC_FREQ = 2;
/** Members inspected when hunting for the cluster's best answer. */
const MAX_MEMBERS_FOR_ANSWER = 25;

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/** Tashkeel, tatweel and other Arabic combining marks that carry no clustering signal. */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/**
 * Fold a message into a comparable form: lowercase, links dropped, Arabic
 * orthography normalised (hamza forms, ya/alef-maqsura, ta-marbuta), punctuation and
 * emoji stripped. This is what makes "بكم التوصيل؟" and "بكم التوصيل" one topic.
 */
export function normaliseForCluster(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(ARABIC_MARKS, '');
  s = s
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ئ/g, 'ي') // ئ -> ي
    .replace(/ؤ/g, 'و') // ؤ -> و
    .replace(/ة/g, 'ه'); // ة -> ه
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Tokens that carry no topical meaning. Deliberately small: an over-eager stoplist
 * would strip the Arabic question words ("بكم", "وين") that make a label readable.
 */
const STOPWORDS = new Set([
  // English
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for',
  'from', 'have', 'has', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'not', 'of',
  'ok', 'okay', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'them', 'then',
  'there', 'they', 'this', 'to', 'up', 'was', 'we', 'were', 'will', 'with', 'you',
  'your', 'yes', 'pls', 'plz', 'please', 'u', 'ur',
  // Arabic function words
  'في', 'من', 'الى', 'على', 'عن', 'مع', 'هل', 'ان', 'انا', 'انت', 'هو', 'هي', 'هذا',
  'هذه', 'ذلك', 'كان', 'يكون', 'لا', 'ما', 'او', 'و', 'ثم', 'قد', 'لكن', 'كل', 'بس',
  'يا', 'لو', 'اذا', 'عندك', 'في', 'شو',
]);

/**
 * Greeting / acknowledgement noise. A window's single biggest "topic" is otherwise
 * always "hi" — useless as a FAQ candidate and it crowds out the real questions.
 */
const TRIVIAL_TOKENS = new Set([
  'hi', 'hey', 'hello', 'hallo', 'thanks', 'thank', 'thx', 'ty', 'welcome', 'good',
  'morning', 'evening', 'night', 'bye', 'sure', 'great', 'nice', 'cool', 'perfect',
  'مرحبا', 'مرحبتين', 'هلا', 'اهلا', 'السلام', 'عليكم', 'وعليكم', 'شكرا', 'شكرًا',
  'تسلم', 'يسلمو', 'صباح', 'مساء', 'الخير', 'النور', 'تمام', 'اوك', 'حلو', 'ماشي',
  'يعطيك', 'العافيه', 'العافية',
]);

/** Topical tokens of a normalised string. Pure digits are dropped — a bare number is
 *  as likely to be a house number as a quantity, and it never makes a useful label. */
export function topicTokens(normalised: string): string[] {
  if (!normalised) return [];
  return normalised
    .split(' ')
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** A line that is nothing but greeting/ack noise. */
function isTrivial(normalised: string): boolean {
  const parts = normalised.split(' ').filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.length > 4) return false;
  return parts.every((p) => TRIVIAL_TOKENS.has(p) || STOPWORDS.has(p) || /^\d+$/.test(p));
}

// ---------------------------------------------------------------------------
// Hashed trigram vectors
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Only needs to spread trigrams across buckets. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * L2-normalised, fixed-width vector of a string's character trigrams (the hashing
 * trick). Unit length is the precondition `cosineSimilarity` documents, so the dot
 * product it computes IS the cosine — no second normalisation anywhere.
 */
export function trigramVector(text: string, dim: number = VECTOR_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const g of trigrams(text)) {
    const i = fnv1a(g) % dim;
    vec[i] = (vec[i] ?? 0) + 1;
  }
  let sq = 0;
  for (const v of vec) sq += v * v;
  if (sq === 0) return vec;
  const norm = Math.sqrt(sq);
  for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

// ---------------------------------------------------------------------------
// Deterministic statistics — no LLM is involved in any number the tenant sees
// ---------------------------------------------------------------------------

export interface SalesScanComputedStats {
  messagesAnalyzed: number;
  inbound: number;
  outbound: number;
  conversations: number;
  medianReplyMinutes: number | null;
}

/**
 * Counts + median first-response time. The median is taken over every
 * inbound-run -> first-outbound gap, per conversation: a customer who sends three
 * messages then gets one reply contributes ONE gap, measured from the first of the
 * three (which is what "how fast do they answer" means to a human). Median rather
 * than mean because one overnight message would otherwise dominate.
 */
export function computeSalesStats(messages: SalesMessageForAnalysis[]): SalesScanComputedStats {
  let inbound = 0;
  let outbound = 0;
  const byConversation = new Map<string, SalesMessageForAnalysis[]>();
  for (const m of messages) {
    if (m.direction === 'in') inbound++;
    else outbound++;
    const list = byConversation.get(m.counterpartyHash);
    if (list) list.push(m);
    else byConversation.set(m.counterpartyHash, [m]);
  }

  const gapsMs: number[] = [];
  for (const list of byConversation.values()) {
    const ordered = [...list].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    let awaitingSince: number | null = null;
    for (const m of ordered) {
      if (m.direction === 'in') {
        if (awaitingSince === null) awaitingSince = m.sentAt.getTime();
        continue;
      }
      if (awaitingSince !== null) {
        const gap = m.sentAt.getTime() - awaitingSince;
        if (gap >= 0) gapsMs.push(gap);
        awaitingSince = null;
      }
    }
  }

  return {
    messagesAnalyzed: messages.length,
    inbound,
    outbound,
    conversations: byConversation.size,
    medianReplyMinutes: gapsMs.length > 0 ? round1(median(gapsMs) / 60000) : null,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export interface SalesQuestionCluster {
  /** Stable within one run only ("t1", "t2", …). Used to correlate LLM naming. */
  id: string;
  /** Inbound messages in this cluster. */
  count: number;
  /**
   * Aggregate label tokens. Every token here occurs in >= MIN_KEYWORD_DOC_FREQ
   * distinct inbound messages of the window, so no unique identifier can leak.
   */
  keywords: string[];
  /**
   * Human-readable fallback when no model names the cluster. Built from `keywords`, so
   * it is never customer prose. Clusters that cannot produce keywords are not returned.
   */
  label: string;
  /** ID only — the representative BODY intentionally never leaves this module. */
  representativeId: string;
  /** Verbatim from `direction === 'out'` only: the tenant's own best reply. */
  bestAnswer: string | null;
  /** Most recent time this topic came up (drives recency tie-breaks in the UI). */
  lastSeenAt: Date;
}

export interface ClusterOptions {
  maxInput?: number;
  maxClusters?: number;
  cosineMin?: number;
  jaccardMin?: number;
  replyWindowMs?: number;
  maxAnswerChars?: number;
}

interface WorkingCluster {
  id: string;
  /** Running sum of member vectors; the centroid is this, normalised. */
  sum: number[];
  centroid: number[];
  /** Trigram set of the seed message — the exact-match confirmation reference. */
  repGrams: Set<string>;
  representativeId: string;
  members: { msg: SalesMessageForAnalysis; tokens: string[] }[];
  lastSeenAt: Date;
}

/**
 * Greedy single-pass agglomerative clustering of the INBOUND messages, then one
 * outbound answer per cluster.
 *
 * Give it BOTH directions of the conversations you want analysed (normally the DM
 * subset): inbound drives the clustering, outbound supplies `bestAnswer`.
 *
 * Single-pass greedy rather than k-means/HDBSCAN because k is unknown, the corpus is
 * small, and the ordering bias (earliest message seeds a topic) is harmless when the
 * only thing we do with a cluster is count it and name it.
 */
export function clusterInboundQuestions(
  messages: SalesMessageForAnalysis[],
  opts: ClusterOptions = {},
): SalesQuestionCluster[] {
  const maxInput = opts.maxInput ?? DEFAULT_MAX_INPUT;
  const maxClusters = opts.maxClusters ?? DEFAULT_MAX_CLUSTERS;
  const cosineMin = opts.cosineMin ?? DEFAULT_COSINE_MIN;
  const jaccardMin = opts.jaccardMin ?? DEFAULT_JACCARD_MIN;

  // Eligible inbound: real text, meaningful length, not pure greeting noise.
  const eligible: { msg: SalesMessageForAnalysis; norm: string; tokens: string[] }[] = [];
  for (const m of messages) {
    if (m.direction !== 'in') continue;
    if (m.kind !== 'text') continue;
    const body = (m.body ?? '').trim();
    if (!body) continue;
    const norm = normaliseForCluster(body);
    if (norm.length < 6) continue;
    if (isTrivial(norm)) continue;
    const tokens = topicTokens(norm);
    if (tokens.length === 0) continue;
    eligible.push({ msg: m, norm, tokens });
  }
  if (eligible.length === 0) return [];

  // Keep the most recent slice (a window that overran its cap should describe its
  // latest state), then cluster in chronological order.
  eligible.sort((a, b) => a.msg.sentAt.getTime() - b.msg.sentAt.getTime());
  const window = eligible.length > maxInput ? eligible.slice(eligible.length - maxInput) : eligible;

  // Corpus-wide document frequency — the aggregation floor for keywords.
  const corpusDf = new Map<string, number>();
  for (const e of window) {
    for (const t of new Set(e.tokens)) corpusDf.set(t, (corpusDf.get(t) ?? 0) + 1);
  }

  const clusters: WorkingCluster[] = [];
  for (const e of window) {
    const vec = trigramVector(e.norm);
    const grams = trigrams(e.norm);

    let best: WorkingCluster | null = null;
    let bestScore = cosineMin;
    for (const c of clusters) {
      const score = cosineSimilarity(vec, c.centroid);
      if (score < bestScore) continue;
      // Confirm with the exact trigram overlap: the hashing trick collides, and a
      // collision must not be allowed to fuse two unrelated topics.
      if (trigramSim(grams, c.repGrams) < jaccardMin) continue;
      best = c;
      bestScore = score;
    }

    if (best) {
      best.members.push({ msg: e.msg, tokens: e.tokens });
      for (let i = 0; i < best.sum.length; i++) best.sum[i] = (best.sum[i] ?? 0) + (vec[i] ?? 0);
      best.centroid = normalise(best.sum);
      if (e.msg.sentAt > best.lastSeenAt) best.lastSeenAt = e.msg.sentAt;
      continue;
    }

    if (clusters.length >= maxClusters) continue;
    clusters.push({
      id: `t${clusters.length + 1}`,
      sum: [...vec],
      centroid: [...vec],
      repGrams: grams,
      representativeId: e.msg.id,
      members: [{ msg: e.msg, tokens: e.tokens }],
      lastSeenAt: e.msg.sentAt,
    });
  }

  const outboundByConversation = indexOutbound(messages);
  const replyWindowMs = opts.replyWindowMs ?? DEFAULT_REPLY_WINDOW_MS;
  const maxAnswerChars = opts.maxAnswerChars ?? DEFAULT_MAX_ANSWER_CHARS;

  const out: SalesQuestionCluster[] = clusters.map((c) => {
    const keywords = clusterKeywords(c, corpusDf);
    return {
      id: c.id,
      count: c.members.length,
      keywords,
      label: keywords.length > 0 ? keywords.slice(0, 5).join(' · ') : 'Unlabelled topic',
      representativeId: c.representativeId,
      bestAnswer: pickBestAnswer(c, outboundByConversation, replyWindowMs, maxAnswerChars),
      lastSeenAt: c.lastSeenAt,
    };
  });

  out.sort((a, b) => b.count - a.count || b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  // A cluster with no keywords is one whose every token appeared in a single message —
  // so it cannot be labelled without quoting the customer, which B7 forbids. Dropping it
  // here (rather than leaving the caller to notice) is what makes the rule structural:
  // no consumer of this function is ever handed an unlabellable topic.
  return out.filter((c) => c.keywords.length > 0);
}

function normalise(vec: number[]): number[] {
  let sq = 0;
  for (const v of vec) sq += v * v;
  if (sq === 0) return [...vec];
  const norm = Math.sqrt(sq);
  return vec.map((v) => v / norm);
}

/**
 * Label tokens for a cluster: ranked by in-cluster document frequency, then by
 * corpus frequency, and filtered to tokens seen in >= MIN_KEYWORD_DOC_FREQ distinct
 * inbound messages window-wide. That filter is the privacy control — a name, a street
 * or a one-off landmark appears once and is therefore never a keyword.
 */
function clusterKeywords(c: WorkingCluster, corpusDf: Map<string, number>): string[] {
  const df = new Map<string, number>();
  for (const m of c.members) {
    for (const t of new Set(m.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return [...df.entries()]
    .filter(([t]) => (corpusDf.get(t) ?? 0) >= MIN_KEYWORD_DOC_FREQ)
    .sort((a, b) => b[1] - a[1] || (corpusDf.get(b[0]) ?? 0) - (corpusDf.get(a[0]) ?? 0))
    .slice(0, 8)
    .map(([t]) => t);
}

function indexOutbound(
  messages: SalesMessageForAnalysis[],
): Map<string, SalesMessageForAnalysis[]> {
  const map = new Map<string, SalesMessageForAnalysis[]>();
  for (const m of messages) {
    if (m.direction !== 'out') continue;
    if (m.kind !== 'text') continue;
    if (!(m.body ?? '').trim()) continue;
    const list = map.get(m.counterpartyHash);
    if (list) list.push(m);
    else map.set(m.counterpartyHash, [m]);
  }
  for (const list of map.values()) list.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  return map;
}

/**
 * The tenant's own best answer to this topic.
 *
 * B7 is absolute here: the ONLY verbatim text this pipeline may surface is
 * `direction === 'out'`. We take the first outbound message that followed a member
 * question in the same conversation (within `replyWindowMs`) and prefer the most
 * substantial one that still fits the quote budget, because the fullest reply is the
 * one worth turning into an FAQ answer later.
 */
function pickBestAnswer(
  c: WorkingCluster,
  outboundByConversation: Map<string, SalesMessageForAnalysis[]>,
  replyWindowMs: number,
  maxChars: number,
): string | null {
  const recentFirst = [...c.members]
    .sort((a, b) => b.msg.sentAt.getTime() - a.msg.sentAt.getTime())
    .slice(0, MAX_MEMBERS_FOR_ANSWER);

  const candidates: string[] = [];
  for (const m of recentFirst) {
    const outs = outboundByConversation.get(m.msg.counterpartyHash);
    if (!outs) continue;
    const askedAt = m.msg.sentAt.getTime();
    const reply = outs.find((o) => {
      const dt = o.sentAt.getTime() - askedAt;
      return dt > 0 && dt <= replyWindowMs;
    });
    const body = (reply?.body ?? '').trim();
    if (body.length >= 2) candidates.push(body);
  }
  if (candidates.length === 0) return null;

  const fitting = candidates.filter((b) => b.length <= maxChars);
  if (fitting.length > 0) {
    return fitting.reduce((a, b) => (b.length > a.length ? b : a));
  }
  // Everything is long: truncate the shortest on a word boundary.
  const shortest = candidates.reduce((a, b) => (b.length < a.length ? b : a));
  return truncateWords(shortest, maxChars);
}

export function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Outbound sampling — the ONLY text that may be put in a prompt
// ---------------------------------------------------------------------------

export interface OutboundSample {
  /** First outbound of a conversation — where greetings live. */
  openers: string[];
  /** Last outbound of a conversation — where sign-offs live. */
  closers: string[];
  /** Mid-conversation replies — where tone and habits live. */
  middles: string[];
  /** How many outbound messages were eligible before sampling. */
  outboundConsidered: number;
  /** True when DM outbound was too thin and group outbound was mixed in. */
  includedGroups: boolean;
}

export interface OutboundSampleOptions {
  maxOpeners?: number;
  maxClosers?: number;
  maxMiddles?: number;
  maxCharsPerMessage?: number;
  /** Below this many DM outbound messages we widen to groups rather than give up. */
  minDmOutbound?: number;
}

/**
 * Pick a small, diverse, bucketed sample of the TENANT'S OWN messages.
 *
 * Bucketing by position is what makes the voice profile good: asking a model to find
 * greetings in a flat shuffle of 60 replies is much weaker than handing it the 20
 * messages that actually opened a conversation. Round-robin across conversations stops
 * one chatty thread from defining the whole profile, and near-duplicate collapse stops
 * a copy-pasted template from being counted twenty times.
 */
export function pickOutboundSamples(
  messages: SalesMessageForAnalysis[],
  opts: OutboundSampleOptions = {},
): OutboundSample {
  const maxOpeners = opts.maxOpeners ?? 20;
  const maxClosers = opts.maxClosers ?? 15;
  const maxMiddles = opts.maxMiddles ?? 30;
  const maxChars = opts.maxCharsPerMessage ?? 300;
  const minDmOutbound = opts.minDmOutbound ?? 20;

  const usable = messages.filter(
    (m) => m.direction === 'out' && m.kind === 'text' && (m.body ?? '').trim().length >= 2,
  );
  const dmOnly = usable.filter((m) => !m.isGroup);
  const includedGroups = dmOnly.length < minDmOutbound && usable.length > dmOnly.length;
  const pool = includedGroups ? usable : dmOnly;

  const byConversation = new Map<string, SalesMessageForAnalysis[]>();
  for (const m of pool) {
    const list = byConversation.get(m.counterpartyHash);
    if (list) list.push(m);
    else byConversation.set(m.counterpartyHash, [m]);
  }
  const threads = [...byConversation.values()].map((list) =>
    [...list].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()),
  );
  // Most recent conversations first: how they write today beats how they wrote a week ago.
  threads.sort(
    (a, b) =>
      (b[b.length - 1]?.sentAt.getTime() ?? 0) - (a[a.length - 1]?.sentAt.getTime() ?? 0),
  );

  const seen = new Set<string>();
  const take = (m: SalesMessageForAnalysis | undefined, into: string[], cap: number): void => {
    if (!m || into.length >= cap) return;
    const body = (m.body ?? '').trim();
    const key = normaliseForCluster(body).slice(0, 120);
    if (!key || seen.has(key)) return;
    seen.add(key);
    into.push(truncateWords(body, maxChars));
  };

  const openers: string[] = [];
  const closers: string[] = [];
  const middles: string[] = [];

  for (const t of threads) take(t[0], openers, maxOpeners);
  for (const t of threads) {
    if (t.length >= 2) take(t[t.length - 1], closers, maxClosers);
  }
  // Round-robin the interiors so breadth beats depth.
  for (let depth = 1; middles.length < maxMiddles; depth++) {
    let progressed = false;
    for (const t of threads) {
      if (depth >= t.length - 1) continue;
      progressed = true;
      take(t[depth], middles, maxMiddles);
      if (middles.length >= maxMiddles) break;
    }
    if (!progressed) break;
  }

  return { openers, closers, middles, outboundConsidered: pool.length, includedGroups };
}

/**
 * Rough script mix of a set of strings. Passed to the model as a hint so `languages`
 * is grounded in the corpus rather than guessed from a handful of samples — and so an
 * Arabic-script tenant is never described as English-only.
 */
export function scriptMix(texts: string[]): { arabicShare: number; latinShare: number } {
  let arabic = 0;
  let latin = 0;
  for (const t of texts) {
    for (const ch of t) {
      if (/\p{Script=Arabic}/u.test(ch)) arabic++;
      else if (/\p{Script=Latin}/u.test(ch)) latin++;
    }
  }
  const total = arabic + latin;
  if (total === 0) return { arabicShare: 0, latinShare: 0 };
  return {
    arabicShare: round1((arabic / total) * 100) / 100,
    latinShare: round1((latin / total) * 100) / 100,
  };
}
