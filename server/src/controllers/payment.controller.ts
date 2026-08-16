import type { Request, Response } from 'express';
import type { AuthUser } from '../middlewares/requireAuth';
import type { ExpenseReportInput } from '../schemas/expense.schemas';
import { expenseService } from '../services/expense.service';

/**
 * HTTP adapter for payments — deliberately thin (design: "no try/catch,
 * Express 5 → errorHandler"). Domain errors bubble to the global errorHandler,
 * which maps `err.statusCode`; the controller never builds error bodies.
 *
 * - report: guarded (requireAuth → requireRole resident → validateZod) — 201
 *   with the R3 public shape
 */
export const paymentController = {
  /** POST /api/v1/expenses/:id/payments — resident proof report (R3). */
  async report(req: Request, res: Response): Promise<void> {
    const actor = req.user as AuthUser;
    const id = String(req.params.id);
    const { proof_url } = req.body as ExpenseReportInput;
    const payment = await expenseService.reportPayment(actor.id, id, proof_url);
    res.status(201).json(payment);
  },
};