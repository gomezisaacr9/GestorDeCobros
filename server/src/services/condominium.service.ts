import { randomUUID } from 'node:crypto';
import { ConflictError } from '../errors/http-errors';
import { condominiumRepository, type CondominiumRow } from '../repositories/condominium.repository';

/**
 * Public condominium shape exposed by the API — never includes `deleted_at`.
 */
export interface CondominiumPublic {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function toPublic(row: CondominiumRow): CondominiumPublic {
  return { id: row.id, name: row.name, created_at: row.created_at, updated_at: row.updated_at };
}

export const condominiumService = {
  /**
   * Creates a condominium. Rejects with ConflictError when the name already
   * exists among active rows (design D8: service pre-check; soft-deleted
   * names are free again). The id is generated here (design D7), keeping the
   * repository a dumb CRUD layer.
   */
  async create(name: string): Promise<CondominiumPublic> {
    if (await condominiumRepository.existsByName(name)) {
      throw new ConflictError('Ya existe un condominio con ese nombre');
    }
    const row = await condominiumRepository.insert({ id: randomUUID(), name });
    return toPublic(row);
  },

  /** Lists active condominiums ordered by name ASC (delegates to repository). */
  async list(): Promise<CondominiumPublic[]> {
    const rows = await condominiumRepository.listByAll();
    return rows.map(toPublic);
  },
};