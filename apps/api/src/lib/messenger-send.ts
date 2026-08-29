// Send a text message via the Meta Page Send API (Messenger + Instagram).
// Shared by the bot reply path and the inbox operator-reply path so both use
// the same transport. Loads the per-org MessengerChannel, decrypts the page
// token, and POSTs. Returns the message id, or null on any failure (callers
// log + degrade — a send hiccup never throws into the hot path).
import { decryptSecret } from '@platform/db';

import { withRlsBypass } from './db.js';

const FB_GRAPH = 'https://graph.facebook.com/v25.0';
const IG_GRAPH = 'https://graph.instagram.com/v21.0';

// Pick the Graph host from the token shape. Instagram-Login tokens start with
// "IG" and MUST go to graph.instagram.com — graph.facebook.com rejects them
// ("Cannot parse access token", code 190). Facebook Page tokens (EAA…) use the
// facebook host. This auto-adapts whether the tenant connected via a Page or
// via Instagram Login.
function graphBaseFor(token: string): string {
  return token.startsWith('IG') ? IG_GRAPH : FB_GRAPH;
}

type Logger = { warn: (...a: unknown[]) => void };

export async function sendMessengerText(
  orgId: string,
  recipientId: string,
  text: string,
  log?: Logger,
  quickReplies?: string[],
): Promise<string | null> {
  const channel = await withRlsBypass((tx) =>
    tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
  );
  if (!channel || !channel.isActive || !channel.pageAccessToken) return null;
  const pageToken = decryptSecret(channel.pageAccessToken) ?? '';
  if (!pageToken) return null;
  const base = graphBaseFor(pageToken);
  const isIg = base === IG_GRAPH;
  // Up to 13 are allowed; keep it tidy. Title ≤ 20 chars (Meta hard limit).
  const qr = (quickReplies ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 11)
    .map((t) => ({ content_type: 'text', title: t.slice(0, 20), payload: t.slice(0, 60) }));
  try {
    const res = await fetch(`${base}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Instagram's send API doesn't take messaging_type; Messenger does.
      body: JSON.stringify({
        recipient: { id: recipientId },
        ...(isIg ? {} : { messaging_type: 'RESPONSE' }),
        message: { text: text.slice(0, 1900), ...(qr.length ? { quick_replies: qr } : {}) },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    if (!res.ok) {
      log?.warn?.({ status: res.status, body: body.slice(0, 200) }, '[messenger] send failed');
      return null;
    }
    try {
      return (JSON.parse(body) as { message_id?: string }).message_id ?? null;
    } catch {
      return null;
    }
  } catch (err) {
    log?.warn?.({ err: err instanceof Error ? err.message : err }, '[messenger] send threw');
    return null;
  }
}

// Fetch the customer's display name from the Graph API so the inbox +
// /contacts show a real name instead of a raw PSID. Best-effort: returns null
// on any failure (the caller keeps the PSID-only contact). Messenger exposes
// first_name/last_name/name; Instagram exposes name/username — we ask for all
// and pick whatever comes back.
export async function fetchMessengerProfileName(
  orgId: string,
  psid: string,
  channelKind: 'messenger' | 'instagram',
  log?: Logger,
): Promise<string | null> {
  const channel = await withRlsBypass((tx) =>
    tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
  );
  if (!channel || !channel.pageAccessToken) return null;
  const pageToken = decryptSecret(channel.pageAccessToken) ?? '';
  if (!pageToken) return null;
  // Instagram-scoped IDs only expose name/username — asking for the
  // Messenger-only first_name/last_name makes Graph reject the whole request,
  // which is why IG threads were falling back to the raw numeric id.
  const fields = channelKind === 'instagram' ? 'name,username' : 'name,first_name,last_name';
  const base = graphBaseFor(pageToken);
  try {
    const res = await fetch(
      `${base}/${encodeURIComponent(psid)}?fields=${fields}&access_token=${encodeURIComponent(
        pageToken,
      )}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) {
      log?.warn?.(
        { status: res.status, channelKind, body: (await res.text()).slice(0, 200) },
        '[messenger] profile fetch failed',
      );
      return null;
    }
    const j = (await res.json()) as {
      name?: string;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    if (channelKind === 'instagram') {
      // Show both the display name and the @handle, e.g. "Tayseer (@tayseer_laz)".
      const nm = j.name?.trim() || '';
      const un = j.username?.trim() || '';
      if (nm && un) return `${nm} (@${un})`;
      if (nm) return nm;
      return un ? `@${un}` : null;
    }
    const name =
      j.name?.trim() ||
      [j.first_name, j.last_name].filter(Boolean).join(' ').trim() ||
      j.username?.trim() ||
      '';
    return name || null;
  } catch (err) {
    log?.warn?.({ err: err instanceof Error ? err.message : err }, '[messenger] profile fetch threw');
    return null;
  }
}

// Send an image attachment by URL (used to deliver product photos). Best-
// effort; returns the message id or null.
export async function sendMessengerImage(
  orgId: string,
  recipientId: string,
  imageUrl: string,
  log?: Logger,
): Promise<string | null> {
  const channel = await withRlsBypass((tx) =>
    tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
  );
  if (!channel || !channel.isActive || !channel.pageAccessToken) return null;
  const pageToken = decryptSecret(channel.pageAccessToken) ?? '';
  if (!pageToken) return null;
  const base = graphBaseFor(pageToken);
  const isIg = base === IG_GRAPH;
  try {
    const res = await fetch(`${base}/me/messages?access_token=${encodeURIComponent(pageToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        ...(isIg ? {} : { messaging_type: 'RESPONSE' }),
        message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log?.warn?.({ status: res.status }, '[messenger] image send failed');
      return null;
    }
    const body = await res.text();
    try {
      return (JSON.parse(body) as { message_id?: string }).message_id ?? null;
    } catch {
      return null;
    }
  } catch (err) {
    log?.warn?.({ err: err instanceof Error ? err.message : err }, '[messenger] image send threw');
    return null;
  }
}
