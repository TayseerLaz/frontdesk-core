// Follow-ups — automated re-engagement over WhatsApp templates.
//
// Three independent types under one per-tenant config (BotConfig.followUps):
//   • noReply     — customer inquired, got an answer, went silent → follow up
//                   after firstDelayHours, once more after secondDelayHours,
//                   then stop. Any customer reply resets the cadence.
//   • afterBooking — a confirmed booking's appointment passed → check in
//                   delayHours later (post-visit "how was it?").
//   • idleCheckin — a real past customer has been silent idleDays → casual
//                   check-in, spaced at least idleDays apart.
//
// Every send is an APPROVED Meta template (we are outside the 24h service
// window by construction), so each type is inert until the tenant picks an
// approved template for it. All sends respect Contact optedOutAt / blockedAt /
// deletedAt and wallet metering.
//
// This module is PURE — no env, no db imports (env.ts process.exit(1)s, the
// sales-scan-window.ts precedent) — so the decision table runs in the pure
// hard CI gate and is shared verbatim by the api (config validation) and the
// worker (the tick).
import { z } from 'zod';

/** Hard per-org per-tick send budget across all three types. Keeps a freshly
 * enabled feature (or a backlog after downtime) from bursting a tenant's
 * number — the same class of accident as the 2026-08 stale-redelivery blast. */
export const FOLLOW_UP_MAX_SENDS_PER_ORG_TICK = 30;

/** noReply scan window: threads whose last inbound is older than this are out
 * of the cadence for good (the cadence completes within ~4 days; bounding the
 * scan keeps the tick's query size flat forever). */
export const FOLLOW_UP_NO_REPLY_LOOKBACK_DAYS = 30;

/** idleCheckin: never resurrect threads whose customer hasn't written within
 * this window — re-engaging a 2-year-dead contact reads as spam and burns
 * WhatsApp quality rating. */
export const FOLLOW_UP_IDLE_LOOKBACK_DAYS = 180;

/** afterBooking: if the tick was down (or the feature off) long enough that a
 * booking's follow-up is this far past due, skip it — a "how did it go?" a
 * week late is worse than none. */
export const FOLLOW_UP_BOOKING_MAX_OVERDUE_DAYS = 7;

const noReplySchema = z.object({
  enabled: z.boolean().default(false),
  templateName: z.string().trim().min(1).max(200).nullable().default(null),
  firstDelayHours: z.number().int().min(1).max(720).default(24),
  secondDelayHours: z.number().int().min(1).max(2160).default(72),
});

const afterBookingSchema = z.object({
  enabled: z.boolean().default(false),
  templateName: z.string().trim().min(1).max(200).nullable().default(null),
  delayHours: z.number().int().min(1).max(720).default(24),
});

const idleCheckinSchema = z.object({
  enabled: z.boolean().default(false),
  templateName: z.string().trim().min(1).max(200).nullable().default(null),
  idleDays: z.number().int().min(3).max(365).default(30),
});

export const followUpsConfigSchema = z.object({
  /** Master switch — nothing runs while false. */
  enabled: z.boolean().default(false),
  /** Stamped SERVER-SIDE on the off→on transition; eligibility never reaches
   * further back than this, so enabling the feature can't blast historical
   * threads. Client-sent values are ignored by the API. */
  enabledAt: z.string().datetime().nullable().default(null),
  noReply: noReplySchema.default({}),
  afterBooking: afterBookingSchema.default({}),
  idleCheckin: idleCheckinSchema.default({}),
});

export type FollowUpsConfig = z.infer<typeof followUpsConfigSchema>;

/** Parse an untrusted BotConfig.followUps JSON blob. Null = missing/invalid —
 * callers treat that as "feature not configured", never as an error. */
