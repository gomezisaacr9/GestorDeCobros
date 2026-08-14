import type { NextFunction, Request, Response } from 'express';

/**
 * Global error handler for Express.
 * Express 5 natively passes unhandled promise rejections to next(err).
 * This middleware catches them and formats them as standard JSON responses.
 * 
 * Must have exactly 4 parameters to be recognized by Express as an error handler.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const message = err.statusCode ? err.message : 'Error interno del servidor';

  // Log unhandled server errors (500) for internal debugging
  if (statusCode === 500) {
    console.error(err);
  }

  res.status(statusCode).json({ error: message });
}
