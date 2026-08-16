import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../errors/http-errors';
import { buildingRepository, type BuildingRow } from './building.repository';
import { condominiumRepository } from './condominium.repository';

/**
 * Public building shape exposed by the API — never includes `deleted_at`.
 */
export interface BuildingPublic {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function toPublic(row: BuildingRow): BuildingPublic {
  return { id: row.id, name: row.name, created_at: row.created_at, updated_at: row.updated_at };
}

export const buildingService = {
  /**
   * Creates a building. Gates on an ACTIVE parent condominium (soft-deleted →
   * NotFoundError) and rejects with ConflictError when the name already exists
   * inside that condominium (design D8; same name in another condominium is
   * allowed). Id generated here (design D7).
   */
  async create(name: string, condominiumId: string): Promise<BuildingPublic> {
    const parent = await condominiumRepository.findActiveById(condominiumId);
    if (!parent) {
      throw new NotFoundError('Condominio no encontrado');
    }
    if (await buildingRepository.existsByName(name, condominiumId)) {
      throw new ConflictError('Ya existe un edificio con ese nombre en el condominio');
    }
    const row = await buildingRepository.insert({
      id: randomUUID(),
      name,
      condominium_id: condominiumId,
    });
    return toPublic(row);
  },

  /** Lists active buildings of a condominium, name ASC (delegates to repository). */
  async listByCondominium(condominiumId: string): Promise<BuildingPublic[]> {
    const rows = await buildingRepository.listByCondominium(condominiumId);
    return rows.map(toPublic);
  },
};