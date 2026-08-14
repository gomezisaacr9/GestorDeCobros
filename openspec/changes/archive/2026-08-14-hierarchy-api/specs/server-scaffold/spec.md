# Delta for server-scaffold

## MODIFIED Requirements

### Requirement: Dependency Manifest

The server MUST declare in `package.json` the runtime dependencies `knex`, `better-sqlite3`, and `uuid`; and dev dependencies `typescript`, `tsx` (or equivalent runner), `@types/uuid`, and `vitest`. It MUST define scripts `migrate:latest`, `migrate:rollback`, and `test` (running `vitest run`); a `test:watch` script MAY also exist.
(Previously: dev deps had no `vitest` and scripts covered only migrations.)

#### Scenario: Install resolves

- GIVEN a clean `package.json` with the declared dependencies
- WHEN `npm install` runs
- THEN install completes without peer/engine errors

#### Scenario: Migration scripts are callable

- GIVEN installed dependencies
- WHEN `npm run migrate:latest` is invoked
- THEN the knex CLI runs against the configured migration directory

#### Scenario: Test script runs the suite

- GIVEN vitest installed and specs present under `server/test`
- WHEN `npm run test` executes
- THEN vitest runs the suite and reports a pass/fail result
