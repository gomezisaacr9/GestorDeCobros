import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import cookieParser from 'cookie-parser';
import express from 'express';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest, signToken } from './helpers/http';
import { buildingRouter } from '../src/modules/hierarchy/building.routes';
import { errorHandler } from '../src/middlewares/errorHandler';
import { condominiumService } from '../src/modules/hierarchy/condominium.service';
import { unitService } from '../src/modules/hierarchy/unit.service';

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
  app.use('/api/v1/buildings', buildingRouter);
  app.use(errorHandler);
  return app;
}

async function seedCondominium(): Promise<string> {
  return (await condominiumService.create('Torres del Sol')).id;
}

describe('building routes (RBAC + CRUD + nested units)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('POST / RBAC: superadmin and condo_admin → 201; building_admin and resident → 403; no cookie → 401', async () => {
    const app = buildApp();
    const condominiumId = await seedCondominium();
    const body = { name: 'Edificio A', condominium_id: condominiumId };

    const superRes = await appRequest(app, 'POST', '/api/v1/buildings', { token: SUPERADMIN, body });
    expect(superRes.status).toBe(201);
    const condoRes = await appRequest(app, 'POST', '/api/v1/buildings', {
      token: CONDO_ADMIN,
      body: { name: 'Edificio B', condominium_id: condominiumId },
    });
    expect(condoRes.status).toBe(201);
    const buildingRes = await appRequest(app, 'POST', '/api/v1/buildings', { token: BUILDING_ADMIN, body });
    expect(buildingRes.status).toBe(403);
    const residentRes = await appRequest(app, 'POST', '/api/v1/buildings', { token: RESIDENT, body });
    expect(residentRes.status).toBe(403);
    const noCookieRes = await appRequest(app, 'POST', '/api/v1/buildings', { body });
    expect(noCookieRes.status).toBe(401);
  });

  it('POST / as condo_admin → 201 with public shape and Location header', async () => {
    const app = buildApp();
    const condominiumId = await seedCondominium();

    const res = await appRequest(app, 'POST', '/api/v1/buildings', {
      token: CONDO_ADMIN,
      body: { name: 'Edificio A', condominium_id: condominiumId },
    });
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(parsed.id).toMatch(UUID_RE);
    expect(parsed.name).toBe('Edificio A');
    expect(parsed.created_at).toBeTruthy();
    expect(parsed.updated_at).toBeTruthy();
    expect(parsed).not.toHaveProperty('deleted_at');
    expect(res.headers.get('location')).toBe(`/api/v1/buildings/${parsed.id}`);
  });

  it('POST / with an unknown condominium_id → 404', async () => {
    const res = await appRequest(buildApp(), 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Edificio A', condominium_id: randomUUID() },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });

  it('POST / with a duplicate name inside the condominium → 409', async () => {
    const app = buildApp();
    const condominiumId = await seedCondominium();
    const body = { name: 'Edificio A', condominium_id: condominiumId };
    await appRequest(app, 'POST', '/api/v1/buildings', { token: SUPERADMIN, body });

    const res = await appRequest(app, 'POST', '/api/v1/buildings', { token: SUPERADMIN, body });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBeTruthy();
  });

  it('GET / RBAC: superadmin and condo_admin → 200; building_admin and resident → 403; no cookie → 401', async () => {
    const app = buildApp();
    expect((await appRequest(app, 'GET', '/api/v1/buildings', { token: SUPERADMIN })).status).toBe(200);
    expect((await appRequest(app, 'GET', '/api/v1/buildings', { token: CONDO_ADMIN })).status).toBe(200);
    expect((await appRequest(app, 'GET', '/api/v1/buildings', { token: BUILDING_ADMIN })).status).toBe(403);
    expect((await appRequest(app, 'GET', '/api/v1/buildings', { token: RESIDENT })).status).toBe(403);
    expect((await appRequest(app, 'GET', '/api/v1/buildings')).status).toBe(401);
  });

  it('GET /?condominium_id= scopes to that condominium: active only, ordered, no deleted_at', async () => {
    const app = buildApp();
    const first = await seedCondominium();
    const second = (await condominiumService.create('Parque Central')).id;
    await appRequest(app, 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Torre B', condominium_id: first },
    });
    await appRequest(app, 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Torre A', condominium_id: first },
    });
    const toDelete = await appRequest(app, 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Torre C', condominium_id: first },
    });
    const { id: deletedId } = (await toDelete.json()) as { id: string };
    await connection('buildings').where({ id: deletedId }).update({ deleted_at: connection.fn.now() });
    await appRequest(app, 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Torre A', condominium_id: second },
    });

    const res = await appRequest(app, 'GET', `/api/v1/buildings?condominium_id=${first}`, {
      token: CONDO_ADMIN,
    });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.map((b: { name: string }) => b.name)).toEqual(['Torre A', 'Torre B']);
    for (const row of parsed) {
      expect(row).not.toHaveProperty('deleted_at');
    }
  });

  it('GET / without condominium_id → 200 [] (no scope)', async () => {
    const app = buildApp();
    const condominiumId = await seedCondominium();
    await appRequest(app, 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Edificio A', condominium_id: condominiumId },
    });

    const res = await appRequest(app, 'GET', '/api/v1/buildings', { token: SUPERADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /:id/units RBAC: superadmin, condo_admin and building_admin → 200; resident → 403; no cookie → 401', async () => {
    const app = buildApp();
    const condominiumId = await seedCondominium();
    const created = await appRequest(app, 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Edificio A', condominium_id: condominiumId },
    });
    const { id } = (await created.json()) as { id: string };

    expect((await appRequest(app, 'GET', `/api/v1/buildings/${id}/units`, { token: SUPERADMIN })).status).toBe(200);
    expect((await appRequest(app, 'GET', `/api/v1/buildings/${id}/units`, { token: CONDO_ADMIN })).status).toBe(200);
    expect((await appRequest(app, 'GET', `/api/v1/buildings/${id}/units`, { token: BUILDING_ADMIN })).status).toBe(200);
    expect((await appRequest(app, 'GET', `/api/v1/buildings/${id}/units`, { token: RESIDENT })).status).toBe(403);
    expect((await appRequest(app, 'GET', `/api/v1/buildings/${id}/units`)).status).toBe(401);
  });

  it('GET /:id/units returns the scoped active units ordered by number', async () => {
    const app = buildApp();
    const condominiumId = await seedCondominium();
    const created = await appRequest(app, 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Edificio A', condominium_id: condominiumId },
    });
    const { id } = (await created.json()) as { id: string };
    await unitService.create('2', id);
    await unitService.create('10', id);
    const toDelete = await unitService.create('1', id);
    await connection('units').where({ id: toDelete.id }).update({ deleted_at: connection.fn.now() });

    const res = await appRequest(app, 'GET', `/api/v1/buildings/${id}/units`, { token: BUILDING_ADMIN });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.map((u: { number: string }) => u.number)).toEqual(['10', '2']);
    for (const row of parsed) {
      expect(row).not.toHaveProperty('deleted_at');
    }
  });

  it('GET /:id/units returns 200 [] when the building is soft-deleted, 404 when the id is unknown', async () => {
    const app = buildApp();
    const condominiumId = await seedCondominium();
    const created = await appRequest(app, 'POST', '/api/v1/buildings', {
      token: SUPERADMIN,
      body: { name: 'Edificio A', condominium_id: condominiumId },
    });
    const { id } = (await created.json()) as { id: string };
    await connection('buildings').where({ id }).update({ deleted_at: connection.fn.now() });

    const softDeleted = await appRequest(app, 'GET', `/api/v1/buildings/${id}/units`, { token: SUPERADMIN });
    expect(softDeleted.status).toBe(200);
    expect(await softDeleted.json()).toEqual([]);

    const unknown = await appRequest(app, 'GET', `/api/v1/buildings/${randomUUID()}/units`, {
      token: SUPERADMIN,
    });
    expect(unknown.status).toBe(404);
  });
});