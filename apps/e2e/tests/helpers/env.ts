import 'node:process';

export const env = {
  WEB_URL: process.env.E2E_WEB_URL ?? 'http://localhost:3000',
  API_URL: process.env.E2E_API_URL ?? 'http://localhost:4000',
  DATABASE_URL:
    process.env.E2E_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://aligned:aligned@localhost:5432/aligned',
  MAILPIT_URL: process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025',
  SEED_ADMIN_EMAIL: process.env.E2E_SEED_ADMIN_EMAIL ?? 'admin@aligned.local',
  SEED_ADMIN_PASSWORD: process.env.E2E_SEED_ADMIN_PASSWORD ?? 'Aligned123!',
  SEED_ORG_SLUG: process.env.E2E_SEED_ORG_SLUG ?? 'demo',
};

export function uniqueEmail(label = 'qa'): string {
  const n = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${label}+${n}@aligned.local`;
}

export function uniqueSlug(prefix = 'qa'): string {
  const raw = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
