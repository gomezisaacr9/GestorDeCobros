import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import cookieParser from 'cookie-parser';
import express from 'express';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest, signToken } from './helpers/http';
import { unitRouter } from '../src/modules/hierarchy/unit.routes';
import { buildingRouter } from '../src/modules/hierarchy/building.routes';
import { condominiumService } from '../src/modules/hierarchy/condominium.service';
import { buildingService } from '../src/modules/hierarchy/building.service';
import { errorHandler } from '../src/middlewares/errorHandler';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SUPERADMIN = signToken({ sub: 'user-super', role: 'superadmin' });
const CONDO_ADMIN = signToken({ sub: 'user-condo', role: 'condo_admin' });
const BUILDING_ADMIN = signToken({ sub: 'user-building', role: 'building_admin' });
const RESIDENT = signToken({ sub: 'user-res', role: 'resident' });

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/units', unitRouter);
  app.use('/api/v1/buildings', buildingRouter);
  app.use(errorHandler);
  return app;
}

async function seedBuilding(): Promise<string> {
  const condominium = await condominiumService.create('Torres del Sol');
  return (await buildingService.create('Edificio A', condominium.id)).id;
}

describe('unit routes (RBAC + CRUD + scoped list + nested 404 vs [])', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('POST / RBAC: superadmin, condo_admin and building_admin → 201; resident → 403; no cookie → 401', async () => {
    const app = buildApp();
    const buildingId = await seedBuilding();
    const body = { number: '101', building_id: buildingId };

    const superRes = await appRequest(app, 'POST', '/api/v1/units', { token: SUPERADMIN, body });
    expect(superRes.status).toBe(201);
    const condoRes = await appRequest(app, 'POST', '/api/v1/units', {
      token: CONDO_ADMIN,
      body: { number: '102', building_id: buildingId },
    });
    expect(condoRes.status).toBe(201);
    const buildingRes = await appRequest(app, 'POST', '/api/v1/units', {
      token: BUILDING_ADMIN,
      body: { number: '103', building_id: buildingId },
    });
    expect(buildingRes.status).toBe(201);
    const residentRes = await appRequest(app, 'POST', '/api/v1/units', { token: RESIDENT, body });
    expect(residentRes.status).toBe(403);
    const noCookieRes = await appRequest(app, 'POST', '/api/v1/units', { body });
    expect(noCookieRes.status).toBe(401);
  });

  it('POST / as building_admin → 201 with public shape and Location header', async () => {
    const app = buildApp();
    const buildingId = await seedBuilding();

    const res = await appRequest(app, 'POST', '/api/v1/units', {
      token: BUILDING_ADMIN,
      body: { number: '101', building_id: buildingId },
    });
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(parsed.id).toMatch(UUID_RE);
    expect(parsed.number).toBe('101');
    expect(parsed.created_at).toBeTruthy();
    expect(parsed.updated_at).toBeTruthy();
    expect(parsed).not.toHaveProperty('deleted_at');
    expect(res.headers.get('location')).toBe(`/api/v1/units/${parsed.id}`);
  });

  it('POST / with an unknown or soft-deleted parent building → 404', async () => {
    const app = buildApp();
    const buildingId = await seedBuilding();
    await connection('buildings').where({ id: buildingId }).update({ deleted_at: connection.fn.now() });

    const softDeleted = await appRequest(app, 'POST', '/api/v1/units', {
      token: SUPERADMIN,
      body: { number: '101', building_id: buildingId },
    });
    expect(softDeleted.status).toBe(404);

    const unknown = await appRequest(app, 'POST', '/api/v1/units', {
      token: SUPERADMIN,
      body: { number: '101', building_id: randomUUID() },
    });
    expect(unknown.status).toBe(404);
  });

  it('POST / with a duplicate number inside the building → 409', async () => {
    const app = buildApp();
    const buildingId = await seedBuilding();
    const body = { number: '101', building_id: buildingId };
    await appRequest(app, 'POST', '/api/v1/units', { token: SUPERADMIN, body });

    const res = await appRequest(app, 'POST', '/api/v1/units', { token: SUPERADMIN, body });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBeTruthy();
  });

  it('POST / with an invalid number → 400 with details', async () => {
    const app = buildApp();
    const buildingId = await seedBuilding();

    const res = await appRequest(app, 'POST', '/api/v1/units', {
      token: SUPERADMIN,
      body: { number: '', building_id: buildingId },
    });
    expect(res.status).toBe(400);
    const parsed = await res.json();
    expect(parsed.error).toBe('Solicitud inválida');
    expect(Array.isArray(parsed.details)).toBe(true);
  });

  it('GET / RBAC: superadmin, condo_admin and building_admin → 200; resident → 403; no cookie → 401', async () => {
    const app = buildApp();
    expect((await appRequest(app, 'GET', '/api/v1/units', { token: SUPERADMIN })).status).toBe(200);
    expect((await appRequest(app, 'GET', '/api/v1/units', { token: CONDO_ADMIN })).status).toBe(200);
    expect((await appRequest(app, 'GET', '/api/v1/units', { token: BUILDING_ADMIN })).status).toBe(200);
    expect((await appRequest(app, 'GET', '/api/v1/units', { token: RESIDENT })).status).toBe(403);
    expect((await appRequest(app, 'GET', '/api/v1/units')).status).toBe(401);
  });

  it('GET /?building_id= scopes to that building: active only, ordered by number, no deleted_at', async () => {
    const app = buildApp();
    const first = await seedBuilding();
    const second = await (async () => {
      const condominium = await condominiumService.create('Parque Central');
      return (await buildingService.create('Edificio B', condominium.id)).id;
    })();
    await appRequest(app, 'POST', '/api/v1/units', {
      token: SUPERADMIN,
      body: { number: '2', building_id: first },
    });
    await appRequest(app, 'POST', '/api/v1/units', {
      token: SUPERADMIN,
      body: { number: '10', building_id: first },
    });
    const toDelete = await appRequest(app, 'POST', '/api/v1/units', {
      token: SUPERADMIN,
      body: { number: '1', building_id: first },
    });
    const { id: deletedId } = (await toDelete.json()) as { id: string };
    await connection('units').where({ id: deletedId }).update({ deleted_at: connection.fn.now() });
    await appRequest(app, 'POST', '/api/v1/units', {
      token: SUPERADMIN,
      body: { number: '10', building_id: second },
    });

    const res = await appRequest(app, 'GET', `/api/v1/units?building_id=${first}`, {
      token: BUILDING_ADMIN,
    });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.map((u: { number: string }) => u.number)).toEqual(['10', '2']);
    for (const row of parsed) {
      expect(row).not.toHaveProperty('deleted_at');
    }
  });

  it('GET / without building_id → 200 [] (no scope)', async () => {
    const app = buildApp();
    const buildingId = await seedBuilding();
    await appRequest(app, 'POST', '/api/v1/units', {
      token: SUPERADMIN,
      body: { number: '101', building_id: buildingId },
    });

    const res = await appRequest(app, 'GET', '/api/v1/units', { token: SUPERADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('nested GET /buildings/:id/units: 200 [] when the parent is soft-deleted, 404 when unknown', async () => {
    const app = buildApp();
    const buildingId = await seedBuilding();
    await connection('buildings').where({ id: buildingId }).update({ deleted_at: connection.fn.now() });

    const softDeleted = await appRequest(app, 'GET', `/api/v1/buildings/${buildingId}/units`, {
      token: BUILDING_ADMIN,
    });
    expect(softDeleted.status).toBe(200);
    expect(await softDeleted.json()).toEqual([]);

    const unknown = await appRequest(app, 'GET', `/api/v1/buildings/${randomUUID()}/units`, {
      token: BUILDING_ADMIN,
    });
    expect(unknown.status).toBe(404);
  });
});