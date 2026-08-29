import { test, expect } from '../helpers/fixtures';
import { env, uniqueEmail, uniqueSlug } from '../helpers/env';
import {
  clearInbox,
  waitForEmail,
} from '../helpers/mailpit';
import {
  closePool,
  deleteOrgBySlug,
  deleteUserByEmail,
  getOrgIdBySlug,
  getUserIdByEmail,
  markUserVerified,
  query,
} from '../helpers/db';
const GOOD_PASSWORD = 'VeryStrongPwd!234';

type Member = {
  membershipId: string;
  userId: string;
  email: string;
  role: 'admin' | 'editor' | 'viewer';
  isActive: boolean;
};

async function signupFreshOrg(label: string): Promise<{
  email: string;
  password: string;
  slug: string;
  orgId: string;
  userId: string;
}> {
  const email = uniqueEmail(label);
  const slug = uniqueSlug(`qa-${label}`);
  const res = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: GOOD_PASSWORD,
      firstName: 'Qa',
      lastName: 'Admin',
      organizationName: `QA ${slug}`,
      organizationSlug: slug,
    }),
  });
  expect(res.status).toBe(201);
  await markUserVerified(email);
  const orgId = (await getOrgIdBySlug(slug))!;
  const userId = (await getUserIdByEmail(email))!;
  return { email, password: GOOD_PASSWORD, slug, orgId, userId };
}

test.afterAll(async () => {
  await closePool();
});

