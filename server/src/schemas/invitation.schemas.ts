import { z } from 'zod';

/**
 * Admin create body: `unit_id` must be a uuid; `expires_in_hours` is an
 * optional integer bounded to 1..720 (≤ 30 days). The 72-hour default is
 * applied in the service, not here (spec R4 — "expired" is derived, never
 * stored as a status).
 */
export const InvitationCreateSchema = z.object({
  unit_id: z.string().uuid(),
  expires_in_hours: z.number().int().min(1).max(720).optional(),
});

/**
 * Public accept body: `email` well-formed, `password` 8..128 chars (reuses
 * the auth validation convention from RotateSchema), optional `name` trimmed
 * ≤ 255 chars.
 */
export const AcceptSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().trim().max(255).optional(),
});

export type InvitationCreateInput = z.infer<typeof InvitationCreateSchema>;
export type AcceptInput = z.infer<typeof AcceptSchema>;
