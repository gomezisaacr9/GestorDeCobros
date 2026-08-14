import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from './errorHandler';
import { NotFoundError } from '../errors/http-errors';

describe('errorHandler middleware', () => {
  it('should return the custom status code and message if it is a domain error', () => {
    const error = new NotFoundError('Custom not found message');
    const req = {} as Request;
    
    const res = {} as Response;
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    
    const next = vi.fn() as NextFunction;

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Custom not found message' });
  });

  it('should return 500 and a generic message for unknown errors without leaking details', () => {
    const error = new Error('Database exploded with sensitive data');
    const req = {} as Request;
    
    const res = {} as Response;
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    
    const next = vi.fn() as NextFunction;

    // Suppress console.error in tests to keep output clean
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Error interno del servidor' });
    expect(consoleSpy).toHaveBeenCalledWith(error);

    consoleSpy.mockRestore();
  });
});
