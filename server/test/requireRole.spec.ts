import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { requireRole } from '../src/middlewares/requireRole';

function mockResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('requireRole middleware', () => {
  it('calls next() when req.user.role is in the allowed set', () => {
    const middleware = requireRole(['superadmin', 'condo_admin']);
    const req = { user: { id: 'u1', role: 'condo_admin' } } as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('replies 403 {error:"Prohibido"} and stops the chain for a disallowed role', () => {
    const middleware = requireRole(['superadmin']);
    const req = { user: { id: 'u2', role: 'building_admin' } } as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Prohibido' });
  });

  it('fails closed: missing req.user (no session identity) → 403', () => {
    const middleware = requireRole(['superadmin']);
    const req = {} as Request;
    const res = mockResponse();
    const next = vi.fn() as NextFunction;

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Prohibido' });
  });

  it('does not leak state between calls (Set built per middleware instance)', () => {
    const allowOnlySuperadmin = requireRole(['superadmin']);
    const allowAll = requireRole(['superadmin', 'condo_admin', 'building_admin', 'resident']);
    const req = { user: { id: 'u3', role: 'resident' } } as Request;

    const deniedRes = mockResponse();
    allowOnlySuperadmin(req, deniedRes, vi.fn() as NextFunction);
    expect(deniedRes.json).toHaveBeenCalledWith({ error: 'Prohibido' });

    const allowedRes = mockResponse();
    const next = vi.fn() as NextFunction;
    allowAll(req, allowedRes, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(allowedRes.status).not.toHaveBeenCalled();
  });
});