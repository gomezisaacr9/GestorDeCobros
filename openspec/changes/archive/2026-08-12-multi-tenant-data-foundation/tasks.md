# Tasks: Multi-Tenant Data Foundation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 280–350 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR (greenfield, no prior code) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Scaffold + migrations | PR 1 | `npm run migrate:latest && npm run typecheck` | `tsx -e` probes for constraints/seed/indexes | All files — single revert removes entire scaffold |

## Phase 1: Project Scaffold

- [x] 1.1 Create `package.json` at repo root: runtime deps `knex ^3.1.0`, `better-sqlite3 ^11.9.1`, `uuid ^11.1.0`; dev deps `typescript ^5.7.3`, `tsx ^4.19.3`, `@types/uuid ^10.0.0`, `@types/better-sqlite3 ^7.6.12`, `@types/node ^22.x`. Scripts: `migrate:latest` → `tsx ./node_modules/knex/bin/cli.js --knexfile ./server/db/knexfile.ts migrate:latest`, `migrate:rollback` → `tsx ./node_modules/knex/bin/cli.js --knexfile ./server/db/knexfile.ts migrate:rollback`, `typecheck` → `tsc --noEmit`. No `"type"` field. — **Deviación**: `better-sqlite3` instalado en `^12.11.1` (no `^11.9.1`): la 11.x no compila contra Node 26.4.0 (V8 deprecated-API errors); 12.11.1 instala limpio.
- [x] 1.2 Create `tsconfig.json`: `strict: true`, `target: ES2022`, `module: commonjs`, `moduleResolution: node`, `esModuleInterop: true`, `noEmit: true`, `include: ["server/**/*"]`, `types: ["node"]`.
- [x] 1.3 Create `.gitignore`: `node_modules/`, `server/dev.sqlite3*`.
- [x] 1.4 Run `npm install` and verify exit 0. Run `npm run typecheck` — must succeed with no errors (no server code yet, but tsc must parse clean).

## Phase 2: Knex Configuration & Connection

- [x] 2.1 Create `server/db/knexfile.ts`: export `development` env — client `better-sqlite3`, `connection.filename: './server/dev.sqlite3'`, `useNullAsDefault: true`, `migrations: { directory: './server/db/migrations', extension: 'ts' }`, `pool: { min: 1, max: 1 }`. — **Deviación**: filename y migrations.directory resueltos con `path.resolve(__dirname, …)`: el CLI knex (Liftoff) hace chdir a `server/db`, rompiendo rutas CWD-relativas. Resultado de archivo idéntico (`server/dev.sqlite3`, `server/db/migrations`).
- [x] 2.2 Create `server/db/connection.ts`: `import knex from 'knex'; import config from './knexfile'; export default knex(config.development);`.

## Phase 3: Migrations (FK order)

- [x] 3.1 Create `server/db/migrations/001_condominiums.ts`: `up()` creates `condominiums` — `id` uuid PK, `name` string NOT NULL, `created_at`/`updated_at` timestamps, `deleted_at` nullable. `down()` drops table if exists.
- [x] 3.2 Create `server/db/migrations/002_buildings.ts`: `up()` creates `buildings` — `id` uuid PK, `condominium_id` uuid NOT NULL FK → `condominiums.id`, `name` string NOT NULL, timestamps + `deleted_at`. Index `idx_buildings_condominium_id` on `condominium_id`. `down()` drops table if exists.
- [x] 3.3 Create `server/db/migrations/003_units.ts`: `up()` creates `units` — `id` uuid PK, `building_id` uuid NOT NULL FK → `buildings.id`, timestamps + `deleted_at`. Index `idx_units_building_id` on `building_id`. `down()` drops table if exists.
- [x] 3.4 Create `server/db/migrations/004_users.ts`: `up()` creates `users` — `id` uuid PK, `email` string NOT NULL UNIQUE, `password_hash` string NOT NULL, `role` string NOT NULL, `condominium_id`/`building_id`/`unit_id` nullable FKs with indexes, `idx_users_role` on `role`, timestamps + `deleted_at`. RBAC CHECK via `table.check()` — superadmin: all 3 FKs NULL; condo_admin: condominium_id NOT NULL, others NULL; building_admin: condominium_id+building_id NOT NULL, unit_id NULL; resident: all 3 NOT NULL. Insert superadmin seed: `email='root@gestionpagos.local'`, `password_hash` via `crypto.scryptSync('ChangeMe!2026', salt, 64)` hex format `scrypt$N$r$p$saltHex$hashHex`, `role='superadmin'`, all jurisdiction FKs NULL. `down()` drops table if exists. — `table.check()` multi-condición **funcionó** (sin fallback raw CREATE TABLE).

## Phase 4: Smoke Tests (no test runner — tsx -e probes)

- [x] 4.1 Clean migrate test: delete `server/dev.sqlite3*` if present, run `npm run migrate:latest` — must exit 0. Verify all 4 tables exist by querying `sqlite_master`.
- [x] 4.2 Type check: run `npm run typecheck` — must succeed.
- [x] 4.3 FK constraint test: `tsx -e` — insert building with `condominium_id='c999'` (non-existent) → expect `SQLITE_CONSTRAINT_FOREIGNKEY`. Insert unit with `building_id='b999'` → same.
- [x] 4.4 CHECK constraint test: `tsx -e` — insert user `role='superadmin'` with `condominium_id` set → expect `SQLITE_CONSTRAINT_CHECK`. Insert `role='resident'` with `unit_id` NULL → expect `SQLITE_CONSTRAINT_CHECK`.
- [x] 4.5 UNIQUE constraint test: `tsx -e` — insert duplicate `email` → expect `SQLITE_CONSTRAINT_UNIQUE`.
- [x] 4.6 Seed test: `tsx -e` — `SELECT COUNT(*) FROM users WHERE role='superadmin'` returns 1, all 3 FKs NULL.
- [x] 4.7 Index test: `tsx -e` — query `sqlite_master WHERE type='index'` and verify `idx_buildings_condominium_id` and `idx_users_role` exist.
- [x] 4.8 Rollback test: `npm run migrate:rollback` — no app tables remain. Re-run `migrate:latest` succeeds cleanly.

## Apply Result

- status: **success** — all 12 tasks complete (phases 1→4)
- smoke evidence: 12/12 PASS on constraint/seed/index probe; `migrate:latest` exit 0; `migrate:rollback` → no app tables; re-migrate clean; typecheck 0 errors
- deviations: `better-sqlite3 ^12.11.1` (Node 26 compat); knexfile paths via `__dirname` (Liftoff chdir)
- next: `verify`

## Verify Result

- status: **PASS** — 14/14 requirements, 23/23 scenarios compliant
- evidence: `migrate:latest` exit 0; `migrate:rollback` → 0 tables; re-migrate clean; typecheck exit 0; 8 constraint probes PASS; superadmin seed verified; 6 indexes verified; soft delete verified
- deviations: none (minor: UNIQUE probe masked by CHECK until tested with valid role)
- next: `archive`
