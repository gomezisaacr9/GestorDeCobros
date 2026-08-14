import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Authorization guard (design D4): fails closed. Calls `next()` only when
 * `req.user.role` (injected by `requireAuth`) is in the allowed set; otherwise
 * replies 403 `{ error: 'Prohibido' }` and stops the chain. A missing
 * `req.user` is treated as denied — no identity, no access.
 */
export function requireRole(allowed: readonly string[]): RequestHandler {
  const allowedRoles = new Set(allowed);
  return (req: Request, res: Response, next: NextFunction) => {
    if (typeof req.user?.role !== 'string' || !allowedRoles.has(req.user.role)) {
      res.status(403).json({ error: 'Prohibido' });
      return;
    }
    next();
  };
}