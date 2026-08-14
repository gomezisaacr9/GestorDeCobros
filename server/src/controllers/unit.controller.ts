import type { Request, Response } from 'express';
import { ConflictError, NotFoundError } from '../errors/http-errors';
import { buildingRepository } from '../repositories/building.repository';
import { unitService, type UnitPublic } from '../services/unit.service';
import type { UnitRow } from '../repositories/unit.repository';

/**
 * Public unit response shape — `deleted_at` is never exposed.
 */
export interface PublicUnit {
  id: string;
  number: string;
  created_at: string;
  updated_at: string;
}

function toPublic(row: UnitRow | UnitPublic): PublicUnit {
  return { id: row.id, number: row.number, created_at: row.created_at, updated_at: row.updated_at };
}

export const unitController = {
  /** POST /api/v1/units — 201 + Location on success; 404/409 from domain errors. */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { number, building_id: buildingId } = req.body as {
        number: string;
        building_id: string;
      };
      const created = await unitService.create(number, buildingId);
      res.setHeader('Location', `/api/v1/units/${created.id}`);
      res.status(201).json(toPublic(created));
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof ConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  },

  /**
   * GET /api/v1/units — scoped list. The design only exposes scoped queries,
   * so the list is filtered by the `building_id` query param; without it (or
   * with a malformed value) the request matches zero rows → [].
   */
  async list(req: Request, res: Response): Promise<void> {
    const buildingId = req.query.building_id;
    if (typeof buildingId !== 'string') {
      res.status(200).json([]);
      return;
    }
    const rows = await unitService.listByBuilding(buildingId);
    res.status(200).json(rows.map(toPublic));
  },

  /**
   * GET /api/v1/buildings/:id/units — nested list gated by the parent's
   * existence (design D10): a soft-deleted parent still exists ⇒ 200 ([]);
   * an unknown id ⇒ 404.
   */
  async listByBuilding(req: Request, res: Response): Promise<void> {
    const buildingId = String(req.params.id);
    if (!(await buildingRepository.existsById(buildingId))) {
      res.status(404).json({ error: 'Edificio no encontrado' });
      return;
    }
    const rows = await unitService.listByBuilding(buildingId);
    res.status(200).json(rows.map(toPublic));
  },
};