// Phase 4 — Broadcasts E2E.
//
// Exercises:
//   - Contacts: add via UI + verify in DB.
//   - Segments: create via UI with a tag-in filter + live preview count.
//   - Broadcasts: create draft via API (channel + template dependency makes
//     full UI wizard impractical in CI), verify it surfaces in /broadcasts.
//   - Lifecycle: cancel a draft via API → state flips to cancelled.
//
// The full send path (Meta /messages call) is not covered here; that needs
// a sandboxed Meta channel + would be flaky in CI. Worker-level testing of
// fanout + send sits in apps/api/test or unit tests instead.
import { ApiClient } from '../helpers/api';
import { closePool, deleteOrgCascade, deleteUserByEmail, markUserVerified, query } from '../helpers/db';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import { expect, test } from '../helpers/fixtures';

const PASSWORD = 'FixtureOrgPwd!234';

test.describe.configure({ mode: 'serial' });

let email: string;
let slug: string;
let orgId: string;

test.beforeAll(async () => {
  email = uniqueEmail('bcast-admin');
  slug = uniqueSlug('qa-bcast');
  const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      firstName: 'Qa',
      lastName: 'Broadcast',
      organizationName: `QA ${slug}`,
      organizationSlug: slug,
    }),
  });
  expect(res.status).toBe(201);
  await markUserVerified(email);

  const api = new ApiClient();
  await api.login(email, PASSWORD);
  const session = await api.get<{ organization: { id: string } }>('/api/v1/auth/session');
  if (session.status !== 200) throw new Error(`auth session failed: ${session.status}`);
  orgId = session.body.organization.id;
});

test.afterAll(async () => {
  await query(`DELETE FROM broadcast_events WHERE organization_id = $1`, [orgId]).catch(() => {});
  await query(`DELETE FROM broadcast_recipients WHERE organization_id = $1`, [orgId]).catch(() => {});
  await query(`DELETE FROM broadcasts WHERE organization_id = $1`, [orgId]).catch(() => {});
  await query(`DELETE FROM segments WHERE organization_id = $1`, [orgId]).catch(() => {});
  await query(`DELETE FROM contact_tags WHERE organization_id = $1`, [orgId]).catch(() => {});
  await query(`DELETE FROM contacts WHERE organization_id = $1`, [orgId]).catch(() => {});
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

test('add a contact via the UI; row appears in DB', async ({ page }) => {
  await loginUi(page);
  await page.goto('/contacts');
  await page.getByRole('button', { name: /add contact/i }).click();
  await page.getByLabel(/phone \(e\.164\)/i).fill('+14155550199');
  await page.getByLabel(/display name/i).fill('QA Test User');
  await page.getByLabel(/tags/i).fill('vip, qa');
  await page.getByRole('button', { name: /add contact/i }).last().click();
  // Toast lands; row appears in the list.
  await expect(page.getByText('+14155550199')).toBeVisible({ timeout: 5000 });

  const rows = await query<{ id: string; phone_e164: string }>(
    `SELECT id, phone_e164 FROM contacts WHERE organization_id = $1`,
    [orgId],
  );
  expect(rows.find((r) => r.phone_e164 === '+14155550199')).toBeTruthy();
});

test('create a segment with tag-in filter; preview shows count', async ({ page }) => {
  await loginUi(page);
  await page.goto('/segments');
  await page.getByRole('button', { name: /new segment/i }).click();
  await page.getByLabel(/^name$/i).fill('VIP QA');
  // First clause defaults to tag/in. Type the tag.
  // The UI uses a single Input where comma-separated tags get split.
  await page.getByPlaceholder(/vip, austin/i).fill('vip');
  // Wait for the live preview count to populate.
  await expect(page.getByText(/\d+ matching contact/)).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /create segment/i }).click();
  // Row appears in list.
  await expect(page.getByText('VIP QA')).toBeVisible({ timeout: 5000 });

  const rows = await query<{ id: string }>(
    `SELECT id FROM segments WHERE organization_id = $1 AND name = 'VIP QA'`,
    [orgId],
  );
  expect(rows.length).toBe(1);
});

test('create a draft broadcast via API and cancel it', async ({ page }) => {
  await loginUi(page);
  // We need a channel + an "approved" template. Insert them via DB directly so
  // the draft-create validation passes — actually sending requires a real Meta
  // backend, which we're not exercising.
  await query(
    `INSERT INTO whatsapp_channels (organization_id, is_primary, webhook_verify_token, access_token, phone_number_id, is_active)
     VALUES ($1, true, 'qa-token', 'qa-access', 'qa-phone-id', true)
     ON CONFLICT DO NOTHING`,
    [orgId],
  );
  const channelId = (
    await query<{ id: string }>(
      `SELECT id FROM whatsapp_channels WHERE organization_id = $1 LIMIT 1`,
      [orgId],
    )
  )[0]!.id;

  await query(
    `INSERT INTO whatsapp_templates (organization_id, name, language, category, body_text, status, updated_at)
     VALUES ($1, 'qa_template', 'en_US', 'MARKETING', 'Hello {{1}}', 'approved', now())
     ON CONFLICT DO NOTHING`,
    [orgId],
  );
  const templateId = (
    await query<{ id: string }>(
      `SELECT id FROM whatsapp_templates WHERE organization_id = $1 AND name = 'qa_template'`,
      [orgId],
    )
  )[0]!.id;

  const api = new ApiClient();
  await api.login(email, PASSWORD);

  const create = await api.post('/api/v1/broadcasts', {
    name: 'QA test broadcast',
    channelId,
    audienceKind: 'manual',
    manualPhones: ['+14155550199'],
    abTest: false,
    variantATemplateId: templateId,
    variantAVariables: { '1': { kind: 'static', value: 'Friend' } },
  });
  expect(create.status).toBe(201);
  const broadcastId = (create.body as { data: { id: string } }).data.id;

  // List page shows it.
  await page.goto('/broadcasts');
  await expect(page.getByText('QA test broadcast')).toBeVisible({ timeout: 5000 });

  // Cancel via API.
  const cancel = await api.post(`/api/v1/broadcasts/${broadcastId}/cancel`);
  expect(cancel.status).toBe(200);
  expect((cancel.body as { data: { status: string } }).data.status).toBe('cancelled');

  // Cleanup the seed rows we added.
  await query(`DELETE FROM whatsapp_templates WHERE id = $1`, [templateId]).catch(() => {});
  await query(`DELETE FROM whatsapp_channels WHERE id = $1`, [channelId]).catch(() => {});
});
