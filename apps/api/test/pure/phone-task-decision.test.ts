// The write-back rule for AI phone calls. This is the file that has to fail if
// anyone ever widens the conditions under which a call may change a record.
//
// The regression that motivated it: a COD order was cancelled whenever the
// extraction carried `confirmed: 'no'`, even when the disposition said the
// customer had asked for CHANGES. "No, not like that, I want to add something"
// is not a cancellation, and an ambiguous answer must reach a human.
import { describe, expect, it } from 'vitest';

import {
  APPLY_MIN_CONFIDENCE,
  decideWriteBack,
  type WriteBackInput,
} from '../../src/lib/phone-task-decision.js';

function call(over: Partial<WriteBackInput> = {}): WriteBackInput {
  return {
    kind: 'cod_order_confirm',
    status: 'completed',
    taskCompleted: true,
    confidence: 0.95,
    result: { disposition: 'confirmed', confirmed: 'yes' },
    ...over,
  };
}

describe('decideWriteBack — gates before any disposition is read', () => {
  it('parks a call that did not complete', () => {
    const d = decideWriteBack(call({ status: 'failed', failureMessage: 'busy' }));
    expect(d.action).toBe('needs_review');
    expect(d.reason).toContain('busy');
  });

  it('parks a completed call whose task was not completed', () => {
    expect(decideWriteBack(call({ taskCompleted: false })).action).toBe('needs_review');
  });

  it('parks anything below the confidence floor and admits the floor itself', () => {
    expect(decideWriteBack(call({ confidence: APPLY_MIN_CONFIDENCE - 0.01 })).action).toBe(
      'needs_review',
    );
    expect(decideWriteBack(call({ confidence: APPLY_MIN_CONFIDENCE })).action).toBe('confirmed');
  });

  it('parks a call with no structured result', () => {
    expect(decideWriteBack(call({ result: null })).action).toBe('needs_review');
  });
});

describe('decideWriteBack — cash-on-delivery orders', () => {
  it('confirms only on an explicit disposition and an explicit yes', () => {
    expect(decideWriteBack(call()).action).toBe('confirmed');
  });

  it('cancels on an explicit cancelled disposition', () => {
    const d = decideWriteBack(call({ result: { disposition: 'cancelled', confirmed: 'no' } }));
    expect(d.action).toBe('cancelled');
  });

  it('cancels on an explicit cancellation even when the yes/no field is unknown', () => {
    expect(
      decideWriteBack(call({ result: { disposition: 'cancelled', confirmed: 'unknown' } })).action,
    ).toBe('cancelled');
  });

  // THE REGRESSION.
  it('does NOT cancel when the customer asked for changes, whatever the yes/no field says', () => {
    const d = decideWriteBack(
      call({
        result: {
          disposition: 'changed',
          confirmed: 'no',
          requested_changes: 'Add 1 large fries',
        },
      }),
    );
    expect(d.action).toBe('needs_review');
    expect(d.reason).toContain('Add 1 large fries');
  });

  it('does not cancel on a bare no without a cancellation disposition', () => {
    expect(
      decideWriteBack(call({ result: { disposition: 'needs_human', confirmed: 'no' } })).action,
    ).toBe('needs_review');
  });

  it('parks a self-contradicting extraction rather than acting on it', () => {
    expect(
      decideWriteBack(call({ result: { disposition: 'cancelled', confirmed: 'yes' } })).action,
    ).toBe('needs_review');
    expect(
      decideWriteBack(call({ result: { disposition: 'confirmed', confirmed: 'no' } })).action,
    ).toBe('needs_review');
  });

  it('parks every non-committal disposition', () => {
    for (const disposition of ['voicemail', 'no_answer', 'wrong_number', 'needs_human', '']) {
      expect(decideWriteBack(call({ result: { disposition, confirmed: 'unknown' } })).action).toBe(
        'needs_review',
      );
    }
  });
});

describe('decideWriteBack — bookings', () => {
  const booking = (result: Record<string, unknown>) =>
    decideWriteBack(call({ kind: 'booking_confirm', result }));

  it('confirms on an explicit disposition and an explicit yes', () => {
    expect(booking({ disposition: 'confirmed', can_attend: 'yes' }).action).toBe('confirmed');
  });

  it('cancels on an explicit decline', () => {
    expect(booking({ disposition: 'declined', can_attend: 'no' }).action).toBe('cancelled');
  });

  it('does not cancel when the customer wants to reschedule', () => {
    expect(
      booking({ disposition: 'changed', can_attend: 'no', requested_changes: 'Thursday instead' })
        .action,
    ).toBe('needs_review');
  });

  it('parks a self-contradicting extraction', () => {
    expect(booking({ disposition: 'declined', can_attend: 'yes' }).action).toBe('needs_review');
  });
});

describe('decideWriteBack — custom goals never mutate a record', () => {
  it('returns noop whatever the disposition says', () => {
    for (const disposition of ['confirmed', 'cancelled', 'changed']) {
      expect(decideWriteBack(call({ kind: 'custom', result: { disposition } })).action).toBe('noop');
    }
  });
});
