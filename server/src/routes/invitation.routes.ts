import { Router } from 'express';
import { invitationController } from '../controllers/invitation.controller';
import { requireAuth } from '../middlewares/requireAuth';
import { requireRole } from '../middlewares/requireRole';
import { validateZod } from '../middlewares/validateZod';
import { AcceptSchema, InvitationCreateSchema } from '../schemas/invitation.schemas';

/**
 * Invitation routes — MIXED guards per design D1:
 * - `POST /` (admin issuance): requireAuth → requireRole → validateZod →
 *   controller (401 → 403 → 400, fail closed — unit.routes pattern).
 * - `GET /:token` and `POST /:token/accept` (public onboarding): NO guards —
 *   the raw token IS the authorization (spec invitation-public). They must
 *   NEVER sit behind `router.use(requireAuth)`.
 */
const router = Router();

router.post(
  '/',
  requireAuth,
  requireRole(['superadmin', 'condo_admin', 'building_admin']),
  validateZod(InvitationCreateSchema),
  invitationController.create,
);

// Public onboarding — token-only authorization (invitation-public spec).
// `accept` still validates its body (R4: 400 before any mutation — S9).
router.get('/:token', invitationController.resolve);
router.post('/:token/accept', validateZod(AcceptSchema), invitationController.accept);

export default router;
export { router as invitationRouter };