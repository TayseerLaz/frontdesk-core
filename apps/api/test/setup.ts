// Vitest setup. Runs once per test file.
//
// We use a real Postgres + Redis (from docker-compose). Each test file gets a
// fresh transaction-scoped state by truncating the org-scoped tables before
// each test. Avoids the slowness of full migration resets.
import { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { buildServer } from '../src/server.js';

let app: Awaited<ReturnType<typeof buildServer>> | null = null;
const prisma = new PrismaClient();

export function getApp() {
  if (!app) throw new Error('App not built. Did you call setupTestApp()?');
  return app;
}

export async function setupTestApp() {
  if (!app) {
    app = await buildServer();
    await app.ready();
  }
  return app;
}

beforeAll(async () => {
  await setupTestApp();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Truncate all tenant-scoped tables. Cheap and keeps tests independent.
  await prisma.$executeRawUnsafe(`SET app.bypass_rls = 'on'`);
  await prisma.$executeRawUnsafe(
    `TRUNCATE
       phone_tasks,
       whatsapp_messages, whatsapp_channels,
       webhook_deliveries, webhook_endpoints,
       sync_runs, api_connectors,
       import_job_rows, import_jobs,
       product_images, product_variants, products,
       service_pricing_tiers, availability_windows, services,
       contact_channels, locations, business_info,
       policies, faqs, categories,
       assets,
       sales_scan_summaries, sales_messages, sales_scan_grants,
       catalog_revisions, notifications,
       audit_logs,
       sessions, invitations, api_keys, memberships,
       users, organizations
     RESTART IDENTITY CASCADE`,
  );

  // Sprint 4 — Redis-backed rate limits use the `platform-rl:` namespace and
  // are KEY/EXPIRE-based, so state survives Postgres truncation. Wipe it
  // here so tests that hit per-route rate-limited endpoints (eg the
  // `5/hour` cap on `/account/export`) don't pollute each other.
  try {
    const { getRedis } = await import('../src/lib/redis.js');
    const redis = getRedis();
    const keys = await redis.keys('platform-rl:*');
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Redis not reachable in this test profile — harmless.
  }
});

export { prisma };
