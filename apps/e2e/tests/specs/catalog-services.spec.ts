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

const STRONG_PASSWORD = 'ServicePwd!234A';

const fixtureUser: TestUser = {
  email: uniqueEmail('qa-services'),
  password: STRONG_PASSWORD,
  firstName: 'Qa',
  lastName: 'Services',
  organizationSlug: uniqueSlug('qa-services'),
  organizationName: 'QA Services',
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

test.describe('/services list + edit', () => {
  let serviceId: string;

  test.beforeAll(async ({ api }) => {
    await api.login(fixtureUser.email, fixtureUser.password);
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const res = await api.post<{ data: { id: string } }>(`/api/v1/services`, {
      name: 'Massage (Draft)',
      slug: `svc-${stamp}`,
      basePriceMinor: 5000,
      currency: 'USD',
      priceUnit: 'flat',
      isAvailable: true,
    });
    expect(res.status).toBe(201);
    serviceId = res.body.data.id;
  });

  test('list page shows service', async ({ page, uiLogin }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto('/services');
    await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible();
    await expect(page.getByText('Massage (Draft)')).toBeVisible();
  });

  test('details auto-save after 800ms', async ({ page, uiLogin }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/services/${serviceId}`);
    await expect(page.getByLabel('Name')).toBeVisible();

    await page.getByLabel('Name').fill('Swedish Massage');
    await page.getByLabel('Duration (minutes)').fill('60');
    await page.getByLabel(/Base price \(/).fill('75.00');
    await page.getByLabel('Short description').fill('Relaxation-focused full body massage.');

    await page.waitForTimeout(1500);

    const rows = await query<{
      name: string;
      duration_minutes: number | null;
      base_price_minor: number | null;
      short_description: string | null;
    }>(
      `SELECT name, duration_minutes, base_price_minor, short_description FROM services WHERE id = $1`,
      [serviceId],
    );
    expect(rows[0].name).toBe('Swedish Massage');
    expect(Number(rows[0].duration_minutes)).toBe(60);
    expect(Number(rows[0].base_price_minor)).toBe(7500);
    expect(rows[0].short_description).toBe('Relaxation-focused full body massage.');
  });

  test('pricing tiers: add + save writes service_pricing_tiers rows', async ({ page, uiLogin }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/services/${serviceId}`);

    // Add a tier — scope card lookup before clicking so we can wait for the
    // new tier row to actually render afterwards.
    const tiersCard = page
      .locator('div', { has: page.getByRole('heading', { name: /^Pricing tiers$/ }) })
      .first();
    await page.getByRole('button', { name: /^Add tier$/ }).click();
    const tierCard = tiersCard.locator('.rounded-lg.border').first();
    await expect(tierCard).toBeVisible({ timeout: 5000 });

    const tierInputs = tierCard.locator('input, textarea');
    await tierInputs.nth(0).fill('Standard'); // Name
    await tierInputs.nth(1).fill('7500'); // Price (cents)
    // nth(2) is Description (textarea), nth(3) is Features (comma-separated).
    await tierInputs.nth(3).fill('Hot towel, Aromatherapy, 60 min');

    await page.getByRole('button', { name: /^Save tiers$/ }).click();
    await expect(page.getByText(/Pricing tiers saved/i)).toBeVisible({ timeout: 10_000 });

    const tiers = await query<{
      name: string;
      price_minor: number;
      features: string[];
    }>(
      `SELECT name, price_minor, features FROM service_pricing_tiers WHERE service_id = $1 ORDER BY sort_order`,
      [serviceId],
    );
    expect(tiers.length).toBe(1);
    expect(tiers[0].name).toBe('Standard');
    expect(Number(tiers[0].price_minor)).toBe(7500);
    expect(tiers[0].features).toEqual(['Hot towel', 'Aromatherapy', '60 min']);
  });

  test('weekly availability: enable Tuesday 09:00-17:00 → availability_windows row', async ({
    page,
    uiLogin,
  }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/services/${serviceId}`);

    // The weekly grid renders 7 rows. Each row has a span with the day name.
    // Find the Tuesday span, then walk up to the row-level grid wrapper.
    const tuesdaySpan = page.getByText('Tuesday', { exact: true }).first();
    await expect(tuesdaySpan).toBeVisible();
    const dayRow = tuesdaySpan.locator('xpath=..'); // parent div (the grid row)

    await dayRow.locator('input[type="checkbox"]').check();
    const timeInputs = dayRow.locator('input[type="time"]');
    await timeInputs.nth(0).fill('09:00');
    await timeInputs.nth(1).fill('17:00');

    await page.getByRole('button', { name: /^Save availability$/ }).click();
    await expect(page.getByText(/Availability saved/i)).toBeVisible({ timeout: 8000 });

    const windows = await query<{
      day_of_week: string;
      start_minute: number;
      end_minute: number;
    }>(
      `SELECT day_of_week::text AS day_of_week, start_minute, end_minute
       FROM availability_windows WHERE service_id = $1`,
      [serviceId],
    );
    const tue = windows.find((w) => w.day_of_week === 'tuesday');
    expect(tue).toBeDefined();
    expect(Number(tue!.start_minute)).toBe(9 * 60);
    expect(Number(tue!.end_minute)).toBe(17 * 60);
  });

  test('delete service → soft-deleted (deleted_at is set)', async ({ page, uiLogin, api }) => {
    // Use a separate disposable service so the prior tests' one stays available.
    await api.login(fixtureUser.email, fixtureUser.password);
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const create = await api.post<{ data: { id: string } }>(`/api/v1/services`, {
      name: 'Disposable Service',
      slug: `svc-del-${stamp}`,
      isAvailable: false,
    });
    const id = create.body.data.id;

    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/services/${id}`);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /delete service/i }).click();
    await page.waitForURL(/\/services$/);

    const rows = await query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM services WHERE id = $1`,
      [id],
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });
});
