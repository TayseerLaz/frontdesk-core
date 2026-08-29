// Inbound payment-confirmation webhooks (F-04).
//
// Public (no JWT) endpoints the payment gateways call when a customer actually
// pays. Each is signature-verified against the tenant's own webhook secret, so
// a forged request can't mark an order paid. The tenant is identified by the
// :orgId path segment (each tenant configures its gateway with its own
// endpoint URL + its own secret); the secret — not the path — is what
// authenticates the call.
//
// On a verified success event we resolve the order and call markCartPaid()
// (idempotent), so a gateway's retries can never double-confirm.
import { decryptSecret } from '@platform/db';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { withTenant } from '../../lib/db.js';
import { findCartByPaymentRef, markCartPaid } from '../../lib/payments/confirm.js';
import { getRedis } from '../../lib/redis.js';

// Replay guard: once a (org, signature) pair has been accepted, refuse it again
// for this window. Gateways legitimately retry, but markCartPaid is idempotent
// so a retry is harmless; this stops a CAPTURED valid webhook being re-played.
const WEBHOOK_NONCE_TTL_SEC = 24 * 60 * 60;

/** Returns true the FIRST time this signature is seen for the org; false on replay. */
async function claimWebhookNonce(provider: string, orgId: string, signature: string): Promise<boolean> {
  const digest = createHash('sha256').update(signature).digest('hex');
  const key = `webhook:nonce:${provider}:${orgId}:${digest}`;
  const res = await getRedis().set(key, '1', 'EX', WEBHOOK_NONCE_TTL_SEC, 'NX');
  return res === 'OK';
}

interface ResolvedCreds {
  provider: string;
  testMode: boolean;
  myfatoorahApiKey?: string;
  stripeSecretKey?: string;
  paypalClientId?: string;
  paypalSecret?: string;
  stripeWebhookSecret?: string;
  myfatoorahWebhookSecret?: string;
  paypalWebhookId?: string;
}

async function loadCreds(orgId: string): Promise<ResolvedCreds | null> {
  const row = await withTenant(orgId, (tx) =>
    tx.paymentConfig.findUnique({ where: { organizationId: orgId } }),
  ).catch(() => null);
  if (!row) return null;
  let creds: Record<string, string> = {};
  try {
    const json = decryptSecret(row.credentials);
    creds = json ? (JSON.parse(json) as Record<string, string>) : {};
  } catch {
    creds = {};
  }
  return { provider: row.provider, testMode: row.testMode, ...creds };
}

// Returns the raw bytes Fastify received; undefined when they weren't captured.
// We never fall back to JSON.stringify(req.body) — a re-serialization reorders
// keys and would make the HMAC silently mismatch legitimate senders. (L-10)
function rawBodyOf(req: FastifyRequest): string | undefined {
  return (req as unknown as { rawBody?: string }).rawBody;
}

