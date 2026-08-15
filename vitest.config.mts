import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the server test suite (server/test/**).
 * - `pool: 'forks'` ⇒ every spec file runs in its own forked process, giving
 *   each file its own `process.pid` and therefore its own temp SQLite DB
 *   (setup.ts pins SQLITE_PATH to tmpdir/gp-test-<pid>.sqlite3).
 * - setupFiles run before any test module import, so env (SQLITE_PATH,
 *   JWT_SECRET) is pinned before knex/connection and auth.service resolve.
 */
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    setupFiles: ['server/test/setup.ts'],
    include: ['server/test/**/*.spec.ts'],
  },
});
