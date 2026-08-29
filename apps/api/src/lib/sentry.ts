// Sentry initialisation. No-op if SENTRY_DSN is unset.
import * as Sentry from '@sentry/node';

import { env } from './env.js';

let initialised = false;

export function initSentry() {
  if (initialised) return;
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    release: process.env.SENTRY_RELEASE,
  });
  initialised = true;
}

export function captureError(err: unknown, context?: Record<string, unknown>) {
  if (!env.SENTRY_DSN) return;
  Sentry.captureException(err, { extra: context });
}
