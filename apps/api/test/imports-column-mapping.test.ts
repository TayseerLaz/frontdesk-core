// Session 1 deploy gate: POST /imports with a columnMapping payload must
// be accepted and persisted on the ImportJob. This asserts the backend
// contract the new import-wizard mapping step relies on.
//
// Full worker end-to-end (Wasabi upload + CSV parse) is covered elsewhere;
// this test is narrow — it proves the mapping round-trips through the API.
import { describe, expect, it } from 'vitest';

import { seedOrgAndLogin } from './helpers.js';
import { getApp } from './setup.js';
import { prisma } from './setup.js';

describe('import columnMapping round-trip', () => {
  it('accepts a mapping on POST /imports and persists it on the job row', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'mappingtest');
    const headers = { authorization: `Bearer ${session.accessToken}` };

    // Seed an Asset directly (mirrors what POST /assets/upload-csv would do,
    // minus the Wasabi upload which isn't available in the test env).
    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const asset = await prisma.asset.create({
      data: {
        organizationId: session.orgId,
        kind: 'csv_upload',
        storageKey: `test/${session.orgId}/mapping.csv`,
        contentType: 'text/csv',
        byteSize: 42,
        metadata: { filename: 'mapping.csv' },
      },
    });

    const mapping = {
      'Item Code': 'sku',
      'Product Name': 'name',
      'Unit Price Cents': 'priceMinor',
      Notes: '__ignored__',
    };

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      headers,
      payload: {
        entityKind: 'product',
        sourceAssetId: asset.id,
        columnMapping: mapping,
      },
    });

    expect(create.statusCode).toBe(202);
    const body = create.json() as { data: { id: string } };

    const job = await prisma.importJob.findUnique({ where: { id: body.data.id } });
    expect(job).not.toBeNull();
    expect(job?.columnMapping).toEqual(mapping);
    expect(job?.entityKind).toBe('product');
    expect(job?.sourceAssetId).toBe(asset.id);
  });

  it('accepts a POST without columnMapping (defaults to null on the job)', async () => {
    const app = getApp();
    const session = await seedOrgAndLogin(app, 'mappingnull');
    const headers = { authorization: `Bearer ${session.accessToken}` };

    await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
    const asset = await prisma.asset.create({
      data: {
        organizationId: session.orgId,
        kind: 'csv_upload',
        storageKey: `test/${session.orgId}/nomapping.csv`,
        contentType: 'text/csv',
        byteSize: 42,
        metadata: { filename: 'nomapping.csv' },
      },
    });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      headers,
      payload: { entityKind: 'product', sourceAssetId: asset.id },
    });

    expect(create.statusCode).toBe(202);
    const body = create.json() as { data: { id: string } };
    const job = await prisma.importJob.findUnique({ where: { id: body.data.id } });
    expect(job?.columnMapping).toBeNull();
  });
});
