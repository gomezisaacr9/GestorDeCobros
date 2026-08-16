import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest, signToken } from './helpers/http';
import { createApp } from '../src/app';
import { condominiumService } from '../src/services/condominium.service';
import { buildingService } from '../src/services/building.service';
import { unitService } from '../src/services/unit.service';

/**
 * Expense emission (PR-2, design D3; spec R1 S1–S9). Drives the REAL app
 * (`createApp()` mounts expenseRouter at /api/v1/expenses — the app.ts mount
 * IS exercised by every request). Admin sessions come from REAL seeded
 * `users` rows (D3 requires the DB lookup via `userRepository.findById`), the
 * JWT sub matching the row id — exactly what a production login produces.
 *
 * Per the design's Testing Strategy table, the S1–S9 service behavior is
 * proven AT THE HTTP LAYER in this single spec (tasks 2.2.1 + 2.3.1): the
 * RBAC matrix, jurisdiction anti-enumeration, and duplicate handling are all
 * status-code contracts. No separate service-level spec exists in the design.
 */

const DUMMY_HASH = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);
const PERIOD = '2026-07';

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

const session = (user: { id: string; role: string }): string =>
  signToken({ sub: user.id, role: user.role });

function validBody(unitId: string, overrides: Record<string, unknown> = {}) {
  return {
    unit_id: unitId,
    amount_cents: 1234050,
    concept: 'Expensas julio',
    period: PERIOD,
    ...overrides,
  };
}

