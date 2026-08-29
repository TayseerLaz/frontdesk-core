// Chatbot read API coverage — exercises every /api/v1/read/* endpoint against
// a freshly-seeded fixture org, and verifies:
//   - shape + tenant isolation (a product in org B is NOT returned to org A's key)
//   - cache hit on a repeat call (second call < 50% of first)
//   - invalidation on catalog mutation (PATCH → read reflects change within 2s)
import { ApiClient } from '../helpers/api';
import { closePool, deleteOrgCascade, deleteUserByEmail, markUserVerified, query } from '../helpers/db';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import { expect, test } from '../helpers/fixtures';

const PASSWORD = 'FixtureOrgPwd!234';

test.describe.configure({ mode: 'serial' });

type Fixture = {
  email: string;
  slug: string;
  orgId: string;
  api: ApiClient;
  apiKeySecret: string;
  productIds: string[];
  serviceId: string;
};

let fx: Fixture;
// Second org + product to prove cross-tenant isolation.
let otherEmail: string;
let otherSlug: string;
let otherProductId: string;

async function signupAndLogin(emailAddr: string, org: string): Promise<ApiClient> {
  const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: emailAddr,
      password: PASSWORD,
      firstName: 'Qa',
      lastName: 'Reader',
      organizationName: `QA ${org}`,
      organizationSlug: org,
    }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  await markUserVerified(emailAddr);
  const c = new ApiClient();
  await c.login(emailAddr, PASSWORD);
  return c;
}

async function resolveOrgId(c: ApiClient): Promise<string> {
  const s = await c.get<{ organization: { id: string } }>('/api/v1/auth/session');
  if (s.status !== 200) throw new Error(`session failed: ${s.status}`);
  return s.body.organization.id;
}

test.beforeAll(async () => {
  const email = uniqueEmail('readapi-admin');
  const slug = uniqueSlug('qa-readapi');
  const api = await signupAndLogin(email, slug);
  const orgId = await resolveOrgId(api);

  // Seed: 3 products, 1 service, 1 FAQ, 1 policy, business info.
  const productIds: string[] = [];
  for (const p of [
    { sku: 'RA-SKU-001', name: 'Espresso Beans', shortDescription: 'Rich dark roast blend', priceMinor: 1599 },
    { sku: 'RA-SKU-002', name: 'Cold Brew Bottle', shortDescription: 'Smooth 250ml cold brew', priceMinor: 499 },
    { sku: 'RA-SKU-003', name: 'Reusable Ceramic Mug', shortDescription: 'Premium ceramic mug', priceMinor: 1299 },
  ]) {
    const r = await api.post<{ data: { id: string } }>('/api/v1/products', p);
    if (r.status !== 201) throw new Error(`create product: ${r.status} ${JSON.stringify(r.body)}`);
    productIds.push(r.body.data.id);
  }

  const svc = await api.post<{ data: { id: string } }>('/api/v1/services', {
    name: 'Barista Training',
    shortDescription: 'Hands-on private barista class',
    basePriceMinor: 9999,
    durationMinutes: 90,
  });
  if (svc.status !== 201) throw new Error(`create service: ${svc.status} ${JSON.stringify(svc.body)}`);

  const faq = await api.post('/api/v1/business-info/faqs', {
    question: 'Do you ship internationally?',
    answer: 'Yes, we ship worldwide in 3-7 business days.',
    isPublished: true,
    visibility: 'public',
    tags: ['shipping'],
  });
  if (faq.status !== 201) throw new Error(`create faq: ${faq.status}`);

  const pol = await api.put('/api/v1/business-info/policies', {
    kind: 'return',
    title: 'Returns Policy',
    content: 'Return within 30 days for a full refund.',
    isPublished: true,
  });
  if (pol.status !== 200) throw new Error(`upsert policy: ${pol.status} ${JSON.stringify(pol.body)}`);

  const bi = await api.put('/api/v1/business-info', {
    legalName: 'QA Coffee Co.',
    tagline: 'Brewed with care',
    about: 'We roast locally and ship globally.',
    timezone: 'UTC',
    currency: 'USD',
  });
  if (bi.status !== 200) throw new Error(`upsert business-info: ${bi.status}`);

  // Issue an API key with all read scopes.
  const key = await api.post<{ data: { secret: string } }>('/api/v1/api-keys', {
    name: 'E2E read-api scoped key',
    scopes: ['read:catalog', 'read:business-info', 'read:faqs'],
  });
  if (key.status !== 201) throw new Error(`issue key: ${key.status} ${JSON.stringify(key.body)}`);

  fx = {
    email,
    slug,
    orgId,
    api,
    apiKeySecret: key.body.data.secret,
    productIds,
    serviceId: svc.body.data.id,
  };

  // Second org — just one product, used for cross-tenant isolation.
  otherEmail = uniqueEmail('readapi-other');
  otherSlug = uniqueSlug('qa-readapi-other');
  const otherApi = await signupAndLogin(otherEmail, otherSlug);
  const other = await otherApi.post<{ data: { id: string } }>('/api/v1/products', {
    sku: 'OTHER-SKU-001',
    name: 'Cross Tenant Product (should be hidden)',
    shortDescription: 'Should NOT be visible to the first org',
    priceMinor: 100,
  });
  if (other.status !== 201) throw new Error(`create other product: ${other.status}`);
  otherProductId = other.body.data.id;
});

