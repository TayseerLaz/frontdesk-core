/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type TestUser } from '../helpers/fixtures';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import {
  closePool,
  deleteOrgBySlug,
  deleteUserByEmail,
  getOrgIdBySlug,
  markUserVerified,
  query,
} from '../helpers/db';

const STRONG_PASSWORD = 'BizInfoPwd!234A';

const fixtureUser: TestUser = {
  email: uniqueEmail('qa-biz'),
  password: STRONG_PASSWORD,
  firstName: 'Qa',
  lastName: 'Biz',
  organizationSlug: uniqueSlug('qa-biz'),
  organizationName: 'QA Biz',
};

let orgId: string;

test.beforeAll(async () => {
  const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: fixtureUser.email,
      password: fixtureUser.password,
      firstName: fixtureUser.firstName,
      lastName: fixtureUser.lastName,
      organizationName: fixtureUser.organizationName,
      organizationSlug: fixtureUser.organizationSlug,
    }),
  });
  expect(res.status).toBe(201);
  await markUserVerified(fixtureUser.email);
  const id = await getOrgIdBySlug(fixtureUser.organizationSlug);
  orgId = id!;
});

test.afterAll(async () => {
  await deleteOrgBySlug(fixtureUser.organizationSlug);
  await deleteUserByEmail(fixtureUser.email);
  await closePool();
});

test.describe('/business-info Profile tab', () => {
  test('Profile: legal name + tagline + hours grid → DB row', async ({ page, uiLogin }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto('/business-info');
    await expect(page.getByRole('tab', { name: /profile/i })).toBeVisible();

    // Fill profile fields.
    await page.getByLabel('Legal name').fill('Aligned QA Inc.');
    await page.getByLabel('Tagline').fill('The chatbot for your catalog.');
    await page.getByLabel('About').fill('We are a QA fixture business.');

    // Hours grid — pick Monday by the day label and walk up to the row.
    const mondayLabel = page.getByText('Monday', { exact: true }).first();
    await expect(mondayLabel).toBeVisible();
    const mondayRow = mondayLabel.locator('xpath=..');
    await mondayRow.locator('input[type="checkbox"]').check();
    const times = mondayRow.locator('input[type="time"]');
    await times.nth(0).fill('09:00');
    await times.nth(1).fill('17:00');

    await page.getByRole('button', { name: /save profile & hours/i }).click();
    await expect(page.getByText(/Business profile saved/i)).toBeVisible({ timeout: 8000 });

    const rows = await query<{
      legal_name: string | null;
      tagline: string | null;
      about: string | null;
      operating_hours: any;
    }>(
      `SELECT legal_name, tagline, about, operating_hours FROM business_info WHERE organization_id = $1`,
      [orgId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].legal_name).toBe('Aligned QA Inc.');
    expect(rows[0].tagline).toBe('The chatbot for your catalog.');
    expect(rows[0].about).toBe('We are a QA fixture business.');
    expect(rows[0].operating_hours.monday).toEqual([{ open: '09:00', close: '17:00' }]);
  });
});

