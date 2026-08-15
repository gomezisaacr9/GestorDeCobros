import type { Knex } from 'knex';

/**
 * Apply every pending migration on the given connection (the suite's temp DB).
 */
export async function migrateToLatest(knex: Knex): Promise<void> {
  await knex.migrate.latest();
}

/**
 * Wipe all hierarchy + auth tables between tests, deleting children before
 * parents so FK constraints never fire. Includes the 007 tables (task 3.9,
 * pulled forward: the domain-core specs insert invitations/resident_units).
 *
 * Order rationale (task 3.9, adjusted): `users` references all three
 * jurisdiction FKs (nullable), so it must be deleted BEFORE units/buildings/
 * condominiums; `invitations`/`resident_units` reference `users` and must go
 * first of all.
 * invitations → resident_units → users → units → buildings → condominiums.
 */
const FK_ORDER_TABLES = [
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
