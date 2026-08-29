// Pure-logic gate for the follow-up engines (@platform/shared/follow-ups).
// Runs with NO database and NO environment (vitest.pure.config.ts).
//
// What's pinned here is the part that can silently do damage: a wrong "due"
// answer doesn't crash anything — it messages a real customer's WhatsApp.
// The catastrophic failure modes are each a single boolean away:
//   • reaching behind enabledAt = blasting every historically-silent thread
//     the moment a tenant enables the feature;
//   • chasing customers WE never answered;
//   • ignoring the stage/lastSent stamps = a follow-up loop on one thread;
//   • messaging opted-out contacts (gated in the tick, but the decision
//     table must never claim 'due' states the tick doesn't expect).
import { describe, expect, it } from 'vitest';

import {
  FOLLOW_UP_BOOKING_MAX_OVERDUE_DAYS,
  FOLLOW_UP_IDLE_LOOKBACK_DAYS,
  FOLLOW_UP_NO_REPLY_LOOKBACK_DAYS,
  afterBookingDue,
  idleCheckinDue,
  noReplyAction,
  normalizeFollowUpsConfig,
  templateWantsName,
  type FollowUpsConfig,
} from '@platform/shared';

const HOUR = 3_600_000;
const DAY = 86_400_000;

const NOW = new Date('2026-08-14T12:00:00.000Z');
const ENABLED_AT = new Date('2026-08-01T00:00:00.000Z');

const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

const NO_REPLY: FollowUpsConfig['noReply'] = {
  enabled: true,
  templateName: 'follow_up_1',
  firstDelayHours: 24,
  secondDelayHours: 72,
};
const AFTER_BOOKING: FollowUpsConfig['afterBooking'] = {
  enabled: true,
  templateName: 'post_visit',
  delayHours: 24,
};
const IDLE: FollowUpsConfig['idleCheckin'] = {
  enabled: true,
  templateName: 'hello_again',
  idleDays: 30,
};

describe('normalizeFollowUpsConfig', () => {
  it('fills every default from an empty object', () => {
    const cfg = normalizeFollowUpsConfig({});
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(false);
    expect(cfg!.noReply.firstDelayHours).toBe(24);
    expect(cfg!.noReply.secondDelayHours).toBe(72);
    expect(cfg!.afterBooking.delayHours).toBe(24);
    expect(cfg!.idleCheckin.idleDays).toBe(30);
  });

  it('rejects junk instead of guessing', () => {
    expect(normalizeFollowUpsConfig(null)).toBeNull();
    expect(normalizeFollowUpsConfig('yes')).toBeNull();
    expect(normalizeFollowUpsConfig({ noReply: { firstDelayHours: -4 } })).toBeNull();
    expect(normalizeFollowUpsConfig({ idleCheckin: { idleDays: 1 } })).toBeNull();
  });
});

