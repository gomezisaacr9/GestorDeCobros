import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { expenseRepository } from '../src/repositories/expense.repository';
import { paymentRepository } from '../src/repositories/payment.repository';

/**
 * Payment repository (PR-1 Foundation, design D1/D4/D5): insert with
 * `under_review` default, `findWithCondominium` (chain join → condominium_id,
 * the source of 404 + jurisdiction for review), the single-flip guarded
 * `updateStatusGuarded` and the deterministic latest-payment lookups
 * (`created_at DESC, id DESC`, soft-deleted excluded) consumed by the review
 * latest-check (D4) and the panel merge (D5).
 */

const PERIOD = '2026-07';
const PW = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);

async function seedChain(): Promise<{ condoId: string; buildingId: string; unitId: string }> {
  const condoId = randomUUID();
  const buildingId = randomUUID();
  const unitId = randomUUID();
  await connection('condominiums').insert({ id: condoId, name: 'Pagos Norte' });
  await connection('buildings').insert({ id: buildingId, condominium_id: condoId, name: 'Edificio A' });
  await connection('units').insert({ id: unitId, building_id: buildingId, number: '101' });
  return { condoId, buildingId, unitId };
}

/** Resident user (relaxed 007 CHECK allows jurisdiction-free rows). */
async function seedResident(): Promise<string> {
  const id = randomUUID();
  await connection('users').insert({
    id,
    email: `resident-${id}@gp.test`,
    password_hash: PW,
    role: 'resident',
    name: null,
  });
  return id;
}

async function seedExpense(unitId: string, period: string = PERIOD): Promise<string> {
  const id = randomUUID();
  await expenseRepository.insert({
    id,
    unit_id: unitId,
    amount_cents: 1234050,
    concept: 'Expensas julio',
    period,
  });
  return id;
}

async function seedPayment(expenseId: string, residentId: string): Promise<string> {
  const id = randomUUID();
  await paymentRepository.insert({
    id,
    expense_id: expenseId,
    resident_id: residentId,
    proof_url: 'https://img.example.com/receipt.jpg',
  });
  return id;
}

