# Spec: tenant-data-model

## Requirements

### Requirement: Table Schemas

The system MUST create six tables via Knex migrations: `condominiums`, `buildings`, `units`, `users`, `invitations`, `resident_units`. All tables MUST include `created_at`/`updated_at` timestamps; hierarchy, `users`, and `invitations` keep nullable `deleted_at`.

| Table | Columns (beyond timestamps) |
|-------|------------------------------|
| condominiums | `id` UUID PK, `name` NOT NULL |
| buildings | `id` UUID PK, `condominium_id` NOT NULL FK → condominiums, `name` NOT NULL |
| units | `id` UUID PK, `building_id` NOT NULL FK → buildings, `number` string(50) NOT NULL |
| users | `id` UUID PK, `email` NOT NULL UNIQUE, `password_hash` NOT NULL, `role` NOT NULL, `name` nullable, `condominium_id`/`building_id`/`unit_id` nullable FKs |
| invitations | `id` UUID PK, `token_hash` NOT NULL UNIQUE, `unit_id` NOT NULL, `created_by` NOT NULL, `expires_at` NOT NULL, `status` NOT NULL CHECK |
| resident_units | composite PK (`user_id`, `unit_id`), `created_at` |

#### Scenario: Migrations create all tables

- GIVEN a fresh SQLite database
- WHEN `knex migrate:latest` runs through 007
- THEN all six tables exist with the columns above

#### Scenario: Users rebuild preserves rows

- GIVEN legacy rows including the superadmin seed and residents with all three jurisdiction FKs set
- WHEN migration 007 rebuilds `users` (INSERT…SELECT copy)
- THEN every row survives with identical ids and data, exactly one superadmin remains (no reseed)

#### Scenario: Units number column enforced

- GIVEN migrations applied through `006_units_add_number`
- WHEN inspecting the `units` schema
- THEN `number` is a NOT NULL string column
- AND inserting a unit without `number` fails

### Requirement: Foreign Key Enforcement

The database MUST enforce foreign keys natively (no explicit PRAGMA); inserts referencing missing parents MUST fail with `SQLITE_CONSTRAINT_FOREIGNKEY`.

#### Scenario: Orphan building rejected

- GIVEN no condominium with `id = c999`
- WHEN a building with `condominium_id = c999` is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_FOREIGNKEY`

#### Scenario: Orphan unit rejected

- GIVEN no building with `id = b999`
- WHEN a unit with `building_id = b999` is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_FOREIGNKEY`

### Requirement: Unique Credentials

The system MUST enforce uniqueness of `users.email`; duplicate emails MUST fail with `SQLITE_CONSTRAINT_UNIQUE`.

#### Scenario: Duplicate email rejected

- GIVEN an existing user with `email = a@b.com`
- WHEN a second user with the same email is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_UNIQUE`

### Requirement: RBAC Jurisdiction CHECK

The system MUST enforce role-jurisdiction consistency via a table-level CHECK on `users`, hierarchy `superadmin > condo_admin > building_admin > resident`:

| Role | condominium_id | building_id | unit_id |
|------|---------------|-------------|---------|
| superadmin | NULL | NULL | NULL |
| condo_admin | NOT NULL | NULL | NULL |
| building_admin | NOT NULL | NOT NULL | NULL |
| resident | any | any | any |

The resident branch MUST NOT constrain jurisdiction FKs (membership now lives in `resident_units`); admin branches keep the 004 constraints. Migration 007 MUST rebuild `users` with this reduced CHECK (SQLite cannot ALTER a CHECK) and its `down()` MUST restore the original 004 CHECK.

#### Scenario: Valid legacy resident passes

- GIVEN `role = 'resident'` and all three FKs NOT NULL (legacy 004-shaped row)
- WHEN the user is inserted
- THEN the insert succeeds

#### Scenario: Resident without unit allowed

- GIVEN `role = 'resident'` and `unit_id` NULL
- WHEN the user is inserted
- THEN the insert succeeds

#### Scenario: Superadmin with jurisdiction rejected

- GIVEN `role = 'superadmin'` and `condominium_id` NOT NULL
- WHEN the user is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_CHECK`