describe('noReplyAction', () => {
  const answeredSilent = (silentMs: number) => ({
    lastInboundAt: at(silentMs),
    lastMessageAt: at(silentMs - 60_000), // we replied a minute after them
    inboundCount: 3,
    followUpStage: 0,
    followUpLastSentAt: null,
  });

  it('sends the first follow-up once answered + silent past firstDelayHours', () => {
    expect(noReplyAction(answeredSilent(25 * HOUR), NO_REPLY, ENABLED_AT, NOW)).toBe('send_first');
  });

  it('waits while the silence is shorter than firstDelayHours', () => {
    expect(noReplyAction(answeredSilent(23 * HOUR), NO_REPLY, ENABLED_AT, NOW)).toBe('none');
  });

  it('never chases a customer we did not answer', () => {
    const s = {
      lastInboundAt: at(48 * HOUR),
      lastMessageAt: at(48 * HOUR), // their message IS the newest — unanswered
      inboundCount: 2,
      followUpStage: 0,
      followUpLastSentAt: null,
    };
    expect(noReplyAction(s, NO_REPLY, ENABLED_AT, NOW)).toBe('none');
  });

  it('NEVER reaches behind enabledAt (the historical-blast guard)', () => {
    const s = answeredSilent(48 * HOUR);
    const enabledAfter = new Date(NOW.getTime() - HOUR); // feature turned on an hour ago
    expect(noReplyAction(s, NO_REPLY, enabledAfter, NOW)).toBe('none');
  });

  it('drops threads that left the scan window', () => {
    const s = answeredSilent((FOLLOW_UP_NO_REPLY_LOOKBACK_DAYS + 1) * DAY);
    const oldEnable = new Date('2026-01-01T00:00:00.000Z');
    expect(noReplyAction(s, NO_REPLY, oldEnable, NOW)).toBe('none');
  });

  it('sends the second follow-up after secondDelayHours of continued silence', () => {
    const s = {
      lastInboundAt: at(5 * DAY),
      lastMessageAt: at(73 * HOUR), // the first follow-up bumped lastMessageAt
      inboundCount: 3,
      followUpStage: 1,
      followUpLastSentAt: at(73 * HOUR),
    };
    expect(noReplyAction(s, NO_REPLY, ENABLED_AT, NOW)).toBe('send_second');
  });

  it('waits between the first and second follow-up', () => {
    const s = {
      lastInboundAt: at(3 * DAY),
      lastMessageAt: at(10 * HOUR),
      inboundCount: 3,
      followUpStage: 1,
      followUpLastSentAt: at(10 * HOUR),
    };
    expect(noReplyAction(s, NO_REPLY, ENABLED_AT, NOW)).toBe('none');
  });

  it('closes the cadence at stage 2 — no third follow-up while they stay silent', () => {
    const s = {
      lastInboundAt: at(10 * DAY),
      lastMessageAt: at(6 * DAY), // the second follow-up was the last message
      inboundCount: 3,
      followUpStage: 2,
      followUpLastSentAt: at(6 * DAY), // …and nothing inbound since
    };
    expect(noReplyAction(s, NO_REPLY, ENABLED_AT, NOW)).toBe('none');
  });

  it('a customer reply re-opens the cadence (fresh inquiry, fresh clock)', () => {
    const s = {
      lastInboundAt: at(25 * HOUR), // they replied AFTER our last follow-up…
      lastMessageAt: at(24 * HOUR), // …we answered again…
      inboundCount: 5,
      followUpStage: 2, // …even though the previous cadence was closed
      followUpLastSentAt: at(6 * DAY),
    };
    expect(noReplyAction(s, NO_REPLY, ENABLED_AT, NOW)).toBe('send_first');
  });

  it('is inert without a template or when disabled', () => {
    const s = answeredSilent(48 * HOUR);
    expect(noReplyAction(s, { ...NO_REPLY, templateName: null }, ENABLED_AT, NOW)).toBe('none');
    expect(noReplyAction(s, { ...NO_REPLY, enabled: false }, ENABLED_AT, NOW)).toBe('none');
  });

  it('ignores threads with no real inbound', () => {
    const s = {
      lastInboundAt: null,
      lastMessageAt: at(2 * DAY),
      inboundCount: 0,
      followUpStage: 0,
      followUpLastSentAt: null,
    };
    expect(noReplyAction(s, NO_REPLY, ENABLED_AT, NOW)).toBe('none');
  });
});

