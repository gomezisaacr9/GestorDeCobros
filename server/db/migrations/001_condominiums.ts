import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('condominiums', (table) => {
    table.uuid('id').primary();
    table.string('name').notNullable();
    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('condominiums');
}