export function normalizeFollowUpsConfig(raw: unknown): FollowUpsConfig | null {
  if (raw == null || typeof raw !== 'object') return null;
  const parsed = followUpsConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type NoReplyThreadState = {
  lastInboundAt: Date | null;
  /** Newest message either direction (schema: answered ⇔ lastMessageAt > lastInboundAt). */
  lastMessageAt: Date;
  inboundCount: number;
  followUpStage: number;
  followUpLastSentAt: Date | null;
};

export type NoReplyAction = 'send_first' | 'send_second' | 'none';

/**
 * The no-reply cadence, derived purely from thread columns — no state resets
 * are ever written on the inbound hot path:
 *   fresh   (no follow-up sent since their last inbound): answered + silent
 *           firstDelayHours → send_first (stage:=1).
 *   inFlight(stage 1, no inbound since the follow-up): silent another
 *           secondDelayHours → send_second (stage:=2, cadence closed).
 *   A customer reply makes lastInboundAt > followUpLastSentAt ⇒ fresh again —
 *   a NEW inquiry gets its own cadence, per the tenant spec.
 */
export function noReplyAction(
  s: NoReplyThreadState,
  cfg: FollowUpsConfig['noReply'],
  enabledAt: Date,
  now: Date,
): NoReplyAction {
  if (!cfg.enabled || !cfg.templateName) return 'none';
  if (!s.lastInboundAt || s.inboundCount <= 0) return 'none';
  // Never reach behind the enable stamp (no historical blast) …
  if (s.lastInboundAt.getTime() < enabledAt.getTime()) return 'none';
  // … and never chase threads that left the scan window.
  if (now.getTime() - s.lastInboundAt.getTime() > FOLLOW_UP_NO_REPLY_LOOKBACK_DAYS * DAY_MS)
    return 'none';

  const fresh =
    !s.followUpLastSentAt || s.lastInboundAt.getTime() > s.followUpLastSentAt.getTime();
  if (fresh) {
    // Only follow up conversations we actually answered — chasing someone we
    // ignored ("just checking in!" after silence from OUR side) reads absurd.
    if (s.lastMessageAt.getTime() <= s.lastInboundAt.getTime()) return 'none';
    if (now.getTime() - s.lastInboundAt.getTime() < cfg.firstDelayHours * HOUR_MS) return 'none';
    return 'send_first';
  }
  if (s.followUpStage === 1 && s.followUpLastSentAt) {
    if (now.getTime() - s.followUpLastSentAt.getTime() < cfg.secondDelayHours * HOUR_MS)
      return 'none';
    return 'send_second';
  }
  // stage >= 2 (cadence closed — incl. an idleCheckin that claimed the slot)
  // or an inconsistent stamp: do nothing until the customer replies.
  return 'none';
}

export type BookingFollowUpState = {
  appointmentAt: Date | null;
  followUpSentAt: Date | null;
  status: string;
};

/** Post-appointment follow-up: fires once, delayHours after appointmentAt, for
 * confirmed/completed bookings whose appointment happened after the feature
 * was enabled. Bounded by FOLLOW_UP_BOOKING_MAX_OVERDUE_DAYS. */
export function afterBookingDue(
  b: BookingFollowUpState,
  cfg: FollowUpsConfig['afterBooking'],
  enabledAt: Date,
  now: Date,
): boolean {
  if (!cfg.enabled || !cfg.templateName) return false;
  if (!b.appointmentAt || b.followUpSentAt) return false;
  if (b.status !== 'confirmed' && b.status !== 'completed') return false;
  if (b.appointmentAt.getTime() < enabledAt.getTime()) return false;
  const dueAt = b.appointmentAt.getTime() + cfg.delayHours * HOUR_MS;
  if (now.getTime() < dueAt) return false;
  if (now.getTime() - dueAt > FOLLOW_UP_BOOKING_MAX_OVERDUE_DAYS * DAY_MS) return false;
  return true;
}

export type IdleThreadState = {
  lastInboundAt: Date | null;
  lastMessageAt: Date;
  inboundCount: number;
  followUpLastSentAt: Date | null;
};

/** Casual check-in for a real past customer gone quiet: at least idleDays
 * since the last message in EITHER direction and since our last follow-up
 * (so repeat check-ins stay idleDays apart), customer active within the
 * lookback window. Deliberately NOT gated on enabledAt — re-engaging
 * existing quiet customers is the point — the lookback + per-tick budget +
 * idleDays spacing are the blast controls. */
export function idleCheckinDue(
  s: IdleThreadState,
  cfg: FollowUpsConfig['idleCheckin'],
  now: Date,
): boolean {
  if (!cfg.enabled || !cfg.templateName) return false;
  if (!s.lastInboundAt || s.inboundCount <= 0) return false;
  if (now.getTime() - s.lastInboundAt.getTime() > FOLLOW_UP_IDLE_LOOKBACK_DAYS * DAY_MS)
    return false;
  const lastTouch = Math.max(
    s.lastMessageAt.getTime(),
    s.followUpLastSentAt?.getTime() ?? 0,
  );
  return now.getTime() - lastTouch >= cfg.idleDays * DAY_MS;
}

/** True when a template body carries the single positional {{1}} placeholder
 * (the only variable shape follow-ups support — filled with the customer's
 * name). Mirrors platform-lead-outreach's gate. */
export function templateWantsName(bodyText: string | null | undefined): boolean {
  return /\{\{\s*1\s*\}\}/.test(bodyText ?? '');
}
