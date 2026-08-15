import type { Response } from 'express';
import { env } from '../config/env';
import { signToken } from './auth.service';

/**
 * Shared session-cookie issuance (design D4). Both `authController.login`
 * and the invitation accept flow (R7) must mint IDENTICAL cookies — hence the
 * single source of truth: signToken + the exact opts the auth controller
 * previously declared locally.
 *
 * Signature note: the design sketch shows `(res, sub)`, but the JWT payload
 * requires a role (login signs `{sub, role}`; accept signs role
 * 'resident' — spec R7), so the authoritative signature is `(res, sub, role)`.
 */

const COOKIE_NAME = 'auth_token';
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h, aligned with JWT expiry

export const sessionService = {
  /** Signs `{ sub, role }` and writes the `auth_token` cookie. */
  setSessionCookie(res: Response, sub: string, role: string): void {
    const token = signToken({ sub, role });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: env.NODE_ENV !== 'development',
      sameSite: 'strict',
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    });
  },
};