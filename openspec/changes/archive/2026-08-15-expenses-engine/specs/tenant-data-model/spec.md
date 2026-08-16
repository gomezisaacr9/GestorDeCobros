# Delta for tenant-data-model

Change `expenses-engine` adds migration 008 (`expenses` + `payments`) with FK-safe rollback and a matching test wipe order. Three existing requirements change because they enumerate tables or migration order.

## MODIFIED Requirements

### Requirement: Table Schemas

The system MUST create eight tables via Knex migrations: `condominiums`, `buildings`, `units`, `users`, `invitations`, `resident_units`, `expenses`, `payments`. All tables MUST include `created_at`/`updated_at` timestamps; hierarchy, `users`, `invitations`, `expenses`, and `payments` keep nullable `deleted_at`.
(Previously: six tables — `expenses` and `payments` did not exist)

| Table | Columns (beyond timestamps) |
|-------|------------------------------|
| condominiums | `id` UUID PK, `name` NOT NULL |
| buildings | `id` UUID PK, `condominium_id` NOT NULL FK → condominiums, `name` NOT NULL |
| units | `id` UUID PK, `building_id` NOT NULL FK → buildings, `number` string(50) NOT NULL |
| users | `id` UUID PK, `email` NOT NULL UNIQUE, `password_hash` NOT NULL, `role` NOT NULL, `name` nullable, `condominium_id`/`building_id`/`unit_id` nullable FKs |
| invitations | `id` UUID PK, `token_hash` NOT NULL UNIQUE, `unit_id` NOT NULL, `created_by` NOT NULL, `expires_at` NOT NULL, `status` NOT NULL CHECK |
| resident_units | composite PK (`user_id`, `unit_id`), `created_at` |
| expenses | `id` UUID PK, `unit_id` NOT NULL FK → units, `amount_cents` NOT NULL CHECK (> 0), `concept` NOT NULL, `period` NOT NULL CHECK (YYYY-MM shape), `status` NOT NULL CHECK, partial-unique `(unit_id, period)` |
| payments | `id` UUID PK, `expense_id` NOT NULL FK → expenses, `resident_id` NOT NULL FK → users, `proof_url` NOT NULL, `status` NOT NULL CHECK |

#### Scenario: Migrations create all tables

- GIVEN a fresh SQLite database
- WHEN `knex migrate:latest` runs through 008
- THEN all eight tables exist with the columns above, including the 008 CHECKs and the partial unique index

#### Scenario: Users rebuild preserves rows

- GIVEN legacy rows including the superadmin seed and residents with all three jurisdiction FKs set
- WHEN migration 007 rebuilds `users` (INSERT…SELECT copy)
- THEN every row survives with identical ids and data, exactly one superadmin remains (no reseed)

#### Scenario: Units number column enforced

- GIVEN migrations applied through `006_units_add_number`
- WHEN inspecting the `units` schema
- THEN `number` is a NOT NULL string column
- AND inserting a unit without `number` fails

### Requirement: Soft Delete Semantics

All hierarchy tables, `users`, `invitations`, `expenses`, and `payments` MUST include nullable `deleted_at`. Rows with `deleted_at IS NULL` are active; rows with `deleted_at` set are logically deleted but MUST remain physically present. `resident_units` does NOT have `deleted_at`.
(Previously: the soft-delete list did not include `expenses`/`payments`)

#### Scenario: Logical delete marks the row

- GIVEN an active condominium
- WHEN `deleted_at` is set to the current timestamp
- THEN the row persists with `deleted_at IS NOT NULL`

### Requirement: Migration Order and Rollback

Migrations MUST run in FK order `001_condominiums` → `002_buildings` → `003_units` → `004_users` → `005_users_add_name` → `006_units_add_number` → `007_invitations_resident_units` → `008_expenses_payments`. Every migration MUST implement `down()`; `007 down()` MUST drop `resident_units`, drop `invitations`, and rebuild `users` with the original 004 CHECK (INSERT…SELECT preserve); `008 down()` MUST drop `payments` then `expenses` (FK order). Full rollback MUST empty the database.
(Previously: the chain ended at 007)

#### Scenario: Clean rollback

- GIVEN all migrations applied through 008
- WHEN `knex migrate:rollback` runs to completion
- THEN no application tables remain
- AND `migrate:latest` re-runs cleanly

#### Scenario: One-step rollback drops 008 tables

