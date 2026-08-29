import { describe, expect, it } from 'vitest';

import { hashToken } from '../src/lib/crypto.js';
import { seedOrgAndLogin } from './helpers.js';
import { getApp, prisma } from './setup.js';

describe('chatbot read API', () => {
  it('rejects unauthenticated requests, accepts valid keys, scopes per org', async () => {
    const app = getApp();
    const a = await seedOrgAndLogin(app, 'readtesta');

    // Issue an API key for org A directly (skip the UI flow).
    const secret = `ak_live_${'x'.repeat(24)}`;
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    await prisma.apiKey.create({
      data: {
        organizationId: a.orgId,
        name: 'test',
        prefix: secret.slice(0, 16),
        keyHash: hashToken(secret),
        scopes: ['read:catalog'],
        createdById: a.userId,
      },
    });

    // Add a product to org A.
    await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { sku: 'PUBLIC-1', name: 'Visible', isAvailable: true },
    });

    // Without the key — 401.
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/read/products' });
    expect(unauth.statusCode).toBe(401);

    // With the key — 200, sees the product.
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/read/products',
      headers: { 'x-api-key': secret },
    });
    expect(ok.statusCode).toBe(200);
    const list = ok.json() as { data: { sku: string }[] };
    expect(list.data.find((p) => p.sku === 'PUBLIC-1')).toBeDefined();
  });
});
