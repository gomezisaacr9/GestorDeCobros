import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';

/**
 * Generic body-validation middleware. Parses `req.body` against the given Zod
 * schema; on success the parsed (typed) data replaces `req.body`. On failure
 * replies 400 with the individual Zod issues — the controller never runs.
 */
export function validateZod(schema: ZodSchema): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const error = result.error as ZodError;
      return res.status(400).json({
        error: 'Solicitud inválida',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}