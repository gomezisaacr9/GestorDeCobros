import type { Knex } from 'knex';

/**
 * Apply every pending migration on the given connection (the suite's temp DB).
 */
export async function migrateToLatest(knex: Knex): Promise<void> {
  await knex.migrate.latest();
}

/**
 * Wipe all hierarchy + auth + expenses tables between tests, deleting children
 * before parents so FK constraints never fire. Includes the 007 tables (task
 * 3.9) and the 008 tables (`payments` → `expenses` first — tenant-data-model
 * delta "Test Wipe Order", part of the expenses-engine rollout).
 *
 * Order rationale: `payments` references `expenses` and `users`, `expenses`
 * references `units`, so both 008 tables go before the hierarchy; `users`
 * references all three jurisdiction FKs (nullable) and must be deleted BEFORE
 * units/buildings/condominiums; `invitations`/`resident_units` reference
 * `users` and go first of all.
 * payments → expenses → invitations → resident_units → users → units →
 * buildings → condominiums.
 */
const FK_ORDER_TABLES = [
  'payments',
  'expenses',
  'invitations',
  'resident_units',
  'users',
  'units',
  'buildings',
  'condominiums',
] as const;

export async function wipe(knex: Knex): Promise<void> {
  for (const table of FK_ORDER_TABLES) {
    await knex(table).del();
  }
}
