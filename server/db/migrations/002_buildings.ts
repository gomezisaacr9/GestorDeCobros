import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('buildings', (table) => {
    table.uuid('id').primary();
    table.uuid('condominium_id').notNullable().references('id').inTable('condominiums');
    table.string('name').notNullable();
    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();
    table.index(['condominium_id'], 'idx_buildings_condominium_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('buildings');
}
