import { Router } from 'express';
import { buildingController } from '../controllers/building.controller';
import { condominiumController } from '../controllers/condominium.controller';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validateZod } from '../middlewares/validateZod';
import { CondominiumCreateSchema } from '../schemas/condominium.schemas';

/**
 * Condominium routes. Guard order per design D5: requireAuth → requireRole →
 * validateZod → controller (401 → 403 → 400, fail closed).
 */
const router = Router();
router.use(requireAuth);

router.post(
  '/',
  requireRole(['superadmin']),
  validateZod(CondominiumCreateSchema),
  condominiumController.create,
);
router.get('/', requireRole(['superadmin']), condominiumController.list);
router.get(
  '/:id/buildings',
  requireRole(['superadmin', 'condo_admin']),
  buildingController.listByCondominium,
);

export default router;
export { router as condominiumRouter };