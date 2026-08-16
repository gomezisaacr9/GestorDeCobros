import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest, signToken } from './helpers/http';
import { createApp } from '../src/app';
import { condominiumService } from '../src/modules/hierarchy/condominium.service';
import { buildingService } from '../src/modules/hierarchy/building.service';
import { unitService } from '../src/modules/hierarchy/unit.service';
import { expenseRepository } from '../src/modules/expenses/expense.repository';

/**
 * Resident payment report (PR-3, design D4/D8; spec R3 S14–S21). Drives the
 * REAL app — `POST /api/v1/expenses/:id/payments`. Membership is proven via
 * `listUnitIdsByUser`-family `existsLink` (design R3: expense must belong to a
 * linked unit; otherwise byte-identical 404 «Gasto no encontrado»). The
 * guarded expense flip (`pending|rejected → under_review`, 0 rows ⇒ 409) plus
 * the payment insert run in ONE transaction (ANY failure rolls back). S21
 * (concurrent reports) relies on the knex pool `min:1 max:1` serializing one
 * better-sqlite3 connection: exactly one guarded flip wins (design "Races").
 * Per the design's Testing Strategy table, service behavior is proven at the
 * HTTP layer in this single spec (tasks 3.1.1 + 3.2.1 — same pattern as
 * PR-2's admin spec).
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

/**
 * Seed one payment. `createdAt` pins the row's timestamp so "latest" is
 * deterministic (`created_at DESC, id DESC` — design D5): SQLite time has
 * 1-second resolution, so API-created payments could otherwise tie.
 */
