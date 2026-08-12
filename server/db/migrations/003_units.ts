import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('units', (table) => {
    table.uuid('id').primary();
    table.uuid('building_id').notNullable().references('id').inTable('buildings');
    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();
    table.index(['building_id'], 'idx_units_building_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('units');
}
