import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';

/**
 * Migration 008 — `expenses` and `payments` (common-fee lifecycle, design D1).
 *
 * Covers the tenant-data-model delta scenarios: tables exist with CHECKs and
 * FK columns, the raw-SQL partial unique index (`(unit_id, period)` only for
 * `deleted_at IS NULL`) rejects active duplicates while allowing soft-deleted
 * ones, amount/period/status CHECKs are enforced, orphan expense/payment rows
 * are rejected by the FKs, the latest payment resolves by recency then id,
 * one-step rollback drops only the 008 tables, a clean re-run restores them,
 * and the test wipe order never fires FK constraints with rows in every table.
 */

const PERIOD = '2026-07';
const PW = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);

async function tableDdl(name: string): Promise<string> {
  const rows = (await connection.raw(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  )) as Array<{ sql: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].sql as string;
}

async function indexDdl(name: string): Promise<string> {
  const rows = (await connection.raw(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    [name],
  )) as Array<{ sql: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].sql as string;
}

async function insertParentChain(): Promise<{ unitId: string }> {
  const condoId = randomUUID();
  const buildingId = randomUUID();
  const unitId = randomUUID();
  await connection('condominiums').insert({ id: condoId, name: 'Expensas Probes' });
  await connection('buildings').insert({ id: buildingId, condominium_id: condoId, name: 'Probe B' });
  await connection('units').insert({ id: unitId, building_id: buildingId, number: '101' });
  return { unitId };
}

/** Seeded superadmin (migration 004) doubles as a valid `users` FK target. */
async function adminId(): Promise<string> {
  const row = await connection('users').where({ role: 'superadmin' }).first();
  expect(row).toBeDefined();
  return row.id;
}

async function insertExpense(
  unitId: string,
  overrides: Partial<{ amount_cents: number; period: string; status: string }> = {},
): Promise<string> {
  const id = randomUUID();
  await connection('expenses').insert({
    id,
    unit_id: unitId,
    amount_cents: overrides.amount_cents ?? 1500000,
    concept: 'Expensas probe',
    period: overrides.period ?? PERIOD,
    status: overrides.status ?? 'pending',
  });
  return id;
}

async function insertPayment(
  expenseId: string,
  overrides: Partial<{ resident_id: string; status: string; created_at: string; id: string }> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await connection('payments').insert({
    id,
    expense_id: expenseId,
    resident_id: overrides.resident_id ?? RESIDENT_FALLBACK,
    proof_url: 'https://img.example.com/receipt.jpg',
    status: overrides.status ?? 'under_review',
    created_at: overrides.created_at ?? '2026-07-01 00:00:00',
  });
  return id;
}

// Placeholder for the payment helper default — callers pass a real resident.
const RESIDENT_FALLBACK = '00000000-0000-4000-8000-000000000000';

