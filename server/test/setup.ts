import os from 'node:os';
import path from 'node:path';

/**
 * Test bootstrap — runs BEFORE any test module import (vitest setupFiles).
 * Pins the env so that:
 * - `server/db/knexfile.ts` resolves SQLITE_PATH to a per-process temp DB
 *   (pool:'forks' ⇒ one process per spec file ⇒ isolated DB per file; the
 *   real `server/dev.sqlite3` is never touched, so migration 006 rollback
 *   can never destroy the seeded dev superadmin).
 * - `server/src/config/env.ts` fail-fast finds JWT_SECRET set (needed by
 *   auth.service signToken used in helpers/http.ts).
 */
process.env.SQLITE_PATH = path.join(os.tmpdir(), `gp-test-${process.pid}.sqlite3`);
process.env.JWT_SECRET = 'test-secret-not-for-production-0123456789abcdef';
