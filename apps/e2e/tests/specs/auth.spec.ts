import { test, expect } from '../helpers/fixtures';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import { clearInbox, extractFirstUrl, waitForEmail } from '../helpers/mailpit';
import {
  closePool,
  deleteOrgBySlug,
  deleteUserByEmail,
  failedLoginAttempts,
  markUserVerified,
  userStatus,
} from '../helpers/db';

const GOOD_PASSWORD = 'VeryStrongPwd!234';

test.afterAll(async () => {
  await closePool();
});

test.describe('seed admin login / logout', () => {
  test('logs in with seeded credentials and lands on /dashboard', async ({ page, seedAdminLogin }) => {
    await seedAdminLogin(page);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('logout clears session and /api/v1/auth/session becomes 401', async ({ page, seedAdminLogin, api }) => {
    await seedAdminLogin(page);

    // Open user menu. Button trigger in top bar — open it then click Sign out.
    const userMenu = page.getByRole('button', { name: new RegExp(env.SEED_ADMIN_EMAIL.split('@')[0], 'i') });
    if (await userMenu.isVisible().catch(() => false)) {
      await userMenu.click();
    } else {
      // Fallback — any button that reveals a "Sign out" option.
      await page.locator('header button').last().click();
    }
    await page.getByRole('menuitem', { name: /sign out|log out|logout/i }).click();
    await page.waitForURL(/\/login/);

    const session = await api.get('/api/v1/auth/session');
    expect(session.status).toBe(401);
  });
});

test.describe('signup + email verification', () => {
  const email = uniqueEmail('signup');
  const slug = uniqueSlug('qa-org');

  test.beforeAll(async () => {
    await clearInbox();
  });

  test.afterAll(async () => {
    await deleteUserByEmail(email);
    await deleteOrgBySlug(slug);
  });

  test('signs up, verifies via Mailpit link, logs in', async ({ page }) => {
    await page.goto('/signup');
    await page.getByLabel('First name').fill('Qa');
    await page.getByLabel('Last name').fill('Tester');
    await page.getByLabel(/work email/i).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(GOOD_PASSWORD);
    await page.getByLabel('Organization name').fill(`QA ${slug}`);
    // Overwrite auto-slug with our known unique slug.
    const slugInput = page.locator('#organizationSlug');
    await slugInput.fill(slug);
    await page.getByRole('button', { name: /create organization/i }).click();
    await page.waitForURL(/\/login/);

    expect(await userStatus(email)).toBe('pending');

    const msg = await waitForEmail({ to: email, subjectIncludes: 'Verify', timeoutMs: 20_000 });
    const link = extractFirstUrl(msg.HTML || msg.Text, '/verify-email');
    const path = new URL(link).pathname + new URL(link).search;
    await page.goto(path);
    await expect(page.getByRole('heading', { name: /email verified/i })).toBeVisible({ timeout: 10_000 });

    expect(await userStatus(email)).toBe('active');

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(GOOD_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard/);
  });
});

test.describe('forgot + reset password', () => {
  const email = uniqueEmail('forgot');
  const slug = uniqueSlug('qa-forgot');
  const newPassword = 'ChangedPwd!234A';

  test.beforeAll(async ({ request: _r }) => {
    // Create a verified user via API signup + mark verified in DB (skip the email dance).
    const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: GOOD_PASSWORD,
        firstName: 'Qa',
        lastName: 'Forgot',
        organizationName: `QA ${slug}`,
        organizationSlug: slug,
      }),
    });
    expect(res.status).toBe(201);
    await markUserVerified(email);
    await clearInbox();
  });

  test.afterAll(async () => {
    await deleteUserByEmail(email);
    await deleteOrgBySlug(slug);
  });

  test('requests a reset, follows the email link, sets a new password, logs in with it', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByRole('heading', { name: /check your inbox/i })).toBeVisible({ timeout: 10_000 });

    const msg = await waitForEmail({ to: email, subjectIncludes: 'Reset', timeoutMs: 20_000 });
    const link = extractFirstUrl(msg.HTML || msg.Text, '/reset-password');
    const path = new URL(link).pathname + new URL(link).search;
    await page.goto(path);

    await page.getByLabel(/new password|password/i).first().fill(newPassword);
    const confirm = page.getByLabel(/confirm/i);
    if (await confirm.isVisible().catch(() => false)) await confirm.fill(newPassword);
    await page.getByRole('button', { name: /reset|update|save/i }).first().click();

    // Either stays on page with success or redirects to /login.
    await Promise.race([
      page.waitForURL(/\/login/, { timeout: 6_000 }).catch(() => null),
      expect(page.getByText(/password.*(reset|updated)/i)).toBeVisible({ timeout: 6_000 }),
    ]);

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(newPassword);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard/);
  });
});

test.describe('account lockout', () => {
  const email = uniqueEmail('lockout');
  const slug = uniqueSlug('qa-lockout');

  test.beforeAll(async () => {
    const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password: GOOD_PASSWORD,
        firstName: 'Qa',
        lastName: 'Lockout',
        organizationName: `QA ${slug}`,
        organizationSlug: slug,
      }),
    });
    expect(res.status).toBe(201);
    await markUserVerified(email);
  });

  test.afterAll(async () => {
    await deleteUserByEmail(email);
    await deleteOrgBySlug(slug);
  });

  test('locks the account after 5 wrong passwords', async ({ page, api }) => {
    for (let i = 0; i < 5; i += 1) {
      const r = await api.post('/api/v1/auth/login', { email, password: 'WrongPwd!234aa' });
      expect([400, 401]).toContain(r.status);
    }
    expect(await failedLoginAttempts(email)).toBeGreaterThanOrEqual(5);

    // 6th attempt, even with correct password, should indicate lockout.
    const r = await api.post<{ message?: string; code?: string }>('/api/v1/auth/login', {
      email,
      password: GOOD_PASSWORD,
    });
    expect([401, 423]).toContain(r.status);

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(GOOD_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByText(/locked|too many|try again later/i)).toBeVisible({ timeout: 8_000 });
  });
});
