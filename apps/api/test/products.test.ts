import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp } from './setup.js';

describe('product CRUD', () => {
  it('creates, lists, updates, and deletes a product', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'crudtest');
    const headers = { authorization: `Bearer ${session.accessToken}` };

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/products',
      headers,
      payload: { sku: 'A-1', name: 'Widget', priceMinor: 1000, currency: 'USD' },
    });
    expect(create.statusCode).toBe(201);
    const id = (create.json() as { data: { id: string } }).data.id;

    const list = await app.inject({ method: 'GET', url: '/api/v1/products', headers });
    expect((list.json() as { data: unknown[] }).data.length).toBe(1);

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/products/${id}`,
      headers,
      payload: { name: 'Widget v2' },
    });
    expect(update.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/products/${id}`, headers });
    expect(del.statusCode).toBe(200);

    const listAgain = await app.inject({ method: 'GET', url: '/api/v1/products', headers });
    expect((listAgain.json() as { data: unknown[] }).data.length).toBe(0);
  });
});
