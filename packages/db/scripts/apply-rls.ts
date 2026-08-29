// Applies prisma/rls.sql against DIRECT_DATABASE_URL after Prisma migrations.
// Idempotent — safe to run on every deploy.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(here, '..', 'prisma', 'rls.sql');

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_DATABASE_URL (or DATABASE_URL) must be set to apply RLS.');
  process.exit(1);
}

const sql = await readFile(sqlPath, 'utf8');

const { Client } = await import('pg');
const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query(sql);
  console.warn('[rls] applied prisma/rls.sql');
} finally {
  await client.end();
}
