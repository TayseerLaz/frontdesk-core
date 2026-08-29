// WhatsApp Phase 1.5 — auto-create on first GET, save credentials, mask
// secrets in responses, webhook GET handshake, webhook POST signature
// verification.
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

describe('whatsapp channel config', () => {
  it('creates a stub on first GET and never returns secrets in plain text', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'wachan');
    const headers = { authorization: `Bearer ${me.accessToken}` };

    const get = await app.inject({ method: 'GET', url: '/api/v1/whatsapp', headers });
    expect(get.statusCode).toBe(200);
    const c1 = (get.json() as { data: { webhookVerifyToken: string; webhookCallbackUrl: string } }).data;
    expect(c1.webhookVerifyToken.length).toBeGreaterThan(8);
    expect(c1.webhookCallbackUrl).toContain('/api/v1/whatsapp/webhook/');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/whatsapp',
      headers,
      payload: {
        wabaId: '111111111',
        phoneNumberId: '222222222',
        accessToken: 'EAAtopsecretvaluexyzabc1234567890',
        appSecret: 'appsecretdeadbeefcafebabe12345678',
      },
    });
    expect(put.statusCode).toBe(200);
    const c2 = (put.json() as {
      data: {
        hasAccessToken: boolean;
        hasAppSecret: boolean;
        accessTokenMasked: string;
        appSecretMasked: string;
      };
    }).data;
    expect(c2.hasAccessToken).toBe(true);
    expect(c2.hasAppSecret).toBe(true);
    // Mask: first 4 + ' •••• ' (or equivalent) + last 4 — full secret never returned.
    expect(c2.accessTokenMasked).not.toContain('topsecret');
    expect(c2.accessTokenMasked).toMatch(/^EAAt/);
    expect(c2.accessTokenMasked).toMatch(/7890$/);
    expect(c2.appSecretMasked).not.toContain('deadbeef');
  });

  it('keeps secrets when PUT omits them; clears them on empty string', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'waclear');
    const headers = { authorization: `Bearer ${me.accessToken}` };

    await app.inject({
      method: 'PUT',
      url: '/api/v1/whatsapp',
      headers,
      payload: { accessToken: 'ABCDEFGHIJKL', appSecret: 'SECRET12345678' },
    });

    // Save without sending the secret fields → should remain set.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/whatsapp',
      headers,
      payload: { businessName: 'Acme' },
    });
    const after = await app.inject({ method: 'GET', url: '/api/v1/whatsapp', headers });
    expect((after.json() as { data: { hasAccessToken: boolean } }).data.hasAccessToken).toBe(true);

    // Send empty string → cleared.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/whatsapp',
      headers,
      payload: { accessToken: '' },
    });
    const after2 = await app.inject({ method: 'GET', url: '/api/v1/whatsapp', headers });
    expect((after2.json() as { data: { hasAccessToken: boolean } }).data.hasAccessToken).toBe(false);
  });
});

describe('whatsapp webhook handshake', () => {
  it('echoes the challenge when verify token matches', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'waverify');
    const headers = { authorization: `Bearer ${me.accessToken}` };

    const stub = await app.inject({ method: 'GET', url: '/api/v1/whatsapp', headers });
    const verifyToken = (stub.json() as { data: { webhookVerifyToken: string } }).data.webhookVerifyToken;

    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/whatsapp/webhook/${me.orgId}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=42`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('42');

    const bad = await app.inject({
      method: 'GET',
      url: `/api/v1/whatsapp/webhook/${me.orgId}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`,
    });
    expect(bad.statusCode).toBe(403);
  });
});

describe('whatsapp webhook inbound POST', () => {
  it('rejects unsigned bodies and persists signed ones', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'wainbound');
    const headers = { authorization: `Bearer ${me.accessToken}` };

    const appSecret = 'integration-test-app-secret';
    await app.inject({
      method: 'PUT',
      url: '/api/v1/whatsapp',
      headers,
      payload: { appSecret, accessToken: 'fake-token', phoneNumberId: '999' },
    });

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+15551234' },
                messages: [{ id: 'wamid.test1', from: '+15557654', type: 'text', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    };
    const rawBody = JSON.stringify(payload);
    const goodSig =
      'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    const unsigned = await app.inject({
      method: 'POST',
      url: `/api/v1/whatsapp/webhook/${me.orgId}`,
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(unsigned.statusCode).toBe(401);

    const signed = await app.inject({
      method: 'POST',
      url: `/api/v1/whatsapp/webhook/${me.orgId}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': goodSig },
      payload,
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toEqual({ received: 1 });

    // Persisted in the audit table?
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const rows = await prisma.whatsAppMessage.findMany({ where: { organizationId: me.orgId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fromNumber).toBe('+15557654');
    expect(rows[0]?.body).toBe('hi');
    expect(rows[0]?.direction).toBe('inbound');
  });

  it('refuses inbound when no app secret is configured (no spoof storage)', async () => {
    const app = getApp();
    const me = await seedOrgAndLogin(app, 'wanosecret');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/whatsapp/webhook/${me.orgId}`,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=anything' },
      payload: { entry: [] },
    });
    expect(res.statusCode).toBe(403);
  });
});
