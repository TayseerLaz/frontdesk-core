// Exercises:
//   - Issue an API key via the UI, verify secret_hash in DB is sha256(secret).
//   - Use the key to hit /api/v1/read/products → 200 + last_used_at populated.
//   - Scope enforcement: key scoped only to `read:catalog` → `/read/business-info` = 403.
//   - Rate limiting: hammer requests until 429 lands.
//   - Revocation: key stops working (→ 401) after revoke.
import { createHash } from 'node:crypto';

import { ApiClient } from '../helpers/api';
import { closePool, deleteOrgCascade, deleteUserByEmail, markUserVerified, query } from '../helpers/db';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import { expect, test } from '../helpers/fixtures';

const PASSWORD = 'FixtureOrgPwd!234';

test.describe.configure({ mode: 'serial' });

// ------- Fixture org shared by all tests in this file ----------------------
let email: string;
let slug: string;
let orgId: string;
const cleanup = {
  apiKeyIds: new Set<string>(),
};

test.beforeAll(async () => {
  email = uniqueEmail('apikeys-admin');
  slug = uniqueSlug('qa-apikeys');
  const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      firstName: 'Qa',
      lastName: 'Keys',
      organizationName: `QA ${slug}`,
      organizationSlug: slug,
    }),
  });
  expect(res.status).toBe(201);
  await markUserVerified(email);

  // Resolve org id. Use API login to read session because the seed-admin helper only works on seed org.
  const api = new ApiClient();
  await api.login(email, PASSWORD);
  const session = await api.get<{ organization: { id: string } }>('/api/v1/auth/session');
  if (session.status !== 200) throw new Error(`auth session failed: ${session.status}`);
  orgId = session.body.organization.id;
});

test.afterAll(async () => {
  await query(`DELETE FROM webhook_deliveries WHERE organization_id = $1`, [orgId]).catch(() => {});
  await query(`DELETE FROM webhook_endpoints WHERE organization_id = $1`, [orgId]).catch(() => {});
  await query(`DELETE FROM api_keys WHERE organization_id = $1`, [orgId]).catch(() => {});
  await deleteOrgCascade(slug);
  await deleteUserByEmail(email);
  await closePool();
});

async function loginUi(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/dashboard/);
}

async function issueKeyViaUI(
  page: import('@playwright/test').Page,
  name: string,
  scopes: string[],
): Promise<string> {
  await page.goto('/api-keys');
  await page.getByRole('button', { name: /new api key|issue your first key/i }).first().click();
  // The Dialog's "Name" <Input> has a matching placeholder; target by placeholder for reliability.
  await page.getByPlaceholder('e.g. WhatsApp production bot').fill(name);

  // Scope checkboxes: the page renders each scope as a <code> next to a checkbox.
  // Un-check all scopes first, then check only the requested ones.
  const allScopes = ['read:catalog', 'read:business-info', 'read:faqs'];
  for (const s of allScopes) {
    const label = page.locator('label', { has: page.locator('code', { hasText: s }) });
    const box = label.locator('input[type=checkbox]');
    if (await box.isChecked()) await box.click();
  }
  for (const s of scopes) {
    const label = page.locator('label', { has: page.locator('code', { hasText: s }) });
    await label.locator('input[type=checkbox]').check();
  }
  await page.getByRole('button', { name: /^issue key$/i }).click();

  // "Save this secret" dialog
  await expect(page.getByRole('heading', { name: /save this secret/i })).toBeVisible();
  // Reveal the secret so it's readable in DOM, then grab the code content.
  await page.getByRole('button', { name: /toggle reveal/i }).click();
  const codeLocator = page.locator('code.break-all').first();
  const secret = (await codeLocator.textContent())?.trim() ?? '';
  expect(secret).toMatch(/^ak_live_/);

  // Copy button exists
  await expect(page.getByRole('button', { name: /^copy$/i })).toBeVisible();
  await page.getByRole('button', { name: /i've saved it/i }).click();
  return secret;
}

test('issues an API key, DB hash matches sha256(secret), and the key authenticates', async ({ page }) => {
  await loginUi(page);
  const secret = await issueKeyViaUI(page, 'E2E primary key', ['read:catalog', 'read:business-info', 'read:faqs']);

  // DB hash check.
  const rows = await query<{ id: string; key_hash: string; last_used_at: string | null; scopes: string[] }>(
    `SELECT id, key_hash, last_used_at, scopes FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [orgId],
  );
  expect(rows.length).toBe(1);
  const row = rows[0];
  cleanup.apiKeyIds.add(row.id);
  expect(row.last_used_at).toBeNull();

  const expectedHash = createHash('sha256').update(secret).digest('hex');
  expect(row.key_hash).toBe(expectedHash);

  // Use the key against the read API.
  const readClient = new ApiClient({ apiKey: secret });
  const resp = await readClient.get<{ data: unknown[] }>('/api/v1/read/products');
  expect(resp.status).toBe(200);

  // last_used_at is populated (the api-key plugin fires this fire-and-forget, so poll briefly).
  let lastUsed: string | null = null;
  for (let i = 0; i < 10; i += 1) {
    const r = await query<{ last_used_at: string | null }>(
      `SELECT last_used_at FROM api_keys WHERE id = $1`,
      [row.id],
    );
    if (r[0]?.last_used_at) {
      lastUsed = r[0].last_used_at;
      break;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  expect(lastUsed).not.toBeNull();
});

test('scoped key cannot access endpoints requiring a different scope', async ({ page }) => {
  await loginUi(page);
  // Only `read:catalog` — NOT business-info or faqs.
  const secret = await issueKeyViaUI(page, 'E2E catalog-only key', ['read:catalog']);
  const row = (
    await query<{ id: string }>(
      `SELECT id FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orgId],
    )
  )[0];
  cleanup.apiKeyIds.add(row.id);

  const readClient = new ApiClient({ apiKey: secret });

  // read:catalog → /read/products should pass
  const ok = await readClient.get('/api/v1/read/products');
  expect(ok.status).toBe(200);

  // read:business-info required → /read/business-info should 403
  const denied = await readClient.get('/api/v1/read/business-info');
  expect(denied.status).toBe(403);

  // read:faqs required → /read/faqs should 403
  const faqsDenied = await readClient.get('/api/v1/read/faqs');
  expect(faqsDenied.status).toBe(403);

  // read:business-info required → /read/policies should 403
  const policiesDenied = await readClient.get('/api/v1/read/policies');
  expect(policiesDenied.status).toBe(403);
});

