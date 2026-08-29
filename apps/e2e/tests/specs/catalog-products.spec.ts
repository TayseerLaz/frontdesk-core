/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const STRONG_PASSWORD = 'CatalogPwd!234A';

// 1x1 red PNG.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av7czFnnAAAAAElFTkSuQmCC';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, '..', '..', 'fixtures');
const TINY_PNG_PATH = path.join(FIXTURE_DIR, 'tiny.png');

function ensureTinyPng() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  if (!fs.existsSync(TINY_PNG_PATH)) {
    fs.writeFileSync(TINY_PNG_PATH, Buffer.from(TINY_PNG_B64, 'base64'));
  }
}

const fixtureUser: TestUser = {
  email: uniqueEmail('qa-products'),
  password: STRONG_PASSWORD,
  firstName: 'Qa',
  lastName: 'Products',
  organizationSlug: uniqueSlug('qa-products'),
  organizationName: 'QA Products',
};

let orgId: string;

test.beforeAll(async () => {
  ensureTinyPng();
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
  expect(id).not.toBeNull();
  orgId = id!;
});

test.afterAll(async () => {
  await deleteOrgBySlug(fixtureUser.organizationSlug);
  await deleteUserByEmail(fixtureUser.email);
  await closePool();
});

// ---------- list page ------------------------------------------------------
test.describe('/products list', () => {
  test('search, availability filter, bulk-select, status badges, pagination', async ({
    page,
    uiLogin,
    api,
  }) => {
    await api.login(fixtureUser.email, fixtureUser.password);

    // Create 3 products via API so we have fixtures.
    const names = ['Alpha Widget', 'Beta Gadget', 'Gamma Gizmo'];
    const createdIds: string[] = [];
    for (const name of names) {
      const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const res = await api.post<{ data: { id: string } }>(`/api/v1/products`, {
        sku: `SKU-${stamp}`,
        slug: `p-${stamp}`,
        name,
        priceMinor: 1999,
        currency: 'USD',
        isAvailable: true,
      });
      expect(res.status).toBe(201);
      createdIds.push(res.body.data.id);
    }

    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto('/products');
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();

    // All three products appear.
    for (const n of names) {
      await expect(page.getByRole('cell', { name: new RegExp(n, 'i') }).first()).toBeVisible();
    }

    // Search: type "Alpha", expect Beta/Gamma hidden after debounce (~300ms).
    const search = page.getByPlaceholder(/search by name or sku/i);
    await search.fill('Alpha');
    await page.waitForTimeout(600);
    await expect(page.getByText('Alpha Widget')).toBeVisible();
    await expect(page.getByText('Beta Gadget')).toHaveCount(0);
    await search.fill('');
    await page.waitForTimeout(600);

    // Availability filter — Unavailable should now yield empty.
    // Radix Select: click trigger, then click item.
    const availTrigger = page.getByRole('combobox').nth(1); // category is 0, avail is 1
    await availTrigger.click();
    await page.getByRole('option', { name: /^Unavailable$/ }).click();
    await page.waitForTimeout(400);
    await expect(page.getByText(/No matches|No products/i)).toBeVisible();

    // Reset to All availability.
    await availTrigger.click();
    await page.getByRole('option', { name: /^All availability$/ }).click();
    await page.waitForTimeout(400);

    // Status badge: all should say "Available". Badge text includes a leading
    // checkmark icon so we can't anchor ^...$; use a partial match.
    const badges = page.locator('span,div').filter({ hasText: /\bAvailable\b/ });
    await expect(badges.first()).toBeVisible();

    // Bulk-select: click header checkbox, then "Mark unavailable".
    await page.getByRole('checkbox', { name: /select all/i }).click();
    await expect(page.getByText(/selected/i)).toBeVisible();
    await page.getByRole('button', { name: /mark unavailable/i }).click();
    await page.waitForTimeout(800);

    // Assert DB rows flipped to isAvailable=false.
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM products WHERE organization_id = $1 AND is_available = false AND deleted_at IS NULL`,
      [orgId],
    );
    expect(Number(rows[0].n)).toBe(3);

    // Mark them available again.
    await page.getByRole('checkbox', { name: /select all/i }).click();
    await page.getByRole('button', { name: /mark available/i }).click();
    await page.waitForTimeout(800);

    const rows2 = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM products WHERE organization_id = $1 AND is_available = true AND deleted_at IS NULL`,
      [orgId],
    );
    expect(Number(rows2[0].n)).toBe(3);

    // Cursor pagination — create many products so cursor is exercised at API level.
    // UI limit is 50; creating 52 and asserting API returns a nextCursor.
    // (UI doesn't currently surface a Next-page button, so assert at API level.)
    const before = await api.get<{ data: any[]; nextCursor: string | null }>(
      '/api/v1/products?limit=2',
    );
    expect(before.status).toBe(200);
    expect(before.body.nextCursor).not.toBeNull();
    const next = await api.get<{ data: any[]; nextCursor: string | null }>(
      `/api/v1/products?limit=2&cursor=${encodeURIComponent(before.body.nextCursor!)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.data.length).toBeGreaterThan(0);
    // Second page must not repeat the first page's first product.
    expect(next.body.data[0].id).not.toBe(before.body.data[0].id);

    // Soft-delete one product via row dropdown → Delete.
    page.once('dialog', (d) => void d.accept());
    const gizmoRow = page.locator('tr', { hasText: 'Gamma Gizmo' });
    await gizmoRow.getByRole('button').last().click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await page.waitForTimeout(700);
    await expect(page.getByText('Gamma Gizmo')).toHaveCount(0);

    const deletedRow = await query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM products WHERE id = $1`,
      [createdIds[2]],
    );
    expect(deletedRow[0].deleted_at).not.toBeNull();
  });
});

