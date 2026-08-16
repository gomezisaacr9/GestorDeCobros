import connection from '../../../db/connection';

/**
 * Persisted building row. `deleted_at` is repository-internal: it never
 * appears in API responses (controllers map to the public shape).
 */
export interface BuildingRow {
  id: string;
  name: string;
  condominium_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const BUILDING_COLUMNS = ['id', 'name', 'condominium_id', 'created_at', 'updated_at', 'deleted_at'];

export const buildingRepository = {
  /** Inserts a building and returns the persisted row (with timestamps). */
  async insert(data: { id: string; name: string; condominium_id: string }): Promise<BuildingRow> {
    const [row] = await connection('buildings').insert(data).returning(BUILDING_COLUMNS);
    return row;
  },

  /** Lists active buildings of a condominium, ordered by name ASC. */
  async listByCondominium(condominiumId: string): Promise<BuildingRow[]> {
    return connection('buildings')
      .select(BUILDING_COLUMNS)
      .where({ condominium_id: condominiumId })
      .whereNull('deleted_at')
      .orderBy('name', 'asc');
  },

  /** Finds an active (non-soft-deleted) building by id, or null. */
  async findActiveById(id: string): Promise<BuildingRow | null> {
    const row = await connection('buildings')
      .select(BUILDING_COLUMNS)
      .where({ id })
      .whereNull('deleted_at')
      .first();
    return row ?? null;
  },

  /** True when a row with this id exists — soft-deleted rows count (D10 nested-list gate). */
  async existsById(id: string): Promise<boolean> {
    const row = await connection('buildings').select('id').where({ id }).first();
    return row !== undefined;
  },

  /** True when an active row with this name exists in the given condominium. */
  async existsByName(name: string, condominiumId: string): Promise<boolean> {
    const row = await connection('buildings').select('id').where({ name, condominium_id: condominiumId }).whereNull('deleted_at').first();
    return row !== undefined;
  },
};