import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../errors/http-errors';
import { buildingRepository } from '../repositories/building.repository';
import { unitRepository, type UnitRow } from '../repositories/unit.repository';

/**
 * Public unit shape exposed by the API — never includes `deleted_at`.
 */
export interface UnitPublic {
  id: string;
  number: string;
  created_at: string;
  updated_at: string;
}

function toPublic(row: UnitRow): UnitPublic {
  return { id: row.id, number: row.number, created_at: row.created_at, updated_at: row.updated_at };
}

export const unitService = {
  /**
   * Creates a unit. Gates on an ACTIVE parent building (missing/soft-deleted →
   * NotFoundError) and rejects with ConflictError when the number already
   * exists inside that building (design D8; same number in another building is
   * allowed). Id generated here (design D7).
   */
  async create(number: string, buildingId: string): Promise<UnitPublic> {
    const parent = await buildingRepository.findActiveById(buildingId);
    if (!parent) {
      throw new NotFoundError('Edificio no encontrado');
    }
    if (await unitRepository.existsByNumber(number, buildingId)) {
      throw new ConflictError('Ya existe una unidad con ese número en el edificio');
    }
    const row = await unitRepository.insert({
      id: randomUUID(),
      number,
      building_id: buildingId,
    });
    return toPublic(row);
  },

  /** Lists active units of a building, number ASC (delegates to repository). */
  async listByBuilding(buildingId: string): Promise<UnitPublic[]> {
    const rows = await unitRepository.listByBuilding(buildingId);
    return rows.map(toPublic);
  },
};