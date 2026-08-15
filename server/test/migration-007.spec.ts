import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest } from './helpers/db';

/**
 * Migration 007 — `invitations`, `resident_units` and the rebuilt `users`
 * table with the relaxed RBAC CHECK (resident branch no longer constrains
 * jurisdiction FKs; membership lives in `resident_units`).
 *
 * Covers tenant-data-model scenarios: tables exist, UNIQUE token_hash,
 * status CHECK, composite PK, relaxed resident CHECK, seed preservation
 * across the users rebuild, one-step rollback restoring the exact 004 CHECK,
 * and a clean re-run.
 */

const CONDO_ID = '11111111-1111-4111-8111-111111111111';
const BUILDING_ID = '22222222-2222-4222-8222-222222222222';
const UNIT_A = '33333333-3333-4333-8333-333333333333';
const UNIT_B = '44444444-4444-4444-8444-444444444444';
const USER_FREE = '55555555-5555-4555-8555-555555555555';
const USER_LEGACY = '66666666-6666-4666-8666-666666666666';
const USER_MN = '77777777-7777-4777-8777-777777777777';
const SEED_EMAIL = 'root@gestionpagos.local';
const PW = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);

async function insertParentChain(): Promise<void> {
  await connection('condominiums').insert({ id: CONDO_ID, name: 'Migración Probes' });
  await connection('buildings').insert({ id: BUILDING_ID, condominium_id: CONDO_ID, name: 'Probe B' });
  await connection('units').insert({ id: UNIT_A, building_id: BUILDING_ID, number: '101' });
  await connection('units').insert({ id: UNIT_B, building_id: BUILDING_ID, number: '102' });
}

async function usersDdl(): Promise<string> {
  const rows = (await connection.raw(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  )) as Array<{ sql: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].sql as string;
}

async function residentUnitsDdl(): Promise<string> {
  const rows = (await connection.raw(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resident_units'",
  )) as Array<{ sql: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].sql as string;
}

