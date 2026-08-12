# Design: Multi-Tenant Data Foundation

## Technical Approach

Pure Knex Schema Builder (exploration #155 → proposal). Four migrations in FK order (`001_condominiums` → `002_buildings` → `003_units` → `004_users`), each with `up()`/`down()`. UUID v4 generated at the app layer (repositories — future change; column is `char(36)`). The RBAC jurisdiction rule is a single table-level CHECK rendered **inline in CREATE TABLE** — SQLite does not support `ALTER TABLE ADD CONSTRAINT`, so `table.check()` inside the createTable callback is the only viable Knex path. Scaffold: root `package.json`/`tsconfig.json` (TypeScript lives in `server/`), `server/db/knexfile.ts`, `server/db/connection.ts`. Migration CLI runs through the `tsx` loader. Multi-tenant isolation strategy for this change is **schema-level only**: tenant rows + FK chain + role/jurisdiction CHECK; runtime query scoping middleware is out of scope (future capability, per proposal).

## Architecture Decisions

| # | Decision | Options & tradeoff | Choice — rationale |
|---|----------|--------------------|--------------------|
| 1 | DB file path | root `dev.sqlite3` (pollutes root) vs `server/db/` (clutters migrations dir) vs `server/dev.sqlite3` | **`server/dev.sqlite3`**, resolved as `./server/dev.sqlite3` from repo root (npm scripts run from root; CWD-stable). Gitignored. |
| 2 | CHECK mechanism | `table.check()` vs `knex.raw()` ALTER | **`table.check(<static predicate>)`** in createTable → renders `check(...)` inline in `CREATE TABLE` (confirmed supported, raw predicate passthrough). Fallback: full **raw CREATE TABLE** via `knex.raw()` in the migration — never ALTER (unsupported in SQLite). |
| 3 | Superadmin hash | bcrypt (not in deps) vs placeholder string vs native crypto | **`crypto.scryptSync`** — real, verifiable hash, zero new dependencies. Format `scrypt$N$r$p$saltHex$hashHex` (self-describing params; future auth verifies with `crypto.scrypt`). Placeholder rejected: non-functional value forces wholesale replacement. |
| 4 | Seed location | separate Knex seed file (`knex seed:run`) vs INSERT in migration | **Single INSERT in `004_users` `up()`** — spec binds the seed to `migrate:latest` (scenario: root superadmin exists after migrate). `down()` deletes `WHERE role = 'superadmin'`. Separate seeds run on demand and would break the scenario. |
| 5 | CLI runner | `knex --knexfile` alone (Liftoff needs ts-node, not in deps) vs `knex --ts` (no such flag) | **`tsx ./node_modules/knex/bin/cli.js --knexfile ./server/db/knexfile.ts migrate:latest`** — tsx registers its loader process-wide, transpiling the `.ts` knexfile and `.ts` migrations in-process. Keeps deps within the allowed list. |
| 6 | SQLite config | `useNullAsDefault`, pool sizing, PRAGMA | **`useNullAsDefault: true`** (no undefined→NULL warnings), **pool `{min:1,max:1}`** (single-writer model, spec requirement), **no PRAGMA** (better-sqlite3 compiles FK enforcement ON by default), **per-migration transactions** (Knex default; `transaction:false` only needed for ALTER, not used here). |
| 7 | Module format | `"type": "module"` vs CJS default | **Omit `"type"` (CJS default)** — least friction with better-sqlite3's native binding; tsx compiles ESM-style migration exports to CJS-compatible. |

## Column Schema

All tables: `created_at`/`updated_at` via `table.timestamps(true, true)` (datetime, `DEFAULT CURRENT_TIMESTAMP`), nullable `deleted_at` via `table.timestamp('deleted_at')`.

| Table | Columns (Knex) |
|-------|----------------|
| condominiums | `id` `table.uuid().primary()`; `name` `table.string().notNullable()` |
| buildings | `id` uuid PK; `condominium_id` uuid `notNullable().references('id').inTable('condominiums')` + index `idx_buildings_condominium_id`; `name` string NOT NULL |
| units | `id` uuid PK; `building_id` uuid NOT NULL FK → buildings + index `idx_units_building_id` |
| users | `id` uuid PK; `email` string NOT NULL UNIQUE; `password_hash` string NOT NULL; `role` string NOT NULL; `condominium_id`/`building_id`/`unit_id` uuid nullable FKs (→ respective tables) + indexes `idx_users_condominium_id`, `idx_users_building_id`, `idx_users_unit_id`, `idx_users_role`; table-level `check(...)` |

FK `onDelete`: default (NO ACTION) — soft-delete domain; cascades not needed.

## RBAC CHECK — expected generated SQL

```sql
create table "users" ( ...,
  check (
    (role = 'superadmin'     AND condominium_id IS NULL     AND building_id IS NULL     AND unit_id IS NULL)
    OR (role = 'condo_admin'    AND condominium_id IS NOT NULL AND building_id IS NULL     AND unit_id IS NULL)
    OR (role = 'building_admin' AND condominium_id IS NOT NULL AND building_id IS NOT NULL AND unit_id IS NULL)
    OR (role = 'resident'       AND condominium_id IS NOT NULL AND building_id IS NOT NULL AND unit_id IS NOT NULL)
  )
)
```

`role` enumeration is implied (any other role fails all four branches). Predicate is a static string — no bindings, no injection surface.

## Data Flow

```
npm run migrate:latest
  → tsx loader (transpiles .ts on the fly)
    → knex CLI (knex/bin/cli.js) → knexfile.ts (better-sqlite3, pool 1x1)
      → server/dev.sqlite3
      → migrations 001_condominiums → 002_buildings → 003_units → 004_users (+superadmin seed)
        each in its own transaction; failure rolls back to pre-migration state
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Create | Deps (runtime: `knex ^3.1.0`, `better-sqlite3 ^11.9.1`, `uuid ^11.1.0`; dev: `typescript ^5.7.3`, `tsx ^4.19.3`, `@types/uuid ^10.0.0`, `@types/better-sqlite3 ^7.6.12`, `@types/node ^22.x`). Scripts: `migrate:latest`, `migrate:rollback` (per Decision 5), `typecheck`. No `"type"` field. |
| `tsconfig.json` | Create | `strict: true`, `target: ES2022`, `module/moduleResolution: commonjs/node`, `esModuleInterop`, `noEmit`, `include: ["server/**/*"]`, `types: ["node"]`. |
| `.gitignore` | Create | `node_modules/`, `server/dev.sqlite3*` (prevents committing DB). |
| `server/db/knexfile.ts` | Create | `development` env: client `better-sqlite3`, `connection.filename './server/dev.sqlite3'`, `useNullAsDefault: true`, `migrations: { directory: './server/db/migrations', extension: 'ts' }`, `pool: { min: 1, max: 1 }`. |
| `server/db/connection.ts` | Create | `export default knex(config.development)` — single shared instance. |
| `server/db/migrations/001_condominiums.ts` | Create | Schema + `down()` (dropTableIfExists). |
| `server/db/migrations/002_buildings.ts` | Create | Schema + FK + index + `down()`. |
| `server/db/migrations/003_units.ts` | Create | Schema + FK + index + `down()`. |
| `server/db/migrations/004_users.ts` | Create | Schema + FKs + unique email + indexes + RBAC CHECK + superadmin seed INSERT + `down()` (drop table). |

## Seed Contract

```
email: root@gestionpagos.local          # provisional, documented in code comment
password: ChangeMe!2026                 # provisional — MUST be rotated on first login (future auth)
password_hash: scrypt$16384$8$1$<saltHex>$<hashHex>   # crypto.scryptSync(password, salt, 64), hex
role: superadmin | condominium_id/building_id/unit_id: NULL
```

## Testing Strategy (smoke, no test runner)

| Layer | What | Approach |
|-------|------|----------|
| Smoke | Migrations apply clean | `npm run migrate:latest` → exit 0; tables present |
| Smoke | Type safety | `npm run typecheck` (`tsc --noEmit`) → no errors |
| Integration | Constraint enforcement | `tsx -e` probes against `connection.ts`: orphan building → `SQLITE_CONSTRAINT_FOREIGNKEY`; resident without unit → `SQLITE_CONSTRAINT_CHECK`; duplicate email → `SQLITE_CONSTRAINT_UNIQUE`; superadmin with `condominium_id` set → `SQLITE_CONSTRAINT_CHECK` (each wrapped in try/catch, non-zero exit on missing error) |
| Integration | Seed | count `users WHERE role='superadmin'` = 1 with all 3 FKs NULL |
| Integration | Indexes | query `sqlite_master` for `idx_buildings_condominium_id`, `idx_users_role` |
| Integration | Rollback | `npm run migrate:rollback` → no app tables remain; `migrate:latest` re-runs cleanly |

## Threat Matrix

N/A — no routing, shell-command, subprocess, VCS/PR-automation, executable-classification, or process-integration boundary introduced. `migrate:latest`/`migrate:rollback` are fixed npm scripts with literal-only arguments (no user-controlled input reaches the shell; `--knexfile` is a constant). VCS automation (branch/commit/push/PR) is untouched by this change.

## Migration / Rollout

Greenfield — no production data. Rollback: `npm run migrate:rollback` (all `down()` implemented) or delete `server/dev.sqlite3` and re-run. Future schema changes must respect SQLite's ALTER TABLE limits (table-recreation pattern; `transaction: false` only for ALTER operations).

## Open Questions

- [ ] Node >= 20 required by better-sqlite3 v11 engine — confirm team's Node baseline.
- [ ] Provisional superadmin credentials acceptable for first login (auth is a future change; rotation hook must be planned there).
