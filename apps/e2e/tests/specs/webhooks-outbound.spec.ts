// Outbound webhook end-to-end:
//
//   - Stand up a local HTTP receiver on a random port inside the test.
//   - Register a webhook endpoint via the /webhooks UI subscribed to `product_updated`.
//   - Edit a product → receiver gets POST within 5s with a valid HMAC signature.
//   - Receiver returns 500 three times → delivery retries (BullMQ backoff) →
//     delivery row should have attempts >= 2 with status changing over time.
//   - Receiver returns 400 → NOT retried → row lands in `giving_up` (permanent) status.
//   - Force consecutive_failures to threshold (25) by injecting past rows → endpoint
//     flips to `is_active = false` after one more real failure.
//   - Manual retry re-enqueues a failed delivery.
//
// NOTE on the event kind: the WebhookEventKind enum uses snake_case identifiers
// (`product_updated`), not the dotted `catalog.product.updated` in the prompt.
// We subscribe to the enum value the code emits.
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ApiClient } from '../helpers/api';
import { closePool, deleteOrgCascade, deleteUserByEmail, markUserVerified, query } from '../helpers/db';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import { expect, test } from '../helpers/fixtures';

const PASSWORD = 'FixtureOrgPwd!234';

test.describe.configure({ mode: 'serial' });

// --------- Local test receiver ---------------------------------------------

interface Delivery {
  url: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
}

class Receiver {
  server: http.Server;
  port = 0;
  hostUrl = '';
  deliveries: Delivery[] = [];
  // Dynamic behaviour override. Default 200.
  private respondFn: (count: number) => { status: number; body?: string } = () => ({ status: 200 });

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(Buffer.from(c)));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v ?? '');
          }
          this.deliveries.push({ url: req.url ?? '', headers, body, receivedAt: Date.now() });
          const result = this.respondFn(this.deliveries.length);
          res.writeHead(result.status, { 'content-type': 'text/plain' });
          res.end(result.body ?? '');
        });
      });
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as AddressInfo;
        this.port = addr.port;
        this.hostUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  respond(fn: (count: number) => { status: number; body?: string }) {
    this.respondFn = fn;
  }

  reset() {
    this.deliveries = [];
    this.respondFn = () => ({ status: 200 });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// --------- Fixture org + receiver lifecycle --------------------------------

let fxEmail: string;
let fxSlug: string;
let fxOrgId: string;
let fxApi: ApiClient;
let receiver: Receiver;

test.beforeAll(async () => {
  fxEmail = uniqueEmail('webhooks-admin');
  fxSlug = uniqueSlug('qa-webhooks');
  const r = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: fxEmail,
      password: PASSWORD,
      firstName: 'Qa',
      lastName: 'Webhooks',
      organizationName: `QA ${fxSlug}`,
      organizationSlug: fxSlug,
    }),
  });
  expect(r.status).toBe(201);
  await markUserVerified(fxEmail);
  fxApi = new ApiClient();
  await fxApi.login(fxEmail, PASSWORD);
  const s = await fxApi.get<{ organization: { id: string } }>('/api/v1/auth/session');
  if (s.status !== 200) throw new Error(`session: ${s.status}`);
  fxOrgId = s.body.organization.id;

  receiver = new Receiver();
  await receiver.start();
});

test.afterAll(async () => {
  await receiver?.stop().catch(() => {});
  await query(`DELETE FROM webhook_deliveries WHERE organization_id = $1`, [fxOrgId]).catch(() => {});
  await query(`DELETE FROM webhook_endpoints WHERE organization_id = $1`, [fxOrgId]).catch(() => {});
  await query(`DELETE FROM api_keys WHERE organization_id = $1`, [fxOrgId]).catch(() => {});
  await deleteOrgCascade(fxSlug);
  await deleteUserByEmail(fxEmail);
  await closePool();
});

// --------- Helpers ---------------------------------------------------------

function verifySignature(secret: string, body: string, headerSig: string, timestamp: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return expected === headerSig;
}

