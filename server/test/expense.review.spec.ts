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
 * Guarded review + state machine (PR-3, design D4; spec R4 S22–S29 and R5
 * S30–S31). Drives the REAL app — `POST /api/v1/payments/:paymentId/review`.
 * Jurisdiction is DB-resolved: superadmin → any payment; condo_admin → only
 * payments whose expense's condominium matches the admin's; otherwise 404
 * byte-identical to a nonexistent payment (S24, never 403). The review is a
 * 3-step SINGLE transaction (D4): guarded payment flip → latest-payment check
 * → guarded expense flip; ANY failure rolls back (S25/S26/S31). S27 relies on
 * the pool `min:1 max:1` serializing one connection — exactly one concurrent
 * review flips first and the loser sees 0 affected rows ⇒ 409. Machine
 * scenarios S30/S31 prove the full PENDING → UNDER_REVIEW → APPROVED/REJECTED
 * walk with unbounded REJECTED → UNDER_REVIEW retries (R5). Per the design's
 * Testing Strategy table the service behavior is proven at the HTTP layer
 * (tasks 3.1.1 review part + 3.2.1).
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

async function seedUser(
  role: string,
  fks: { condominiumId?: string; buildingId?: string } = {},
): Promise<{ id: string; role: string }> {
  const id = randomUUID();
  await connection('users').insert({
    id,
    email: `${role}-${id}@gp.test`,
    password_hash: DUMMY_HASH,
    role,
    name: null,
    condominium_id: fks.condominiumId ?? null,
    building_id: fks.buildingId ?? null,
    unit_id: null,
  });
  return { id, role };
}

/** Seed one resident ALREADY linked to the unit (report precondition). */
async function seedLinkedResident(unitId: string): Promise<{ id: string; role: string }> {
  const resident = await seedUser('resident');
  await connection('resident_units').insert({ user_id: resident.id, unit_id: unitId });
  return resident;
}

async function seedExpense(
  unitId: string,
  period: string,
  overrides: { status?: string } = {},
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
  return id;
}

/**
 * Seed one payment. `createdAt` pins the row's timestamp so "latest
 * payment" is deterministic (`created_at DESC, id DESC`, design D5) — SQLite
 * time has 1-second resolution, so API-created payments could otherwise tie.
 */
async function seedPayment(
  expenseId: string,
  residentId: string,
  status: string,
  opts: { createdAt?: string; overrides?: Record<string, unknown> } = {},
): Promise<string> {
  const id = randomUUID();
  const row: Record<string, unknown> = {
    id,
    expense_id: expenseId,
    resident_id: residentId,
    proof_url: 'https://img.example.com/receipt.jpg',
    status,
    ...opts.overrides,
  };
  if (opts.createdAt) {
    row.created_at = opts.createdAt;
    row.updated_at = opts.createdAt;
  }
  await connection('payments').insert(row);
  return id;
}

const session = (user: { id: string; role: string }): string =>
  signToken({ sub: user.id, role: user.role });

