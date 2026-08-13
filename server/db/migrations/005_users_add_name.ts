import type { Knex } from 'knex';

/**
 * Restores the `name` column on `users` (part of the original entity contract
 * v2.0, lost during the first spec→apply cycle). Nullable so existing rows
 * (e.g. the superadmin seed) stay valid until names are backfilled.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.string('name').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('name');
  });
}