describe('migration 007 — invitations + resident_units + relaxed users CHECK', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('creates invitations and resident_units and keeps the 11-column users table', async () => {
    const invites = await connection('invitations').columnInfo();
    expect(invites.id).toBeDefined();
    expect(invites.token_hash).toBeDefined();
    expect(invites.token_hash.nullable).toBe(false);
    expect(invites.unit_id).toBeDefined();
    expect(invites.unit_id.nullable).toBe(false);
    expect(invites.created_by).toBeDefined();
    expect(invites.created_by.nullable).toBe(false);
    expect(invites.expires_at).toBeDefined();
    expect(invites.expires_at.nullable).toBe(false);
    expect(invites.status).toBeDefined();
    expect(invites.status.nullable).toBe(false);
    expect(invites.created_at).toBeDefined();
    expect(invites.updated_at).toBeDefined();
    expect(invites.deleted_at).toBeDefined();

    const ru = await connection('resident_units').columnInfo();
    expect(ru.user_id).toBeDefined();
    expect(ru.user_id.nullable).toBe(false);
    expect(ru.unit_id).toBeDefined();
    expect(ru.unit_id.nullable).toBe(false);
    expect(ru.created_at).toBeDefined();
    expect(ru.created_at.nullable).toBe(false);
    // Spec: no `id` column and no `deleted_at`.
    expect(ru.id).toBeUndefined();
    expect(ru.deleted_at).toBeUndefined();

    const users = await connection('users').columnInfo();
    for (const col of [
      'id',
      'email',
      'password_hash',
      'name',
      'role',
      'condominium_id',
      'building_id',
      'unit_id',
      'created_at',
      'updated_at',
      'deleted_at',
    ]) {
      expect(users[col]).toBeDefined();
    }
  });

  it('rebuilds users with the relaxed CHECK (resident branch unconstrained)', async () => {
    const ddl = await usersDdl();
    expect(ddl).toContain("OR (role = 'resident')");
    // The 004 resident branch (`AND unit_id IS NOT NULL` etc.) must be gone;
    // only the admin branches keep `unit_id IS NULL`.
    expect(ddl).not.toContain('unit_id IS NOT NULL');
  });

  it('allows a resident without any jurisdiction FK (relaxed CHECK)', async () => {
    await connection('users').insert({
      id: USER_FREE,
      email: 'resident-free@gp.test',
      password_hash: PW,
      role: 'resident',
      name: 'Free Resident',
    });
    const row = await connection('users').where({ id: USER_FREE }).first();
    expect(row.email).toBe('resident-free@gp.test');
    expect(row.role).toBe('resident');
    expect(row.condominium_id).toBeNull();
    expect(row.building_id).toBeNull();
    expect(row.unit_id).toBeNull();
  });

  it('accepts a legacy 004-shaped resident with all three jurisdiction FKs', async () => {
    await insertParentChain();
    await connection('users').insert({
      id: USER_LEGACY,
      email: 'resident-legacy@gp.test',
      password_hash: PW,
      role: 'resident',
      condominium_id: CONDO_ID,
      building_id: BUILDING_ID,
      unit_id: UNIT_A,
      name: 'Legacy Resident',
    });
    const row = await connection('users').where({ id: USER_LEGACY }).first();
    expect(row.condominium_id).toBe(CONDO_ID);
    expect(row.building_id).toBe(BUILDING_ID);
    expect(row.unit_id).toBe(UNIT_A);
  });

  it('rejects a superadmin with jurisdiction FKs (admin branches unchanged)', async () => {
    const attempt = connection('users').insert({
      id: '99999999-9999-4999-8999-999999999999',
      email: 'super-bad@gp.test',
      password_hash: PW,
      role: 'superadmin',
      condominium_id: CONDO_ID,
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('rejects a condo_admin without condominium (admin branches unchanged)', async () => {
    const attempt = connection('users').insert({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'condo-bad@gp.test',
      password_hash: PW,
      role: 'condo_admin',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('preserves every legacy user row — exactly one superadmin, seed intact (no reseed)', async () => {
    const supers = await connection('users').where({ role: 'superadmin' });
    expect(supers).toHaveLength(1);
    expect(supers[0].email).toBe(SEED_EMAIL);
    expect(supers[0].password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(supers[0].condominium_id).toBeNull();
    expect(supers[0].building_id).toBeNull();
    expect(supers[0].unit_id).toBeNull();

    const legacy = await connection('users').where({ id: USER_LEGACY }).first();
    expect(legacy.email).toBe('resident-legacy@gp.test');
    expect(legacy.password_hash).toBe(PW);
    expect(legacy.role).toBe('resident');
    expect(legacy.unit_id).toBe(UNIT_A);
  });

  it('enforces UNIQUE on token_hash', async () => {
    const seed = await connection('users').where({ email: SEED_EMAIL }).first();
    const inv = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      token_hash: 'token-hash-1',
      unit_id: UNIT_A,
      created_by: seed.id,
      expires_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
    };
    await connection('invitations').insert(inv);
    const attempt = connection('invitations').insert({ ...inv, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  });

  it('enforces the status CHECK (only active|used)', async () => {
    const seed = await connection('users').where({ email: SEED_EMAIL }).first();
    const attempt = connection('invitations').insert({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      token_hash: 'token-hash-2',
      unit_id: UNIT_A,
      created_by: seed.id,
      expires_at: '2026-01-01T00:00:00.000Z',
      status: 'expired',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('declares a composite PRIMARY KEY (user_id, unit_id) on resident_units', async () => {
    const ddl = await residentUnitsDdl();
    expect(ddl).toMatch(/PRIMARY\s+KEY\s*\([^)]*user_id[^)]*unit_id[^)]*\)/i);
  });

  it('enforces the composite PRIMARY KEY — duplicate membership rejected', async () => {
    await connection('users').insert({
      id: USER_MN,
      email: 'resident-mn@gp.test',
      password_hash: PW,
      role: 'resident',
    });
    await connection('resident_units').insert({ user_id: USER_MN, unit_id: UNIT_A });
    const attempt = connection('resident_units').insert({ user_id: USER_MN, unit_id: UNIT_A });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
  });

  it('allows one resident to belong to multiple units (M:N)', async () => {
    await connection('resident_units').insert({ user_id: USER_MN, unit_id: UNIT_B });
    const rows = await connection('resident_units').where({ user_id: USER_MN });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.unit_id).sort()).toEqual([UNIT_A, UNIT_B].sort());
  });

  it('down() drops both new tables and restores the 004 CHECK, preserving compliant rows', async () => {
    // Rows legal under the relaxed 007 CHECK (no jurisdiction FKs) violate the
    // restored 004 CHECK, so they must not survive the rebuild in `down()`.
    await connection('resident_units').where({ user_id: USER_MN }).del();
    await connection('users').whereIn('email', ['resident-free@gp.test', 'resident-mn@gp.test']).del();

    await connection.migrate.down();

    expect(await connection.schema.hasTable('invitations')).toBe(false);
    expect(await connection.schema.hasTable('resident_units')).toBe(false);

    // Every 004-compliant row survives: seed + legacy resident.
    const users = await connection('users').select('id', 'email');
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.email).sort()).toEqual([SEED_EMAIL, 'resident-legacy@gp.test'].sort());
    const supers = await connection('users').where({ role: 'superadmin' });
    expect(supers).toHaveLength(1);
    expect(supers[0].password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);

    // 004 CHECK restored: the relaxed resident branch is gone and a resident
    // without jurisdiction FKs is rejected again.
    const ddl = await usersDdl();
    expect(ddl).toContain('unit_id IS NOT NULL');
    expect(ddl).not.toContain("OR (role = 'resident')");
    const strict = connection('users').insert({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      email: 'strict-resident@gp.test',
      password_hash: PW,
      role: 'resident',
    });
    await expect(strict).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });

    // `name` column (005) survives the down() rebuild untouched.
    const usersInfo = await connection('users').columnInfo();
    expect(usersInfo.name).toBeDefined();
  });

  it('re-runs migrate:latest cleanly, restoring the 007 shape', async () => {
    await migrateToLatest(connection);

    expect(await connection.schema.hasTable('invitations')).toBe(true);
    expect(await connection.schema.hasTable('resident_units')).toBe(true);

    // Relaxed CHECK works again after the full down/up cycle.
    await connection('users').insert({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      email: 'relaxed-again@gp.test',
      password_hash: PW,
      role: 'resident',
    });
    const row = await connection('users').where({ email: 'relaxed-again@gp.test' }).first();
    expect(row.role).toBe('resident');
    expect(row.unit_id).toBeNull();

    const supers = await connection('users').where({ role: 'superadmin' });
    expect(supers).toHaveLength(1);
    expect(supers[0].password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
  });
});