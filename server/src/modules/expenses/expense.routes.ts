import { Router } from 'express';
import { expenseController } from './expense.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { requireRole } from '../../middlewares/requireRole';
import { validateZod } from '../../middlewares/validateZod';
import { ExpenseCreateSchema } from './expense.schemas';
import { expensePaymentsRouter } from '../../routes/payment.routes';

/**
 * Expense routes (design D7) — MIXED guards:
 * - `POST /` (admin emission, R1): requireAuth → requireRole admin set →
 *   validateZod(ExpenseCreateSchema) → controller (401 → 403 → 400, fail
 *   closed — invitation.routes pattern).
 * - `GET /mine` (resident panel, R2): requireAuth → requireRole resident
 *   (spec R2/S13: a non-resident session is 403, never falls through to the
 *   panel — fail closed).
 */
const router = Router();

router.post(
  '/',
  requireAuth,
  requireRole(['superadmin', 'condo_admin', 'building_admin']),
  validateZod(ExpenseCreateSchema),
  expenseController.create,
);

router.get('/mine', requireAuth, requireRole(['resident']), expenseController.listMine);

router.use('/:id/payments', expensePaymentsRouter);

export default router;
export { router as expenseRouter };