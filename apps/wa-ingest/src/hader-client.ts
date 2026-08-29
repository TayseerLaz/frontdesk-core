import { createHmac } from 'node:crypto';

import { env } from './env.js';
import { logger } from './logger.js';
import type { CapturedMessage, SessionStatus } from './session.js';

/**
 * Client for the the platform API — the system of record that holds the grant and the consent.
 * Every call is HMAC-signed over `<timestamp>.<body>`, mirroring the connector inbound
 * webhook scheme already used in this codebase.
 */

function sign(body: string): { ts: string; sig: string } {
  const ts = Date.now().toString();
  const sig = createHmac('sha256', env.INGEST_SECRET).update(`${ts}.${body}`).digest('hex');
  return { ts, sig };
}

async function post<T>(pathname: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload);
  const { ts, sig } = sign(body);
  const res = await fetch(`${env.PLATFORM_API_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wa-ingest-timestamp': ts,
      'x-wa-ingest-signature': `sha256=${sig}`,
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`platform ${pathname} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Grants this service is allowed to be running, straight from the system of record. */
export interface AuthorisedGrant {
  grantId: string;
  organizationId: string;
  status: string;
  /** min(captureEndsAt, grantExpiresAt) as ISO — the only deadline that matters here. */
  effectiveEndsAt: string;
  pairPhone: string | null;
}

export async function fetchAuthorisedGrants(): Promise<AuthorisedGrant[]> {
  const r = await post<{ data: AuthorisedGrant[] }>('/api/v1/wa-ingest/authorised-grants', {});
  return r.data;
}

export async function pushStatus(
  grantId: string,
  status: SessionStatus,
  extra: { qr?: string | null; pairingCode?: string | null; phone?: string | null },
): Promise<void> {
  await post('/api/v1/wa-ingest/status', { grantId, status, ...extra });
}

export async function pushMessages(
  grantId: string,
  messages: CapturedMessage[],
): Promise<{ stored: number }> {
  const r = await post<{ data: { stored: number } }>('/api/v1/wa-ingest/messages', {
    grantId,
    messages: messages.map((m) => ({
      waMsgId: m.waMsgId,
      counterpartyPhone: m.counterpartyPhone,
      direction: m.direction,
      kind: m.kind,
      body: m.body,
      isGroup: m.isGroup,
      chatName: m.chatName,
      sentAt: m.sentAt.toISOString(),
    })),
  });
  return r.data;
}

/** Report that a grant's credentials are gone. Only called after a verified purge. */
export async function reportPurged(grantId: string): Promise<void> {
  await post('/api/v1/wa-ingest/purged', { grantId });
}

export async function reportEnded(grantId: string, reason: string): Promise<void> {
  await post('/api/v1/wa-ingest/ended', { grantId, reason });
}

export async function heartbeat(active: number): Promise<void> {
  await post('/api/v1/wa-ingest/heartbeat', { active });
}

export function logPushFailure(err: unknown, what: string): void {
  logger.error({ err, what }, 'platform push failed');
}
