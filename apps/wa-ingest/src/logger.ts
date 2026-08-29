import pino from 'pino';

/**
 * A logger that CANNOT log a message body.
 *
 * Blocker B12: customer DM text reaching journald or Sentry sits outside every
 * retention promise we make, and a malformed-message spike would write thousands of
 * them. Rather than rely on redaction paths staying correct, the only helper exposed
 * for message events takes metadata fields explicitly and has no parameter that
 * could carry text. Do not add a `body`/`text`/`caption` field to `msgMeta` — and note
 * that a group's SUBJECT is third-party free text too, so `chatName` does not belong
 * here either. Booleans and counts only.
 */
const base = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Defence in depth: even if a body reaches a log call by another route, drop it.
  redact: {
    paths: [
      'body',
      '*.body',
      'text',
      '*.text',
      'caption',
      '*.caption',
      'message',
      '*.message',
      'waMsg',
      '*.waMsg',
      'conversation',
      '*.conversation',
    ],
    censor: '[redacted]',
  },
});

export const logger = base;

/** The ONLY shape allowed for per-message logging. Deliberately carries no text. */
export interface MsgMeta {
  grantId: string;
  waMsgId: string;
  direction: 'in' | 'out';
  kind: string;
  /** Group chat rather than a DM. A tag, not content. */
  isGroup: boolean;
  /** Character count, never the characters themselves. */
  length: number;
  live: boolean;
}

export function logMsg(event: string, meta: MsgMeta): void {
  base.debug({ ...meta }, event);
}