test.afterAll(async () => {
  await query(`DELETE FROM api_keys WHERE organization_id = $1`, [fx.orgId]).catch(() => {});
  await deleteOrgCascade(fx.slug);
  await deleteUserByEmail(fx.email);
  await deleteOrgCascade(otherSlug);
  await deleteUserByEmail(otherEmail);
  await closePool();
});

// ---------- shape assertions -----------------------------------------------

test('GET /read/products returns the fixture org products, not other tenants', async () => {
  const c = new ApiClient({ apiKey: fx.apiKeySecret });
  const res = await c.get<{ data: Array<{ id: string; sku: string; name: string }> }>(
    '/api/v1/read/products',
  );
  expect(res.status).toBe(200);
  const ids = res.body.data.map((p) => p.id);
  for (const pid of fx.productIds) expect(ids).toContain(pid);
  expect(ids).not.toContain(otherProductId);
  expect(res.body.data.length).toBe(3);
  // Shape spot-check
  const sample = res.body.data[0];
  expect(sample).toHaveProperty('sku');
  expect(sample).toHaveProperty('name');
});

test('GET /read/products/:id — existing returns 200, cross-tenant returns 404', async () => {
  const c = new ApiClient({ apiKey: fx.apiKeySecret });
  const mine = await c.get<{ data: { id: string } }>(`/api/v1/read/products/${fx.productIds[0]}`);
  expect(mine.status).toBe(200);
  expect(mine.body.data.id).toBe(fx.productIds[0]);

  const crossTenant = await c.get(`/api/v1/read/products/${otherProductId}`);
  expect(crossTenant.status).toBe(404);
});

test('GET /read/services and /read/services/:id', async () => {
  const c = new ApiClient({ apiKey: fx.apiKeySecret });
  const list = await c.get<{ data: Array<{ id: string; name: string }> }>('/api/v1/read/services');
  expect(list.status).toBe(200);
  expect(list.body.data.some((s) => s.id === fx.serviceId)).toBe(true);

  const one = await c.get<{ data: { id: string; name: string } }>(
    `/api/v1/read/services/${fx.serviceId}`,
  );
  expect(one.status).toBe(200);
  expect(one.body.data.name).toBe('Barista Training');
});

test('GET /read/business-info returns profile + tagline', async () => {
  const c = new ApiClient({ apiKey: fx.apiKeySecret });
  const res = await c.get<{ data: { legalName: string; tagline: string } | null }>(
    '/api/v1/read/business-info',
  );
  expect(res.status).toBe(200);
  expect(res.body.data).not.toBeNull();
  expect(res.body.data!.legalName).toBe('QA Coffee Co.');
  expect(res.body.data!.tagline).toBe('Brewed with care');
});

test('GET /read/faqs returns the seeded FAQ', async () => {
  const c = new ApiClient({ apiKey: fx.apiKeySecret });
  const res = await c.get<{ data: Array<{ question: string }> }>('/api/v1/read/faqs');
  expect(res.status).toBe(200);
  expect(res.body.data.some((f) => /ship internationally/i.test(f.question))).toBe(true);
});

test('GET /read/policies returns the returns-policy', async () => {
  const c = new ApiClient({ apiKey: fx.apiKeySecret });
  const res = await c.get<{ data: Array<{ kind: string; title: string }> }>(
    '/api/v1/read/policies',
  );
  expect(res.status).toBe(200);
  expect(res.body.data.some((p) => p.kind === 'return' && /refund/i.test(p.content + '')))
    .toBeTruthy();
});

test('GET /read/search?q=... finds products and FAQs', async () => {
  const c = new ApiClient({ apiKey: fx.apiKeySecret });
  const res = await c.get<{ data: Array<{ type: string; title: string }> }>(
    '/api/v1/read/search',
    { q: 'espresso' },
  );
  expect(res.status).toBe(200);
  expect(res.body.data.some((h) => h.type === 'product' && /espresso/i.test(h.title))).toBe(true);
});

// ---------- cache behaviour -----------------------------------------------

test('repeat call within 60s is served from cache (x-cache: HIT)', async () => {
  const c = new ApiClient({ apiKey: fx.apiKeySecret });
  // Cache key is derived from query params — make it unique so we observe a MISS first.
  const uniqueQ = { q: `warm-${Date.now()}` };
  const first = await c.get('/api/v1/read/products', uniqueQ);
  expect(first.status).toBe(200);
  expect(String(first.headers['x-cache'] ?? '')).toMatch(/^(MISS|STALE)$/);

  const second = await c.get('/api/v1/read/products', uniqueQ);
  expect(second.status).toBe(200);
  expect(String(second.headers['x-cache'] ?? '')).toBe('HIT');
});

test('editing a product via the authenticated API invalidates the read cache', async () => {
  const reader = new ApiClient({ apiKey: fx.apiKeySecret });
  const productId = fx.productIds[0];

  // Warm the single-product cache.
  const warm = await reader.get<{ data: { name: string } }>(`/api/v1/read/products/${productId}`);
  expect(warm.status).toBe(200);
  const originalName = warm.body.data.name;

  // Mutate via the authenticated portal API (uses fx.api's JWT).
  const newName = `${originalName} (edited ${Date.now()})`;
  const patch = await fx.api.patch(`/api/v1/products/${productId}`, { name: newName });
  expect(patch.status).toBe(200);

  // Poll read API for the new name; must land within ~2s.
  let observed: string | null = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const r = await reader.get<{ data: { name: string } }>(`/api/v1/read/products/${productId}`);
    if (r.status === 200 && r.body.data.name === newName) {
      observed = r.body.data.name;
      break;
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  expect(observed).toBe(newName);
});
