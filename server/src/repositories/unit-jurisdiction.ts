import type { Knex } from 'knex';
import connection from '../../db/connection';

/**
 * Shared jurisdiction predicate (design D2) — ONE source of truth for the
 * security-critical unit → building → condominium chain lookup used by
 * invitation issuance/accept and (from PR-2 on) expense emission.
 *
 * `invitation.repository.ts` re-exports these symbols; behavior is guarded by
 * the existing invitation green tests — a silent regression here is a FAIL.
 * Fail closed: any role outside the admin set sees nothing.
 */

/**
 * Read-only chain projection (units ⋈ buildings ⋈ condominiums). Names only
 * are exposed publicly.
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

export const CHAIN_COLUMNS = [
  'units.id as unit_id',
  'units.number as unit_number',
  'buildings.id as building_id',
  'buildings.name as building_name',
  'condominiums.id as condominium_id',
  'condominiums.name as condominium_name',
];

const ADMIN_ROLES = new Set(['superadmin', 'condo_admin', 'building_admin']);

/** Active chain projection query (soft-deleted chain members count as absent). */
export function chainQuery(db: Knex) {
  return db('units')
    .join('buildings', 'buildings.id', 'units.building_id')
    .join('condominiums', 'condominiums.id', 'buildings.condominium_id')
    .select(CHAIN_COLUMNS)
    .whereNull('units.deleted_at')
    .whereNull('buildings.deleted_at')
    .whereNull('condominiums.deleted_at');
}

/**
 * Jurisdiction-scoped chain lookup: superadmin → any active unit;
 * condo_admin → units whose `buildings.condominium_id` equals the admin's;
 * building_admin → units of its own building; unknown/cross/soft-deleted →
 * undefined (byte-identical 404 upstream). Fail closed: any other role sees
 * nothing.
 */
export async function findUnitInJurisdiction(
  unitId: string,
  admin: AdminRow,
  db: Knex = connection,
): Promise<UnitChain | undefined> {
  if (!ADMIN_ROLES.has(admin.role)) {
    return undefined;
  }
  const query = chainQuery(db);
  if (admin.role === 'condo_admin') {
    query.where('condominiums.id', admin.condominium_id);
  } else if (admin.role === 'building_admin') {
    query.where('buildings.id', admin.building_id);
  }
  return query.where('units.id', unitId).first();
}