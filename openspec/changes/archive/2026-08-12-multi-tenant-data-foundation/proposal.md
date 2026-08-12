# Proposal: Multi-Tenant Data Foundation

## Intent

Greenfield multi-tenant platform for gastos comunes (condo fees). No code exists yet. This change establishes the persistent tenant model (condominiums → buildings → units) and role-scoped users, plus the minimal server scaffold required to run migrations. Every future capability (auth, billing, API) depends on this foundation; deferring it blocks all vertical slices.

## Scope

### In Scope
- Knex migrations 001–004: condominiums, buildings, units, users (UUID PKs, FKs, indexes, timestamps)
- RBAC jurisdiction CHECK on `users` (superadmin > condo_admin > building_admin > resident)
- Soft delete (`deleted_at`, nullable) on all 4 tables
- Seed: root superadmin (all jurisdiction FKs NULL, provisional credentials, rotation on first login)
- Server scaffold: `package.json`, `tsconfig.json`, `server/db/knexfile.ts`, `server/db/connection.ts`

### Out of Scope
- Auth/JWT, routes, controllers, services, repositories (beyond scaffold), middlewares
- client-web, client-mobile
- Payments, expenses, tenant-isolation middleware, DB triggers, binary UUIDs

## Capabilities

### New Capabilities
- `tenant-data-model`: schema for condominiums/buildings/units/users, FKs, RBAC CHECK, soft delete, superadmin seed
- `server-scaffold`: knex config (better-sqlite3), db connection, migration tooling

### Modified Capabilities
None — greenfield, no existing specs.

## Approach

Pure Knex Schema Builder (exploration #155). UUID v4 generated in repositories; `table.check()` for role+jurisdiction; better-sqlite3 enforces FKs natively (no PRAGMA). Migration order follows FK chain (001→004); indexes on FK columns + `role`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `server/db/knexfile.ts` | New | Knex config: better-sqlite3, pool max 1, migrations dir |
| `server/db/connection.ts` | New | DB connection |
| `server/db/migrations/001_condominiums.ts` … `004_users.ts` | New | Schema DDL |
| `package.json`, `tsconfig.json` | New | Deps: knex, better-sqlite3, uuid, @types/uuid |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `table.check()` multi-condition unsupported | Med | Fallback to `knex.raw()` |
| SQLite ALTER TABLE limits for future changes | Med | Design schema now; table-recreation pattern |
| No test runner — migration errors surface at runtime | Med | Migration smoke test in verify |
| Provisional superadmin credentials in seed | Med | Force rotation on first login (future auth) |

## Rollback Plan

Greenfield: no production data. `knex migrate:rollback` (all `down()` implemented) or delete `dev.sqlite3` and re-run `migrate:latest`. Migrations run in a transaction; SQLite single-writer prevents partial-state races.

## Dependencies

- npm: `knex`, `better-sqlite3`, `uuid`, `@types/uuid`
- SQLite single-writer model (pool max 1)

## Success Criteria

- [ ] `knex migrate:latest` runs clean against empty SQLite file
- [ ] FKs + CHECK enforced: invalid role/jurisdiction inserts throw `SQLITE_CONSTRAINT`
- [ ] Superadmin seed present with all jurisdiction FKs NULL
- [ ] `deleted_at` present on all 4 tables
- [ ] `knex migrate:rollback` returns DB to empty state
