import nodemailer from 'nodemailer';

import { env } from './env.js';

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

let transporter: nodemailer.Transporter | null = null;

function smtpTransporter(): nodemailer.Transporter {
  if (transporter) return transporter;
  // Prod SMTP (AWS SES via STARTTLS on 587). Auth is required when EMAIL_SMTP_HOST is set.
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
  // Dev / fallback: plain SMTP to Mailpit/Mailhog (no auth, no TLS).
  transporter = nodemailer.createTransport({
    host: env.EMAIL_DEV_SMTP_HOST,
    port: env.EMAIL_DEV_SMTP_PORT,
    secure: false,
    ignoreTLS: true,
  });
  return transporter;
}

export async function sendEmail({ to, subject, html, text }: SendArgs): Promise<void> {
  await smtpTransporter().sendMail({ from: env.EMAIL_FROM, to, subject, html, text });
}

// Escape user/tenant/lead-supplied strings before interpolating them into the
// HTML email bodies below. Without this, a value like an inviter name, an org
// name, or a lead's name/phone (the latter arriving from the PUBLIC marketing
// lead form) could inject arbitrary markup into an internal or customer-facing
// email. `&` must be replaced first so we don't double-escape the entities we
// introduce. NOTE: only apply this to values that land in the HTML `html`
// string — never to the plaintext `text` variants.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- templates ------------------------------------------------------
// Minimal, brand-consistent HTML. Phase 1 keeps templates inline for speed;
// later we can move to React Email if we want richer composition.

const baseStyles = `
  <style>
    body { margin: 0; padding: 0; background: #faf9f5; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #360516; }
    .wrap { max-width: 560px; margin: 32px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(54,5,22,.08); }
    .header { background: #360516; padding: 24px 32px; }
    .brand { color: #cfc0a9; font-size: 18px; font-weight: 600; letter-spacing: .02em; }
    .body { padding: 32px; line-height: 1.55; font-size: 15px; color: #360516; }
    .btn { display: inline-block; background: #360516; color: #ffffff !important; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-weight: 600; margin: 16px 0; }
    .footer { padding: 16px 32px 24px; color: #846872; font-size: 12px; background: #faf9f5; }
    .url { word-break: break-all; color: #5c2b2e; font-size: 12px; }
  </style>
`;

const wrap = (innerHtml: string) => `
  <!doctype html>
  <html><head><meta charset="utf-8" />${baseStyles}</head>
  <body>
    <div class="wrap">
      <div class="header"><div class="brand">Hader AI</div></div>
      <div class="body">${innerHtml}</div>
      <div class="footer">Hader AI · Every WhatsApp, answered.</div>
    </div>
  </body></html>
`;

export function emailVerifyTemplate(args: { firstName: string | null; url: string }) {
  const greeting = args.firstName ? `Hi ${args.firstName},` : 'Welcome,';
  const htmlGreeting = args.firstName ? `Hi ${escapeHtml(args.firstName)},` : 'Welcome,';
  const html = wrap(`
    <p>${htmlGreeting}</p>
    <p>Confirm your email address to finish setting up your Hader account.</p>
    <p><a class="btn" href="${args.url}">Verify email</a></p>
    <p class="url">Or copy and paste this URL: ${args.url}</p>
    <p>This link expires in 24 hours.</p>
  `);
  const text = `${greeting}\n\nConfirm your email address: ${args.url}\n\nThis link expires in 24 hours.`;
  return { subject: 'Verify your Hader email', html, text };
}

