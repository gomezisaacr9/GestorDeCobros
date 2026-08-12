# Delta for server-scaffold

New capability — greenfield. Full spec to be created in `openspec/specs/server-scaffold/spec.md` on archive.

## ADDED Requirements

### Requirement: Dependency Manifest

The server MUST declare in `package.json` the runtime dependencies `knex`, `better-sqlite3`, and `uuid`; and dev dependencies `typescript`, `tsx` (or equivalent runner), and `@types/uuid`. It MUST define scripts `migrate:latest` and `migrate:rollback`.

#### Scenario: Install resolves

- GIVEN a clean `package.json` with the declared dependencies
- WHEN `npm install` runs
- THEN install completes without peer/engine errors

#### Scenario: Migration scripts are callable

- GIVEN installed dependencies
- WHEN `npm run migrate:latest` is invoked
- THEN the knex CLI runs against the configured migration directory

### Requirement: TypeScript Configuration

The server MUST ship a `tsconfig.json` that compiles TypeScript in `server/` with strict mode enabled.

#### Scenario: Type-check passes

- GIVEN scaffold files present
- WHEN the TypeScript compiler runs over `server/`
- THEN compilation succeeds with no type errors

### Requirement: Knex Configuration

The system MUST provide `server/db/knexfile.ts` configuring the `development` environment with: client `better-sqlite3`, SQLite file connection, `useNullAsDefault: true`, migrations directory `./server/db/migrations` with `ts` extension, and pool `min: 1, max: 1`.

#### Scenario: Config loads development environment

- GIVEN `knexfile.ts` exists
- WHEN the knex CLI resolves the `development` config
- THEN client is `better-sqlite3` and pool max is 1

### Requirement: SQLite Single-Writer Model

The system MUST constrain the connection pool to a single writer (`max: 1`) because SQLite is single-writer, preventing partial-state races.

#### Scenario: Pool does not exceed one connection

- GIVEN the knex connection is created from the config
- WHEN inspecting pool settings
- THEN `min` and `max` are both 1

### Requirement: Database Connection

The system MUST provide `server/db/connection.ts` exporting a Knex instance built from the `development` config.

#### Scenario: Connection answers

- GIVEN the exported connection
- WHEN executing `select 1`
- THEN the query resolves successfully

### Requirement: Transactional Migrations

Each migration MUST run inside a transaction; if a migration fails mid-way, the database MUST roll back to the pre-migration state rather than leaving partial schema.

#### Scenario: Failed migration leaves no partial state

- GIVEN a migration that fails after creating a table
- WHEN `migrate:latest` runs and the failure occurs
- THEN the partially created table is not present afterwards

#### Scenario: Successful run applies cleanly

- GIVEN an empty SQLite file
- WHEN `migrate:latest` runs
- THEN the command exits successfully and all migrations are recorded in the migration log
