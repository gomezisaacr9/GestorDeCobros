import { Router } from 'express';
import { buildingController } from './building.controller';
import { unitController } from './unit.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { requireRole } from '../../middlewares/requireRole';
import { validateZod } from '../../middlewares/validateZod';
import { BuildingCreateSchema } from './building.schemas';

/**
 * Building routes. Guard order per design D5: requireAuth → requireRole →
 * validateZod → controller (401 → 403 → 400, fail closed).
 */
const router = Router();
router.use(requireAuth);

router.post(
  '/',
  requireRole(['superadmin', 'condo_admin']),
  validateZod(BuildingCreateSchema),
  buildingController.create,
);
router.get('/', requireRole(['superadmin', 'condo_admin']), buildingController.list);
router.get(
  '/:id/units',
  requireRole(['superadmin', 'condo_admin', 'building_admin']),
  unitController.listByBuilding,
);

export default router;
export { router as buildingRouter };