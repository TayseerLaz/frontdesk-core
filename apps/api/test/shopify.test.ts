import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

describe('shopify integration', () => {
  it('stores creds masked, gates on the feature, approves staged items, verifies webhooks', async () => {
    const app = getApp();
    const s = await seedOrgAndLogin(app, 'shopifytest');
    const auth = { authorization: `Bearer ${s.accessToken}` };

    // Initially not connected.
    const g0 = await app.inject({ method: 'GET', url: '/api/v1/shopify', headers: auth });
    expect(g0.statusCode).toBe(200);
    expect((g0.json() as { data: { connected: boolean } }).data.connected).toBe(false);

    // Save credentials — secrets are write-only and never echoed back.
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/shopify',
      headers: auth,
      payload: {
        storeDomain: 'https://test-store.myshopify.com/',
        accessToken: 'shpat_testtoken123',
        apiSecret: 'shpss_testsecret456',
      },
    });
    expect(put.statusCode).toBe(200);
    const dto = (put.json() as { data: Record<string, unknown> }).data;
    expect(dto.connected).toBe(true);
    expect(dto.hasAccessToken).toBe(true);
    expect(dto.hasApiSecret).toBe(true);
    // storeDomain normalized to the bare host.
    expect(dto.storeDomain).toBe('test-store.myshopify.com');
    expect(put.body).not.toContain('shpat_testtoken123');
    expect(put.body).not.toContain('shpss_testsecret456');

    // A pending staged item can be approved.
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const conn = await prisma.shopifyConnection.findUnique({ where: { organizationId: s.orgId } });
    expect(conn).toBeTruthy();
    const staged = await prisma.shopifyStagedItem.create({
      data: {
        organizationId: s.orgId,
        connectionId: conn!.id,
        section: 'product',
        externalId: 'p-1',
        title: 'Sample',
        normalized: { core: { sku: 'sample', name: 'Sample' } },
        status: 'pending',
      },
    });
    const approve = await app.inject({
      method: 'POST',
      url: '/api/v1/shopify/staged/approve',
      headers: auth,
      payload: { ids: [staged.id] },
    });
    expect(approve.statusCode).toBe(200);
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const afterApprove = await prisma.shopifyStagedItem.findUnique({ where: { id: staged.id } });
    expect(afterApprove?.status).toBe('approved');

    // Webhook HMAC: base64( HMAC-SHA256(rawBody, apiSecret) ).
    const body = JSON.stringify({ id: 999, title: 'Webhook product' });
    const goodSig = createHmac('sha256', 'shpss_testsecret456').update(body, 'utf8').digest('base64');

    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/shopify/${conn!.id}`,
      headers: { 'x-shopify-hmac-sha256': 'AAAA', 'content-type': 'application/json' },
      payload: body,
    });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/shopify/${conn!.id}`,
      headers: { 'x-shopify-hmac-sha256': goodSig, 'content-type': 'application/json' },
      payload: body,
    });
    expect(good.statusCode).toBe(200);

    // Disabling the feature gates every /shopify route.
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    await prisma.organization.update({
      where: { id: s.orgId },
      data: { disabledFeatures: ['shopify'] },
    });
    const gated = await app.inject({ method: 'GET', url: '/api/v1/shopify', headers: auth });
    expect(gated.statusCode).toBe(403);
  });
});
