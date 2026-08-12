import crypto from 'node:crypto';
import type { Knex } from 'knex';

// Provisional superadmin seed credentials — MUST be rotated on first login (future auth change).
const SEED_EMAIL = 'root@gestionpagos.local';
const SEED_PASSWORD = 'ChangeMe!2026';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/**
 * Builds a self-describing scrypt hash string:
 * `scrypt$N$r$p$saltHex$hashHex` — parameters embedded so a future auth
 * implementation can verify with `crypto.scrypt` without re-negotiating.
 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary();
    table.string('email').notNullable().unique();
    table.string('password_hash').notNullable();
    table.string('role').notNullable();
    table.uuid('condominium_id').nullable().references('id').inTable('condominiums');
    table.uuid('building_id').nullable().references('id').inTable('buildings');
    table.uuid('unit_id').nullable().references('id').inTable('units');
    table.timestamps(true, true);
    table.timestamp('deleted_at').nullable();
    table.index(['condominium_id'], 'idx_users_condominium_id');
    table.index(['building_id'], 'idx_users_building_id');
    table.index(['unit_id'], 'idx_users_unit_id');
    table.index(['role'], 'idx_users_role');
    // RBAC jurisdiction rule — superadmin > condo_admin > building_admin > resident.
    // Any role outside the four branches fails the check.
    table.check(
      `(role = 'superadmin'     AND condominium_id IS NULL     AND building_id IS NULL     AND unit_id IS NULL)
       OR (role = 'condo_admin'    AND condominium_id IS NOT NULL AND building_id IS NULL     AND unit_id IS NULL)
       OR (role = 'building_admin' AND condominium_id IS NOT NULL AND building_id IS NOT NULL AND unit_id IS NULL)
       OR (role = 'resident'       AND condominium_id IS NOT NULL AND building_id IS NOT NULL AND unit_id IS NOT NULL)`,
    );
  });

  await knex('users').insert({
    id: crypto.randomUUID(),
    email: SEED_EMAIL,
    password_hash: hashPassword(SEED_PASSWORD),
    role: 'superadmin',
    condominium_id: null,
    building_id: null,
    unit_id: null,
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