export function welcomeTemplate(args: {
  firstName: string | null;
  organizationName: string;
  portalUrl: string;
}) {
  const greeting = args.firstName ? `Welcome ${args.firstName},` : 'Welcome,';
  const htmlGreeting = args.firstName ? `Welcome ${escapeHtml(args.firstName)},` : 'Welcome,';
  const html = wrap(`
    <p>${htmlGreeting}</p>
    <p>Your <strong>${escapeHtml(args.organizationName)}</strong> workspace on Hader is ready. Here are the things most clients want to do first:</p>
    <ol>
      <li><strong>Add your products and services</strong> — paste from a spreadsheet or import a CSV.</li>
      <li><strong>Fill business info</strong> — opening hours, contact channels, FAQs.</li>
      <li><strong>Issue an API key</strong> for your chatbot to read your live catalog.</li>
      <li><strong>Connect WhatsApp</strong> — paste your Meta credentials and verify.</li>
    </ol>
    <p><a class="btn" href="${args.portalUrl}/dashboard">Open your dashboard</a></p>
    <p>Need a hand? Reply to this email and the Hader team will help.</p>
  `);
  const text = `${greeting}\n\nYour ${args.organizationName} workspace on Hader is ready.\n\nFirst things to do:\n  1. Add products and services\n  2. Fill business info\n  3. Issue an API key for your chatbot\n  4. Connect WhatsApp\n\nDashboard: ${args.portalUrl}/dashboard\n\nReply to this email if you need help — the Hader team is here.`;
  return { subject: `Welcome to Hader, ${args.organizationName}`, html, text };
}

export function passwordResetTemplate(args: { firstName: string | null; url: string }) {
  const greeting = args.firstName ? `Hi ${args.firstName},` : 'Hello,';
  const htmlGreeting = args.firstName ? `Hi ${escapeHtml(args.firstName)},` : 'Hello,';
  const html = wrap(`
    <p>${htmlGreeting}</p>
    <p>We received a request to reset your Hader password. Click below to choose a new one.</p>
    <p><a class="btn" href="${args.url}">Reset password</a></p>
    <p class="url">Or copy and paste: ${args.url}</p>
    <p>If you didn't request this, you can ignore this email — your password won't change.</p>
    <p>This link expires in 1 hour.</p>
  `);
  const text = `${greeting}\n\nReset your password: ${args.url}\n\nIf you didn't request this, ignore this email.`;
  return { subject: 'Reset your Hader password', html, text };
}

/**
 * Sent when an ALIGNED super-admin provisions a tenant on the customer's
 * behalf (skipping the customer-driven signup flow). The customer's
 * password is delivered here in plain text — they're nudged to change
 * it on first login. Pre-verified email, so no verify-email step.
 */
export function tenantProvisionedTemplate(args: {
  firstName: string | null;
  organizationName: string;
  email: string;
  password: string;
  loginUrl: string;
}) {
  const greeting = args.firstName ? `Hi ${args.firstName},` : 'Hello,';
  const htmlGreeting = args.firstName ? `Hi ${escapeHtml(args.firstName)},` : 'Hello,';
  const html = wrap(`
    <p>${htmlGreeting}</p>
    <p>The Hader team has set up your <strong>${escapeHtml(args.organizationName)}</strong> workspace. You can log in right away with the credentials below.</p>
    <p style="background:#faf9f5;padding:14px;border-radius:6px;font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-size:14px;color:#360516">
      <strong>Email:</strong> ${escapeHtml(args.email)}<br>
      <strong>Password:</strong> ${escapeHtml(args.password)}
    </p>
    <p><a class="btn" href="${args.loginUrl}">Log in</a></p>
    <p><strong>Please change your password</strong> on first login (Settings → Profile → Change password). The temporary password above is shared by email, so treat it as compromised once you're in.</p>
    <p>Reply to this email if you need help getting started — the Hader team is here.</p>
  `);
  const text = `${greeting}\n\nThe Hader team has set up your ${args.organizationName} workspace.\n\nEmail:    ${args.email}\nPassword: ${args.password}\n\nLog in: ${args.loginUrl}\n\nPlease change your password on first login (Settings → Profile → Change password).`;
  return {
    subject: `Your ${args.organizationName} workspace on Hader is ready`,
    html,
    text,
  };
}

export function invitationTemplate(args: { orgName: string; inviterName: string; url: string }) {
  const html = wrap(`
    <p><strong>${escapeHtml(args.inviterName)}</strong> has invited you to join <strong>${escapeHtml(args.orgName)}</strong> on Hader.</p>
    <p><a class="btn" href="${args.url}">Accept invitation</a></p>
    <p class="url">Or copy and paste: ${args.url}</p>
    <p>This invitation expires in 7 days.</p>
  `);
  const text = `${args.inviterName} invited you to join ${args.orgName} on Hader.\n\nAccept: ${args.url}\n\nExpires in 7 days.`;
  return { subject: `Join ${args.orgName} on Hader`, html, text };
}