/** Constant-time hex/base64 compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export default async function paymentWebhookRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Stripe --
  // Verifies the `Stripe-Signature` header (t=…,v1=…) — HMAC-SHA256 of
  // `${t}.${rawBody}` with the endpoint signing secret (whsec_…). Handles
  // `checkout.session.completed`; the cart id rides in client_reference_id.
  app.post('/payments/webhooks/stripe/:orgId', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const creds = await loadCreds(orgId);
    const secret = creds?.stripeWebhookSecret;
    if (!secret) return reply.code(202).send({ ok: false, reason: 'not_configured' });

    const sigHeader = req.headers['stripe-signature'];
    const header = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!header) return reply.code(400).send({ ok: false, reason: 'missing_signature' });
    const parts = Object.fromEntries(
      header.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k?.trim(), v?.trim()] as const;
      }),
    );
    const t = parts['t'];
    const v1 = parts['v1'];
    if (!t || !v1) return reply.code(400).send({ ok: false, reason: 'malformed_signature' });
    // Reject stale timestamps (replay) — 5 minute tolerance.
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
    if (!Number.isFinite(ageSec) || ageSec > 300) {
      return reply.code(400).send({ ok: false, reason: 'timestamp_out_of_tolerance' });
    }
    // No raw bytes → can't verify → reject (never re-serialize the body). (L-10)
    const rawBody = rawBodyOf(req);
    if (rawBody === undefined) {
      return reply.code(400).send({ ok: false, reason: 'missing_raw_body' });
    }
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    if (!safeEqual(expected, v1)) {
      return reply.code(400).send({ ok: false, reason: 'bad_signature' });
    }

    const event = req.body as {
      type?: string;
      data?: { object?: { client_reference_id?: string; metadata?: Record<string, string>; amount_total?: number; currency?: string } };
    };
    if (event.type === 'checkout.session.completed') {
      const obj = event.data?.object ?? {};
      const cartId = obj.client_reference_id || obj.metadata?.cartId;
      if (cartId) {
        await markCartPaid({
          organizationId: orgId,
          cartId,
          provider: 'stripe',
          ref: cartId,
          amountMinorPaid: obj.amount_total ?? null,
          currency: obj.currency?.toUpperCase() ?? null,
        });
      }
    }
    return reply.code(200).send({ ok: true });
  });

  // ------------------------------------------------------------ MyFatoorah --
  // Verifies the `MyFatoorah-Signature` header: Base64(HMAC-SHA256(secret,
  // dataString)) where dataString joins the Data object's fields as
  // `Key=Value` joined by commas, with keys sorted ALPHABETICALLY — the order
  // MyFatoorah documents and signs against (NOT JS object-insertion order,
  // which is attacker-influenced and gateway-divergent). Correlates by the
  // InvoiceId we stored at link creation.
  app.post('/payments/webhooks/myfatoorah/:orgId', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const creds = await loadCreds(orgId);
    const secret = creds?.myfatoorahWebhookSecret;
    if (!secret) return reply.code(202).send({ ok: false, reason: 'not_configured' });

    const sigHeader = req.headers['myfatoorah-signature'];
    const header = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!header) return reply.code(400).send({ ok: false, reason: 'missing_signature' });

    const body = req.body as {
      EventType?: number;
      Event?: string;
      Data?: Record<string, unknown>;
    };
    const data = body.Data ?? {};
    // Reject an empty Data object: there is nothing to authenticate, and the
    // HMAC of an empty string would otherwise be trivially reconstructable.
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return reply.code(400).send({ ok: false, reason: 'empty_data' });
    }
    // Canonical signing string: keys sorted alphabetically (MyFatoorah's spec).
    const dataString = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v ?? ''}`)
      .join(',');
    const expected = createHmac('sha256', secret).update(dataString).digest('base64');
    if (!safeEqual(expected, header)) {
      return reply.code(400).send({ ok: false, reason: 'bad_signature' });
    }

    // Replay protection: MyFatoorah's payload carries no signed timestamp, so
    // dedupe on the (org, signature) pair. A captured valid webhook replayed
    // within the window is rejected; legitimate gateway retries are harmless
    // (markCartPaid is idempotent) but also collapse to a single accept.
    if (!(await claimWebhookNonce('myfatoorah', orgId, header))) {
      return reply.code(200).send({ ok: true, reason: 'duplicate' });
    }

    // Payment success → correlate by stored InvoiceId. MyFatoorah's status
    // strings vary by event; treat Paid/Success as confirmation.
    const invoiceId =
      data['InvoiceId'] != null ? String(data['InvoiceId']) : data['Invoice.Id'] != null ? String(data['Invoice.Id']) : null;
    const statusRaw = String(data['TransactionStatus'] ?? data['InvoiceStatus'] ?? '').toLowerCase();
    const isPaid = statusRaw.includes('paid') || statusRaw.includes('success') || statusRaw === 'succss';
    if (invoiceId && isPaid) {
      const cartId = await findCartByPaymentRef(orgId, 'myfatoorah', invoiceId);
      if (cartId) {
        await markCartPaid({ organizationId: orgId, cartId, provider: 'myfatoorah', ref: invoiceId });
      }
    }
    return reply.code(200).send({ ok: true });
  });

  // ---------------------------------------------------------------- PayPal --
  // PayPal signs with rotating certs; the supported verification is a call to
  // their verify-webhook-signature API with the configured Webhook ID + the
  // transmission headers. On a verified capture/approval we read our cart id
  // from custom_id / reference_id.
  app.post('/payments/webhooks/paypal/:orgId', async (req, reply) => {
    const { orgId } = req.params as { orgId: string };
    const creds = await loadCreds(orgId);
    if (!creds?.paypalWebhookId || !creds.paypalClientId || !creds.paypalSecret) {
      return reply.code(202).send({ ok: false, reason: 'not_configured' });
    }
    const h = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const base = creds.testMode ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
    let verified = false;
    try {
      const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${creds.paypalClientId}:${creds.paypalSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(10_000),
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      if (tokenRes.ok && tokenJson.access_token) {
        const verifyRes = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenJson.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            auth_algo: h('paypal-auth-algo'),
            cert_url: h('paypal-cert-url'),
            transmission_id: h('paypal-transmission-id'),
            transmission_sig: h('paypal-transmission-sig'),
            transmission_time: h('paypal-transmission-time'),
            webhook_id: creds.paypalWebhookId,
            webhook_event: req.body,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const verifyJson = (await verifyRes.json()) as { verification_status?: string };
        verified = verifyRes.ok && verifyJson.verification_status === 'SUCCESS';
      }
    } catch {
      verified = false;
    }
    if (!verified) return reply.code(400).send({ ok: false, reason: 'verification_failed' });

    const event = req.body as {
      event_type?: string;
      resource?: {
        custom_id?: string;
        purchase_units?: { custom_id?: string; reference_id?: string }[];
      };
    };
    if (
      event.event_type === 'PAYMENT.CAPTURE.COMPLETED' ||
      event.event_type === 'CHECKOUT.ORDER.APPROVED' ||
      event.event_type === 'CHECKOUT.ORDER.COMPLETED'
    ) {
      const res = event.resource ?? {};
      const custom = res.custom_id ?? res.purchase_units?.[0]?.custom_id ?? '';
      const refId = res.purchase_units?.[0]?.reference_id ?? '';
      // custom_id is `org=…;cart=…`; reference_id is the bare cart id.
      const cartId = /cart=([0-9a-f-]+)/i.exec(custom)?.[1] ?? (refId || null);
      if (cartId) {
        await markCartPaid({ organizationId: orgId, cartId, provider: 'paypal', ref: cartId });
      }
    }
    return reply.code(200).send({ ok: true });
  });
}
