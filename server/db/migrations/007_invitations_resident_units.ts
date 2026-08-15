import type { Knex } from 'knex';

/**
 * Migration 007 — `invitations`, `resident_units`, and the relaxed `users`
 * RBAC CHECK (resident branch no longer constrains jurisdiction FKs).
 *
 * SQLite cannot ALTER a CHECK, so `users` is rebuilt. To avoid SQLite's
 * schema-global index-name collision (D1(b)) the copy target is created
 * WITHOUT named indexes: INSERT…SELECT (11 columns enumerated, byte-exact
 * copy incl. the superadmin seed — no reseed) → drop legacy `users` → rename
 * → re-add the four `idx_users_*` indexes.
 *
 * `down()` drops the new tables and rebuilds `users` with the verbatim 004
 * CHECK string (004_users.ts:39-44), preserving every 004-compliant row.
 */

// Verbatim 004 RBAC CHECK (004_users.ts:39-44) — restored by down().
const CHECK_004 = `(role = 'superadmin'     AND condominium_id IS NULL     AND building_id IS NULL     AND unit_id IS NULL)
 OR (role = 'condo_admin'    AND condominium_id IS NOT NULL AND building_id IS NULL     AND unit_id IS NULL)
 OR (role = 'building_admin' AND condominium_id IS NOT NULL AND building_id IS NOT NULL AND unit_id IS NULL)
 OR (role = 'resident'       AND condominium_id IS NOT NULL AND building_id IS NOT NULL AND unit_id IS NOT NULL)`;

// Reduced CHECK: the resident branch is unconstrained — membership now lives
// in `resident_units`; admin branches keep the 004 constraints.
const CHECK_RELAXED = `(role = 'superadmin'     AND condominium_id IS NULL     AND building_id IS NULL     AND unit_id IS NULL)
 OR (role = 'condo_admin'    AND condominium_id IS NOT NULL AND building_id IS NULL     AND unit_id IS NULL)
 OR (role = 'building_admin' AND condominium_id IS NOT NULL AND building_id IS NOT NULL AND unit_id IS NULL)
 OR (role = 'resident')`;

// All 11 `users` columns, enumerated for the INSERT…SELECT copy (005 added `name`).
const USERS_COLUMNS = [
  'id',
  'email',
  'password_hash',
  'name',
  'role',
  'condominium_id',
  'building_id',
  'unit_id',
  'created_at',
  'updated_at',
  'deleted_at',
] as const;

/**
 * Rebuilds `users` preserving every row: create copy target (no named
 * indexes, so none collide while the legacy table still owns `idx_users_*`),
 * copy all rows verbatim, drop the legacy table, rename, re-add indexes.
 *
 * `tempTable` MUST differ between rebuild calls: knex names the SQLite
 * `unique(email)` index after the temp table (`users_rebuild_007_up_email_unique`),
 * and that explicit index survives the rename, so reusing one name would
 * collide on the second rebuild. up()/down() therefore use distinct suffixes.
 */
async function rebuildUsers(knex: Knex, checkClause: string, tempTable: string): Promise<void> {
  await knex.schema.createTable(tempTable, (table) => {
    table.uuid('id').primary();
    table.string('email').notNullable().unique();
    table.string('password_hash').notNullable();
    table.string('name').nullable();
    table.string('role').notNullable();
    table.uuid('condominium_id').nullable().references('id').inTable('condominiums');
    table.uuid('building_id').nullable().references('id').inTable('buildings');
    table.uuid('unit_id').nullable().references('id').inTable('units');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.check(checkClause);
  });

  await knex.raw(
    `INSERT INTO ${tempTable} (${USERS_COLUMNS.join(', ')})
     SELECT ${USERS_COLUMNS.join(', ')} FROM users`,
  );

  await knex.schema.dropTableIfExists('users');
  await knex.schema.renameTable(tempTable, 'users');

  await knex.schema.alterTable('users', (table) => {
    table.index(['condominium_id'], 'idx_users_condominium_id');
    table.index(['building_id'], 'idx_users_building_id');
    table.index(['unit_id'], 'idx_users_unit_id');
    table.index(['role'], 'idx_users_role');
  });
}

export async function up(knex: Knex): Promise<void> {
  // 1. Rebuild `users` first — no inbound FKs exist yet, so the swap is safe.
  await rebuildUsers(knex, CHECK_RELAXED, 'users_rebuild_007_up');

  // 2. M:N membership — composite PK, no surrogate id, no deleted_at.
  await knex.schema.createTable('resident_units', (table) => {
    table.uuid('user_id').notNullable().references('id').inTable('users');
    table.uuid('unit_id').notNullable().references('id').inTable('units');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.primary(['user_id', 'unit_id']);
  });

  // 3. Invitations — only the SHA-256 digest is stored; `expired` is derived
  //    from `expires_at` and never stored (D7).
  await knex.schema.createTable('invitations', (table) => {
    table.uuid('id').primary();
    table.string('token_hash').notNullable().unique();
    table.uuid('unit_id').notNullable().references('id').inTable('units');
    table.uuid('created_by').notNullable().references('id').inTable('users');
    table.string('expires_at').notNullable();
    table.string('status').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at').nullable();
    table.check(`status IN ('active','used')`);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('resident_units');
  await knex.schema.dropTableIfExists('invitations');
  await rebuildUsers(knex, CHECK_004, 'users_rebuild_007_down');
}