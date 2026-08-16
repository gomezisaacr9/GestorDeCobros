import { Router } from 'express';
import { unitController } from './unit.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { requireRole } from '../../middlewares/requireRole';
import { validateZod } from '../../middlewares/validateZod';
import { UnitCreateSchema } from './unit.schemas';

/**
 * Unit routes. Guard order per design D5: requireAuth → requireRole →
 * validateZod → controller (401 → 403 → 400, fail closed).
 */
const router = Router();
router.use(requireAuth);

router.post(
  '/',
  requireRole(['superadmin', 'condo_admin', 'building_admin']),
  validateZod(UnitCreateSchema),
  unitController.create,
);
router.get('/', requireRole(['superadmin', 'condo_admin', 'building_admin']), unitController.list);

export default router;
export { router as unitRouter };