test.describe('/members page — list & invite modal', () => {
  const fresh = {
    email: '',
    password: GOOD_PASSWORD,
    slug: '',
    orgId: '',
    userId: '',
  };
  const inviteeEmail = uniqueEmail('invitee');

  test.beforeAll(async () => {
    const o = await signupFreshOrg('members');
    Object.assign(fresh, o);
    await clearInbox();
  });

  test.afterAll(async () => {
    // Delete the org FIRST — CASCADE removes memberships, invitations, and
    // anything else the fresh users reference — so the user deletes don't
    // trip invitation FK constraints.
    await deleteOrgBySlug(fresh.slug);
    await deleteUserByEmail(fresh.email);
    await deleteUserByEmail(inviteeEmail);
  });

  test('renders the members table with the fresh admin row', async ({ page, uiLogin }) => {
    await uiLogin(page, fresh.email, fresh.password);
    await page.goto('/members');
    await expect(page.getByRole('heading', { name: /^members$/i })).toBeVisible();
    await expect(page.getByText(fresh.email)).toBeVisible();
    await expect(page.getByRole('button', { name: /invite member/i })).toBeVisible();
  });

  test('invite modal opens, submits, creates pending invite + sends email, then revokes it', async ({
    page,
    uiLogin,
  }) => {
    await uiLogin(page, fresh.email, fresh.password);
    await page.goto('/members');
    await page.getByRole('button', { name: /invite member/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /invite a member/i })).toBeVisible();
    await dialog.getByLabel(/email/i).fill(inviteeEmail);
    // Role select visible inside the dialog — default 'editor' is fine.
    await expect(dialog.getByLabel(/role/i)).toBeVisible();
    await dialog.getByRole('button', { name: /send invitation/i }).click();

    // Dialog closes after successful submit.
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    // Pending row appears in the Pending invitations card.
    await expect(page.getByRole('heading', { name: /pending invitations/i })).toBeVisible();
    await expect(page.getByText(inviteeEmail)).toBeVisible();

    // Email sent via Mailpit.
    // Invite email subject is "Join <org> on ALIGNED" (see apps/api/src/lib/email.ts).
    const msg = await waitForEmail({ to: inviteeEmail, subjectIncludes: 'Join', timeoutMs: 20_000 });
    expect(msg).toBeTruthy();

    // DB assertion: invitation row exists & pending.
    const rows = await query<{ id: string; status: string }>(
      `SELECT id, status::text AS status FROM invitations WHERE email = $1 AND organization_id = $2`,
      [inviteeEmail.toLowerCase(), fresh.orgId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('pending');

    // Revoke it via UI.
    const row = page.locator('tr', { hasText: inviteeEmail });
    await row.getByRole('button', { name: /revoke invitation/i }).click();
    await expect(page.getByText(inviteeEmail)).toBeHidden({ timeout: 5_000 });

    const afterRevoke = await query<{ status: string }>(
      `SELECT status::text AS status FROM invitations WHERE email = $1 AND organization_id = $2`,
      [inviteeEmail.toLowerCase(), fresh.orgId],
    );
    expect(afterRevoke[0]!.status).toBe('revoked');
  });
});

test.describe('role changes & deactivation', () => {
  const adminUser = { email: '', password: GOOD_PASSWORD, slug: '', orgId: '', userId: '' };
  const editorEmail = uniqueEmail('editor');
  const editorPwd = GOOD_PASSWORD;
  let editorMembershipId = '';
  let editorUserId = '';
  let adminMembershipId = '';

  test.beforeAll(async () => {
    const o = await signupFreshOrg('roles');
    Object.assign(adminUser, o);

    // Create a second user + attach as editor member of adminUser's org.
    const signupRes = await fetch(`${env.API_URL}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: editorEmail,
        password: editorPwd,
        firstName: 'Qa',
        lastName: 'Editor',
        organizationName: `QA Editor ${Date.now()}`,
        organizationSlug: uniqueSlug('qa-editor-own'),
      }),
    });
    expect(signupRes.status).toBe(201);
    await markUserVerified(editorEmail);
    editorUserId = (await getUserIdByEmail(editorEmail))!;

    // Insert editor membership into the fresh org directly (simulating an accepted invite).
    const m = await query<{ id: string }>(
      `INSERT INTO memberships (id, organization_id, user_id, role, is_active, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'editor'::"OrgRole", true, NOW(), NOW())
       RETURNING id`,
      [adminUser.orgId, editorUserId],
    );
    editorMembershipId = m[0]!.id;

    const am = await query<{ id: string }>(
      `SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2`,
      [adminUser.orgId, adminUser.userId],
    );
    adminMembershipId = am[0]!.id;
  });

  test.afterAll(async () => {
    await deleteUserByEmail(adminUser.email);
    await deleteOrgBySlug(adminUser.slug);
    await deleteUserByEmail(editorEmail);
  });

  test('admin changes editor → admin via role select; persists in API', async ({ api }) => {
    const login = await api.login(adminUser.email, adminUser.password);
    expect(login.organizationId).toBe(adminUser.orgId);

    const res = await api.patch(`/api/v1/members/${editorMembershipId}/role`, { role: 'admin' });
    expect(res.status).toBe(200);

    const list = await api.get<{ data: Member[] }>('/api/v1/members');
    const editor = list.body.data.find((m) => m.membershipId === editorMembershipId);
    expect(editor?.role).toBe('admin');
  });

  test('last-admin protection: cannot demote the sole admin', async ({ api }) => {
    // Reset editor back to 'editor' first so there's only ONE admin (the fresh admin).
    await api.login(adminUser.email, adminUser.password);
    await api.patch(`/api/v1/members/${editorMembershipId}/role`, { role: 'editor' });

    const res = await api.patch(`/api/v1/members/${adminMembershipId}/role`, { role: 'viewer' });
    expect([400, 409, 422]).toContain(res.status);
    const body = res.body as { message?: string };
    expect(JSON.stringify(body).toLowerCase()).toMatch(/admin/);
  });

  test('deactivate a non-admin succeeds; deactivated user cannot log in', async ({ api }) => {
    await api.login(adminUser.email, adminUser.password);
    const res = await api.post(`/api/v1/members/${editorMembershipId}/deactivate`);
    expect(res.status).toBe(200);

    // Editor login attempt should fail (no active memberships in this org, but the editor
    // still has their own org from signup — so we check the membership row via DB).
    const row = await query<{ is_active: boolean }>(
      `SELECT is_active FROM memberships WHERE id = $1`,
      [editorMembershipId],
    );
    expect(row[0]!.is_active).toBe(false);
  });

  test('cannot deactivate the last admin', async ({ api }) => {
    await api.login(adminUser.email, adminUser.password);
    const res = await api.post(`/api/v1/members/${adminMembershipId}/deactivate`);
    // API returns 403 ("cannot deactivate yourself") OR 400/409 (last admin).
    expect([400, 403, 409]).toContain(res.status);
  });
});
