// ⚠ HARD DEPLOY GATE — if anything in this file fails, do NOT deploy.
// Verifies that RLS + application code together prevent any cross-tenant read.

import { test, expect } from '../helpers/fixtures';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import { ApiClient } from '../helpers/api';
import {
  closePool,
  deleteOrgBySlug,
  deleteUserByEmail,
  getOrgIdBySlug,
  markUserVerified,
  query,
} from '../helpers/db';
import pg from 'pg';

const GOOD_PASSWORD = 'VeryStrongPwd!234';

type Org = {
  email: string;
  password: string;
  slug: string;
  orgId: string;
  api: ApiClient;
};

async function provisionOrg(label: string): Promise<Org> {
  const email = uniqueEmail(label);
  const slug = uniqueSlug(`qa-${label}`);
  const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: GOOD_PASSWORD,
      firstName: 'Qa',
      lastName: label,
      organizationName: `QA ${slug}`,
      organizationSlug: slug,
    }),
  });
  expect(res.status, `signup ${label}`).toBe(201);
  await markUserVerified(email);
  const orgId = (await getOrgIdBySlug(slug))!;
  expect(orgId).toBeTruthy();

  const api = new ApiClient();
  const login = await api.login(email, GOOD_PASSWORD);
  expect(login.organizationId).toBe(orgId);
  return { email, password: GOOD_PASSWORD, slug, orgId, api };
}

test.describe('tenant isolation — HARD DEPLOY GATE', () => {
  let orgA: Org;
  let orgB: Org;
  let productAId = '';
  let serviceAId = '';
  let faqAId = '';

  test.beforeAll(async () => {
    orgA = await provisionOrg('orgA');
    orgB = await provisionOrg('orgB');

    // As orgA, create a product, a service, and an FAQ.
    const pRes = await orgA.api.post<{ data: { id: string } }>('/api/v1/products', {
      sku: `ISO-A-${Date.now()}`,
      name: 'Org A Secret Product',
      slug: `org-a-secret-${Date.now()}`,
      priceMinor: 9999,
    });
    expect(pRes.status).toBe(201);
    productAId = pRes.body.data.id;

    const sRes = await orgA.api.post<{ data: { id: string } }>('/api/v1/services', {
      name: 'Org A Secret Service',
      slug: `org-a-srv-${Date.now()}`,
      basePriceMinor: 5000,
    });
    expect(sRes.status).toBe(201);
    serviceAId = sRes.body.data.id;

    const fRes = await orgA.api.post<{ data: { id: string } }>('/api/v1/business-info/faqs', {
      question: 'Is Org A data isolated?',
      answer: 'It must be.',
    });
    expect(fRes.status).toBe(201);
    faqAId = fRes.body.data.id;
  });

  test.afterAll(async () => {
    // Best-effort cleanup — even if a test failed.
    if (orgA) {
      await deleteUserByEmail(orgA.email);
      await deleteOrgBySlug(orgA.slug);
    }
    if (orgB) {
      await deleteUserByEmail(orgB.email);
      await deleteOrgBySlug(orgB.slug);
    }
    await closePool();
  });

  test('orgB cannot GET orgA product by id (must be 404)', async () => {
    const res = await orgB.api.get(`/api/v1/products/${productAId}`);
    expect(res.status, 'cross-tenant product read').toBe(404);
  });

  test('orgB cannot GET orgA service by id (must be 404)', async () => {
    const res = await orgB.api.get(`/api/v1/services/${serviceAId}`);
    expect(res.status, 'cross-tenant service read').toBe(404);
  });

  test("orgA FAQ id never appears in orgB's FAQ list", async () => {
    const res = await orgB.api.get<{ data: Array<{ id: string }> }>('/api/v1/business-info/faqs');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((f) => f.id);
    expect(ids, 'orgB faq list must not include orgA faqId').not.toContain(faqAId);
  });

  test("orgA product id never appears in orgB's product list", async () => {
    const res = await orgB.api.get<{ data: Array<{ id: string }> }>('/api/v1/products');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((p) => p.id);
    expect(ids, 'orgB product list must not include orgA productId').not.toContain(productAId);
  });

  test("orgA service id never appears in orgB's service list", async () => {
    const res = await orgB.api.get<{ data: Array<{ id: string }> }>('/api/v1/services');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s) => s.id);
    expect(ids, 'orgB service list must not include orgA serviceId').not.toContain(serviceAId);
  });

  test('direct DB read with app.current_org_id = orgB cannot see orgA product (RLS enforced)', async () => {
    // Use a FRESH dedicated connection — the shared helper pool defaults leak SET LOCAL scope.
    // The `aligned` docker user is typically a SUPERUSER which bypasses RLS; to actually
    // exercise the tenant policy we SET ROLE to the `app_user` non-superuser role that
    // rls.sql provisions for application connections.
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE app_user`);
      await client.query(`SET LOCAL app.current_org_id = '${orgB.orgId}'`);

      const prodRows = await client.query(
        `SELECT id FROM products WHERE id = $1`,
        [productAId],
      );
      const svcRows = await client.query(
        `SELECT id FROM services WHERE id = $1`,
        [serviceAId],
      );
      const faqRows = await client.query(`SELECT id FROM faqs WHERE id = $1`, [faqAId]);

      await client.query('COMMIT');

      // If any of these >0, RLS is not protecting orgA data from an orgB tenant context.
      expect(prodRows.rowCount, 'RLS: orgA product visible to orgB context').toBe(0);
      expect(svcRows.rowCount, 'RLS: orgA service visible to orgB context').toBe(0);
      expect(faqRows.rowCount, 'RLS: orgA faq visible to orgB context').toBe(0);
    } finally {
      await client.end();
    }
  });
});
