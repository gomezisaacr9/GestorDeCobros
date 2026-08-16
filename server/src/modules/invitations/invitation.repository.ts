import type { Knex } from 'knex';
import connection from '../../../db/connection';

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