async function seedPayment(
  expenseId: string,
  residentId: string,
  status: string,
  opts: { createdAt?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const row: Record<string, unknown> = {
    id,
    expense_id: expenseId,
    resident_id: residentId,
    proof_url: 'https://img.example.com/receipt.jpg',
    status,
  };
  if (opts.createdAt) {
    row.created_at = opts.createdAt;
    row.updated_at = opts.createdAt;
  }
  await connection('payments').insert(row);
  return id;
}

const residentSession = (user: { id: string; role: string }): string =>
  signToken({ sub: user.id, role: user.role });

describe('expense payment report (POST /api/v1/expenses/:id/payments, R3 S14–S21)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('S14: happy report flips the expense in one tx → 201 exact public shape', async () => {
    const { unitId } = await seedChain();
    const resident = await seedResident();
    await linkResident(resident.id, unitId);
    const expenseId = await seedExpense(unitId, '2026-07');

    const res = await appRequest(createApp(), 'POST', `/api/v1/expenses/${expenseId}/payments`, {
      token: residentSession(resident),
      body: { proof_url: 'https://img.example.com/receipt.jpg' },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, string>;
    // R3: EXACTLY the five keys — no resident_id, no updated_at, no deleted_at.
    expect(Object.keys(body).sort()).toEqual([
      'created_at',
      'expense_id',
      'id',
      'proof_url',
      'status',
    ]);
    expect(body.expense_id).toBe(expenseId);
    expect(body.proof_url).toBe('https://img.example.com/receipt.jpg');
    expect(body.status).toBe('under_review');
    expect(body.created_at).toBeDefined();

    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('under_review'); // flipped in the same tx (S14)
    const payments = await connection('payments').where({ expense_id: expenseId });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('under_review');
    expect(payments[0].id).toBe(body.id);
  });

  it('S15: rejected expense retries with a NEW payment → 201, different id', async () => {
    const { unitId } = await seedChain();
    const resident = await seedResident();
    await linkResident(resident.id, unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'rejected' });
    // Previous rejected payment pinned to the past so the new one is latest.
    const p1 = await seedPayment(expenseId, resident.id, 'rejected', {
      createdAt: '2026-07-01 00:00:00',
    });

    const res = await appRequest(createApp(), 'POST', `/api/v1/expenses/${expenseId}/payments`, {
      token: residentSession(resident),
      body: { proof_url: 'https://img.example.com/retry.jpg' },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).not.toBe(p1); // DIFFERENT payment id (S15)
    expect(body.status).toBe('under_review');
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('under_review'); // returns to under_review
    expect((await connection('payments').where({ expense_id: expenseId })).length).toBe(2);
  });

  it('S16: report while under_review → 409 and no second payment row', async () => {
    const { unitId } = await seedChain();
    const resident = await seedResident();
    await linkResident(resident.id, unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'under_review' });
    await seedPayment(expenseId, resident.id, 'under_review', {
      createdAt: '2026-07-01 00:00:00',
    });

    const res = await appRequest(createApp(), 'POST', `/api/v1/expenses/${expenseId}/payments`, {
      token: residentSession(resident),
      body: { proof_url: 'https://img.example.com/second.jpg' },
    });

    expect(res.status).toBe(409);
    const payments = await connection('payments').where({ expense_id: expenseId });
    expect(payments).toHaveLength(1); // no second row (S16)
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('under_review'); // unchanged
  });

  it('S17: report on approved (terminal) → 409', async () => {
    const { unitId } = await seedChain();
    const resident = await seedResident();
    await linkResident(resident.id, unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'approved' });
    await seedPayment(expenseId, resident.id, 'approved', {
      createdAt: '2026-07-01 00:00:00',
    });

    const res = await appRequest(createApp(), 'POST', `/api/v1/expenses/${expenseId}/payments`, {
      token: residentSession(resident),
      body: { proof_url: 'https://img.example.com/late.jpg' },
    });

    expect(res.status).toBe(409);
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('approved');
  });

  it('S18: neighbor expense is a byte-identical 404 and the expense never changes', async () => {
    const { unitId: u1 } = await seedChain();
    const { unitId: u2 } = await seedChain('Parque Central', 'Edificio B', '202');
    const resident = await seedResident();
    await linkResident(resident.id, u1);
    const neighborExpenseId = await seedExpense(u2, '2026-07');
    const app = createApp();
    const token = residentSession(resident);

    const neighbor = await appRequest(app, 'POST', `/api/v1/expenses/${neighborExpenseId}/payments`, {
      token,
      body: { proof_url: 'https://img.example.com/x.jpg' },
    });
    const unknown = await appRequest(app, 'POST', `/api/v1/expenses/${randomUUID()}/payments`, {
      token,
      body: { proof_url: 'https://img.example.com/x.jpg' },
    });

    expect(neighbor.status).toBe(404);
    expect(unknown.status).toBe(404);
    const neighborBody = await neighbor.json();
    const unknownBody = await unknown.json();
    expect(neighborBody).toEqual(unknownBody); // byte-identical (S18)
    expect(neighborBody.error).toBe('Gasto no encontrado');
    const expense = await connection('expenses').where({ id: neighborExpenseId }).first();
    expect(expense.status).toBe('pending'); // never changes (S18)
    expect((await connection('payments').where({ expense_id: neighborExpenseId })).length).toBe(0);
  });

  it('S19: nonexistent expense → 404 with the same generic body', async () => {
    const resident = await seedResident();

    const res = await appRequest(createApp(), 'POST', `/api/v1/expenses/${randomUUID()}/payments`, {
      token: residentSession(resident),
      body: { proof_url: 'https://img.example.com/x.jpg' },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Gasto no encontrado' });
  });

  it('S20: non-http(s) proof rejected → 400 and no payment row', async () => {
    const { unitId } = await seedChain();
    const resident = await seedResident();
    await linkResident(resident.id, unitId);
    const expenseId = await seedExpense(unitId, '2026-07');
    const app = createApp();
    const token = residentSession(resident);

    const badUrls = ['ftp://files/x', 'javascript:alert(1)', 'not-a-url'];
    for (const proof_url of badUrls) {
      const res = await appRequest(app, 'POST', `/api/v1/expenses/${expenseId}/payments`, {
        token,
        body: { proof_url },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Solicitud inválida');
      expect(Array.isArray(json.details)).toBe(true);
    }

    expect((await connection('payments').where({ expense_id: expenseId })).length).toBe(0);
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('pending'); // no mutation on 400
  });

  it('S21: concurrent reports on a rejected expense → exactly one 201, one 409', async () => {
    const { unitId } = await seedChain();
    const resident = await seedResident();
    await linkResident(resident.id, unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'rejected' });
    await seedPayment(expenseId, resident.id, 'rejected', {
      createdAt: '2026-07-01 00:00:00',
    });
    const app = createApp();
    const token = residentSession(resident);

    const [a, b] = await Promise.all([
      appRequest(app, 'POST', `/api/v1/expenses/${expenseId}/payments`, {
        token,
        body: { proof_url: 'https://img.example.com/a.jpg' },
      }),
      appRequest(app, 'POST', `/api/v1/expenses/${expenseId}/payments`, {
        token,
        body: { proof_url: 'https://img.example.com/b.jpg' },
      }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]); // guarded transition wins (S21)
    const payments = await connection('payments')
      .select('status')
      .where({ expense_id: expenseId });
    expect(payments).toHaveLength(2); // seed + exactly one winner
    expect(payments.filter((p) => p.status === 'under_review')).toHaveLength(1);
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('under_review');
  });
});