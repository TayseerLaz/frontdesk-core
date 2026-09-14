// Phone-task write-back decision — the ONE rule that decides whether an AI
// phone call is allowed to change a business record.
//
// Extracted into its own module for two reasons:
//   1. it is the safety-critical part of the CALL-E integration, and it must be
//      testable without a database, an env file or a network (test/pure);
//   2. it must have NO imports, so nothing can leak into the pure test layer.
//
// The rule, in one sentence: a record is mutated only when the call completed,
// CALL-E reported `task_completed` with confidence >= APPLY_MIN_CONFIDENCE, and
// the extracted disposition is BOTH explicit AND uncontradicted by the rest of
// the extraction. Everything else becomes `needs_review` and a human decides.
//
// 2026-09-14 — the "uncontradicted" half of that sentence is why this module
// exists. The previous inline version cancelled a COD order on
// `confirmed === 'no'` regardless of disposition, so a customer who said "no,
// not like that, I want to change the order" (disposition `changed`,
// confirmed `no`) had their order CANCELLED instead of routed to a human. A
// reviewer on the CALL-E community repository caught it. An ambiguous answer
// must never be resolved into a destructive write.

/** Minimum completion confidence before any record may be mutated. */
export const APPLY_MIN_CONFIDENCE = 0.7;

export type PhoneTaskAction = 'confirmed' | 'cancelled' | 'needs_review' | 'noop';

export interface WriteBackDecision {
  action: PhoneTaskAction;
  reason: string;
}

export interface WriteBackInput {
  /** PhoneTask.kind — 'cod_order_confirm' | 'booking_confirm' | anything else. */
  kind: string;
  /** CALL-E call status; only 'completed' may mutate. */
  status: string;
  failureMessage?: string | null;
  taskCompleted: boolean;
  /** CALL-E completion confidence, 0..1. */
  confidence: number;
  /** The schema-validated structured result, or null when absent. */
  result: Record<string, unknown> | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function decideWriteBack(input: WriteBackInput): WriteBackDecision {
  if (input.status !== 'completed') {
    return {
      action: 'needs_review',
      reason: `Call ${input.status}${input.failureMessage ? `: ${input.failureMessage}` : ''}`,
    };
  }
  if (!input.taskCompleted || input.confidence < APPLY_MIN_CONFIDENCE || !input.result) {
    return {
      action: 'needs_review',
      reason: `Low confidence (${Math.round(input.confidence * 100)}%) or task not completed`,
    };
  }

  const result = input.result;
  const disposition = str(result.disposition);

  if (input.kind === 'cod_order_confirm') {
    const confirmed = str(result.confirmed);
    // Confirm: explicit disposition AND an explicit yes.
    if (disposition === 'confirmed' && confirmed === 'yes') {
      return { action: 'confirmed', reason: 'Customer confirmed the order by phone' };
    }
    // Cancel: an explicit CANCELLED disposition, not merely a "no" to the
    // read-back. `confirmed !== 'yes'` only blocks a self-contradicting
    // extraction (cancelled + yes), which is itself a reason for a human.
    if (disposition === 'cancelled' && confirmed !== 'yes') {
      return { action: 'cancelled', reason: 'Customer cancelled the order by phone' };
    }
    return {
      action: 'needs_review',
      reason: reviewReason(disposition, confirmed, str(result.requested_changes)),
    };
  }

  if (input.kind === 'booking_confirm') {
    const canAttend = str(result.can_attend);
    if (disposition === 'confirmed' && canAttend === 'yes') {
      return { action: 'confirmed', reason: 'Customer confirmed the appointment by phone' };
    }
    if (disposition === 'declined' && canAttend !== 'yes') {
      return { action: 'cancelled', reason: 'Customer declined the appointment by phone' };
    }
    return {
      action: 'needs_review',
      reason: reviewReason(disposition, canAttend, str(result.requested_changes)),
    };
  }

  return { action: 'noop', reason: 'Custom goal — result recorded, nothing mutated' };
}

// A reason an operator can act on without opening the transcript.
function reviewReason(disposition: string, answer: string, changes: string): string {
  const d = disposition || 'unknown';
  if (disposition === 'changed' || changes) {
    return `Customer asked for changes (${d})${changes ? `: ${changes}` : ''}`;
  }
  if (answer === 'no') {
    return `Customer did not accept the details as read back (${d})`;
  }
  return `Disposition: ${d}`;
}
