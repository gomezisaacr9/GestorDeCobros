import type { Request, Response } from 'express';
import type { AuthUser } from '../../middlewares/requireAuth';
import type { ExpenseCreateInput } from './expense.schemas';
import { expenseService } from './expense.service';

/**
 * HTTP adapter for expense emission + resident panel — deliberately thin
 * (design: "no try/catch, Express 5 → errorHandler"). Domain errors
 * (NotFoundError, ConflictError) bubble to the global errorHandler, which
 * maps `err.statusCode`; the controller never builds error bodies.
 *
 * - create: guarded (401 → 403 → 400) — 201 with the R1 public shape
 * - listMine: guarded (401 → 403) — 200 array of R2 public items
 *
 * Session parsing is the existing `req.user` injected by requireAuth
 * (never re-verified here).
 */
export const expenseController = {
  /** POST /api/v1/expenses — admin emission (R1). */
  async create(req: Request, res: Response): Promise<void> {
    const actor = req.user as AuthUser;
    const input = req.body as ExpenseCreateInput;
    const expense = await expenseService.create(actor, input);
    res.status(201).json(expense);
  },

  /** GET /api/v1/expenses/mine — resident panel (R2). */
  async listMine(req: Request, res: Response): Promise<void> {
    const actor = req.user as AuthUser;
    const items = await expenseService.listMine(actor.id);
    res.status(200).json(items);
  },
};