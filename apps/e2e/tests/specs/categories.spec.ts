import { test, expect } from '../helpers/fixtures';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import {
  closePool,
  deleteOrgBySlug,
  deleteUserByEmail,
  getOrgIdBySlug,
  markUserVerified,
  query,
} from '../helpers/db';

const GOOD_PASSWORD = 'VeryStrongPwd!234';

type Category = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
};

test.afterAll(async () => {
  await closePool();
});

test.describe('categories API CRUD (no UI yet)', () => {
  const email = uniqueEmail('cats');
  const slug = uniqueSlug('qa-cats');
  let orgId = '';
  let rootCategoryId = '';
  let childCategoryId = '';

  test.beforeAll(async () => {
    const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: GOOD_PASSWORD,
        firstName: 'Qa',
        lastName: 'Cats',
        organizationName: `QA ${slug}`,
        organizationSlug: slug,
      }),
    });
    expect(res.status).toBe(201);
    await markUserVerified(email);
    orgId = (await getOrgIdBySlug(slug))!;
    expect(orgId).toBeTruthy();
  });

  test.afterAll(async () => {
    await deleteUserByEmail(email);
    await deleteOrgBySlug(slug);
  });

  test('POST /api/v1/categories creates a root category', async ({ api }) => {
    await api.login(email, GOOD_PASSWORD);
    const res = await api.post<{ data: Category }>('/api/v1/categories', {
      name: 'Beverages',
      slug: 'beverages',
      sortOrder: 0,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Beverages');
    expect(res.body.data.slug).toBe('beverages');
    expect(res.body.data.parentId).toBeNull();
    rootCategoryId = res.body.data.id;
  });

  test('POST a child category with parentId works', async ({ api }) => {
    await api.login(email, GOOD_PASSWORD);
    const res = await api.post<{ data: Category }>('/api/v1/categories', {
      name: 'Coffee',
      slug: 'coffee',
      parentId: rootCategoryId,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.parentId).toBe(rootCategoryId);
    childCategoryId = res.body.data.id;
  });

  test('GET /api/v1/categories lists both', async ({ api }) => {
    await api.login(email, GOOD_PASSWORD);
    const res = await api.get<{ data: Category[] }>('/api/v1/categories');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c) => c.id);
    expect(ids).toContain(rootCategoryId);
    expect(ids).toContain(childCategoryId);
  });

  test('PATCH renames a category', async ({ api }) => {
    await api.login(email, GOOD_PASSWORD);
    const res = await api.patch<{ data: Category }>(`/api/v1/categories/${rootCategoryId}`, {
      name: 'Drinks',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Drinks');
  });

  test('self-parent is rejected', async ({ api }) => {
    await api.login(email, GOOD_PASSWORD);
    const res = await api.patch(`/api/v1/categories/${rootCategoryId}`, {
      parentId: rootCategoryId,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('DELETE clears categoryId on products that used it', async ({ api }) => {
    await api.login(email, GOOD_PASSWORD);

    // Use a fresh category created just for this test so earlier tests in this
    // describe block can't leave it in an unexpected state.
    const suffix = Date.now().toString(36);
    const catRes = await api.post<{ data: Category }>('/api/v1/categories', {
      name: `Del ${suffix}`,
      slug: `del-${suffix}`,
    });
    expect(catRes.status, `cat create: ${JSON.stringify(catRes.body)}`).toBe(201);
    const freshCatId = catRes.body.data.id;

    // Create a product attached to the fresh category.
    const pRes = await api.post<{ data: { id: string; categoryId: string | null } }>(
      '/api/v1/products',
      {
        sku: `QA-SKU-${suffix}`,
        name: 'QA Coffee Bean',
        slug: `qa-coffee-${suffix}`,
        categoryId: freshCatId,
        priceMinor: 1200,
      },
    );
    expect(pRes.status, `product create: ${JSON.stringify(pRes.body)}`).toBe(201);
    const productId = pRes.body.data.id;

    // Pre-check DB: product's category_id column is set.
    const before = await query<{ category_id: string | null }>(
      `SELECT category_id FROM products WHERE id = $1`,
      [productId],
    );
    expect(before[0]!.category_id).toBe(freshCatId);

    // Delete the fresh category.
    const dRes = await api.delete(`/api/v1/categories/${freshCatId}`);
    expect(dRes.status, `delete: ${JSON.stringify(dRes.body)}`).toBe(200);

    // Product's category_id must now be null (onDelete: SetNull).
    const after = await query<{ category_id: string | null }>(
      `SELECT category_id FROM products WHERE id = $1`,
      [productId],
    );
    expect(after[0]!.category_id).toBeNull();

    // GET the now-deleted category should 404.
    const getAgain = await api.get(`/api/v1/categories/${freshCatId}`);
    expect([404, 405]).toContain(getAgain.status);
  });
});
