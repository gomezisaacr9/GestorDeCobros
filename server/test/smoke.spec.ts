import { describe, expect, it } from 'vitest';

describe('vitest runner', () => {
  it('boots the suite with the per-process temp-DB harness configured', () => {
    // setup.ts must run BEFORE this module resolves (setupFiles), pinning the
    // env so knex/connection and auth.service read test values, never dev.sqlite3.
    expect(process.env.SQLITE_PATH).toContain('gp-test-');
    expect(process.env.JWT_SECRET).toMatch(/^test-secret/);
  });
});