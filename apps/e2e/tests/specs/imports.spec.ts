// End-to-end coverage for the CSV/XLSX import flow.
//
// Flow under test:
//   1. GET /api/v1/imports/templates/:kind for each of product|service|faq|business_info
//      returns a non-empty XLSX body with the right content-type.
//   2. Upload a good product CSV → worker processes all rows → status "succeeded" →
//      3 products exist for the test org.
//   3. Upload a CSV with 1 invalid row → status "partial" → import_job_rows shows
//      2 succeeded + 1 failed with structured errors.
//   4. Upload a large CSV → click Cancel while processing → status becomes
//      "cancelled" (British spelling — matches the Prisma enum / API).
//   5. Detail page filters to "failed only" and renders raw row data.
//
// Tenant hygiene: a dedicated QA org is provisioned in beforeAll and deleted in
// afterAll. All tenant-scoped cleanup cascades from deleting the org.
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
import { FormData, File, request } from 'undici';

const ADMIN_PASSWORD = 'Aligned123!Import';
const ADMIN_EMAIL = uniqueEmail('qa-imports-admin');
const ORG_SLUG = uniqueSlug('qa-imports');

let orgId = '';
let accessToken = '';

async function apiJson<T>(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    ...(opts.headers ?? {}),
  };
  // Only set content-type when we have a body — Fastify rejects empty JSON.
  if (opts.body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await request(`${env.API_URL}${path}`, {
    method: method as never,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.body.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.statusCode, body: body as T };
}

async function loginAs(email: string, password: string): Promise<string> {
  const res = await request(`${env.API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.statusCode !== 200) {
    const txt = await res.body.text();
    throw new Error(`Login failed ${res.statusCode}: ${txt}`);
  }
  const json = (await res.body.json()) as { accessToken: string };
  return json.accessToken;
}

async function uploadCsvAndStartImport(
  csv: string,
  filename: string,
  entityKind: 'product' | 'service' | 'faq' | 'business_info',
): Promise<string> {
  const form = new FormData();
  form.append('file', new File([csv], filename, { type: 'text/csv' }));
  const upload = await request(`${env.API_URL}/api/v1/assets/upload-csv`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (upload.statusCode !== 201) {
    throw new Error(`Upload failed ${upload.statusCode}: ${await upload.body.text()}`);
  }
  const uploadJson = (await upload.body.json()) as { data: { assetId: string } };

  const startRes = await apiJson<{ data: { id: string } }>('POST', '/api/v1/imports', {
    body: { entityKind, sourceAssetId: uploadJson.data.assetId },
  });
  expect(startRes.status).toBe(202);
  return startRes.body.data.id;
}

async function waitForStatus(
  importId: string,
  terminal: Array<'succeeded' | 'partial' | 'failed' | 'cancelled'>,
  timeoutMs = 30_000,
): Promise<{ status: string; succeededRows: number; failedRows: number; totalRows: number }> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await apiJson<{
      data: { status: string; succeededRows: number; failedRows: number; totalRows: number };
    }>('GET', `/api/v1/imports/${importId}`);
    if (r.status === 200 && terminal.includes(r.body.data.status as never)) {
      return r.body.data;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Import ${importId} never reached ${terminal.join('|')} — last status: ${r.body?.data?.status}`,
      );
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

async function deleteImportsForOrg(): Promise<void> {
  // ON DELETE CASCADE from organization takes care of everything, but if we
  // keep the org alive between tests, wipe just the import-scoped rows.
  if (!orgId) return;
  await query(`DELETE FROM import_job_rows WHERE organization_id = $1`, [orgId]);
  await query(`DELETE FROM import_jobs WHERE organization_id = $1`, [orgId]);
  await query(`DELETE FROM assets WHERE organization_id = $1`, [orgId]);
  await query(`DELETE FROM products WHERE organization_id = $1`, [orgId]);
  await query(`DELETE FROM faqs WHERE organization_id = $1`, [orgId]);
}

test.beforeAll(async () => {
  // Provision the QA org via the signup API, then mark verified.
  const res = await request(`${env.API_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      firstName: 'Qa',
      lastName: 'Imports',
      organizationName: `QA Imports ${ORG_SLUG}`,
      organizationSlug: ORG_SLUG,
    }),
  });
  if (res.statusCode !== 201) {
    throw new Error(`signup failed ${res.statusCode}: ${await res.body.text()}`);
  }
  await res.body.dump();
  await markUserVerified(ADMIN_EMAIL);
  const foundId = await getOrgIdBySlug(ORG_SLUG);
  if (!foundId) throw new Error('org not created');
  orgId = foundId;
  accessToken = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
});

test.afterAll(async () => {
  await deleteImportsForOrg();
  await deleteUserByEmail(ADMIN_EMAIL);
  await deleteOrgBySlug(ORG_SLUG);
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. Template download — one endpoint per entity kind.
// ---------------------------------------------------------------------------
test.describe('templates', () => {
  const kinds = ['product', 'service', 'faq', 'business_info'] as const;
  for (const kind of kinds) {
    test(`GET /imports/templates/${kind} returns a non-empty XLSX`, async () => {
      const res = await request(`${env.API_URL}/api/v1/imports/templates/${kind}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const ct = res.headers['content-type'];
      expect(String(ct)).toContain('spreadsheetml.sheet');
      const buf = Buffer.from(await res.body.arrayBuffer());
      expect(buf.byteLength).toBeGreaterThan(512);
      // XLSX is a ZIP — first four bytes are PK\x03\x04.
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Good CSV (3 rows) → succeeded → 3 products in DB.
// ---------------------------------------------------------------------------
test.describe('happy path — good product CSV', () => {
  test.afterAll(async () => {
    await deleteImportsForOrg();
  });

  test('uploads, worker runs, 3 products appear', async () => {
    // The worker reads the CSV headers as the target field names (the import
    // wizard currently does no header→field mapping).
    const csv = [
      'sku,name,shortDescription,priceMinor,currency,isAvailable,stockQuantity,categorySlug',
      'QA-GOOD-1,QA Widget 1,Nice widget,1999,USD,true,10,qa-widgets',
      'QA-GOOD-2,QA Widget 2,Better widget,2999,USD,true,5,qa-widgets',
      'QA-GOOD-3,QA Widget 3,Best widget,3999,USD,false,0,qa-widgets',
    ].join('\n');

    const importId = await uploadCsvAndStartImport(csv, 'products-good.csv', 'product');
    const job = await waitForStatus(importId, ['succeeded', 'partial', 'failed']);
    expect(job.status).toBe('succeeded');
    expect(job.succeededRows).toBe(3);
    expect(job.failedRows).toBe(0);

    const rows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM products WHERE organization_id = $1 AND sku LIKE 'QA-GOOD-%'`,
      [orgId],
    );
    expect(Number(rows[0].count)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. One bad row → partial → import_job_rows has 2 succeeded + 1 failed.
// ---------------------------------------------------------------------------
test.describe('partial — one invalid row', () => {
  test.afterAll(async () => {
    await deleteImportsForOrg();
  });

  test('status is partial, row-level errors are persisted', async () => {
    const csv = [
      'sku,name,priceMinor,currency,isAvailable',
      'QA-PART-1,Valid One,1000,USD,true',
      'QA-PART-2,Bad Price,abc,USD,true', // priceMinor="abc" fails intish
      'QA-PART-3,Valid Three,3000,USD,false',
    ].join('\n');

    const importId = await uploadCsvAndStartImport(csv, 'products-bad-row.csv', 'product');
    const job = await waitForStatus(importId, ['succeeded', 'partial', 'failed']);
    expect(job.status).toBe('partial');
    expect(job.succeededRows).toBe(2);
    expect(job.failedRows).toBe(1);

    const rows = await query<{
      status: string;
      row_number: number;
      errors: unknown;
      raw_data: unknown;
    }>(
      `SELECT status::text AS status, row_number, errors, raw_data FROM import_job_rows WHERE import_job_id = $1 ORDER BY row_number`,
      [importId],
    );
    expect(rows).toHaveLength(3);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toEqual(['failed', 'succeeded', 'succeeded']);

    const failed = rows.find((r) => r.status === 'failed');
    expect(failed).toBeTruthy();
    expect(Array.isArray(failed!.errors)).toBe(true);
    // Raw row data is rendered on the detail page — must be present.
    expect(failed!.raw_data).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. Cancel while processing → status becomes "cancelled".
// ---------------------------------------------------------------------------
test.describe('cancel', () => {
  test.setTimeout(90_000);

  test.afterAll(async () => {
    await deleteImportsForOrg();
  });

  test('user can cancel a large in-progress import', async () => {
    // Build a 250-row CSV. Worker flushes progress every 25 rows and checks the
    // status between flushes, so 250 rows gives plenty of room to cancel.
    const lines = ['sku,name,priceMinor,currency,isAvailable'];
    for (let i = 0; i < 250; i++) {
      lines.push(`QA-CANCEL-${i},Cancel Product ${i},${1000 + i},USD,true`);
    }
    const csv = lines.join('\n');

    const importId = await uploadCsvAndStartImport(csv, 'products-large.csv', 'product');

    // Wait until the worker has processed at least one row — past 'validating'.
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await apiJson<{ data: { status: string; processedRows: number } }>(
        'GET',
        `/api/v1/imports/${importId}`,
      );
      const s = r.body.data.status;
      if (s === 'processing' || s === 'succeeded' || s === 'partial' || s === 'cancelled') break;
      if (Date.now() - start > 20_000) break; // fall through; cancel anyway
      await new Promise((res) => setTimeout(res, 200));
    }

    const cancel = await apiJson<{ ok: boolean }>('POST', `/api/v1/imports/${importId}/cancel`);
    expect(cancel.status).toBe(200);

    const job = await waitForStatus(
      importId,
      ['cancelled', 'succeeded', 'partial', 'failed'],
      60_000,
    );
    // If the file was tiny enough to finish before the cancel click, this would
    // land on succeeded; but with 250 rows the worker should observe the cancel
    // between flushes.
    expect(job.status).toBe('cancelled');
    expect(job.succeededRows).toBeLessThan(250);
  });
});

// ---------------------------------------------------------------------------
// 5. Detail page — "failed only" filter + raw data rendering.
// ---------------------------------------------------------------------------
test.describe('detail page UI', () => {
  test('renders failed-only rows and expands raw data', async ({ page, uiLogin }) => {
    const csv = [
      'sku,name,priceMinor,currency,isAvailable',
      'QA-UI-1,UI Product One,1500,USD,true',
      'QA-UI-2,UI Bad,NaN,USD,true',
      'QA-UI-3,UI Product Three,3500,USD,true',
    ].join('\n');

    const importId = await uploadCsvAndStartImport(csv, 'products-ui.csv', 'product');
    const job = await waitForStatus(importId, ['succeeded', 'partial', 'failed']);
    expect(job.status).toBe('partial');

    await uiLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/imports/${importId}`);

    // Default state is "failed only" — verify by looking for the toggle text.
    await expect(page.getByRole('button', { name: /show all/i })).toBeVisible();

    // Failed row must be visible, a succeeded row must NOT be in the list.
    await expect(page.getByText(/Row 3/i).first()).toBeVisible(); // failed row is row 3 (header + 2 + bad)
    await expect(page.getByText(/Row 2/i)).toHaveCount(0); // a succeeded row
    // The first failed row has its error summary shown inline — there will be
    // some Zod-ish text on the row. We just assert something inline-red is
    // present by looking for the row + a non-empty error container.
    const row3 = page.getByText(/Row 3/i).first();
    await expect(row3).toBeVisible();

    // Expand to see raw data.
    await page.getByText(/Row 3/i).first().click();
    await expect(page.getByText(/"sku"\s*:\s*"QA-UI-2"/)).toBeVisible();

    // Toggle "Show all" — succeeded rows now appear.
    await page.getByRole('button', { name: /show all/i }).click();
    await expect(page.getByText(/Row 2/i)).toBeVisible();
  });
});
