import type { Knex } from 'knex';
import connection from '../../db/connection';

/**
 * M:N resident ↔ unit membership. Composite PK (user_id, unit_id) is the
 * natural unique constraint — `linkIfAbsent` absorbs the duplicate-insert
 * race with `onConflict.ignore()` so an already-linked resident is a no-op
 * (spec S8b).
 */
export const residentUnitsRepository = {
  /** Links a resident to a unit unless the pair already exists. */
  async linkIfAbsent(
    userId: string,
    unitId: string,
    trx: Knex = connection,
  ): Promise<void> {
    await trx('resident_units')
      .insert({ user_id: userId, unit_id: unitId })
      .onConflict(['user_id', 'unit_id'])
      .ignore();
  },

  /** True when the (user, unit) pair exists. */
  async existsLink(
    userId: string,
    unitId: string,
    trx: Knex = connection,
  ): Promise<boolean> {
    const row = await trx('resident_units')
      .select('user_id')
      .where({ user_id: userId, unit_id: unitId })
      .first();
    return row !== undefined;
  },

  /**
   * All unit ids the user is linked to (spec R2 panel membership filter —
   * task 1.4, PR-1 BLOCKER for the resident panel). Single SQL filter, no
   * joins: one id per `resident_units` row, empty array when there are none.
   */
  async listUnitIdsByUser(userId: string, trx: Knex = connection): Promise<string[]> {
    const rows = await trx('resident_units').select('unit_id').where({ user_id: userId });
    return rows.map((row) => row.unit_id);
  },
};