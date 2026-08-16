import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { expenseRepository } from '../src/modules/expenses/expense.repository';

/**
 * Expense repository (PR-1 Foundation, design D1/D3): insert with `pending`
 * default, active-row lookups (post / unit+period), panel join with
 * `unit_number`, the guarded `updateStatusGuarded(from[] → to)` transition,
 * DB-level duplicate invariant (partial unique index) and trailing-trx
 * semantics. The SQLITE_CONSTRAINT_UNIQUE → 409 mapping is service-layer
 * (design D3, PR-2) — this spec pins the raw DB contract the service maps.
 */

const PERIOD = '2026-07';
const PW = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);

async function seedChain(): Promise<{ condoId: string; buildingId: string; unitId: string }> {
  const condoId = randomUUID();
  const buildingId = randomUUID();
  const unitId = randomUUID();
  await connection('condominiums').insert({ id: condoId, name: 'Repos Norte' });
  await connection('buildings').insert({ id: buildingId, condominium_id: condoId, name: 'Edificio A' });
  await connection('units').insert({ id: unitId, building_id: buildingId, number: '101' });
  return { condoId, buildingId, unitId };
}

async function seedExpense(unitId: string): Promise<string> {
  const id = randomUUID();
  await expenseRepository.insert({
    id,
    unit_id: unitId,
    amount_cents: 1234050,
    concept: 'Expensas julio',
    period: PERIOD,
  });
  return id;
}

describe('expense repository', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('insert persists a row whose status defaults to pending', async () => {
    const { unitId } = await seedChain();
    const id = await seedExpense(unitId);

    const row = await connection('expenses').where({ id }).first();
    expect(row.unit_id).toBe(unitId);
    expect(row.amount_cents).toBe(1234050); // integer cents roundtrip
    expect(row.concept).toBe('Expensas julio');
    expect(row.period).toBe(PERIOD);
    expect(row.status).toBe('pending');
  });

  it('insert rejects an ACTIVE duplicate (unit_id, period) via the partial unique index', async () => {
    const { unitId } = await seedChain();
    await seedExpense(unitId);

    const attempt = expenseRepository.insert({
      id: randomUUID(),
      unit_id: unitId,
      amount_cents: 1500000,
      concept: 'Duplicada',
      period: PERIOD,
    });
    await expect(attempt).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' });
  });

  it('findActiveByUnitPeriod finds the active row and skips soft-deleted ones', async () => {
    const { unitId } = await seedChain();
    const id = await seedExpense(unitId);
    // Second row on a DIFFERENT period (the partial unique index forbids two
    // active rows on the same pair), then soft-deleted.
    const other = randomUUID();
    await expenseRepository.insert({
      id: other,
      unit_id: unitId,
      amount_cents: 999999,
      concept: 'Expensas agosto',
      period: '2026-08',
    });
    await connection('expenses').where({ id: other }).update({ deleted_at: connection.fn.now() });

    const found = await expenseRepository.findActiveByUnitPeriod(unitId, PERIOD);
    expect(found?.id).toBe(id);
    expect(found?.status).toBe('pending');

    // The soft-deleted row no longer counts as active for ITS period.
    expect(await expenseRepository.findActiveByUnitPeriod(unitId, '2026-08')).toBeUndefined();
    expect(await expenseRepository.findActiveByUnitPeriod(randomUUID(), PERIOD)).toBeUndefined();
  });

  it('findActiveById returns the active row or undefined (missing/soft-deleted)', async () => {
    const { unitId } = await seedChain();
    const id = await seedExpense(unitId);

    const found = await expenseRepository.findActiveById(id);
    expect(found?.id).toBe(id);
    expect(found?.period).toBe(PERIOD);

    expect(await expenseRepository.findActiveById(randomUUID())).toBeUndefined();
    await connection('expenses').where({ id }).update({ deleted_at: connection.fn.now() });
    expect(await expenseRepository.findActiveById(id)).toBeUndefined();
  });

  it('listByUnitIds joins unit_number, excludes soft-deleted, and handles an empty list', async () => {
    const { unitId } = await seedChain();
    const id = await seedExpense(unitId);
    // A second unit in the same building; a soft-deleted expense there.
    const unit2 = randomUUID();
    await connection('units').insert({ id: unit2, building_id: (await connection('units').where({ id: unitId }).first()).building_id, number: '202' });
    const deleted = await seedExpense(unit2);
    await connection('expenses').where({ id: deleted }).update({ deleted_at: connection.fn.now() });

    const rows = await expenseRepository.listByUnitIds([unitId, unit2]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].unit_id).toBe(unitId);
    expect(rows[0].unit_number).toBe('101');
    expect(rows[0].amount_cents).toBe(1234050);
    expect(rows[0]).not.toHaveProperty('deleted_at');

    expect(await expenseRepository.listByUnitIds([])).toEqual([]);
  });

  it('updateStatusGuarded flips only matching from-statuses and reports affected rows', async () => {
    const { unitId } = await seedChain();
    const id = await seedExpense(unitId);

    expect(await expenseRepository.updateStatusGuarded(id, ['pending', 'rejected'], 'under_review')).toBe(1);
    const row = await connection('expenses').where({ id }).first();
    expect(row.status).toBe('under_review');

    // Guarded: already under_review is not in the allowed from-set.
    expect(await expenseRepository.updateStatusGuarded(id, ['pending', 'rejected'], 'under_review')).toBe(0);
    expect(await expenseRepository.updateStatusGuarded(id, ['under_review'], 'approved')).toBe(1);
    expect(await expenseRepository.updateStatusGuarded(id, ['under_review'], 'approved')).toBe(0);
    expect(await expenseRepository.updateStatusGuarded(randomUUID(), ['under_review'], 'approved')).toBe(0);
  });

  it('updateStatusGuarded never touches soft-deleted expenses', async () => {
    const { unitId } = await seedChain();
    const id = await seedExpense(unitId);
    await connection('expenses').where({ id }).update({ deleted_at: connection.fn.now() });

    expect(await expenseRepository.updateStatusGuarded(id, ['pending'], 'under_review')).toBe(0);
    const row = await connection('expenses').where({ id }).first();
    expect(row.status).toBe('pending');
  });

  it('updateStatusGuarded honors the trailing transaction (rollback leaves the old status)', async () => {
    const { unitId } = await seedChain();
    const id = await seedExpense(unitId);

    const trx = await connection.transaction();
    await expenseRepository.updateStatusGuarded(id, ['pending'], 'under_review', trx);
    await trx.rollback();

    const row = await connection('expenses').where({ id }).first();
    expect(row.status).toBe('pending');
  });

  it('insert honors the trailing transaction (rollback removes the row)', async () => {
    const { unitId } = await seedChain();
    const id = randomUUID();

    const trx = await connection.transaction();
    await expenseRepository.insert(
      { id, unit_id: unitId, amount_cents: 9900, concept: 'En tx', period: '2026-08' },
      trx,
    );
    await trx.rollback();

    expect(await connection('expenses').where({ id }).first()).toBeUndefined();
  });
});