async function createProduct(sku: string, name: string): Promise<string> {
  const res = await fxApi.post<{ data: { id: string } }>('/api/v1/products', { sku, name });
  if (res.status !== 201) throw new Error(`create product: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id;
}

async function waitForDelivery(
  endpointId: string,
  match: (row: { status: string; attempts: number; response_status: number | null }) => boolean,
  timeoutMs = 10_000,
): Promise<{ id: string; status: string; attempts: number; response_status: number | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await query<{ id: string; status: string; attempts: number; response_status: number | null }>(
      `SELECT id, status, attempts, response_status FROM webhook_deliveries
         WHERE endpoint_id = $1 ORDER BY created_at DESC`,
      [endpointId],
    );
    const hit = rows.find(match);
    if (hit) return hit;
    await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}

async function loginUi(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(fxEmail);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/dashboard/);
}

// --------- Tests -----------------------------------------------------------

test('creates endpoint via UI, verifies HMAC signature on a real delivery', async ({ page }) => {
  receiver.reset();
  receiver.respond(() => ({ status: 200 }));

  await loginUi(page);
  await page.goto('/webhooks');

  // Open create dialog.
  await page.getByRole('button', { name: /new endpoint|add an endpoint/i }).first().click();
  // Radix Label doesn't always wire up via getByLabel; target inputs by placeholder/order.
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder(/your-system\.example/i).fill(`${receiver.hostUrl}/hook`);
  // Description input has no placeholder — it's the 2nd text input in the dialog.
  await dialog.locator('input[type="text"]').nth(1).fill('E2E product_updated endpoint');
  // Subscribe specifically to `product_updated`.
  const productUpdatedLabel = page.locator('label', {
    has: page.locator('code', { hasText: /^product_updated$/ }),
  });
  await productUpdatedLabel.locator('input[type=checkbox]').check();
  await page.getByRole('button', { name: /^create endpoint$/i }).click();

  // "Save this signing secret" dialog — reveal + read + close.
  const secretDialog = page.getByRole('dialog').filter({ hasText: /save this signing secret/i });
  await expect(secretDialog).toBeVisible();
  await secretDialog.getByRole('button', { name: /toggle reveal/i }).click();
  // Inside that dialog, the first <code class="break-all"> is the endpoint URL; the second is the secret.
  const secretText = (await secretDialog.locator('code.break-all').nth(1).textContent())?.trim() ?? '';
  expect(secretText).toMatch(/^whsec_/);
  await secretDialog.getByRole('button', { name: /i've saved it/i }).click();

  // Cross-check DB: the signing_secret matches what the UI showed.
  const epRow = (
    await query<{ id: string; signing_secret: string; event_kinds: string[] }>(
      `SELECT id, signing_secret, event_kinds FROM webhook_endpoints
         WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [fxOrgId],
    )
  )[0];
  expect(epRow).toBeDefined();
  expect(epRow.signing_secret).toBe(secretText);
  expect(epRow.event_kinds).toContain('product_updated');

  // Trigger a product_updated event — create then PATCH.
  const productId = await createProduct(`WH-SKU-${Date.now()}`, 'Webhook Target Product');
  const patch = await fxApi.patch(`/api/v1/products/${productId}`, { name: 'Webhook Target Product v2' });
  expect(patch.status).toBe(200);

  // Wait up to 5s for the receiver to get the delivery.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && receiver.deliveries.length === 0) {
    await new Promise((res) => setTimeout(res, 100));
  }
  expect(receiver.deliveries.length).toBeGreaterThan(0);
  const d = receiver.deliveries[0];
  expect(d.headers['x-webhook-event']).toBe('product_updated');
  expect(d.headers['x-webhook-delivery']).toBeTruthy();
  expect(d.headers['x-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  expect(d.headers['x-webhook-timestamp']).toMatch(/^\d+$/);

  // HMAC check.
  const valid = verifySignature(
    secretText,
    d.body,
    d.headers['x-signature'],
    d.headers['x-webhook-timestamp'],
  );
  expect(valid).toBe(true);

  // Body is JSON with event, organizationId, data.
  const parsed = JSON.parse(d.body);
  expect(parsed.event).toBe('product_updated');
  expect(parsed.organizationId).toBe(fxOrgId);
  expect(parsed.data).toHaveProperty('id');

  // Delivery row marked delivered.
  const row = await waitForDelivery(epRow.id, (r) => r.status === 'delivered');
  expect(row?.status).toBe('delivered');
});

test('5xx responses trigger retries with backoff; delivery succeeds once receiver returns 200', async () => {
  // Grab the endpoint created in the previous test.
  const ep = (
    await query<{ id: string; signing_secret: string }>(
      `SELECT id, signing_secret FROM webhook_endpoints
         WHERE organization_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1`,
      [fxOrgId],
    )
  )[0];
  expect(ep).toBeDefined();

  receiver.reset();
  // Fail 3 times with 500, then succeed.
  receiver.respond((n) => (n <= 3 ? { status: 500, body: 'transient' } : { status: 200 }));

  // Clean up any deliveries from previous tests so waitForDelivery below
  // matches only the delivery this test triggers.
  const priorIds = (
    await query<{ id: string }>(`SELECT id FROM webhook_deliveries WHERE endpoint_id = $1`, [ep.id])
  ).map((r) => r.id);

  const pid = await createProduct(`WH-RETRY-${Date.now()}`, 'Retry Product');
  await fxApi.patch(`/api/v1/products/${pid}`, { name: 'Retry Product v2' });

  // Wait up to 90s — exp backoff after 3 failures gives us attempts at ~5s, 10s, 20s, 40s.
  const delivered = await waitForDelivery(
    ep.id,
    (r) => r.status === 'delivered' && !priorIds.includes((r as { id: string }).id),
    90_000,
  );
  expect(delivered).not.toBeNull();
  expect(delivered!.attempts).toBeGreaterThanOrEqual(2);
  // Sanity: receiver observed the retry traffic (at least 2, likely 4).
  expect(receiver.deliveries.length).toBeGreaterThanOrEqual(2);
});