/** Full report flow via the API, returning the created payment id. */
async function reportViaApi(app: ReturnType<typeof createApp>, token: string, expenseId: string): Promise<string> {
  const res = await appRequest(app, 'POST', `/api/v1/expenses/${expenseId}/payments`, {
    token,
    body: { proof_url: 'https://img.example.com/receipt.jpg' },
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

describe('payment review + state machine (POST /api/v1/payments/:paymentId/review, R4 S22–S29; R5 S30–S31)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  describe('guarded review (R4 S22–S29)', () => {

  it('S22: superadmin approves → 200 terminal; later report/review are 409', async () => {
    const { unitId } = await seedChain();
    const superadmin = await seedUser('superadmin');
    const resident = await seedLinkedResident(unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'under_review' });
    const p1 = await seedPayment(expenseId, resident.id, 'under_review');
    const app = createApp();
    const token = session(superadmin);

    const res = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
      token,
      body: { decision: 'approved' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual([
      'decision',
      'expense_id',
      'expense_status',
      'id',
      'updated_at',
    ]); // EXACTLY the R4 keys
    expect(body.id).toBe(p1);
    expect(body.decision).toBe('approved');
    expect(body.expense_id).toBe(expenseId);
    expect(body.expense_status).toBe('approved');
    expect(body.updated_at).toBeDefined();

    const payment = await connection('payments').where({ id: p1 }).first();
    expect(payment.status).toBe('approved');
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('approved'); // terminal (S22)

    // Later reports/reviews on it are 409.
    const report = await appRequest(app, 'POST', `/api/v1/expenses/${expenseId}/payments`, {
      token: session(resident),
      body: { proof_url: 'https://img.example.com/late.jpg' },
    });
    expect(report.status).toBe(409);
    const reReview = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
      token,
      body: { decision: 'rejected' },
    });
    expect(reReview.status).toBe(409);
  });

  it('S23: condo admin rejects inside its scope → 200; resident may report again', async () => {
    const { unitId, condoId } = await seedChain();
    const condoAdmin = await seedUser('condo_admin', { condominiumId: condoId });
    const resident = await seedLinkedResident(unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'under_review' });
    const p1 = await seedPayment(expenseId, resident.id, 'under_review');
    const app = createApp();

    const res = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
      token: session(condoAdmin),
      body: { decision: 'rejected' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.expense_status).toBe('rejected');
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('rejected');

    // S15 retry — the resident may now report again.
    const retry = await appRequest(app, 'POST', `/api/v1/expenses/${expenseId}/payments`, {
      token: session(resident),
      body: { proof_url: 'https://img.example.com/retry.jpg' },
    });
    expect(retry.status).toBe(201);
  });

  it('S24: cross-jurisdiction review is a byte-identical 404 and nothing changes', async () => {
    const mine = await seedChain('Torre Norte');
    const other = await seedChain('Parque Central', 'Edificio B', '202');
    const condoAdminC1 = await seedUser('condo_admin', { condominiumId: mine.condoId });
    const resident = await seedLinkedResident(other.unitId);
    const expenseOther = await seedExpense(other.unitId, '2026-07', { status: 'under_review' });
    const paymentOther = await seedPayment(expenseOther, resident.id, 'under_review');
    const app = createApp();
    const token = session(condoAdminC1);

    const cross = await appRequest(app, 'POST', `/api/v1/payments/${paymentOther}/review`, {
      token,
      body: { decision: 'approved' },
    });
    const unknown = await appRequest(app, 'POST', `/api/v1/payments/${randomUUID()}/review`, {
      token,
      body: { decision: 'approved' },
    });

    expect(cross.status).toBe(404);
    expect(unknown.status).toBe(404);
    const crossBody = await cross.json();
    const unknownBody = await unknown.json();
    expect(crossBody).toEqual(unknownBody); // byte-identical (S24)
    expect(crossBody.error).toBe('Pago no encontrado');

    const payment = await connection('payments').where({ id: paymentOther }).first();
    expect(payment.status).toBe('under_review'); // nothing changed (S24)
    const expense = await connection('expenses').where({ id: expenseOther }).first();
    expect(expense.status).toBe('under_review');
  });

  it('S25: re-reviewing a decided payment is 409 and the expense does not change', async () => {
    const { unitId } = await seedChain();
    const superadmin = await seedUser('superadmin');
    const resident = await seedLinkedResident(unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'under_review' });
    const p1 = await seedPayment(expenseId, resident.id, 'rejected'); // already decided
    const app = createApp();

    const res = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
      token: session(superadmin),
      body: { decision: 'approved' },
    });

    expect(res.status).toBe(409); // 0-row guarded update (S25)
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('under_review'); // not changed (S25)
    const payment = await connection('payments').where({ id: p1 }).first();
    expect(payment.status).toBe('rejected');
  });

  it('S26: reviewing a non-latest payment is 409 and the newer one stays under_review', async () => {
    const { unitId } = await seedChain();
    const superadmin = await seedUser('superadmin');
    const resident = await seedLinkedResident(unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'under_review' });
    // p1 older and already rejected; p2 under_review is the latest.
    const p1 = await seedPayment(expenseId, resident.id, 'rejected', {
      createdAt: '2026-07-01 00:00:00',
    });
    const p2 = await seedPayment(expenseId, resident.id, 'under_review', {
      createdAt: '2026-07-02 00:00:00',
    });
    const app = createApp();

    const res = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
      token: session(superadmin),
      body: { decision: 'approved' },
    });

    expect(res.status).toBe(409); // stale payment ⇒ 409 (S26)
    const p2Row = await connection('payments').where({ id: p2 }).first();
    expect(p2Row.status).toBe('under_review'); // untouched (S26)
    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('under_review');
  });

  it('S27: double-review race on one under_review payment → exactly one 200, one 409', async () => {
    const { unitId } = await seedChain();
    const superadmin = await seedUser('superadmin');
    const resident = await seedLinkedResident(unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'under_review' });
    const p1 = await seedPayment(expenseId, resident.id, 'under_review');
    const app = createApp();
    const token = session(superadmin);

    const [winner, loser] = await Promise.all([
      appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
        token,
        body: { decision: 'approved' },
      }),
      appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
        token,
        body: { decision: 'rejected' },
      }),
    ]);

    const statuses = [winner.status, loser.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]); // exactly one winner (S27)
    const winningBody = winner.status === 200 ? await winner.json() : await loser.json();
    const expense = await connection('expenses').where({ id: expenseId }).first();
    // The final expense_status equals the winner's decision (S27).
    expect(expense.status).toBe(winningBody.expense_status);
    expect(['approved', 'rejected']).toContain(expense.status);
    const payment = await connection('payments').where({ id: p1 }).first();
    expect(payment.status).toBe(expense.status);
  });

  it('S28: resident and building_admin → 403 Prohibido, controller never runs', async () => {
    const { unitId, condoId, buildingId } = await seedChain();
    const resident = await seedLinkedResident(unitId);
    const buildingAdmin = await seedUser('building_admin', { condominiumId: condoId, buildingId });
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'under_review' });
    const p1 = await seedPayment(expenseId, resident.id, 'under_review');
    const app = createApp();

    for (const actor of [resident, buildingAdmin]) {
      const res = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
        token: session(actor),
        body: { decision: 'approved' },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Prohibido' });
    }
    const payment = await connection('payments').where({ id: p1 }).first();
    expect(payment.status).toBe('under_review'); // untouched
  });

  it('S29: nonexistent payment → 404 with the generic body', async () => {
    const superadmin = await seedUser('superadmin');

    const res = await appRequest(createApp(), 'POST', `/api/v1/payments/${randomUUID()}/review`, {
      token: session(superadmin),
      body: { decision: 'approved' },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Pago no encontrado' });
  });
  }); // describe 'guarded review (R4 S22–S29)'

  describe('state machine (R5 S30–S31)', () => {

  it('S30: reopen cycle walks pending → under_review → rejected → under_review → approved', async () => {
    const { unitId } = await seedChain();
    const superadmin = await seedUser('superadmin');
    const resident = await seedLinkedResident(unitId);
    // Emit via API so the machine starts at `pending` for real.
    const app = createApp();
    const residentToken = session(resident);
    const adminToken = session(superadmin);
    const emit = await appRequest(app, 'POST', '/api/v1/expenses', {
      token: adminToken,
      body: {
        unit_id: unitId,
        amount_cents: 1234050,
        concept: 'Expensas julio',
        period: '2026-07',
      },
    });
    expect(emit.status).toBe(201);
    const expenseId = (await emit.json()).id as string;

    // 1. report → pending → under_review (p1).
    const p1 = await reportViaApi(app, residentToken, expenseId);
    // Pin p1 in the past so the next API-created payment is provably latest.
    await connection('payments')
      .where({ id: p1 })
      .update({ created_at: '2026-07-01 00:00:00', updated_at: '2026-07-01 00:00:00' });

    // 2. reject p1 → under_review → rejected.
    const reject = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
      token: adminToken,
      body: { decision: 'rejected' },
    });
    expect(reject.status).toBe(200);
    expect((await reject.json()).expense_status).toBe('rejected');

    // 3. report again → rejected → under_review with a NEW payment (p2).
    const p2 = await reportViaApi(app, residentToken, expenseId);
    expect(p2).not.toBe(p1);

    // 4. approve p2 → under_review → approved (terminal).
    const approve = await appRequest(app, 'POST', `/api/v1/payments/${p2}/review`, {
      token: adminToken,
      body: { decision: 'approved' },
    });
    expect(approve.status).toBe(200);
    expect((await approve.json()).expense_status).toBe('approved');

    const expense = await connection('expenses').where({ id: expenseId }).first();
    expect(expense.status).toBe('approved');
    const payments = await connection('payments')
      .select('id', 'status')
      .where({ expense_id: expenseId })
      .orderBy('created_at', 'asc');
    expect(payments.map((p) => p.status)).toEqual(['rejected', 'approved']); // p1: rejected, p2: approved
    expect(payments[0].id).toBe(p1);
    expect(payments[1].id).toBe(p2);
  });

  it('S31: every invalid edge is 409 without mutating either row', async () => {
    const { unitId } = await seedChain();
    const superadmin = await seedUser('superadmin');
    const resident = await seedLinkedResident(unitId);
    const expenseId = await seedExpense(unitId, '2026-07', { status: 'under_review' });
    const p1 = await seedPayment(expenseId, resident.id, 'under_review', {
      createdAt: '2026-07-01 00:00:00',
    });
    const app = createApp();
    const residentToken = session(resident);
    const adminToken = session(superadmin);

    // (1) second report while under_review → 409, nothing changes.
    const secondReport = await appRequest(app, 'POST', `/api/v1/expenses/${expenseId}/payments`, {
      token: residentToken,
      body: { proof_url: 'https://img.example.com/second.jpg' },
    });
    expect(secondReport.status).toBe(409);
    expect((await connection('payments').where({ expense_id: expenseId })).length).toBe(1);
    expect((await connection('expenses').where({ id: expenseId }).first()).status).toBe('under_review');

    // (2) first review decides p1 → 200.
    const firstReview = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
      token: adminToken,
      body: { decision: 'approved' },
    });
    expect(firstReview.status).toBe(200);

    // (3) re-review of the same payment → 409, BOTH rows unchanged (S31).
    const reReview = await appRequest(app, 'POST', `/api/v1/payments/${p1}/review`, {
      token: adminToken,
      body: { decision: 'rejected' },
    });
    expect(reReview.status).toBe(409);
    expect((await connection('payments').where({ id: p1 }).first()).status).toBe('approved');
    expect((await connection('expenses').where({ id: expenseId }).first()).status).toBe('approved');

    // (4) review of a non-latest payment → 409, both unchanged.
    // Fresh scenario: p1 under_review (old), p2 under_review (latest), expense under_review.
    const expense2 = await seedExpense(unitId, '2026-08', { status: 'under_review' });
    const oldP = await seedPayment(expense2, resident.id, 'under_review', {
      createdAt: '2026-07-01 00:00:00',
    });
    await seedPayment(expense2, resident.id, 'under_review', { createdAt: '2026-07-02 00:00:00' });
    const stale = await appRequest(app, 'POST', `/api/v1/payments/${oldP}/review`, {
      token: adminToken,
      body: { decision: 'approved' },
    });
    expect(stale.status).toBe(409);
    const rows = await connection('payments')
      .select('status')
      .where({ expense_id: expense2 })
      .orderBy('created_at', 'asc');
    expect(rows.map((r) => r.status)).toEqual(['under_review', 'under_review']); // untouched
    expect((await connection('expenses').where({ id: expense2 }).first()).status).toBe('under_review');
  });
  }); // describe 'state machine (R5 S30–S31)'
});