describe('expense admin emission (POST /api/v1/expenses, R1 S1–S9)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  describe('RBAC matrix (S1–S4)', () => {
    it('S1: superadmin emits with full cents roundtrip → 201 status pending, exact shape', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');

      const res = await appRequest(createApp(), 'POST', '/api/v1/expenses', {
        token: session(superadmin),
        body: validBody(unitId),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.unit_id).toBe(unitId);
      expect(body.amount_cents).toBe(1234050); // no float drift (S1)
      expect(body.concept).toBe('Expensas julio');
      expect(body.period).toBe(PERIOD);
      expect(body.status).toBe('pending');
      expect(body.created_at).toBeDefined();
      expect(body.updated_at).toBeDefined();
      expect(body).not.toHaveProperty('deleted_at');
      expect(body).not.toHaveProperty('proof_url');
    });

    it('S2: condo_admin emits for a unit inside its condominium → 201', async () => {
      const { unitId, condoId } = await seedChain();
      const condoAdmin = await seedUser('condo_admin', { condominiumId: condoId });

      const res = await appRequest(createApp(), 'POST', '/api/v1/expenses', {
        token: session(condoAdmin),
        body: validBody(unitId),
      });

      expect(res.status).toBe(201);
      expect((await res.json()).status).toBe('pending');
    });

    it('S2: building_admin emits for a unit of its own building → 201', async () => {
      const { unitId, condoId, buildingId } = await seedChain();
      const buildingAdmin = await seedUser('building_admin', { condominiumId: condoId, buildingId: buildingId });

      const res = await appRequest(createApp(), 'POST', '/api/v1/expenses', {
        token: session(buildingAdmin),
        body: validBody(unitId),
      });

      expect(res.status).toBe(201);
      expect((await res.json()).amount_cents).toBe(1234050);
    });

    it('S3: resident → 403 Prohibido and the controller never runs', async () => {
      const { unitId } = await seedChain();
      const resident = await seedUser('resident');

      const res = await appRequest(createApp(), 'POST', '/api/v1/expenses', {
        token: session(resident),
        body: validBody(unitId),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Prohibido' });
      expect((await connection('expenses').count<{ c: number }>('* as c').first())?.c).toBe(0);
    });

    it('S4: no session → 401 from requireAuth, before any role check', async () => {
      const res = await appRequest(createApp(), 'POST', '/api/v1/expenses', {
        body: validBody(randomUUID()),
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'No autorizado' });
    });
  });

  describe('validation (S5)', () => {
    it('S5: each invalid body → 400 with details and no row created', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');
      const app = createApp();
      const token = session(superadmin);

      const invalidBodies = [
        validBody(unitId, { unit_id: 'not-a-uuid' }),
        validBody(unitId, { amount_cents: 0 }),
        validBody(unitId, { amount_cents: -50 }),
        validBody(unitId, { amount_cents: 12.34 }),
        validBody(unitId, { concept: '' }),
        validBody(unitId, { concept: 'x'.repeat(301) }),
        validBody(unitId, { period: '2026-13' }),
        validBody(unitId, { period: '2026-1' }),
      ];

      for (const body of invalidBodies) {
        const res = await appRequest(app, 'POST', '/api/v1/expenses', { token, body });
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toBe('Solicitud inválida');
        expect(Array.isArray(json.details)).toBe(true);
        expect(json.details.length).toBeGreaterThan(0);
      }

      expect((await connection('expenses').count<{ c: number }>('* as c').first())?.c).toBe(0);
    });
  });

  describe('jurisdiction anti-enumeration (S6/S7 — byte-identical 404)', () => {
    it('S6: cross-jurisdiction unit → 404 byte-identical to a nonexistent unit', async () => {
      const mine = await seedChain('Torre Norte');
      const other = await seedChain('Parque Central');
      const condoAdmin = await seedUser('condo_admin', { condominiumId: mine.condoId });
      const app = createApp();
      const token = session(condoAdmin);

      const cross = await appRequest(app, 'POST', '/api/v1/expenses', {
        token,
        body: validBody(other.unitId),
      });
      const unknown = await appRequest(app, 'POST', '/api/v1/expenses', {
        token,
        body: validBody(randomUUID()),
      });

      expect(cross.status).toBe(404);
      expect(unknown.status).toBe(404);
      const crossBody = await cross.json();
      const unknownBody = await unknown.json();
      expect(crossBody).toEqual(unknownBody);
      expect(crossBody.error).toBe('Unidad no encontrada');
    });

    it('S7: soft-deleted unit → 404 with the same generic body', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');
      await connection('units').where({ id: unitId }).update({ deleted_at: connection.fn.now() });
      const app = createApp();
      const token = session(superadmin);

      const deleted = await appRequest(app, 'POST', '/api/v1/expenses', {
        token,
        body: validBody(unitId),
      });
      const unknown = await appRequest(app, 'POST', '/api/v1/expenses', {
        token,
        body: validBody(randomUUID()),
      });

      expect(deleted.status).toBe(404);
      expect(await deleted.json()).toEqual(await unknown.json());
    });
  });

  describe('duplicates (S8/S9)', () => {
    it('S8: active duplicate (unit_id, period) → 409 and no second row', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');
      const token = session(superadmin);
      const app = createApp();

      const first = await appRequest(app, 'POST', '/api/v1/expenses', {
        token,
        body: validBody(unitId),
      });
      expect(first.status).toBe(201);

      const second = await appRequest(app, 'POST', '/api/v1/expenses', {
        token,
        body: validBody(unitId),
      });

      expect(second.status).toBe(409);
      expect((await second.json()).error).toBeDefined();
      expect((await connection('expenses').count<{ c: number }>('* as c').first())?.c).toBe(1);
    });

    it('S9: soft-deleted duplicate does not block → 201 with two physical rows', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');
      const token = session(superadmin);
      const app = createApp();

      const first = await appRequest(app, 'POST', '/api/v1/expenses', {
        token,
        body: validBody(unitId),
      });
      expect(first.status).toBe(201);
      const firstId = (await first.json()).id as string;
      await connection('expenses').where({ id: firstId }).update({ deleted_at: connection.fn.now() });

      const reemit = await appRequest(app, 'POST', '/api/v1/expenses', {
        token,
        body: validBody(unitId),
      });

      expect(reemit.status).toBe(201);
      const body = await reemit.json();
      expect(body.id).not.toBe(firstId);
      expect(body.amount_cents).toBe(1234050);
      expect((await connection('expenses').count<{ c: number }>('* as c').first())?.c).toBe(2);
    });
  });
});