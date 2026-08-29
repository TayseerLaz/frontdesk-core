import { defineConfig } from 'vitest/config';

/**
 * Pure-logic test config: NO global setup, NO database, NO environment.
 *
 * vitest.config.ts applies test/setup.ts as a global setupFile, and that file imports the
 * server -> env.ts -> process.exit(1) when a variable is missing. The consequence is that
 * the ordinary suite cannot be run on a developer machine at all, so test files were only
 * ever executed in CI. Together with tsconfig.json excluding test/ from tsc, that meant a
 * test file could be syntactically broken, pass `pnpm typecheck` locally, and only fail
 * after a push — which is exactly what happened on 2026-08-03.
 *
 * Anything matched here must import only modules that touch neither env nor the database.
 * If a test added to this pattern starts failing with a process exit, that is the signal
 * that a dependency has leaked into the pure layer — fix the import, do not move the test.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: [],
    include: ['test/pure/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
