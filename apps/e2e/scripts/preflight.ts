import { request } from 'undici';
import { env } from '../tests/helpers/env';
import { query, closePool } from '../tests/helpers/db';

type Check = { name: string; ok: boolean; detail: string };

async function pingUrl(url: string, label: string): Promise<Check> {
  try {
    const res = await request(url);
    await res.body.dump();
    return { name: label, ok: res.statusCode < 500, detail: `${url} → ${res.statusCode}` };
  } catch (err) {
    return { name: label, ok: false, detail: `${url} → ${(err as Error).message}` };
  }
}

async function main(): Promise<void> {
  const results: Check[] = [];

  results.push(await pingUrl(`${env.API_URL}/health`, 'api /health'));
  results.push(await pingUrl(env.WEB_URL, 'web /'));
  results.push(await pingUrl(`${env.MAILPIT_URL}/api/v1/info`, 'mailpit'));

  try {
    const rows = await query<{ email: string }>(`SELECT email FROM users WHERE email = $1`, [env.SEED_ADMIN_EMAIL]);
    results.push({
      name: 'postgres + seed admin',
      ok: rows.length === 1,
      detail: rows.length === 1 ? `found ${rows[0].email}` : `seed admin ${env.SEED_ADMIN_EMAIL} NOT FOUND — run pnpm db:seed`,
    });
  } catch (err) {
    results.push({ name: 'postgres + seed admin', ok: false, detail: (err as Error).message });
  }

  try {
    const wasabiCheck = await request(`${env.API_URL}/api/v1/storage/health`);
    await wasabiCheck.body.dump();
    results.push({
      name: 'api Wasabi config',
      ok: wasabiCheck.statusCode < 500,
      detail: `→ ${wasabiCheck.statusCode} (non-blocking — tests assert at upload time)`,
    });
  } catch {
    results.push({ name: 'api Wasabi config', ok: true, detail: 'no /storage/health route (non-blocking)' });
  }

  await closePool();

  const pad = (s: string, n: number) => s.padEnd(n);
  const ok = results.every((r) => r.ok);
  console.log('\n=== Preflight ===');
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✘'}  ${pad(r.name, 24)} ${r.detail}`);
  }
  console.log(ok ? '\nStack looks healthy.\n' : '\nStack is NOT ready. Fix the ✘ rows above.\n');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
