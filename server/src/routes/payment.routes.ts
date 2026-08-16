import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validateZod } from '../middlewares/validateZod';
import { ExpenseReportSchema, ExpenseReviewSchema } from '../schemas/expense.schemas';

/**
 * Payment routes (design D7 — separate router mirroring the API surface):
 * - `POST /expenses/:id/payments` (resident proof report, R3): requireAuth →
 *   requireRole resident → validateZod(ExpenseReportSchema) → controller
 *   (401 → 403 → 400, fail closed).
 * - `POST /payments/:paymentId/review` (admin review, R4): requireAuth →
 *   requireRole superadmin/condo_admin → validateZod(ExpenseReviewSchema).
 *
 * This router is mounted at `/api/v1` (see app.ts) so both spec URLs resolve:
 * `/api/v1/expenses/:id/payments` and `/api/v1/payments/:paymentId/review`.
 */
const router = Router();

router.post(
  '/expenses/:id/payments',
  requireAuth,
  requireRole(['resident']),
  validateZod(ExpenseReportSchema),
  paymentController.report,
);

router.post(
  '/payments/:paymentId/review',
  requireAuth,
  requireRole(['superadmin', 'condo_admin']),
  validateZod(ExpenseReviewSchema),
  paymentController.review,
);

export default router;
export { router as paymentRouter };