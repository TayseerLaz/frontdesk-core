// Minimal outbound WhatsApp text sender from the org's PRIMARY channel.
//
// The WhatsApp routes send inline (per-call-site fetch); this is the shared,
// self-contained version for NON-WhatsApp flows that still need to message a
// customer's phone — e.g. delivering a payment link after a VOICE order.
//
// IMPORTANT (Meta rule): a free-form text only delivers inside the 24h customer
// service window. To a "cold" number (someone who only phoned and never
// messaged the business) Meta rejects it (error 131047) — that requires an
// approved template. This helper is best-effort: it returns the outcome and
// never throws, so the caller can log + fall back (the operator still has the
// order).
import { withRlsBypass } from './db.js';

export async function sendWhatsAppText(
  orgId: string,
  toPhone: string,
  body: string,
): Promise<{ ok: boolean; error?: string; metaMessageId?: string }> {
  const to = (toPhone || '').replace(/\D+/g, '');
  if (to.length < 6) return { ok: false, error: 'invalid recipient number' };

  const channel = await withRlsBypass((tx) =>
    tx.whatsAppChannel.findFirst({
      where: { organizationId: orgId, isPrimary: true, isActive: true },
      select: { phoneNumberId: true, accessToken: true },
    }),
  );
  if (!channel?.phoneNumberId || !channel.accessToken) {
    return { ok: false, error: 'no active primary WhatsApp channel' };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${channel.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { preview_url: true, body },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const text = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, error: `meta ${res.status} ${text.slice(0, 300)}` };
    let id: string | undefined;
    try {
      id = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id;
    } catch {
      /* ignore */
    }
    return { ok: true, metaMessageId: id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}
