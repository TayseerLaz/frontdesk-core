import { createHmac } from 'node:crypto';

import { decryptSecret } from '@platform/db';
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

function sign(secret: string, body: string, ts: number) {
  return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

describe('inbound webhook signature', () => {
  it('rejects bad signatures and accepts valid ones', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'sigtest');

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: {
        name: 'Inbound',
        entityKind: 'product',
        enableInboundWebhook: true,
      },
    });
    expect(create.statusCode).toBe(201);
    const connectorId = (create.json() as { data: { id: string } }).data.id;

    // Fetch the secret directly from the DB (server never returns it).
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const connector = await prisma.apiConnector.findUnique({ where: { id: connectorId } });
    expect(connector?.webhookSecret).toBeTruthy();
    // webhookSecret is AES-256-GCM encrypted at rest (F-01); the inbound verifier
    // decrypts it before the HMAC compare, so sign with the PLAINTEXT secret.
    // (decryptSecret is a no-op passthrough when SECRET_ENCRYPTION_KEY is unset.)
    const plainSecret = decryptSecret(connector!.webhookSecret!);

    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ ping: true });

    // Bad sig → 401.
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/inbound/${connectorId}`,
      headers: {
        'x-signature': 'sha256=deadbeef',
        'x-webhook-timestamp': String(ts),
        'content-type': 'application/json',
      },
      payload: body,
    });
    expect(bad.statusCode).toBe(401);

    // Good sig → 202 accepted.
    const good = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/inbound/${connectorId}`,
      headers: {
        'x-signature': sign(plainSecret!, body, ts),
        'x-webhook-timestamp': String(ts),
        'content-type': 'application/json',
      },
      payload: body,
    });
    expect(good.statusCode).toBe(202);
  });
});
