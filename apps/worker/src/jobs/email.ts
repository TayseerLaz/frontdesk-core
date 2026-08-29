// Email delivery worker.
//
// The `email` BullMQ queue was defined long ago but had NO consumer — every
// caller fell back to sending inline from the request path (auth flows still
// do for their own latency reasons). This worker drains the queue so any
// producer that prefers fire-and-forget delivery (retries + backoff, no
// request-path latency) actually gets its mail sent.
//
// On failure we throw so BullMQ retries with the attempts/backoff configured by
// the enqueuer. SMTP transport falls back to Mailpit/Mailhog in dev (see
// lib/email.ts), so this is inert-but-safe without production SMTP configured.
import { Worker } from 'bullmq';

import { sendEmail } from '../lib/email.js';
import { getConnection } from '../lib/redis.js';

interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function startEmailWorker() {
  const worker = new Worker<EmailJobData>(
    'email',
    async (job) => {
      const { to, subject, html, text } = job.data;
      if (!to || !subject) {
        // Malformed job — don't retry an unsendable message forever.
        return;
      }
      await sendEmail({ to, subject, html, text: text ?? '' });
    },
    {
      connection: getConnection(),
      // Email is low-volume and order-insensitive; a small concurrency is fine.
      concurrency: 5,
    },
  );

  return worker;
}
