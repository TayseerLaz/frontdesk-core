// Ops gate (no DB): every OPT-IN feature — one listed in
// ORG_FEATURE_DEFAULT_DISABLED — MUST ship a migration that backfills its key
// into existing orgs' `disabled_features`. New orgs get the key at creation
// time (ORG_FEATURE_DEFAULT_DISABLED is applied then), but EXISTING orgs only
// get it if a migration appends it. Forgetting that backfill is exactly the
// A default-disabled feature key with no backfill leaves every pre-existing
// org lacked the key and the portal mislabeled the whole fleet as a partner
// ("Properties" everywhere). This test fails the build if any default-disabled
// feature lacks its backfill, so that mistake can never merge again.
//
// Pure filesystem scan — no Postgres needed. It asserts the backfill EXISTS;
// the fail-closed org.sourceSystem gate (see Organization.sourceSystem) is the
// second line of defence that keeps a missing backfill from ever failing open.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORG_FEATURE_DEFAULT_DISABLED } from '@platform/shared';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations', import.meta.url),
);

/** Concatenated SQL of every migration in the repo. */
function allMigrationSql(): string {
  const parts: string[] = [];
  for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      parts.push(readFileSync(join(MIGRATIONS_DIR, entry.name, 'migration.sql'), 'utf8'));
    } catch {
      // A migration dir without a migration.sql (e.g. a lock/journal dir) — skip.
    }
  }
  return parts.join('\n');
}

/**
 * True if some migration appends `key` to disabled_features. Tolerant of the
 * column being quoted or not and of arbitrary whitespace, e.g. both:
 *   array_append("disabled_features", 'shopify')
 *   array_append(disabled_features, '<feature_key>')
 */
function hasBackfill(sql: string, key: string): boolean {
  const re = new RegExp(
    String.raw`array_append\s*\(\s*"?disabled_features"?\s*,\s*'${key}'\s*\)`,
    'i',
  );
  return re.test(sql);
}

describe('opt-in feature backfill invariant', () => {
  it('every default-disabled feature has a disabled_features backfill migration', () => {
    const sql = allMigrationSql();
    // Sanity: migrations actually loaded (guards a wrong path silently passing).
    expect(sql.length).toBeGreaterThan(1000);

    const missing = ORG_FEATURE_DEFAULT_DISABLED.filter((key) => !hasBackfill(sql, key));

    expect(
      missing,
      `These opt-in (default-disabled) features are missing a migration that ` +
        `backfills existing orgs' disabled_features:\n  ${missing.join('\n  ')}\n` +
        `Add a migration with:  UPDATE "organizations" SET "disabled_features" = ` +
        `array_append("disabled_features", '<key>') WHERE NOT ('<key>' = ANY("disabled_features"));`,
    ).toEqual([]);
  });
});
