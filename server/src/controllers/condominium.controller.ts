import type { Request, Response } from 'express';
import { ConflictError, NotFoundError } from '../errors/http-errors';
import { condominiumService, type CondominiumPublic } from '../services/condominium.service';
import type { CondominiumRow } from '../repositories/condominium.repository';

/**
 * Public condominium response shape — `deleted_at` is never exposed.
 */
export interface PublicCondominium {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

function toPublic(row: CondominiumRow | CondominiumPublic): PublicCondominium {
  return { id: row.id, name: row.name, created_at: row.created_at, updated_at: row.updated_at };
}

export const condominiumController = {
  /** POST /api/v1/condominiums — 201 + Location on success; 404/409 from domain errors. */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { name } = req.body as { name: string };
      const created = await condominiumService.create(name);
      res.setHeader('Location', `/api/v1/condominiums/${created.id}`);
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

  /** GET /api/v1/condominiums — 200 with the active list. */
  async list(_req: Request, res: Response): Promise<void> {
    const rows = await condominiumService.list();
    res.status(200).json(rows.map(toPublic));
  },
};