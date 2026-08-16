import connection from '../../../db/connection';

/**
 * Persisted unit row. `deleted_at` is repository-internal: it never
 * appears in API responses (controllers map to the public shape).
 */
export interface UnitRow {
  id: string;
  number: string;
  building_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const UNIT_COLUMNS = ['id', 'number', 'building_id', 'created_at', 'updated_at', 'deleted_at'];

export const unitRepository = {
  /** Inserts a unit and returns the persisted row (with timestamps). */
  async insert(data: { id: string; number: string; building_id: string }): Promise<UnitRow> {
    const [row] = await connection('units').insert(data).returning(UNIT_COLUMNS);
    return row;
  },

  /** Lists active units of a building, ordered by number ASC. */
  async listByBuilding(buildingId: string): Promise<UnitRow[]> {
    return connection('units')
      .select(UNIT_COLUMNS)
      .where({ building_id: buildingId })
      .whereNull('deleted_at')
      .orderBy('number', 'asc');
  },

  /** Finds an active (non-soft-deleted) unit by id, or null. */
  async findActiveById(id: string): Promise<UnitRow | null> {
    const row = await connection('units')
      .select(UNIT_COLUMNS)
      .where({ id })
      .whereNull('deleted_at')
      .first();
    return row ?? null;
  },

  /** True when a row with this id exists — soft-deleted rows count (D10 nested-list gate). */
  async existsById(id: string): Promise<boolean> {
    const row = await connection('units').select('id').where({ id }).first();
    return row !== undefined;
  },

  /** True when an active row with this number exists in the given building. */
  async existsByNumber(number: string, buildingId: string): Promise<boolean> {
    const row = await connection('units').select('id').where({ number, building_id: buildingId }).whereNull('deleted_at').first();
    return row !== undefined;
  },
};