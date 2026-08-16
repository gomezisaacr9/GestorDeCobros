import { Router } from 'express';
import { authController } from './auth.controller';
import { requireAuth } from '../../middlewares/requireAuth';
import { validateZod } from '../../middlewares/validateZod';
import { LoginSchema, RotateSchema } from './auth.schemas';

const router = Router();

router.post('/login', validateZod(LoginSchema), authController.login);
router.get('/me', requireAuth, authController.me);
router.patch('/password/rotate', requireAuth, validateZod(RotateSchema), authController.rotate);

export default router;