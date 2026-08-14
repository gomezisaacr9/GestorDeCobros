# Delta for tenant-data-model

## MODIFIED Requirements

### Requirement: Table Schemas

The system MUST create four tables via Knex migrations: `condominiums`, `buildings`, `units`, `users`. All tables MUST include `created_at`/`updated_at` timestamps and nullable `deleted_at`.

| Table | Columns (beyond timestamps) |
|-------|------------------------------|
| condominiums | `id` UUID PK, `name` NOT NULL |
| buildings | `id` UUID PK, `condominium_id` NOT NULL FK → condominiums, `name` NOT NULL |
| units | `id` UUID PK, `building_id` NOT NULL FK → buildings, `number` string NOT NULL |
| users | `id` UUID PK, `email` NOT NULL UNIQUE, `password_hash` NOT NULL, `role` NOT NULL, `condominium_id`/`building_id`/`unit_id` nullable FKs |

(Previously: `units` had no `number` column; migration 006 restores the missing contract.)

#### Scenario: Migrations create all tables

- GIVEN a fresh SQLite database
- WHEN `knex migrate:latest` runs
- THEN the four tables exist with the columns above and UUID `id` primary keys

#### Scenario: Units number column enforced

- GIVEN migrations applied through `006_units_add_number`
- WHEN inspecting the `units` schema
- THEN `number` is a NOT NULL string column
- AND inserting a unit without `number` fails

### Requirement: Migration Order and Rollback

Migrations MUST run in FK order `001_condominiums` → `002_buildings` → `003_units` → `004_users` → `005_users_add_name` → `006_units_add_number`. Every migration MUST implement `down()`; rollback MUST empty the database.
(Previously: order listed only `001`–`004`; `005` (users.name) and `006` (units.number) were absent.)

#### Scenario: Clean rollback

- GIVEN all migrations applied
- WHEN `knex migrate:rollback` runs to completion
- THEN no application tables remain
- AND `migrate:latest` re-runs cleanly
