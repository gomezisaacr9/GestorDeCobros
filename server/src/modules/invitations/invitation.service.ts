import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import connection from '../../../db/connection';
import { ConflictError, GoneError, NotFoundError } from '../../errors/http-errors';
import { invitationRepository, type AdminRow } from './invitation.repository';
import { residentUnitService } from '../hierarchy/resident-unit.service';
import { getUserById, findResidentByEmail, createResident, hashPassword, type UserRow } from '../auth/auth.service';

/**
 * Single-use magic-link invitations (design D1..D8; specs invitation-admin R1–R4,
 * invitation-public R1–R7). Raw tokens are generated here with 256-bit entropy,
 * persisted ONLY as their SHA-256 digest, and never logged (spec R3). `accept`
 * runs inside one knex transaction: any failure rolls back and leaves the
 * token active (R6 S15).
 */

const DEFAULT_EXPIRY_HOURS = 72; // spec R4 — bounds exposure to ≤ 30 days

const SLEEPER_DEAD = 0;

/** 256-bit entropy token, 64 lowercase hex chars (spec R3). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 digest — the ONLY value ever persisted / compared (spec R3). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface PublicUser {
  id: string;
  email: string;
  role: string;
  name: string | null;
}

function toPublic(user: UserRow): PublicUser {
  // Defensive: never leak password_hash / deleted_at.
  return { id: user.id, email: user.email, role: user.role, name: user.name };
}

/**
 * SQLite 'now' mirrored into the exact stored format ('YYYY-MM-DD HH:MM:SS',
 * UTC) so lexicographic comparison with `expires_at` is chronological (D7 —
 * avoids mixed-format string comparisons against toISOString()).
 */
function nowSqlite(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function isExpired(expiresAt: string): boolean {
  return expiresAt <= nowSqlite();
}

/**
 * ONE joined query for the consuming path (D8): resolves the token (404 for
 * unknown) and loads the active chain (410 for dead link). Expiry/status
 * differentiation happens at the call site: resolve reconciles BOTH into 410
 * (R3), accept maps used → 409 and expired → 410 (R6).
 */
async function loadInvitation(raw: string, trx: Knex): Promise<{ id: string; unit_id: string; expires_at: string; status: string }> {
  const invitation = await invitationRepository.findActiveByTokenHash(hashToken(raw), trx);
  if (!invitation) {
    throw new NotFoundError('Invitación no encontrada');
  }
  return invitation;
}

export const invitationService = {
  /**
   * Admin issuance (D3): loads the actor row (fail closed — missing/soft-deleted
   * admin ⇒ NotFoundError 'Unidad no encontrada'), scopes the target unit to
   * the admin's jurisdiction, persists hash-only + D7 expiry, and returns the
   * magic link whose final segment is the raw token (appears exactly once).
   */
  async create(
    actor: { id: string; role: string },
    input: { unit_id: string; expires_in_hours?: number },
  ): Promise<{ magic_link: string }> {
    const admin = await getUserById(actor.id);
    if (!admin) {
      throw new NotFoundError('Unidad no encontrada');
    }
    const chain = await invitationRepository.findUnitInJurisdiction(input.unit_id, admin as AdminRow);
    if (!chain) {
      throw new NotFoundError('Unidad no encontrada'); // unknown / cross-jurisdiction / soft-deleted
    }
    const raw = generateToken();
    await invitationRepository.insert({
      id: randomUUID(),
      token_hash: hashToken(raw),
      unit_id: input.unit_id,
      created_by: admin.id,
      // D7: same-statement `now` as the created_at default ⇒ exact offset.
      expires_at: connection.raw(
        `datetime('now', '+${input.expires_in_hours ?? DEFAULT_EXPIRY_HOURS} hours')`,
      ),
    });
    return { magic_link: `/api/v1/invitations/${raw}` };
  },

  /**
   * Public names-only resolution (spec R1): 404 for unknown/delisted tokens
   * (findActiveByTokenHash excludes soft-deleted), reconciled 410 for
   * expired / used / dead chain — the body never leaks ids or status.
   */
  async resolve(raw: string): Promise<{ condominium: string; building: string; unit: string }> {
    const invitation = await invitationRepository.findActiveByTokenHash(hashToken(raw));
    if (!invitation) {
      throw new NotFoundError('Invitación no encontrada');
    }
    if (isExpired(invitation.expires_at) || invitation.status !== 'active') {
      throw new GoneError('Invitación expirada o ya utilizada');
    }
    const chain = await invitationRepository.findUnitChain(invitation.unit_id);
    if (!chain) {
      throw new GoneError('Invitación expirada o ya utilizada');
    }
    return {
      condominium: chain.condominium_name,
      building: chain.building_name,
      unit: chain.unit_number,
    };
  },

  /**
   * Single-transaction accept (D2). Sequence: lookup → active chain → holder
   * branch (register/link/conflict) → linkIfAbsent (idempotent S8b) → guarded
   * markUsed → commit. ANY throw rolls back and rethrows, leaving the token
   * active (R6 S15). Returns the public user + whether a row was created.
   */
  async accept(
    raw: string,
    input: { email: string; password: string; name?: string },
  ): Promise<{ user: PublicUser; created: boolean }> {
    const trx = await connection.transaction();
    try {
      const invitation = await loadInvitation(raw, trx);
      // R6 ordering: expiry checked BEFORE status — a used-but-expired token
      // is 410 (design "expired checked before used"); a merely-used token 409.
      if (isExpired(invitation.expires_at)) {
        throw new GoneError('Invitación expirada o ya utilizada');
      }
      if (invitation.status !== 'active') {
        throw new ConflictError('Invitación ya utilizada'); // S12
      }
      const chain = await invitationRepository.findUnitChain(invitation.unit_id, trx);
      if (!chain) {
        throw new GoneError('Invitación expirada o ya utilizada'); // dead unit chain (D8)
      }
      const holder = await findResidentByEmail(input.email, trx);

      let user: UserRow;
      let created = false;
      if (holder) {
        if (holder.deleted_at !== null || holder.role !== 'resident') {
          throw new ConflictError('No se puede vincular el email'); // R5 S10/S11
        }
        user = holder;
      } else {
        const password_hash = await hashPassword(input.password);
        user = await createResident({ email: input.email, password_hash, name: input.name }, trx);
        created = true;
      }

      await residentUnitService.linkResidentToUnit(user.id, invitation.unit_id, trx);
      const affected = await invitationRepository.markUsed(invitation.id, trx);
      if (affected === SLEEPER_DEAD) {
        throw new ConflictError('Invitación ya utilizada'); // concurrent consume (D2)
      }

      await trx.commit();
      return { user: toPublic(user), created };
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  },
};