describe('afterBookingDue', () => {
  const booking = (over: Partial<Parameters<typeof afterBookingDue>[0]> = {}) => ({
    appointmentAt: at(25 * HOUR),
    followUpSentAt: null,
    status: 'confirmed',
    ...over,
  });

  it('fires delayHours after the appointment', () => {
    expect(afterBookingDue(booking(), AFTER_BOOKING, ENABLED_AT, NOW)).toBe(true);
  });

  it('waits until the delay has passed', () => {
    expect(
      afterBookingDue(booking({ appointmentAt: at(2 * HOUR) }), AFTER_BOOKING, ENABLED_AT, NOW),
    ).toBe(false);
  });

  it('fires exactly once (stamp wins)', () => {
    expect(
      afterBookingDue(booking({ followUpSentAt: at(HOUR) }), AFTER_BOOKING, ENABLED_AT, NOW),
    ).toBe(false);
  });

  it('skips cancelled / new bookings', () => {
    expect(afterBookingDue(booking({ status: 'cancelled' }), AFTER_BOOKING, ENABLED_AT, NOW)).toBe(
      false,
    );
    expect(afterBookingDue(booking({ status: 'new' }), AFTER_BOOKING, ENABLED_AT, NOW)).toBe(false);
    expect(
      afterBookingDue(booking({ status: 'completed' }), AFTER_BOOKING, ENABLED_AT, NOW),
    ).toBe(true);
  });

  it('never reaches appointments from before the feature was enabled', () => {
    const enabledAfter = new Date(NOW.getTime() - 2 * HOUR);
    expect(afterBookingDue(booking(), AFTER_BOOKING, enabledAfter, NOW)).toBe(false);
  });

  it('gives up when too far past due (no week-late "how was it?")', () => {
    const staleBy = (FOLLOW_UP_BOOKING_MAX_OVERDUE_DAYS + 1) * DAY + 24 * HOUR;
    expect(
      afterBookingDue(booking({ appointmentAt: at(staleBy) }), AFTER_BOOKING, ENABLED_AT, NOW),
    ).toBe(false);
  });
});

describe('idleCheckinDue', () => {
  const idle = (over: Partial<Parameters<typeof idleCheckinDue>[0]> = {}) => ({
    lastInboundAt: at(35 * DAY),
    lastMessageAt: at(35 * DAY),
    inboundCount: 4,
    followUpLastSentAt: null,
    ...over,
  });

  it('fires after idleDays of full silence', () => {
    expect(idleCheckinDue(idle(), IDLE, NOW)).toBe(true);
  });

  it('waits while any message (either direction) is fresher than idleDays', () => {
    expect(idleCheckinDue(idle({ lastMessageAt: at(10 * DAY) }), IDLE, NOW)).toBe(false);
  });

  it('spaces repeat check-ins by idleDays (the stamp counts as a touch)', () => {
    expect(idleCheckinDue(idle({ followUpLastSentAt: at(10 * DAY) }), IDLE, NOW)).toBe(false);
    expect(idleCheckinDue(idle({ followUpLastSentAt: at(31 * DAY) }), IDLE, NOW)).toBe(true);
  });

  it('never resurrects threads beyond the lookback window', () => {
    const ancient = (FOLLOW_UP_IDLE_LOOKBACK_DAYS + 1) * DAY;
    expect(
      idleCheckinDue(idle({ lastInboundAt: at(ancient), lastMessageAt: at(ancient) }), IDLE, NOW),
    ).toBe(false);
  });

  it('ignores threads where the customer never wrote', () => {
    expect(idleCheckinDue(idle({ inboundCount: 0 }), IDLE, NOW)).toBe(false);
    expect(idleCheckinDue(idle({ lastInboundAt: null }), IDLE, NOW)).toBe(false);
  });

  it('is inert without a template or when disabled', () => {
    expect(idleCheckinDue(idle(), { ...IDLE, templateName: null }, NOW)).toBe(false);
    expect(idleCheckinDue(idle(), { ...IDLE, enabled: false }, NOW)).toBe(false);
  });
});

describe('templateWantsName', () => {
  it('detects the single positional placeholder in any spacing', () => {
    expect(templateWantsName('Hi {{1}}!')).toBe(true);
    expect(templateWantsName('Hi {{ 1 }}!')).toBe(true);
    expect(templateWantsName('Hi there!')).toBe(false);
    expect(templateWantsName(null)).toBe(false);
  });
});
