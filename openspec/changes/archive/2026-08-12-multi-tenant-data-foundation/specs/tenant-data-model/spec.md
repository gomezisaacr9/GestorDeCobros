# Delta for tenant-data-model

New capability — greenfield. Full spec lands in `openspec/specs/tenant-data-model/spec.md` on archive.

## ADDED Requirements

### Requirement: Table Schemas

The system MUST create four tables via Knex migrations: `condominiums`, `buildings`, `units`, `users`. All tables MUST include `created_at`/`updated_at` timestamps and nullable `deleted_at`.

| Table | Columns (beyond timestamps) |
|-------|------------------------------|
| condominiums | `id` UUID PK, `name` NOT NULL |
| buildings | `id` UUID PK, `condominium_id` NOT NULL FK → condominiums, `name` NOT NULL |
| units | `id` UUID PK, `building_id` NOT NULL FK → buildings |
| users | `id` UUID PK, `email` NOT NULL UNIQUE, `password_hash` NOT NULL, `role` NOT NULL, `condominium_id`/`building_id`/`unit_id` nullable FKs |

#### Scenario: Migrations create all tables

- GIVEN a fresh SQLite database
- WHEN `knex migrate:latest` runs
- THEN the four tables exist with the columns above and UUID `id` primary keys

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
| resident | NOT NULL | NOT NULL | NOT NULL |

#### Scenario: Valid resident passes

- GIVEN `role = 'resident'` and all three FKs NOT NULL
- WHEN the user is inserted
- THEN the insert succeeds

#### Scenario: Superadmin with jurisdiction rejected

- GIVEN `role = 'superadmin'` and `condominium_id` NOT NULL
- WHEN the user is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_CHECK`

#### Scenario: Resident without unit rejected

- GIVEN `role = 'resident'` and `unit_id` NULL
- WHEN the user is inserted
- THEN the insert throws `SQLITE_CONSTRAINT_CHECK`

### Requirement: Soft Delete Semantics

All four tables MUST include nullable `deleted_at`. Rows with `deleted_at IS NULL` are active; rows with `deleted_at` set are logically deleted but MUST remain physically present.

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

Migrations MUST run in FK order `001_condominiums` → `002_buildings` → `003_units` → `004_users`. Every migration MUST implement `down()`; rollback MUST empty the database.

#### Scenario: Clean rollback

- GIVEN all migrations applied
- WHEN `knex migrate:rollback` runs to completion
- THEN no application tables remain
- AND `migrate:latest` re-runs cleanly