#### Scenario: Condo admin without condominium rejected

- GIVEN `role = 'condo_admin'` and `condominium_id` NULL
- WHEN the user is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_CHECK`

### Requirement: Invitations Table

Migration 007 MUST create `invitations`: `id` UUID PK; `token_hash` TEXT NOT NULL UNIQUE (SHA-256 digest ONLY — raw tokens MUST NOT be stored); `unit_id` UUID NOT NULL FK → units; `created_by` UUID NOT NULL FK → users; `expires_at` TEXT NOT NULL (ISO); `status` TEXT NOT NULL CHECK (`status IN ('active','used')`); `created_at`/`updated_at`; nullable `deleted_at`. Expiry MUST be derived from `expires_at` — `expired` is never a stored status.

#### Scenario: Duplicate token hash rejected

- GIVEN an existing invitation with `token_hash = h1`
- WHEN a second row with the same `token_hash` is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_UNIQUE`

#### Scenario: Status CHECK enforced

- GIVEN the `invitations` table
- WHEN a row with `status = 'expired'` is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_CHECK`

### Requirement: Resident Unit Membership

Migration 007 MUST create `resident_units`: `user_id` UUID NOT NULL FK → users, `unit_id` UUID NOT NULL FK → units, `created_at` NOT NULL, composite PRIMARY KEY (`user_id`, `unit_id`). No `id` column and no `deleted_at`. The table MUST enable M:N membership (one resident, many units; one unit, many residents).

#### Scenario: Duplicate membership rejected

- GIVEN a `(user_id, unit_id)` pair already present
- WHEN the same pair is inserted again
- THEN the insert throws `SQLITE_CONSTRAINT_PRIMARYKEY`

#### Scenario: Multi-property resident

- GIVEN one resident user and two units
- WHEN a `resident_units` row is inserted for each unit
- THEN both inserts succeed and the user belongs to both units

### Requirement: Soft Delete Semantics

All hierarchy tables, `users`, and `invitations` MUST include nullable `deleted_at`. Rows with `deleted_at IS NULL` are active; rows with `deleted_at` set are logically deleted but MUST remain physically present. `resident_units` does NOT have `deleted_at`.

#### Scenario: Logical delete marks the row

- GIVEN an active condominium
- WHEN `deleted_at` is set to the current timestamp
- THEN the row persists with `deleted_at IS NOT NULL`

### Requirement: Foreign Key and Role Indexes

The system MUST index `buildings.condominium_id`, `units.building_id`, `users.condominium_id`, `users.building_id`, `users.unit_id`, and `users.role`.

#### Scenario: Indexes exist after migration

- GIVEN migrations applied
- WHEN querying `sqlite_master` for index names
- THEN `idx_buildings_condominium_id` and `idx_users_role` exist

### Requirement: Superadmin Seed

The system MUST seed exactly one root superadmin in migrations, with `role = 'superadmin'`, all three jurisdiction FKs NULL, and non-nullable `email` + `password_hash` (provisional).

#### Scenario: Root superadmin exists after migrate

- GIVEN `knex migrate:latest` completed
- WHEN querying `users` where `role = 'superadmin'`
- THEN exactly one row exists with all jurisdiction FKs NULL

### Requirement: Migration Order and Rollback

Migrations MUST run in FK order `001_condominiums` → `002_buildings` → `003_units` → `004_users` → `005_users_add_name` → `006_units_add_number` → `007_invitations_resident_units`. Every migration MUST implement `down()`; `007 down()` MUST drop `resident_units`, drop `invitations`, and rebuild `users` with the original 004 CHECK (INSERT…SELECT preserve). Full rollback MUST empty the database.

#### Scenario: Clean rollback

- GIVEN all migrations applied through 007
- WHEN `knex migrate:rollback` runs to completion
- THEN no application tables remain
- AND `migrate:latest` re-runs cleanly

#### Scenario: One-step rollback restores 004 CHECK

- GIVEN all migrations applied through 007
- WHEN `knex migrate:rollback` rolls back exactly one step
- THEN `invitations` and `resident_units` are gone, the `users` CHECK matches migration 004, and every user row survives
