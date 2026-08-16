import type { Request, Response } from 'express';
import type { AuthUser } from '../../middlewares/requireAuth';
import type { AcceptInput, InvitationCreateInput } from './invitation.schemas';
import { invitationService } from './invitation.service';
import { sessionService } from '../auth/session.service';

/**
 * HTTP adapter for invitation flows — deliberately thin (design: "no
 * try/catch, Express 5 → errorHandler"). Domain errors (NotFoundError,
 * ConflictError, GoneError) bubble to the global errorHandler, which maps
 * `err.statusCode` (design D6); the controller never builds error bodies.
 *
 * - create: guarded (401 → 403 → 400) — 201 `{ magic_link }` (raw token once)
 * - resolve: public GET — 200 names only (spec R1)
 * - accept: public POST — 201 (registered) / 200 (linked) + session cookie
 */
export const invitationController = {
  /** POST /api/v1/invitations — admin issuance (D3 jurisdiction lookup in the service). */
  async create(req: Request, res: Response): Promise<void> {
    // requireAuth + requireRole guarantee an admin identity here (fail-closed
    // 401/403 before the controller ever runs).
    const actor = req.user as AuthUser;
    const { unit_id, expires_in_hours } = req.body as InvitationCreateInput;
    const { magic_link } = await invitationService.create(actor, {
      unit_id,
      expires_in_hours,
    });
    res.status(201).json({ magic_link });
  },

  /** GET /api/v1/invitations/:token — public names-only resolution (R1). */
  async resolve(req: Request, res: Response): Promise<void> {
    const token = String(req.params.token);
    // D5: req.user is NEVER read here — the token is the sole authorization.
    const names = await invitationService.resolve(token);
    res.status(200).json(names);
  },

  /** POST /api/v1/invitations/:token/accept — register or link + cookie (R4/R7). */
  async accept(req: Request, res: Response): Promise<void> {
    const token = String(req.params.token);
    const { email, password, name } = req.body as AcceptInput;
    const { user, created } = await invitationService.accept(token, { email, password, name });
    sessionService.setSessionCookie(res, user.id, user.role);
    res.status(created ? 201 : 200).json({
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    });
  },
};