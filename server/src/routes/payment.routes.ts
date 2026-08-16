import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validateZod } from '../middlewares/validateZod';
import { ExpenseReportSchema, ExpenseReviewSchema } from '../modules/payments/payment.schemas';

/**
 * Expense Payments Sub-router
 * Mounted at `/api/v1/expenses/:id/payments` via expenseRouter.
 * Requires `mergeParams: true` to access `:id` from the parent router.
 */
const expensePaymentsRouter = Router({ mergeParams: true });

expensePaymentsRouter.post(
  '/',
  requireAuth,
  requireRole(['resident']),
  validateZod(ExpenseReportSchema),
  paymentController.report,
);

/**
 * Payment Reviews Router
 * Mounted at `/api/v1/payments`
 */
const paymentRouter = Router();

paymentRouter.post(
  '/:paymentId/review',
  requireAuth,
  requireRole(['superadmin', 'condo_admin']),
  validateZod(ExpenseReviewSchema),
  paymentController.review,
);

export { expensePaymentsRouter, paymentRouter };