describe('payment repository', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('insert persists a row whose status defaults to under_review', async () => {
    const { unitId } = await seedChain();
    const residentId = await seedResident();
    const expenseId = await seedExpense(unitId);
    const id = await seedPayment(expenseId, residentId);

    const row = await connection('payments').where({ id }).first();
    expect(row.expense_id).toBe(expenseId);
    expect(row.resident_id).toBe(residentId);
    expect(row.proof_url).toBe('https://img.example.com/receipt.jpg');
    expect(row.status).toBe('under_review');
  });

  it('findWithCondominium resolves the chain through expenses → units → buildings → condominiums', async () => {
    const { condoId, buildingId, unitId } = await seedChain();
    const residentId = await seedResident();
    const expenseId = await seedExpense(unitId);
    const id = await seedPayment(expenseId, residentId);

    const found = await paymentRepository.findWithCondominium(id);
    expect(found?.id).toBe(id);
    expect(found?.expense_id).toBe(expenseId);
    expect(found?.status).toBe('under_review');
    expect(found?.condominium_id).toBe(condoId);

    // Mismatch-proof: the fixture chain is the only one; the join is real.
    expect(await paymentRepository.findWithCondominium(randomUUID())).toBeUndefined();
    void buildingId;
  });

  it('findWithCondominium treats a soft-deleted payment as absent (404 semantics)', async () => {
    const { unitId } = await seedChain();
    const residentId = await seedResident();
    const expenseId = await seedExpense(unitId);
    const id = await seedPayment(expenseId, residentId);
    await connection('payments').where({ id }).update({ deleted_at: connection.fn.now() });

    expect(await paymentRepository.findWithCondominium(id)).toBeUndefined();
  });

  it('updateStatusGuarded flips under_review once and reports 0 rows afterwards', async () => {
    const { unitId } = await seedChain();
    const residentId = await seedResident();
    const expenseId = await seedExpense(unitId);
    const id = await seedPayment(expenseId, residentId);

    expect(await paymentRepository.updateStatusGuarded(id, 'approved')).toBe(1);
    const row = await connection('payments').where({ id }).first();
    expect(row.status).toBe('approved');

    // One flip per payment: decided payments are terminal at this layer.
    expect(await paymentRepository.updateStatusGuarded(id, 'rejected')).toBe(0);
    expect(await paymentRepository.updateStatusGuarded(randomUUID(), 'approved')).toBe(0);
  });

  it('updateStatusGuarded never flips soft-deleted payments', async () => {
    const { unitId } = await seedChain();
    const residentId = await seedResident();
    const expenseId = await seedExpense(unitId);
    const id = await seedPayment(expenseId, residentId);
    await connection('payments').where({ id }).update({ deleted_at: connection.fn.now() });

    expect(await paymentRepository.updateStatusGuarded(id, 'approved')).toBe(0);
    const row = await connection('payments').where({ id }).first();
    expect(row.status).toBe('under_review');
  });

  it('latestByExpenseId resolves by created_at DESC then id DESC, skipping deleted rows', async () => {
    const { unitId } = await seedChain();
    const residentId = await seedResident();
    const expenseId = await seedExpense(unitId);

    // Explicit controlled ids with equal created_at → greater id wins.
    await connection('payments').insert({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expense_id: expenseId,
      resident_id: residentId,
      proof_url: 'https://img.example.com/a.jpg',
      status: 'rejected',
      created_at: '2026-07-01 00:00:00',
    });
    await connection('payments').insert({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expense_id: expenseId,
      resident_id: residentId,
      proof_url: 'https://img.example.com/b.jpg',
      status: 'under_review',
      created_at: '2026-07-01 00:00:00',
    });

    let latest = await paymentRepository.latestByExpenseId(expenseId);
    expect(latest?.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    // A strictly newer created_at outranks id ordering.
    await connection('payments')
      .where({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
      .update({ created_at: '2026-08-01 00:00:00' });
    latest = await paymentRepository.latestByExpenseId(expenseId);
    expect(latest?.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    // Soft-deleted rows are never the "latest".
    await connection('payments')
      .where({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
      .update({ deleted_at: connection.fn.now() });
    latest = await paymentRepository.latestByExpenseId(expenseId);
    expect(latest?.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    expect(await paymentRepository.latestByExpenseId(randomUUID())).toBeUndefined();
  });

  it('latestByExpenseIds returns only the given expenses, ordered so the first per expense is the latest', async () => {
    const { unitId } = await seedChain();
    const residentId = await seedResident();
    // Two expenses on the SAME unit need distinct periods (partial unique
    // index on (unit_id, period) forbids two active rows on one pair).
    const expenseA = await seedExpense(unitId, '2026-07');
    const expenseB = await seedExpense(unitId, '2026-08');

    // eA: rejected (older) + under_review (newer). eB: single approved.
    await connection('payments').insert({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expense_id: expenseA,
      resident_id: residentId,
      proof_url: 'https://img.example.com/c.jpg',
      status: 'rejected',
      created_at: '2026-07-01 00:00:00',
    });
    await connection('payments').insert({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      expense_id: expenseA,
      resident_id: residentId,
      proof_url: 'https://img.example.com/d.jpg',
      status: 'under_review',
      created_at: '2026-07-02 00:00:00',
    });
    await connection('payments').insert({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expense_id: expenseB,
      resident_id: residentId,
      proof_url: 'https://img.example.com/e.jpg',
      status: 'approved',
      created_at: '2026-07-01 00:00:00',
    });

    const rows = await paymentRepository.latestByExpenseIds([expenseA, expenseB]);
    // All three payments present (2 for eA, 1 for eB), newest FIRST globally
    // (contract: first occurrence per expense = its latest payment, D5).
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd'); // newest row overall
    const firstPerExpense = new Map<string, string>();
    for (const row of rows) {
      if (!firstPerExpense.has(row.expense_id)) firstPerExpense.set(row.expense_id, row.id);
    }
    expect(firstPerExpense.get(expenseA)).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(firstPerExpense.get(expenseB)).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

    expect(await paymentRepository.latestByExpenseIds([])).toEqual([]);
  });

  it('insert honors the trailing transaction (rollback removes the row)', async () => {
    const { unitId } = await seedChain();
    const residentId = await seedResident();
    const expenseId = await seedExpense(unitId);
    const id = randomUUID();

    const trx = await connection.transaction();
    await paymentRepository.insert(
      { id, expense_id: expenseId, resident_id: residentId, proof_url: 'https://img.example.com/tx.jpg' },
      trx,
    );
    await trx.rollback();

    expect(await connection('payments').where({ id }).first()).toBeUndefined();
  });
});