describe('migration 008 — expenses + payments', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('creates the expenses table with the 008 columns, unit FK and pending default', async () => {
    const columns = await connection('expenses').columnInfo();
    for (const col of [
      'id',
      'unit_id',
      'amount_cents',
      'concept',
      'period',
      'status',
      'created_at',
      'updated_at',
      'deleted_at',
    ]) {
      expect(columns[col]).toBeDefined();
    }
    expect(columns.unit_id.nullable).toBe(false);
    expect(columns.amount_cents.nullable).toBe(false);
    expect(columns.period.nullable).toBe(false);
    expect(columns.status.nullable).toBe(false);
    expect(columns.deleted_at.nullable).toBe(true);

    const ddl = await tableDdl('expenses');
    expect(ddl).toMatch(/references\s*`?units`?\s*\(`?id`?\)/i);
    expect(ddl).toMatch(/default\s*'pending'/i);

    // Behavioral default: omitting status yields 'pending'.
    const { unitId } = await insertParentChain();
    const id = await insertExpense(unitId, {});
    const row = await connection('expenses').where({ id }).first();
    expect(row.status).toBe('pending');
    expect(row.amount_cents).toBe(1500000);
  });

  it('creates the payments table with the 008 columns, FKs and under_review default', async () => {
    const columns = await connection('payments').columnInfo();
    for (const col of [
      'id',
      'expense_id',
      'resident_id',
      'proof_url',
      'status',
      'created_at',
      'updated_at',
      'deleted_at',
    ]) {
      expect(columns[col]).toBeDefined();
    }
    expect(columns.expense_id.nullable).toBe(false);
    expect(columns.resident_id.nullable).toBe(false);
    expect(columns.proof_url.nullable).toBe(false);
    expect(columns.status.nullable).toBe(false);
    expect(columns.deleted_at.nullable).toBe(true);

    const ddl = await tableDdl('payments');
    expect(ddl).toMatch(/references\s*`?expenses`?\s*\(`?id`?\)/i);
    expect(ddl).toMatch(/references\s*`?users`?\s*\(`?id`?\)/i);
    expect(ddl).toMatch(/default\s*'under_review'/i);

    // Behavioral default: omitting status yields 'under_review'.
    const { unitId } = await insertParentChain();
    const expenseId = await insertExpense(unitId);
    const admin = await adminId();
    const id = await insertPayment(expenseId, { resident_id: admin });
    const row = await connection('payments').where({ id }).first();
    expect(row.status).toBe('under_review');
  });

  it('declares all four 008 indexes, including the partial unique one', async () => {
    const partial = await indexDdl('idx_expenses_unique_unit_period_active');
    expect(partial).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
    expect(partial).toMatch(/ON\s+expenses\s*\(unit_id,\s*period\)/i);
    // Partial: only covers rows with deleted_at IS NULL (S9 path).
    expect(partial).toMatch(/WHERE\s+deleted_at\s+IS\s+NULL/i);

    for (const name of ['idx_expenses_unit_id', 'idx_payments_expense_id', 'idx_payments_resident_id']) {
      await expect(indexDdl(name)).resolves.toMatch(/CREATE\s+INDEX/i);
    }
  });

  it('rejects an ACTIVE duplicate (unit_id, period) with SQLITE_CONSTRAINT_UNIQUE', async () => {
    const { unitId } = await insertParentChain();
    await insertExpense(unitId);
    const attempt = connection('expenses').insert({
      id: randomUUID(),
      unit_id: unitId,
      amount_cents: 1200000,
      concept: 'Expensas duplicada',
      period: PERIOD,
      status: 'pending',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  });

  it('allows a soft-deleted duplicate — the partial index ignores deleted rows (S9)', async () => {
    const { unitId } = await insertParentChain();
    const first = await insertExpense(unitId);
    await connection('expenses').where({ id: first }).update({ deleted_at: connection.fn.now() });

    await insertExpense(unitId); // same (unit_id, period), now active — must succeed
    const rows = await connection('expenses').where({ unit_id: unitId, period: PERIOD });
    expect(rows).toHaveLength(2);
  });

  it('enforces the amount CHECK (amount_cents > 0)', async () => {
    const { unitId } = await insertParentChain();
    const attempt = connection('expenses').insert({
      id: randomUUID(),
      unit_id: unitId,
      amount_cents: 0,
      concept: 'Expensas cero',
      period: PERIOD,
      status: 'pending',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('enforces the period CHECK (YYYY-MM shape via GLOB)', async () => {
    const { unitId } = await insertParentChain();
    const attempt = connection('expenses').insert({
      id: randomUUID(),
      unit_id: unitId,
      amount_cents: 1500000,
      concept: 'Expensas mal periodo',
      period: '2026-1', // not [0-9][0-9] month
      status: 'pending',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('enforces the expenses status CHECK (pending|under_review|approved|rejected)', async () => {
    const { unitId } = await insertParentChain();
    const attempt = connection('expenses').insert({
      id: randomUUID(),
      unit_id: unitId,
      amount_cents: 1500000,
      concept: 'Expensas status raro',
      period: PERIOD,
      status: 'paid',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('rejects an orphan expense (FK → units)', async () => {
    const attempt = connection('expenses').insert({
      id: randomUUID(),
      unit_id: '99999999-9999-4999-8999-999999999999',
      amount_cents: 1500000,
      concept: 'Expensas huerfana',
      period: PERIOD,
      status: 'pending',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  });

  it('rejects an orphan payment (FK → expenses and users)', async () => {
    const attempt = connection('payments').insert({
      id: randomUUID(),
      expense_id: '99999999-9999-4999-8999-999999999999',
      resident_id: RESIDENT_FALLBACK,
      proof_url: 'https://img.example.com/receipt.jpg',
      status: 'under_review',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  });

  it('enforces the payments status CHECK (only under_review|approved|rejected)', async () => {
    const { unitId } = await insertParentChain();
    const expenseId = await insertExpense(unitId);
    const admin = await adminId();
    const attempt = connection('payments').insert({
      id: randomUUID(),
      expense_id: expenseId,
      resident_id: admin,
      proof_url: 'https://img.example.com/receipt.jpg',
      status: 'pending',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
  });

  it('resolves the latest payment by recency then id deterministically', async () => {
    const { unitId } = await insertParentChain();
    const admin = await adminId();
    const expenseId = await insertExpense(unitId);
    // Equal created_at ⇒ the greater id wins (created_at DESC, id DESC).
    const earlier = '99999999-9999-4999-8999-00000000000a';
    const later = '99999999-9999-4999-8999-00000000000b';
    await insertPayment(expenseId, { resident_id: admin, id: earlier });
    await insertPayment(expenseId, { resident_id: admin, id: later });

    const latest = await connection('payments')
      .where({ expense_id: expenseId })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first();
    expect(latest.id).toBe(later);

    // A strictly newer created_at outranks id ordering.
    await connection('payments').where({ id: earlier }).update({ created_at: '2026-08-01 00:00:00' });
    const newest = await connection('payments')
      .where({ expense_id: expenseId })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .first();
    expect(newest.id).toBe(earlier);
  });

  it('full wipe with rows in EVERY table never fires FK constraints (wipe order)', async () => {
    const { unitId } = await insertParentChain();
    const admin = await adminId();

    const residentId = randomUUID();
    await connection('users').insert({
      id: residentId,
      email: `wipe-resident-${residentId}@gp.test`,
      password_hash: PW,
      role: 'resident',
      name: null,
    });
    await connection('resident_units').insert({ user_id: residentId, unit_id: unitId });
    await connection('invitations').insert({
      id: randomUUID(),
      token_hash: `wipe-token-${randomUUID()}`,
      unit_id: unitId,
      created_by: admin,
      expires_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });
    const expenseId = await insertExpense(unitId);
    await insertPayment(expenseId, { resident_id: residentId });

    await wipe(connection); // must not throw SQLITE_CONSTRAINT_FOREIGNKEY

    for (const table of [
      'payments',
      'expenses',
      'invitations',
      'resident_units',
      'users',
      'units',
      'buildings',
      'condominiums',
    ]) {
      const rows = await connection(table).select('*');
      expect(rows).toHaveLength(0);
    }
  });

  it('down() drops payments then expenses; one-step rollback keeps the 007 tables', async () => {
    await connection.migrate.down();

    expect(await connection.schema.hasTable('payments')).toBe(false);
    expect(await connection.schema.hasTable('expenses')).toBe(false);
    // 007 tables survive this single step (restoring the 004 users CHECK now
    // takes two steps — 008 sits on top).
    expect(await connection.schema.hasTable('invitations')).toBe(true);
    expect(await connection.schema.hasTable('resident_units')).toBe(true);
    const ddl = await tableDdl('users');
    expect(ddl).toContain("OR (role = 'resident')");
  });

  it('re-runs migrate:latest cleanly, restoring the 008 shape', async () => {
    await migrateToLatest(connection);

    expect(await connection.schema.hasTable('expenses')).toBe(true);
    expect(await connection.schema.hasTable('payments')).toBe(true);
    const partial = await indexDdl('idx_expenses_unique_unit_period_active');
    expect(partial).toMatch(/WHERE\s+deleted_at\s+IS\s+NULL/i);

    const { unitId } = await insertParentChain();
    await insertExpense(unitId);
    const attempt = connection('expenses').insert({
      id: randomUUID(),
      unit_id: unitId,
      amount_cents: 1200000,
      concept: 'Expensas duplicada',
      period: PERIOD,
      status: 'pending',
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  });
});