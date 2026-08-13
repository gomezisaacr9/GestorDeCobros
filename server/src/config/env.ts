import dotenv from 'dotenv';

dotenv.config();

/**
 * Fail-fast environment bootstrap. `index.ts` must import this module FIRST:
 * a missing/empty JWT_SECRET throws here, before `app.listen` — the process
 * exits non-zero rather than serving with a derived or default secret.
 */
function assertEnv(): { JWT_SECRET: string; NODE_ENV: string; PORT: number } {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.trim() === '') {
    throw new Error('JWT_SECRET is required — set it in .env (fail-fast, no default).');
  }
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const portRaw = process.env.PORT ?? '3000';
  const port = Number.parseInt(portRaw, 10);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got "${process.env.PORT}".`);
  }
  return { JWT_SECRET: jwtSecret, NODE_ENV: nodeEnv, PORT: port };
}

export const env = assertEnv();