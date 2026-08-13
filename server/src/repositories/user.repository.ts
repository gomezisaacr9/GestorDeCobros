import connection from '../../db/connection';

/**
 * Persisted user row. `password_hash` and `deleted_at` are repository-internal:
 * they never appear in API responses (controllers map to the public shape).
 */
export interface UserRow {
  id: string;
  email: string;
  role: string;
  name: string | null;
  password_hash: string;
  deleted_at: string | null;
}

const USER_COLUMNS = ['id', 'email', 'role', 'name', 'password_hash', 'deleted_at'];

export const userRepository = {
  /** Finds an active (non-soft-deleted) user by email. */
  async findByEmail(email: string): Promise<UserRow | undefined> {
    return connection('users')
      .select(USER_COLUMNS)
      .where({ email })
      .whereNull('deleted_at')
      .first();
  },

  /** Finds an active (non-soft-deleted) user by id. */
  async findById(id: string): Promise<UserRow | undefined> {
    return connection('users')
      .select(USER_COLUMNS)
      .where({ id })
      .whereNull('deleted_at')
      .first();
  },

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await connection('users')
      .where({ id })
      .update({ password_hash: passwordHash, updated_at: connection.fn.now() });
  },
};