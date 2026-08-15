import path from 'node:path';
import type { Knex } from 'knex';

const sharedConfig: Knex.Config = {
  client: 'better-sqlite3',
  useNullAsDefault: true,
  migrations: {
    directory: path.resolve(__dirname, 'migrations'),
    extension: 'ts',
  },
  pool: { min: 1, max: 1 },
};

const config: Record<string, Knex.Config> = {
  development: {
    ...sharedConfig,
    connection: {
      // Resolved from this file, not CWD: the knex CLI (Liftoff) chdirs into
      // server/db when loading the knexfile, which would break a CWD-relative
      // path. __dirname keeps CLI runs and server/db/connection.ts on the same file.
      // Tests override via SQLITE_PATH (test/setup.ts) → temp DB per process.
      filename: process.env.SQLITE_PATH ?? path.resolve(__dirname, '../dev.sqlite3'),
    },
  },
  test: {
    ...sharedConfig,
    connection: {
      filename: process.env.SQLITE_PATH ?? ':memory:',
    },
  },
  production: {
    ...sharedConfig,
    connection: {
      filename: process.env.SQLITE_PATH ?? path.resolve(__dirname, '../prod.sqlite3'),
    },
  },
};

export default config;
