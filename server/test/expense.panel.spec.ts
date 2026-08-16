import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest, signToken } from './helpers/http';
import { createApp } from '../src/app';
import { condominiumService } from '../src/services/condominium.service';
import { buildingService } from '../src/services/building.service';
import { unitService } from '../src/services/unit.service';
import { expenseRepository } from '../src/modules/expenses/expense.repository';

/**
 * Resident panel (PR-2, design D5; spec R2 S10–S13). Drives the REAL app —
 * `GET /api/v1/expenses/mine`. Membership filter via `listUnitIdsByUser`
 * (single SQL filter, design R2); `payment_status` merged from
 * `latestByExpenseIds` (`created_at DESC, id DESC`, first-per-expense) and
 * NEVER `proof_url`. Service behavior is proven at the HTTP layer per the
 * design's Testing Strategy table (task 2.2.2).
 */

const DUMMY_HASH = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);

async function seedChain(
  condoName = 'Torre Norte',
  buildingName = 'Edificio A',
  number = '101',
): Promise<{ condoId: string; buildingId: string; unitId: string }> {
  const condo = await condominiumService.create(condoName);
  const building = await buildingService.create(buildingName, condo.id);
  const unit = await unitService.create(number, building.id);
  return { condoId: condo.id, buildingId: building.id, unitId: unit.id };
}

async function seedResident(): Promise<{ id: string; role: string }> {
  const id = randomUUID();
  await connection('users').insert({
    id,
    email: `resident-${id}@gp.test`,
    password_hash: DUMMY_HASH,
    role: 'resident',
    name: null,
    condominium_id: null,
    building_id: null,
    unit_id: null,
  });
  return { id, role: 'resident' };
}

async function linkResident(userId: string, unitId: string): Promise<void> {
  await connection('resident_units').insert({ user_id: userId, unit_id: unitId });
}

async function seedExpense(
  unitId: string,
  period: string,
  overrides: { status?: string; softDeleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await expenseRepository.insert({
    id,
    unit_id: unitId,
    amount_cents: 1234050,
    concept: `Expensas ${period}`,
    period,
  });
  if (overrides.status && overrides.status !== 'pending') {
    await connection('expenses')
      .where({ id })
      .update({ status: overrides.status, updated_at: connection.fn.now() });
  }
  if (overrides.softDeleted) {
    await connection('expenses').where({ id }).update({ deleted_at: connection.fn.now() });
  }
  return id;
}

async function seedPayment(expenseId: string, residentId: string, status: string): Promise<string> {
  const id = randomUUID();
  await connection('payments').insert({
    id,
    expense_id: expenseId,
    resident_id: residentId,
    proof_url: 'https://img.example.com/receipt.jpg',
    status,
  });
  return id;
}

const residentSession = (user: { id: string; role: string }): string =>
  signToken({ sub: user.id, role: user.role });

describe('expense resident panel (GET /api/v1/expenses/mine, R2 S10–S13)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('S10: resident sees own active expenses with unit_number, payment_status, and NO proof_url', async () => {
    const { unitId } = await seedChain();
    const resident = await seedResident();
    await linkResident(resident.id, unitId);

    // u1: one expense rejected after a payment report, one with no payments,
    // one soft-deleted (must NOT appear).
    const rejectedId = await seedExpense(unitId, '2026-07', { status: 'rejected' });
    await seedPayment(rejectedId, resident.id, 'rejected');
    const noPaymentId = await seedExpense(unitId, '2026-08');
    await seedExpense(unitId, '2026-06', { softDeleted: true });

    const res = await appRequest(createApp(), 'GET', '/api/v1/expenses/mine', {
      token: residentSession(resident),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, string | null>>;
    expect(body).toHaveLength(2); // exactly the two active items
    const byId = new Map(body.map((item) => [String(item.id), item]));

    const rejected = byId.get(rejectedId)!;
    expect(rejected.unit_id).toBe(unitId);
    expect(rejected.unit_number).toBe('101');
    expect(rejected.payment_status).toBe('rejected');
    expect(rejected.status).toBe('rejected');
    expect(rejected.amount_cents).toBe(1234050);

    const noPayment = byId.get(noPaymentId)!;
    expect(noPayment.unit_number).toBe('101');
    expect(noPayment.payment_status).toBeNull();

    // No item — including the caller's own — carries proof_url or deleted_at.
    for (const item of body) {
      expect(item).not.toHaveProperty('proof_url');
      expect(item).not.toHaveProperty('deleted_at');
    }
  });

  it('S11: resident with no resident_units rows → 200 []', async () => {
    const resident = await seedResident();

    const res = await appRequest(createApp(), 'GET', '/api/v1/expenses/mine', {
      token: residentSession(resident),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('S12: neighbor isolation — an expense on u2 never appears for resident A of u1', async () => {
    const { unitId: u1 } = await seedChain();
    const { unitId: u2 } = await seedChain('Parque Central', 'Edificio B', '202');
    const residentA = await seedResident();
    await linkResident(residentA.id, u1);
    await seedExpense(u2, '2026-07');

    const res = await appRequest(createApp(), 'GET', '/api/v1/expenses/mine', {
      token: residentSession(residentA),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, string | null>>;
    expect(body).toHaveLength(0);
    const byUnit = body.map((item) => item.unit_id);
    expect(byUnit).not.toContain(u2);
  });

  it('S13: guard matrix — no session → 401, condo_admin → 403', async () => {
    const { condoId } = await seedChain();
    const noSession = await appRequest(createApp(), 'GET', '/api/v1/expenses/mine');
    expect(noSession.status).toBe(401);
    expect(await noSession.json()).toEqual({ error: 'No autorizado' });

    const condoAdmin = {
      id: randomUUID(),
      role: 'condo_admin',
    };
    await connection('users').insert({
      id: condoAdmin.id,
      email: `condo-${condoAdmin.id}@gp.test`,
      password_hash: DUMMY_HASH,
      role: 'condo_admin',
      name: null,
      condominium_id: condoId,
      building_id: null,
      unit_id: null,
    });

    const forbidden = await appRequest(createApp(), 'GET', '/api/v1/expenses/mine', {
      token: residentSession(condoAdmin),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'Prohibido' });
  });
});