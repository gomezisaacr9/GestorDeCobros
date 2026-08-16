import type { Knex } from 'knex';
import connection from '../../db/connection';
import {
  chainQuery,
  findUnitInJurisdiction,
  type AdminRow,
  type UnitChain,
} from './unit-jurisdiction';

// Shared jurisdiction helper (design D2) — ONE source of truth, now defined
// in unit-jurisdiction.ts and re-exported here so existing callers keep their
// import path. Behavior is unchanged; the invitation green tests guard it.
export { chainQuery, findUnitInJurisdiction } from './unit-jurisdiction';
export type { AdminRow, UnitChain } from './unit-jurisdiction';

/**
 * Persisted invitation row. Only the SHA-256 digest (`token_hash`) is ever
 * stored — raw tokens never reach the repository (spec R3).
 */
export interface InvitationRow {
  id: string;
  token_hash: string;
  unit_id: string;
  created_by: string;
  expires_at: string;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const INVITATION_COLUMNS = [
  'id',
  'token_hash',
  'unit_id',
  'created_by',
  'expires_at',
  'status',
  'created_at',
  'updated_at',
  'deleted_at',
];

export const invitationRepository = {
  /** Finds a non-soft-deleted invitation by token hash (trailing trx? — D2). */
  async findActiveByTokenHash(
    hash: string,
    trx: Knex = connection,
  ): Promise<InvitationRow | undefined> {
    return trx('invitations')
      .select(INVITATION_COLUMNS)
      .where({ token_hash: hash })
      .whereNull('deleted_at')
      .first();
  },

  /** Active unit → building → condominium chain, or undefined (design D8). */
  async findUnitChain(unitId: string, trx: Knex = connection): Promise<UnitChain | undefined> {
    return chainQuery(trx).where('units.id', unitId).first();
  },

  /**
   * Jurisdiction-scoped chain lookup — delegates to the shared helper in
   * unit-jurisdiction.ts (design D2, single source of truth). Unknown/cross/
   * soft-deleted → undefined (byte-identical 404 upstream). Fail closed:
   * any other role sees nothing.
   */
  async findUnitInJurisdiction(
    unitId: string,
    admin: AdminRow,
  ): Promise<UnitChain | undefined> {
    return findUnitInJurisdiction(unitId, admin);
  },

  /**
   * Persists an invitation as `status = 'active'`. `expires_at` arrives as a
   * knex raw (D7: `datetime('now', '+N hours')` — same-statement `now` as the
   * `created_at` default ⇒ identical base timestamp).
   */
  async insert(
    data: {
      id: string;
      token_hash: string;
      unit_id: string;
      created_by: string;
      expires_at: string | Knex.Raw;
    },
    trx: Knex = connection,
  ): Promise<void> {
    await trx('invitations').insert({ ...data, status: 'active' });
  },

  /**
   * Single-use consume guard (design D2): only a non-soft-deleted `active`
   * invitation flips to `used`. Returns the number of affected rows — 0 means
   * a concurrent accept already consumed it (409 upstream). Soft-deleted
   * rows count as absent (`whereNull deleted_at`), matching
   * `findActiveByTokenHash` semantics.
   */
  async markUsed(id: string, trx: Knex = connection): Promise<number> {
    return trx('invitations')
      .where({ id, status: 'active' })
      .whereNull('deleted_at')
      .update({ status: 'used', updated_at: trx.fn.now() });
  },
};