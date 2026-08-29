import pg from 'pg';
import { env } from './env';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, values as any);
  return res.rows;
}

export async function getOrgIdBySlug(slug: string): Promise<string | null> {
  const rows = await query<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [slug]);
  return rows[0]?.id ?? null;
}

export async function getUserIdByEmail(email: string): Promise<string | null> {
  const rows = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
  return rows[0]?.id ?? null;
}

export async function markUserVerified(email: string): Promise<void> {
  await query(
    `UPDATE users SET email_verified_at = NOW(), status = 'active'::"UserStatus" WHERE email = $1`,
    [email.toLowerCase()],
  );
}

export async function userStatus(email: string): Promise<string | null> {
  const rows = await query<{ status: string }>(`SELECT status::text AS status FROM users WHERE email = $1`, [
    email.toLowerCase(),
  ]);
  return rows[0]?.status ?? null;
}

export async function failedLoginAttempts(email: string): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT failed_login_attempts AS n FROM users WHERE email = $1`,
    [email.toLowerCase()],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function latestInvitationToken(email: string): Promise<string | null> {
  const rows = await query<{ token: string }>(
    `SELECT token FROM invitations WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
    [email.toLowerCase()],
  );
  return rows[0]?.token ?? null;
}

export async function deleteOrgBySlug(slug: string): Promise<void> {
  await query(`DELETE FROM organizations WHERE slug = $1`, [slug]);
}

export async function deleteUserByEmail(email: string): Promise<void> {
  await query(`DELETE FROM users WHERE email = $1`, [email.toLowerCase()]);
}

export async function countRowsForOrg(table: string, orgId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "${table}" WHERE organization_id = $1`,
    [orgId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function listApiKeysForOrg(orgId: string): Promise<Array<{ id: string; name: string }>> {
  return await query<{ id: string; name: string }>(
    `SELECT id, name FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC`,
    [orgId],
  );
}

/** Full tenant teardown — deletes the org and everything owned by it via CASCADE. */
export async function deleteOrgCascade(slug: string): Promise<void> {
  await query(`DELETE FROM organizations WHERE slug = $1`, [slug]);
}
