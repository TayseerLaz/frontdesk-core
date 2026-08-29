import { test as base, expect, Page } from '@playwright/test';
import { ApiClient } from './api';
import { env } from './env';

export type TestUser = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organizationSlug: string;
  organizationName: string;
};

type Fixtures = {
  api: ApiClient;
  uiLogin: (page: Page, email: string, password: string) => Promise<void>;
  seedAdminLogin: (page: Page) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  api: async ({}, use) => {
    const client = new ApiClient();
    await use(client);
  },

  uiLogin: async ({}, use) => {
    await use(async (page, email, password) => {
      await page.goto('/login');
      await page.getByLabel(/email/i).fill(email);
      await page.getByLabel(/password/i).fill(password);
      await page.getByRole('button', { name: /sign in|log in/i }).click();
      await page.waitForURL(/\/dashboard/);
    });
  },

  seedAdminLogin: async ({ uiLogin }, use) => {
    await use(async (page) => {
      await uiLogin(page, env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
    });
  },
});

export { expect };