test('hammering the read API past the per-key rate-limit returns 429', async ({ page }) => {
  await loginUi(page);
  const secret = await issueKeyViaUI(page, 'E2E ratelimit key', ['read:catalog']);
  const row = (
    await query<{ id: string }>(
      `SELECT id FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orgId],
    )
  )[0];
  cleanup.apiKeyIds.add(row.id);

  // Fire 250 requests with moderate parallelism. Global read-API bucket is
  // RATE_LIMIT_API_PER_SECOND=100/sec per key — we should trip it.
  const client = new ApiClient({ apiKey: secret });
  const N = 250;
  const statuses: number[] = [];
  // Issue 25 requests in parallel at a time so we don't saturate sockets.
  for (let batch = 0; batch < N / 25; batch += 1) {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => client.get('/api/v1/read/products')),
    );
    for (const r of results) statuses.push(r.status);
    if (statuses.includes(429)) break;
  }
  expect(statuses).toContain(429);
});

test('revoking a key causes subsequent calls to return 401', async ({ page }) => {
  await loginUi(page);
  const secret = await issueKeyViaUI(page, 'E2E revoke-me key', ['read:catalog']);
  const row = (
    await query<{ id: string }>(
      `SELECT id FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [orgId],
    )
  )[0];
  cleanup.apiKeyIds.add(row.id);

  const client = new ApiClient({ apiKey: secret });
  const before = await client.get('/api/v1/read/products');
  expect(before.status).toBe(200);

  // Intercept window.confirm used by the page component before clicking Revoke.
  await page.goto('/api-keys');
  page.once('dialog', (d) => d.accept());

  // Find the list item for the key we just created (by name) and click its Revoke (Trash) button.
  const item = page.locator('li', { hasText: 'E2E revoke-me key' }).first();
  await item.getByRole('button', { name: /revoke/i }).click();

  // Wait for the key to disappear from the list.
  await expect(item).toHaveCount(0, { timeout: 10_000 });

  // DB row should now have revoked_at set.
  const dbAfter = await query<{ revoked_at: string | null }>(
    `SELECT revoked_at FROM api_keys WHERE id = $1`,
    [row.id],
  );
  expect(dbAfter[0]?.revoked_at).not.toBeNull();

  // Next call with the now-revoked secret returns 401.
  const after = await client.get('/api/v1/read/products');
  expect(after.status).toBe(401);
});
