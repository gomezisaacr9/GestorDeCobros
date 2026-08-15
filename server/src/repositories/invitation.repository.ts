import type { Knex } from 'knex';
import connection from '../../db/connection';

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

/**
 * Read-only chain projection (units ⋈ buildings ⋈ condominiums) used by both
 * resolve and accept (design D8). Names only are exposed publicly.
 */
export interface UnitChain {
  unit_id: string;
  unit_number: string;
  building_id: string;
  building_name: string;
  condominium_id: string;
  condominium_name: string;
}

/**
 * Minimal admin shape consumed by the jurisdiction predicates (role + the two
 * relevant FKs). `UserRow` satisfies it structurally.
 */
export interface AdminRow {
  id: string;
  role: string;
  condominium_id: string | null;
  building_id: string | null;
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

const CHAIN_COLUMNS = [
  'units.id as unit_id',
  'units.number as unit_number',
  'buildings.id as building_id',
  'buildings.name as building_name',
  'condominiums.id as condominium_id',
  'condominiums.name as condominium_name',
];

const ADMIN_ROLES = new Set(['superadmin', 'condo_admin', 'building_admin']);

function chainQuery(db: Knex) {
  return db('units')
    .join('buildings', 'buildings.id', 'units.building_id')
    .join('condominiums', 'condominiums.id', 'buildings.condominium_id')
    .select(CHAIN_COLUMNS)
    .whereNull('units.deleted_at')
    .whereNull('buildings.deleted_at')
    .whereNull('condominiums.deleted_at');
}

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
   * Jurisdiction-scoped chain lookup (design D3): superadmin → any active
   * unit; condo_admin → units whose `buildings.condominium_id` equals the
   * admin's; building_admin → units of its own building; unknown/cross/
   * soft-deleted → undefined (byte-identical 404 upstream). Fail closed:
   * any other role sees nothing.
   */
  async findUnitInJurisdiction(
    unitId: string,
    admin: AdminRow,
  ): Promise<UnitChain | undefined> {
    if (!ADMIN_ROLES.has(admin.role)) {
      return undefined;
    }
    const query = chainQuery(connection);
    if (admin.role === 'condo_admin') {
      query.where('condominiums.id', admin.condominium_id);
    } else if (admin.role === 'building_admin') {
      query.where('buildings.id', admin.building_id);
    }
    return query.where('units.id', unitId).first();
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