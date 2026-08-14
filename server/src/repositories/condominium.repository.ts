import connection from '../../db/connection';

/**
 * Persisted condominium row. `deleted_at` is repository-internal: it never
 * appears in API responses (controllers map to the public shape).
 */
export interface CondominiumRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const CONDOMINIUM_COLUMNS = ['id', 'name', 'created_at', 'updated_at', 'deleted_at'];

export const condominiumRepository = {
  /** Inserts a condominium and returns the persisted row (with timestamps). */
  async insert(data: { id: string; name: string }): Promise<CondominiumRow> {
    const [row] = await connection('condominiums').insert(data).returning(CONDOMINIUM_COLUMNS);
    return row;
  },

  /** Lists active condominiums ordered by name ASC. */
  async listByAll(): Promise<CondominiumRow[]> {
    return connection('condominiums')
      .select(CONDOMINIUM_COLUMNS)
      .whereNull('deleted_at')
      .orderBy('name', 'asc');
  },

  /** Finds an active (non-soft-deleted) condominium by id, or null. */
  async findActiveById(id: string): Promise<CondominiumRow | null> {
    const row = await connection('condominiums')
      .select(CONDOMINIUM_COLUMNS)
      .where({ id })
      .whereNull('deleted_at')
      .first();
    return row ?? null;
  },

  /** True when a row with this id exists — soft-deleted rows count (D10 nested-list gate). */
  async existsById(id: string): Promise<boolean> {
    const row = await connection('condominiums').select('id').where({ id }).first();
    return row !== undefined;
  },

  /** True when an active row with this name exists. */
  async existsByName(name: string): Promise<boolean> {
    const row = await connection('condominiums').select('id').where({ name }).whereNull('deleted_at').first();
    return row !== undefined;
  },
};