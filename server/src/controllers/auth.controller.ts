import type { Request, Response } from 'express';
import { userRepository } from '../repositories/user.repository';
import {
  hashPassword,
  verifyCredentials,
  verifyPassword,
} from '../services/auth.service';
import { sessionService } from '../services/session.service';

const UNAUTHORIZED_LOGIN = 'Credenciales inválidas';

interface PublicUser {
  id: string;
  email: string;
  role: string;
  name: string | null;
}

function toPublic(user: PublicUser): PublicUser {
  // Defensive: never leak password_hash / deleted_at. `name` is nullable.
  return { id: user.id, email: user.email, role: user.role, name: user.name };
}

export const authController = {
  /** POST /api/v1/auth/login — verify credentials, issue session cookie. */
  async login(req: Request, res: Response): Promise<void> {
    const { email, password } = req.body as { email: string; password: string };
    const user = await verifyCredentials(email, password);
    if (!user) {
      res.status(401).json({ error: UNAUTHORIZED_LOGIN });
      return;
    }
    // D4: cookie issuance delegated to the shared session service so the
    // invitation accept flow mints byte-identical session cookies (spec R7).
    sessionService.setSessionCookie(res, user.id, user.role);
    res.status(200).json(toPublic(user));
  },

  /** GET /api/v1/auth/me — current user (active rows only). */
  async me(req: Request, res: Response): Promise<void> {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
    const dbUser = await userRepository.findById(user.id);
    if (!dbUser) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
    res.status(200).json(toPublic(dbUser));
  },

  /** PATCH /api/v1/auth/password/rotate — verify current, persist new hash. */
  async rotate(req: Request, res: Response): Promise<void> {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };
    const dbUser = await userRepository.findById(user.id);
    if (!dbUser) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
    const currentValid = await verifyPassword(currentPassword, dbUser.password_hash);
    if (!currentValid) {
      res.status(401).json({ error: UNAUTHORIZED_LOGIN });
      return;
    }
    const newHash = await hashPassword(newPassword);
    await userRepository.updatePasswordHash(user.id, newHash);
    res.status(200).json({ message: 'Contraseña actualizada' });
  },
};