test.describe('/business-info Locations tab', () => {
  test('add → list → delete', async ({ page, uiLogin }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto('/business-info');
    await page.getByRole('tab', { name: /locations/i }).click();

    await page.getByRole('button', { name: /^Add location$/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Name and Address have htmlFor; city/region/postal/country use bare Labels
    // without htmlFor, so target inputs by order within the dialog.
    await dialog.locator('#loc-name').fill('HQ');
    await dialog.locator('#loc-addr').fill('123 Main St');
    const gridInputs = dialog.locator('.grid input');
    await gridInputs.nth(0).fill('Springfield'); // City
    await gridInputs.nth(1).fill('IL');          // Region
    await gridInputs.nth(2).fill('62704');       // Postal code
    await gridInputs.nth(3).fill('us');          // Country

    // Two "Add location" buttons exist at this point (opener + dialog submit);
    // click the submit inside the dialog.
    await dialog.getByRole('button', { name: /^Add location$/ }).click();
    await expect(page.getByText(/Location added/i)).toBeVisible({ timeout: 8000 });

    // UI list shows it.
    await expect(page.getByText('HQ')).toBeVisible();

    // DB row.
    const rows = await query<{ name: string; city: string | null; country: string | null }>(
      `SELECT name, city, country FROM locations WHERE organization_id = $1`,
      [orgId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('HQ');
    expect(rows[0].city).toBe('Springfield');
    expect(rows[0].country).toBe('US');

    // Delete it.
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /remove location/i }).click();
    await page.waitForTimeout(600);

    const rows2 = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM locations WHERE organization_id = $1`,
      [orgId],
    );
    expect(Number(rows2[0].n)).toBe(0);
  });
});

test.describe('/business-info Contacts tab', () => {
  test('add + delete contact channel', async ({ page, uiLogin }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto('/business-info');
    await page.getByRole('tab', { name: /contacts/i }).click();

    // Kind Select defaults to whatsapp; change to phone via Radix Select.
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /^phone$/ }).click();

    await page.getByPlaceholder(/Label/i).fill('Main');
    await page.getByPlaceholder(/Value/i).fill('+1 555 0100');
    await page.getByRole('button', { name: /^Add$/ }).click();
    await expect(page.getByText(/Contact added/i)).toBeVisible({ timeout: 8000 });

    const rows = await query<{ kind: string; value: string; label: string | null }>(
      `SELECT kind, value, label FROM contact_channels WHERE organization_id = $1`,
      [orgId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('phone');
    expect(rows[0].value).toBe('+1 555 0100');
    expect(rows[0].label).toBe('Main');

    // Delete.
    page.once('dialog', (d) => void d.accept());
    await page
      .getByRole('button', { name: /^Remove$/ })
      .first()
      .click();
    await page.waitForTimeout(500);
    const rows2 = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM contact_channels WHERE organization_id = $1`,
      [orgId],
    );
    expect(Number(rows2[0].n)).toBe(0);
  });
});

test.describe('/business-info FAQs tab', () => {
  test('add FAQ → toggle visibility → reorder (API) → delete', async ({ page, uiLogin, api }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto('/business-info');
    await page.getByRole('tab', { name: /faqs/i }).click();

    // Add FAQ #1.
    await page.getByLabel('Question').fill('When are you open?');
    await page.getByLabel('Answer').fill('Mon–Fri 09:00–17:00.');
    await page.getByRole('button', { name: /^Add FAQ$/ }).click();
    await expect(page.getByText(/FAQ added/i)).toBeVisible({ timeout: 8000 });

    // Add FAQ #2 so we can reorder.
    await page.getByLabel('Question').fill('Do you ship?');
    await page.getByLabel('Answer').fill('Yes, worldwide.');
    await page.getByRole('button', { name: /^Add FAQ$/ }).click();
    await page.waitForTimeout(600);

    const faqs = await query<{ id: string; question: string; sort_order: number; visibility: string }>(
      `SELECT id, question, sort_order, visibility::text AS visibility
         FROM faqs WHERE organization_id = $1
         ORDER BY created_at ASC`,
      [orgId],
    );
    expect(faqs.length).toBe(2);

    // Toggle visibility on the first FAQ via the Radix Select trigger in its row.
    const firstRow = page.locator('li', { hasText: /When are you open\?/ });
    await firstRow.getByRole('combobox').click();
    await page.getByRole('option', { name: /^Private$/ }).click();
    await page.waitForTimeout(600);

    const after = await query<{ visibility: string }>(
      `SELECT visibility::text AS visibility FROM faqs WHERE id = $1`,
      [faqs[0].id],
    );
    expect(after[0].visibility).toBe('private');

    // Reorder via API (UI has no reorder buttons today).
    await api.login(fixtureUser.email, fixtureUser.password);
    const reorder = await api.post(`/api/v1/business-info/faqs/reorder`, {
      order: [
        { id: faqs[1].id, sortOrder: 0 },
        { id: faqs[0].id, sortOrder: 1 },
      ],
    });
    expect(reorder.status).toBe(200);
    const sorted = await query<{ id: string; sort_order: number }>(
      `SELECT id, sort_order FROM faqs WHERE organization_id = $1 ORDER BY sort_order ASC`,
      [orgId],
    );
    expect(sorted[0].id).toBe(faqs[1].id);
    expect(sorted[1].id).toBe(faqs[0].id);

    // Delete both FAQs via UI.
    for (let i = 0; i < 2; i += 1) {
      page.once('dialog', (d) => void d.accept());
      await page
        .getByRole('button', { name: /delete faq/i })
        .first()
        .click();
      await page.waitForTimeout(500);
    }

    const finalCount = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM faqs WHERE organization_id = $1`,
      [orgId],
    );
    expect(Number(finalCount[0].n)).toBe(0);
  });
});

test.describe('/business-info Policies tab', () => {
  test('upsert policies by kind: return + privacy persist independently', async ({
    page,
    uiLogin,
  }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto('/business-info');
    await page.getByRole('tab', { name: /policies/i }).click();

    // Policy form uses bare Radix Labels without htmlFor — scope to the Edit
    // policy card and target the fields by placeholder / position.
    const policyCard = page
      .locator('div', { has: page.getByRole('heading', { name: /^Edit policy$/ }) })
      .first();
    const titleInput = policyCard.getByPlaceholder(/return policy/i);
    const contentArea = policyCard.locator('textarea');

    const saveBtn = policyCard.getByRole('button', { name: /save policy/i });

    // Return policy (default kind = "return").
    await titleInput.fill('Return Policy');
    await contentArea.fill('Returns accepted within 30 days.');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.getByText(/Policy saved/i)).toBeVisible({ timeout: 8000 });

    // Switch kind to "privacy".
    await policyCard.getByRole('combobox').first().click();
    await page.getByRole('option', { name: /^privacy$/ }).click();
    await titleInput.fill('Privacy Policy');
    await contentArea.fill('We do not sell your data.');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.getByText(/Policy saved/i)).toBeVisible({ timeout: 8000 });

    const rows = await query<{ kind: string; title: string; content: string }>(
      `SELECT kind, title, content FROM policies WHERE organization_id = $1 ORDER BY kind`,
      [orgId],
    );
    expect(rows.length).toBe(2);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind.return.title).toBe('Return Policy');
    expect(byKind.return.content).toBe('Returns accepted within 30 days.');
    expect(byKind.privacy.title).toBe('Privacy Policy');
    expect(byKind.privacy.content).toBe('We do not sell your data.');
  });
});
