import type { Knex } from 'knex';
import connection from '../../../db/connection';

/**
 * Persisted user row. `password_hash` and `deleted_at` are repository-internal:
 * they never appear in API responses (controllers map to the public shape).
 * Jurisdiction FKs are exposed — D3 (`findUnitInJurisdiction`) reads
 * `condominium_id`/`building_id` off the admin row.
 */
export interface UserRow {
  id: string;
  email: string;
  role: string;
  name: string | null;
  password_hash: string;
  condominium_id: string | null;
  building_id: string | null;
  unit_id: string | null;
  deleted_at: string | null;
}

const USER_COLUMNS = [
  'id',
  'email',
  'role',
  'name',
  'password_hash',
  'condominium_id',
  'building_id',
  'unit_id',
  'deleted_at',
];

export const userRepository = {
  /** Finds an active (non-soft-deleted) user by email. */
  async findByEmail(email: string, trx: Knex = connection): Promise<UserRow | undefined> {
    return trx('users')
      .select(USER_COLUMNS)
      .where({ email })
      .whereNull('deleted_at')
      .first();
  },

  /** Finds an active (non-soft-deleted) user by id. */
  async findById(id: string, trx: Knex = connection): Promise<UserRow | undefined> {
    return trx('users')
      .select(USER_COLUMNS)
      .where({ id })
      .whereNull('deleted_at')
      .first();
  },

  /**
   * Finds a user by email REGARDLESS of soft-delete (invitation accept needs
   * the physical row to branch on `deleted_at` — spec R5 S11).
   */
  async findAnyByEmail(email: string, trx: Knex = connection): Promise<UserRow | undefined> {
    return trx('users').select(USER_COLUMNS).where({ email }).first();
  },

  /** Inserts a user row (jurisdiction FKs default to NULL — relaxed 007 CHECK). */
  async insert(
    data: {
      id: string;
      email: string;
      password_hash: string;
      role: string;
      name?: string | null;
      condominium_id?: string | null;
      building_id?: string | null;
      unit_id?: string | null;
    },
    trx: Knex = connection,
  ): Promise<void> {
    await trx('users').insert(data);
  },

  async updatePasswordHash(
    id: string,
    passwordHash: string,
    trx: Knex = connection,
  ): Promise<void> {
    await trx('users')
      .where({ id })
      .update({ password_hash: passwordHash, updated_at: trx.fn.now() });
  },
};