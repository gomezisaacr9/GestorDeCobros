import type { Knex } from 'knex';

/**
 * Adds `number` (string, NOT NULL, no default) to `units`.
 *
 * SQLite cannot `ADD COLUMN` with NOT NULL unless a non-NULL default is given,
 * yet the spec forbids a default (inserting a unit without `number` MUST fail).
 * `units` had zero rows (no write path existed before hierarchy-api) so the
 * table is safely dropped and recreated. Design D11/D12.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('units');
  await knex.schema.createTable('units', (table) => {
    table.uuid('id').primary();
    table.uuid('building_id').notNullable().references('id').inTable('buildings');
    table.string('number', 50).notNullable();
    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();
    table.index(['building_id'], 'idx_units_building_id');
  });
}

/** Restores the exact pre-006 shape (migration 003). */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('units');
  await knex.schema.createTable('units', (table) => {
    table.uuid('id').primary();
    table.uuid('building_id').notNullable().references('id').inTable('buildings');
    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();
    table.index(['building_id'], 'idx_units_building_id');
  });
}