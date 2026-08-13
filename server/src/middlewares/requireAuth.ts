import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AuthUser {
  id: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Authenticated-route guard: reads the `auth_token` HttpOnly cookie, verifies
 * the JWT signature/expiry, and injects `req.user = { id, role }`. Missing,
 * invalid, or expired tokens → 401 before the controller runs.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token: unknown = req.cookies?.['auth_token'];
  if (typeof token !== 'string' || token === '') {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
    req.user = { id: payload.sub, role: String(payload.role ?? '') };
    next();
  } catch {
    res.status(401).json({ error: 'No autorizado' });
  }
}

export const requireAuthHandler: RequestHandler = requireAuth;