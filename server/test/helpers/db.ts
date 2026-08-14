import type { Knex } from 'knex';

/**
 * Apply every pending migration on the given connection (the suite's temp DB).
 */
export async function migrateToLatest(knex: Knex): Promise<void> {
  await knex.migrate.latest();
}

/**
 * Wipe all hierarchy + auth tables between tests, deleting children before
 * parents so FK constraints never fire:
 * units → buildings → condominiums → users.
 */
const FK_ORDER_TABLES = ['units', 'buildings', 'condominiums', 'users'] as const;

export async function wipe(knex: Knex): Promise<void> {
  for (const table of FK_ORDER_TABLES) {
    await knex(table).del();
  }
}