// ---------- edit page: auto-save, image upload, variants, danger, versions ----
test.describe('/products/[id] edit', () => {
  let productId: string;
  let productSku: string;

  test.beforeAll(async ({ api }) => {
    await api.login(fixtureUser.email, fixtureUser.password);
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    productSku = `EDIT-${stamp}`;
    const res = await api.post<{ data: { id: string } }>(`/api/v1/products`, {
      sku: productSku,
      slug: `edit-${stamp}`,
      name: 'Edit Me',
      priceMinor: 999,
      currency: 'USD',
      isAvailable: true,
    });
    productId = res.body.data.id;
  });

  test('details auto-save after 800ms writes DB', async ({ page, uiLogin }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/products/${productId}`);
    await expect(page.getByLabel('Name')).toBeVisible();

    const name = page.getByLabel('Name');
    await name.fill('Auto-saved Name');
    const priceInput = page.getByLabel(/^Price \(/);
    await priceInput.fill('42.50');
    const shortDesc = page.getByLabel('Short description');
    await shortDesc.fill('Cached from the chatbot');
    // getByLabel('Description') matches both "Short description" and "Description"; scope by exact role.
    const desc = page.getByRole('textbox', { name: 'Description', exact: true });
    await desc.fill('Long markdown description.');

    // Wait past debounce + save.
    await page.waitForTimeout(1500);

    const rows = await query<{
      name: string;
      price_minor: number;
      short_description: string | null;
      description: string | null;
    }>(
      `SELECT name, price_minor, short_description, description FROM products WHERE id = $1`,
      [productId],
    );
    expect(rows[0].name).toBe('Auto-saved Name');
    expect(Number(rows[0].price_minor)).toBe(4250);
    expect(rows[0].short_description).toBe('Cached from the chatbot');
    expect(rows[0].description).toBe('Long markdown description.');

    // SKU change also auto-saved.
    const newSku = `${productSku}-X`;
    await page.getByLabel('SKU').fill(newSku);
    await page.waitForTimeout(1500);
    const skuRow = await query<{ sku: string }>(`SELECT sku FROM products WHERE id = $1`, [productId]);
    expect(skuRow[0].sku.toLowerCase()).toBe(newSku.toLowerCase());
  });

  test('image upload → thumbnail, DB rows in product_images + assets; delete removes it', async ({
    page,
    uiLogin,
  }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/products/${productId}`);

    // Pick the file via the hidden input. setInputFiles works on hidden inputs.
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(TINY_PNG_PATH);

    // Wait for the thumbnail to appear strictly inside the Images card.
    const imagesCard = page.locator('div', { has: page.getByRole('heading', { name: /^Images$/ }) }).first();
    await expect(imagesCard.locator('img').first()).toBeVisible({ timeout: 20_000 });

    // DB: one product_images row + one asset row.
    const imgs = await query<{ id: string; asset_id: string; is_primary: boolean }>(
      `SELECT id, asset_id, is_primary FROM product_images WHERE product_id = $1`,
      [productId],
    );
    expect(imgs.length).toBe(1);
    const assetId = imgs[0].asset_id;
    const assets = await query<{ id: string; kind: string; byte_size: number }>(
      `SELECT id, kind::text AS kind, byte_size FROM assets WHERE id = $1`,
      [assetId],
    );
    expect(assets[0].kind).toBe('image');
    expect(Number(assets[0].byte_size)).toBeGreaterThan(0);
    // First upload is marked primary.
    expect(imgs[0].is_primary).toBe(true);

    // Upload a second image so we can test "Make primary".
    await page.locator('input[type="file"]').first().setInputFiles(TINY_PNG_PATH);
    await page.waitForTimeout(2000);

    const imgs2 = await query<{ id: string; is_primary: boolean }>(
      `SELECT id, is_primary FROM product_images WHERE product_id = $1 ORDER BY created_at`,
      [productId],
    );
    expect(imgs2.length).toBe(2);

    // Hover the non-primary thumbnail and click "Make primary" — because hover
    // reveals controls, we force-click the button which exists in DOM.
    const makePrimary = page.getByRole('button', { name: /make primary/i }).first();
    await makePrimary.click({ force: true });
    await page.waitForTimeout(800);

    const imgs3 = await query<{ id: string; is_primary: boolean }>(
      `SELECT id, is_primary FROM product_images WHERE product_id = $1`,
      [productId],
    );
    expect(imgs3.filter((i) => i.is_primary).length).toBe(1);

    // Delete one image via trash button.
    const deleteBtn = page.getByRole('button', { name: /remove image/i }).first();
    await deleteBtn.click({ force: true });
    await page.waitForTimeout(800);

    const imgs4 = await query<{ id: string }>(
      `SELECT id FROM product_images WHERE product_id = $1`,
      [productId],
    );
    expect(imgs4.length).toBeLessThan(imgs3.length);
  });

  test('variants: add option keys and rows, save → product_variants matches', async ({
    page,
    uiLogin,
  }) => {
    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/products/${productId}`);

    // Scroll the Variants card into view so action buttons are clickable.
    await page.getByRole('heading', { name: /^Variants$/ }).scrollIntoViewIfNeeded();

    // Add option keys "color" and "size".
    const optionInput = page.getByPlaceholder(/e\.g\. color/i);
    const optionBtn = page.getByRole('button', { name: 'Option', exact: true });
    await optionInput.fill('color');
    await optionBtn.click();
    await expect(optionInput).toHaveValue('', { timeout: 2000 });
    await optionInput.fill('size');
    await optionBtn.click();
    await expect(optionInput).toHaveValue('', { timeout: 2000 });

    // Add 2 variants.
    const addVariantBtn = page.getByRole('button', { name: /^Add variant$/ });
    await addVariantBtn.click();
    await addVariantBtn.click();

    // Wait for the two variant rows to be in the DOM before filling.
    const tableRowsCheck = page.locator('table tr').filter({ has: page.locator('input') });
    await expect(tableRowsCheck).toHaveCount(2, { timeout: 5000 });

    // Confirm the option columns are now part of the header (safeguards column indices).
    await expect(page.getByRole('columnheader', { name: /^color$/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /^size$/ })).toBeVisible();

    // Fill rows. Cells are Inputs — target by column index isn't easy; instead
    // fill cells by iterating through visible variant rows.
    const tableRows = page.locator('table tr').filter({ has: page.locator('input') });
    const rowCount = await tableRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // Row 0: SKU, Name, color, size, price, stock.
    const row0 = tableRows.nth(0);
    await row0.locator('input').nth(0).fill(`${productSku}-V1`);
    await row0.locator('input').nth(1).fill('Red / Small');
    await row0.locator('input').nth(2).fill('red');
    await row0.locator('input').nth(3).fill('S');
    await row0.locator('input').nth(4).fill('1500');

    const row1 = tableRows.nth(1);
    await row1.locator('input').nth(0).fill(`${productSku}-V2`);
    await row1.locator('input').nth(1).fill('Blue / Large');
    await row1.locator('input').nth(2).fill('blue');
    await row1.locator('input').nth(3).fill('L');
    await row1.locator('input').nth(4).fill('1800');

    await page.getByRole('button', { name: /^Save variants$/ }).click();
    await expect(page.getByText(/Variants saved/i)).toBeVisible({ timeout: 8000 });

    const variants = await query<{
      sku: string;
      name: string;
      options: any;
      price_minor: number | null;
    }>(
      `SELECT sku, name, options, price_minor FROM product_variants WHERE product_id = $1 ORDER BY sort_order`,
      [productId],
    );
    expect(variants.length).toBe(2);
    expect(variants[0].options).toMatchObject({ color: 'red', size: 'S' });
    expect(variants[1].options).toMatchObject({ color: 'blue', size: 'L' });
    expect(Number(variants[0].price_minor)).toBe(1500);
    expect(Number(variants[1].price_minor)).toBe(1800);
  });

  test('danger zone delete → deleted_at is set', async ({ page, uiLogin, api }) => {
    // Create a throwaway product so we don't kill the one used for version-history below.
    await api.login(fixtureUser.email, fixtureUser.password);
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const res = await api.post<{ data: { id: string } }>(`/api/v1/products`, {
      sku: `DELME-${stamp}`,
      slug: `delme-${stamp}`,
      name: 'Delete Me Plz',
      isAvailable: false,
    });
    const id = res.body.data.id;

    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/products/${id}`);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /delete product/i }).click();
    await page.waitForURL(/\/products$/);

    const rows = await query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM products WHERE id = $1`,
      [id],
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  test('version history shows entries; restore reverts fields + records a restored revision', async ({
    page,
    uiLogin,
    api,
  }) => {
    await api.login(fixtureUser.email, fixtureUser.password);
    // Make sure the product exists and is active.
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const create = await api.post<{ data: { id: string } }>(`/api/v1/products`, {
      sku: `VER-${stamp}`,
      slug: `ver-${stamp}`,
      name: 'Original Name',
      priceMinor: 1000,
      currency: 'USD',
      isAvailable: true,
    });
    const id = create.body.data.id;

    // Update it a couple of times to generate revisions.
    await api.patch(`/api/v1/products/${id}`, { name: 'Second Name', priceMinor: 2000 });
    await api.patch(`/api/v1/products/${id}`, { name: 'Third Name', priceMinor: 3000 });

    const revs = await query<{ id: string; version_number: number; action: string }>(
      `SELECT id, version_number, action::text AS action FROM catalog_revisions
       WHERE entity_type = 'product'::"RevisionEntityType" AND entity_id = $1
       ORDER BY version_number ASC`,
      [id],
    );
    expect(revs.length).toBeGreaterThanOrEqual(3);

    await uiLogin(page, fixtureUser.email, fixtureUser.password);
    await page.goto(`/products/${id}`);
    await expect(page.getByText(/Version history/i)).toBeVisible();
    // Revision timeline entries visible.
    await expect(page.getByText(/created/i).first()).toBeVisible();

    // Click the earliest revision ("created").
    const earliest = page.getByText(/^v1$/);
    await earliest.click();

    // Preview dialog with snapshot + Restore button.
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /restore this version/i }).click();

    // Wait until product name reverts in the details card.
    await expect(page.getByLabel('Name')).toHaveValue(/Original Name/i, { timeout: 10_000 });

    const dbRow = await query<{ name: string; price_minor: number | null }>(
      `SELECT name, price_minor FROM products WHERE id = $1`,
      [id],
    );
    expect(dbRow[0].name).toBe('Original Name');
    expect(Number(dbRow[0].price_minor)).toBe(1000);

    const restoredRevs = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM catalog_revisions
       WHERE entity_type = 'product'::"RevisionEntityType" AND entity_id = $1 AND action = 'restored'::"RevisionAction"`,
      [id],
    );
    expect(Number(restoredRevs[0].n)).toBeGreaterThanOrEqual(1);
  });
});
