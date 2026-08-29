// Inbound-burst handling for the WhatsApp bot — PURE logic, no env/db imports
// (env.ts process.exit(1)s without production variables, which would make these
// rules untestable on a developer machine — the sales-scan-window.ts precedent).
//
// Two failure modes live here, both found in production on 2026-08-10:
//
// 1. STALE REDELIVERY. When the webhook endpoint is down, Meta queues every
//    inbound and redelivers each one on its own backoff schedule for up to
//    7 days. Those redeliveries are NOT duplicates (the wamid was never
//    stored), so the idempotency guard passes them and the bot answers a
//    days-old message at a random hour — the customer experiences the AI
//    "messaging them on its own". After the 2026-08-05→08-08 outage, Aseer
//    customers were getting replies to 4-day-old greetings at 2 AM.
//    `isStaleInbound` decides which messages are too old to auto-answer.
//    They are still persisted and visible in the inbox for a human.
//
// 2. BURST DOUBLE-REPLY. A customer sending two messages 2–20 s apart (the
//    second landing while the first reply is still generating) used to get
//    two parallel generations, neither aware of the other → two replies,
//    the second re-greeting from scratch. `aggregateUnansweredTail` folds
//    every unanswered trailing message into ONE user turn so whichever
//    generation ultimately sends answers ALL pending inquiries in one
//    message — nothing is dropped, and noise like "." is absorbed as
//    context instead of triggering its own reply.

export interface BurstHistoryRow {
  direction: string; // 'inbound' | 'outbound'
  body: string | null;
  metaMessageId?: string | null;
  // Meta's own send timestamp (epoch seconds) from raw_payload.timestamp.
  // received_at is USELESS for staleness — a redelivered message is
  // processed "now", so only Meta's timestamp reveals its true age.
  sentEpochSeconds?: number | null;
}

export interface BurstResult {
  // The aggregated user turn: every unanswered trailing inbound joined in
  // order, the triggering message's (transcript-substituted) text last.
  userTurn: string;
  // How many leading history rows remain history; the folded tail rows must
  // NOT also be passed as history or the model sees them twice.
  historyBeforeBurst: number;
  // Number of messages folded into the turn (>= 1).
  burstSize: number;
}

/**
 * True when an inbound message is too old to auto-answer. Fails OPEN
 * (not stale) on a missing/garbled/future timestamp — a fresh message must
 * never lose its reply to a parsing edge, and Meta redeliveries always carry
 * a valid epoch-seconds timestamp.
 */
export function isStaleInbound(
  sentEpochSeconds: number | null | undefined,
  nowEpochSeconds: number,
  maxAgeSeconds: number,
): boolean {
  if (sentEpochSeconds == null || !Number.isFinite(sentEpochSeconds)) return false;
  if (!Number.isFinite(nowEpochSeconds) || !Number.isFinite(maxAgeSeconds)) return false;
  const age = nowEpochSeconds - sentEpochSeconds;
  return age > maxAgeSeconds;
}

/** Extract Meta's epoch-seconds timestamp from a stored raw_payload. */
export function sentEpochFromRaw(rawPayload: unknown): number | null {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const ts = (rawPayload as { timestamp?: unknown }).timestamp;
  if (ts == null) return null;
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fold the unanswered trailing inbound run into one user turn.
 *
 * Walks history from the end collecting consecutive inbound rows (the
 * messages nothing has answered yet). The walk STOPS at the first outbound
 * (that inquiry was answered) and at the first stale row (an outage-era
 * redelivery is context, not an active question — folding it would make the
 * bot suddenly answer a days-old message inside a fresh conversation).
 *
 * The triggering message's text is passed separately because voice notes
 * substitute their transcript AFTER the history row was persisted with an
 * "[audio]" placeholder — the row is matched by metaMessageId and replaced.
 * When the id is absent (or the row isn't in the bounded history slice) the
 * text is still appended so the current message is never lost.
 */
export function aggregateUnansweredTail(args: {
  history: BurstHistoryRow[];
  currentMetaId: string | null;
  currentText: string;
  nowEpochSeconds: number;
  // Tail rows older than this are left as history, not folded. Default 1h.
  maxAgeSeconds?: number;
}): BurstResult {
  const maxAge = args.maxAgeSeconds ?? 60 * 60;
  const h = args.history;
  let start = h.length; // index of the first row belonging to the burst
  while (start > 0) {
    const row = h[start - 1]!;
    if (row.direction !== 'inbound') break;
    if (isStaleInbound(row.sentEpochSeconds, args.nowEpochSeconds, maxAge)) break;
    start -= 1;
  }

  const tail = h.slice(start);
  const parts: string[] = [];
  let currentIncluded = false;
  for (let i = 0; i < tail.length; i++) {
    const row = tail[i]!;
    const isCurrent =
      args.currentMetaId != null
        ? row.metaMessageId === args.currentMetaId
        : i === tail.length - 1; // no id to match — assume the newest row is the trigger
    if (isCurrent) {
      parts.push(args.currentText);
      currentIncluded = true;
    } else if (row.body && row.body.trim().length > 0) {
      parts.push(row.body);
    }
  }
  if (!currentIncluded) parts.push(args.currentText);

  return {
    userTurn: parts.join('\n'),
    historyBeforeBurst: start,
    burstSize: parts.length,
  };
}
