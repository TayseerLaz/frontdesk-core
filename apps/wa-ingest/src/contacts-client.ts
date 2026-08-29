import { createHmac } from 'node:crypto';

import { env } from './env.js';
import { logger } from './logger.js';

/**
 * the platform client for the CONTACT-SYNC feature.
 *
 * Deliberately separate from platform-client.ts and signed with a DIFFERENT secret. Sales
 * Scan's capture half is gated behind 16 open blockers; if both features shared one
 * credential, switching on contact sync would silently hand this process the ability to
 * act on the capture seam too. Two features with very different readiness do not share a
 * key.
 */

function sign(body: string): { ts: string; sig: string } {
  const ts = Date.now().toString();
  const sig = createHmac('sha256', env.CONTACTS_SECRET!).update(`${ts}.${body}`).digest('hex');
  return { ts, sig };
}

async function post<T>(pathname: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const { ts, sig } = sign(body);
  const res = await fetch(`${env.PLATFORM_API_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wa-contacts-timestamp': ts,
      'x-wa-contacts-signature': `sha256=${sig}`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`platform ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

export interface PendingContactSession {
  sessionId: string;
  organizationId: string;
  /** Absolute deadline — tear the socket down at this point no matter what. */
  expiresAt: string;
}

export async function fetchPendingSessions(): Promise<PendingContactSession[]> {
  const r = await post<{ data: PendingContactSession[] }>('/api/v1/wa-contacts/pending', {});
  return r.data;
}

export async function pushQr(
  sessionId: string,
  qr: string | null,
  linkedPhone?: string | null,
): Promise<void> {
  await post('/api/v1/wa-contacts/qr', { sessionId, qr, linkedPhone: linkedPhone ?? null });
}

export interface HarvestedContact {
  /** Digits only, no '+'. WhatsApp JIDs are already international. */
  phone: string;
  name: string | null;
}

export async function pushContacts(
  sessionId: string,
  contacts: HarvestedContact[],
  linkedPhone: string | null,
): Promise<{ stored: number }> {
  const r = await post<{ data: { stored: number } }>('/api/v1/wa-contacts/contacts', {
    sessionId,
    contacts,
    linkedPhone,
  });
  return r.data;
}

export async function reportEnded(sessionId: string, reason: string): Promise<void> {
  await post('/api/v1/wa-contacts/ended', { sessionId, reason });
}

export function logContactsFailure(err: unknown, what: string): void {
  logger.error({ err, what }, 'contacts push failed');
}