- GIVEN all migrations applied through 008
- WHEN `knex migrate:rollback` rolls back exactly one step
- THEN `payments` and `expenses` are gone, `invitations`/`resident_units` survive, and the `users` CHECK is still the relaxed 007 form (restoring the 004 CHECK now takes two steps)
(Previously: one step restored the 004 CHECK — 008 sits on top, so step one only drops the new tables)

## ADDED Requirements

### Requirement: Migration 008 — Expenses Table

Migration 008 MUST create `expenses`: `id` UUID PK; `unit_id` UUID NOT NULL FK → units; `amount_cents` INTEGER NOT NULL CHECK (`amount_cents > 0`); `concept` TEXT NOT NULL; `period` TEXT NOT NULL with a CHECK enforcing the `YYYY-MM` shape (SQLite `GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`; month-range validity 01..12 is enforced by the Zod schema at the API layer — the CHECK guards shape, the schema guards semantics); `status` TEXT NOT NULL CHECK (`status IN ('pending','under_review','approved','rejected')`) DEFAULT `'pending'`; `created_at`/`updated_at`; nullable `deleted_at`. Uniqueness of `(unit_id, period)` MUST be enforced by a DATABASE-level partial unique index created via raw SQL — `CREATE UNIQUE INDEX idx_expenses_unique_unit_period_active ON expenses (unit_id, period) WHERE deleted_at IS NULL` — because Knex has no partial-index builder. Tradeoff: DB enforcement is race-safe (two concurrent emissions cannot both insert), unlike an app-layer pre-check; the service MAY pre-check for a clean 409 but MUST also map `SQLITE_CONSTRAINT_UNIQUE` on insert to 409 as the race backstop. The system MUST also index `expenses.unit_id` (`idx_expenses_unit_id`).

#### Scenario: Partial unique index rejects active duplicate

- GIVEN an active expense `(u1, 2026-07)`
- WHEN a second row with the same pair and `deleted_at IS NULL` is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_UNIQUE`

#### Scenario: Soft-deleted duplicate allowed

- GIVEN an expense `(u1, 2026-07)` with `deleted_at` set
- WHEN the same pair is inserted again as active
- THEN the insert succeeds (partial index only covers `deleted_at IS NULL`)

#### Scenario: Amount CHECK and status CHECK enforced

- GIVEN the `expenses` table
- WHEN a row with `amount_cents = 0` or `status = 'paid'` is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_CHECK`

#### Scenario: Orphan expense rejected

- GIVEN no unit with `id = u999`
- WHEN an expense with `unit_id = u999` is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_FOREIGNKEY`

### Requirement: Migration 008 — Payments Table

Migration 008 MUST create `payments`: `id` UUID PK; `expense_id` UUID NOT NULL FK → expenses; `resident_id` UUID NOT NULL FK → users; `proof_url` TEXT NOT NULL; `status` TEXT NOT NULL CHECK (`status IN ('under_review','approved','rejected')`) DEFAULT `'under_review'`; `created_at`/`updated_at`; nullable `deleted_at`. The system MUST index `payments.expense_id` (`idx_payments_expense_id`) and `payments.resident_id` (`idx_payments_resident_id`). The "latest payment" per expense MUST be resolvable via `ORDER BY created_at DESC, id DESC LIMIT 1` excluding `deleted_at IS NOT NULL` rows.

#### Scenario: Payment status CHECK enforced

- GIVEN the `payments` table
- WHEN a row with `status = 'pending'` is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_CHECK`

#### Scenario: Orphan payment rejected

- GIVEN no expense with `id = e999` or no user with `id = r999`
- WHEN a payment referencing either is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_FOREIGNKEY`

#### Scenario: Latest payment resolves by recency then id

- GIVEN two payments on one expense with equal `created_at`
- WHEN ordering by `created_at DESC, id DESC`
- THEN the greater `id` wins deterministically

### Requirement: Test Wipe Order

`server/test/helpers/db.ts` `wipe()` MUST delete tables in FK-child-first order: `payments` → `expenses` → `invitations` → `resident_units` → `users` → `units` → `buildings` → `condominiums`. `payments` MUST precede `expenses` (references it) and `expenses` MUST precede `units`; `users` MUST precede the hierarchy tables it references.
(Previously: `invitations → resident_units → users → units → buildings → condominiums`)

#### Scenario: Full wipe never fires FK constraints

- GIVEN a suite state with rows in every table
- WHEN `wipe()` runs between tests
- THEN every table is empty and no `SQLITE_CONSTRAINT_FOREIGNKEY` is thrown