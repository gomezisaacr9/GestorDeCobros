import type { Request, Response } from 'express';
import { ConflictError, NotFoundError } from '../errors/http-errors';
import { condominiumRepository } from '../repositories/condominium.repository';
import { buildingService, type BuildingPublic } from '../services/building.service';
import type { BuildingRow } from '../repositories/building.repository';

/**
 * Public building response shape — `deleted_at` is never exposed.
 */
export interface PublicBuilding {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function toPublic(row: BuildingRow | BuildingPublic): PublicBuilding {
  return { id: row.id, name: row.name, created_at: row.created_at, updated_at: row.updated_at };
}

export const buildingController = {
  /** POST /api/v1/buildings — 201 + Location on success; 404/409 from domain errors. */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { name, condominium_id: condominiumId } = req.body as {
        name: string;
        condominium_id: string;
      };
      const created = await buildingService.create(name, condominiumId);
      res.setHeader('Location', `/api/v1/buildings/${created.id}`);
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
   * GET /api/v1/buildings — scoped list. The design only exposes scoped
   * queries, so the list is filtered by the `condominium_id` query param;
   * without it (or with a malformed value) the request matches zero rows → [].
   */
  async list(req: Request, res: Response): Promise<void> {
    const condominiumId = req.query.condominium_id;
    if (typeof condominiumId !== 'string') {
      res.status(200).json([]);
      return;
    }
    const rows = await buildingService.listByCondominium(condominiumId);
    res.status(200).json(rows.map(toPublic));
  },

  /**
   * GET /api/v1/condominiums/:id/buildings — nested list gated by the parent's
   * existence (design D10): a soft-deleted parent still exists ⇒ 200 ([]);
   * an unknown id ⇒ 404.
   */
  async listByCondominium(req: Request, res: Response): Promise<void> {
    const condominiumId = String(req.params.id);
    if (!(await condominiumRepository.existsById(condominiumId))) {
      res.status(404).json({ error: 'Condominio no encontrado' });
      return;
    }
    const rows = await buildingService.listByCondominium(condominiumId);
    res.status(200).json(rows.map(toPublic));
  },
};