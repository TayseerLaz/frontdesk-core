// Minimal SMTP sender for the worker. Mirrors apps/api/src/lib/email.ts but
// only includes the bits the worker needs: a single sendEmail() call. Falls
// back to Mailpit/Mailhog when EMAIL_SMTP_HOST is unset, same as the API.
import nodemailer, { type Transporter } from 'nodemailer';

import { env } from './env.js';

let transporter: Transporter | null = null;

function getTransport(): Transporter {
  if (transporter) return transporter;
  if (env.EMAIL_SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: env.EMAIL_SMTP_HOST,
      port: env.EMAIL_SMTP_PORT ?? 587,
      secure: env.EMAIL_SMTP_SECURE ?? false,
      auth:
        env.EMAIL_SMTP_USER && env.EMAIL_SMTP_PASS
          ? { user: env.EMAIL_SMTP_USER, pass: env.EMAIL_SMTP_PASS }
          : undefined,
    });
    return transporter;
  }
  transporter = nodemailer.createTransport({
    host: env.EMAIL_DEV_SMTP_HOST,
    port: env.EMAIL_DEV_SMTP_PORT,
    secure: false,
    ignoreTLS: true,
  });
  return transporter;
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  await getTransport().sendMail({
    from: env.EMAIL_FROM,
    to: args.to,
    subject: args.subject,
    html: args.html,
    text: args.text,
  });
}