test('4xx response is treated as permanent — no retry, status goes to giving_up', async () => {
  const ep = (
    await query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE organization_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 1`,
      [fxOrgId],
    )
  )[0];
  expect(ep).toBeDefined();

  receiver.reset();
  receiver.respond(() => ({ status: 400, body: 'bad request — permanent' }));

  const before = receiver.deliveries.length;
  const pid = await createProduct(`WH-400-${Date.now()}`, 'Permanent Fail Product');
  await fxApi.patch(`/api/v1/products/${pid}`, { name: 'Permanent Fail v2' });

  // Wait for a row to reach `giving_up` with attempts == 1 (no retry).
  const row = await waitForDelivery(
    ep.id,
    (r) => r.status === 'giving_up' && r.response_status === 400,
    15_000,
  );
  expect(row).not.toBeNull();
  expect(row!.attempts).toBe(1);

  // Give the system an extra breath to NOT retry.
  await new Promise((res) => setTimeout(res, 1500));
  expect(receiver.deliveries.length - before).toBe(1);
});

test('25 consecutive failures flips endpoint to disabled (is_active=false)', async () => {
  // Strategy: we don't want to wait through 25 real exponential retries.
  // The ENDPOINT state machine watches `consecutive_failures`. We seed the
  // column to 24 directly, then trigger one real 5xx delivery that exhausts
  // attempts and bumps to 25, which should flip is_active to false.
  //
  // We also shortcut WEBHOOK_MAX_ATTEMPTS by injecting a single 400 (permanent-fail)
  // so bumpFailureCount runs after ONE attempt.
  const ep = (
    await query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE organization_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 1`,
      [fxOrgId],
    )
  )[0];
  expect(ep).toBeDefined();

  // Prime consecutive_failures just below the threshold.
  await query(
    `UPDATE webhook_endpoints SET consecutive_failures = 24 WHERE id = $1`,
    [ep.id],
  );

  receiver.reset();
  receiver.respond(() => ({ status: 400, body: 'permanent' })); // 1 attempt, bumps failures to 25.

  const pid = await createProduct(`WH-DISABLE-${Date.now()}`, 'Disable Product');
  await fxApi.patch(`/api/v1/products/${pid}`, { name: 'Disable v2' });

  // Poll for is_active == false.
  const deadline = Date.now() + 15_000;
  let disabled = false;
  while (Date.now() < deadline) {
    const rows = await query<{ is_active: boolean; consecutive_failures: number }>(
      `SELECT is_active, consecutive_failures FROM webhook_endpoints WHERE id = $1`,
      [ep.id],
    );
    if (rows[0] && rows[0].is_active === false && rows[0].consecutive_failures >= 25) {
      disabled = true;
      break;
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  expect(disabled).toBe(true);
});

test('manual retry re-enqueues a failed delivery', async () => {
  // Re-enable the endpoint so the retry's delivery worker doesn't short-circuit.
  const ep = (
    await query<{ id: string }>(
      `SELECT id FROM webhook_endpoints WHERE organization_id = $1
         ORDER BY created_at DESC LIMIT 1`,
      [fxOrgId],
    )
  )[0];
  // PATCH via admin API — this also resets consecutive_failures.
  const reactivate = await fxApi.patch(`/api/v1/webhook-endpoints/${ep.id}`, { isActive: true });
  expect(reactivate.status).toBe(200);

  // Find a prior failed delivery (from the previous test, where receiver returned 400).
  const failed = (
    await query<{ id: string; attempts: number; status: string }>(
      `SELECT id, attempts, status FROM webhook_deliveries
         WHERE endpoint_id = $1 AND status IN ('giving_up','failed')
         ORDER BY created_at DESC LIMIT 1`,
      [ep.id],
    )
  )[0];
  expect(failed).toBeDefined();

  // This time, make the receiver succeed.
  receiver.reset();
  receiver.respond(() => ({ status: 200 }));

  const retry = await fxApi.post(`/api/v1/webhook-deliveries/${failed.id}/retry`);
  expect(retry.status).toBe(200);

  // Poll the specific delivery we retried — not `status === 'delivered'` globally,
  // which would match prior-test rows.
  const deadline = Date.now() + 30_000;
  let done: { status: string; attempts: number } | null = null;
  while (Date.now() < deadline) {
    const rows = await query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM webhook_deliveries WHERE id = $1`,
      [failed.id],
    );
    if (rows[0]?.status === 'delivered') {
      done = rows[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(done).not.toBeNull();
  expect(receiver.deliveries.length).toBeGreaterThanOrEqual(1);
});
