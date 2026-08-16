import type { Request, Response } from 'express';
import type { AuthUser } from '../middlewares/requireAuth';
import type { ExpenseReportInput, ExpenseReviewInput } from '../modules/payments/payment.schemas';
import { paymentService } from '../services/payment.service';

/**
 * HTTP adapter for payments — deliberately thin (design: "no try/catch,
 * Express 5 → errorHandler"). Domain errors bubble to the global errorHandler,
 * which maps `err.statusCode`; the controller never builds error bodies.
 *
 * - report: guarded (requireAuth → requireRole resident → validateZod) — 201
 *   with the R3 public shape
 * - review: guarded (requireAuth → requireRole superadmin/condo_admin →
 *   validateZod) — 200 with the R4 public shape
 */
export const paymentController = {
  /** POST /api/v1/expenses/:id/payments — resident proof report (R3). */
  async report(req: Request, res: Response): Promise<void> {
    const actor = req.user as AuthUser;
    const id = String(req.params.id);
    const { proof_url } = req.body as ExpenseReportInput;
    const payment = await paymentService.reportPayment(actor.id, id, proof_url);
    res.status(201).json(payment);
  },

  /** POST /api/v1/payments/:paymentId/review — admin decision (R4). */
  async review(req: Request, res: Response): Promise<void> {
    const actor = req.user as AuthUser;
    const paymentId = String(req.params.paymentId);
    const { decision } = req.body as ExpenseReviewInput;
    const result = await paymentService.review(paymentId, actor, decision);
    res.status(200).json(result);
  },
};