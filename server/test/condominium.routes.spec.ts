import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import cookieParser from 'cookie-parser';
import express from 'express';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest, signToken } from './helpers/http';
import { condominiumRouter } from '../src/modules/hierarchy/condominium.routes';
import { errorHandler } from '../src/middlewares/errorHandler';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SUPERADMIN = signToken({ sub: 'user-super', role: 'superadmin' });
const CONDO_ADMIN = signToken({ sub: 'user-condo', role: 'condo_admin' });
const RESIDENT = signToken({ sub: 'user-res', role: 'resident' });

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/condominiums', condominiumRouter);
  app.use(errorHandler);
  return app;
}

describe('condominium routes (RBAC + CRUD + nested)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('POST / without a session cookie → 401 from requireAuth', async () => {
    const res = await appRequest(buildApp(), 'POST', '/api/v1/condominiums', {
      body: { name: 'Torres del Sol' },
    });
    expect(res.status).toBe(401);
  });

  it('POST / as resident → 403 and the controller never runs', async () => {
    const res = await appRequest(buildApp(), 'POST', '/api/v1/condominiums', {
      token: RESIDENT,
      body: { name: 'Torres del Sol' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Prohibido' });
  });

  it('POST / as superadmin → 201 with public shape and Location header', async () => {
    const res = await appRequest(buildApp(), 'POST', '/api/v1/condominiums', {
      token: SUPERADMIN,
      body: { name: 'Torres del Sol' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(UUID_RE);
    expect(body.name).toBe('Torres del Sol');
    expect(body.created_at).toBeTruthy();
    expect(body.updated_at).toBeTruthy();
    expect(body).not.toHaveProperty('deleted_at');
    expect(res.headers.get('location')).toBe(`/api/v1/condominiums/${body.id}`);
  });

  it('POST / with an invalid body → 400 with details and the controller never runs', async () => {
    const res = await appRequest(buildApp(), 'POST', '/api/v1/condominiums', {
      token: SUPERADMIN,
      body: { name: '' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Solicitud inválida');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('POST / with a duplicate name → 409', async () => {
    await appRequest(buildApp(), 'POST', '/api/v1/condominiums', {
      token: SUPERADMIN,
      body: { name: 'Torres del Sol' },
    });
    const res = await appRequest(buildApp(), 'POST', '/api/v1/condominiums', {
      token: SUPERADMIN,
      body: { name: 'Torres del Sol' },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBeTruthy();
  });

  it('GET / without a session cookie → 401', async () => {
    const res = await appRequest(buildApp(), 'GET', '/api/v1/condominiums');
    expect(res.status).toBe(401);
  });

  it('GET / as resident → 403', async () => {
    const res = await appRequest(buildApp(), 'GET', '/api/v1/condominiums', { token: RESIDENT });
    expect(res.status).toBe(403);
  });

  it('GET / as superadmin → 200 list ordered by name, excluding soft-deleted, no deleted_at', async () => {
    const app = buildApp();
    await appRequest(app, 'POST', '/api/v1/condominiums', { token: SUPERADMIN, body: { name: 'Zeta' } });
    const keep = await appRequest(app, 'POST', '/api/v1/condominiums', {
      token: SUPERADMIN,
      body: { name: 'Alpha' },
    });
    const keepBody = await keep.json();
    await appRequest(app, 'POST', '/api/v1/condominiums', { token: SUPERADMIN, body: { name: 'Beta' } });
    await connection('condominiums').where({ id: keepBody.id }).update({ deleted_at: connection.fn.now() });

    const res = await appRequest(app, 'GET', '/api/v1/condominiums', { token: SUPERADMIN });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((c: { name: string }) => c.name)).toEqual(['Beta', 'Zeta']);
    for (const row of body) {
      expect(row).not.toHaveProperty('deleted_at');
    }
  });

  it('GET /:id/buildings RBAC: superadmin and condo_admin → 200; resident → 403; no cookie → 401', async () => {
    const app = buildApp();
    const created = await appRequest(app, 'POST', '/api/v1/condominiums', {
      token: SUPERADMIN,
      body: { name: 'Torres del Sol' },
    });
    const { id } = (await created.json()) as { id: string };

    expect((await appRequest(app, 'GET', `/api/v1/condominiums/${id}/buildings`, { token: SUPERADMIN })).status).toBe(200);
    expect(
      (await appRequest(app, 'GET', `/api/v1/condominiums/${id}/buildings`, { token: CONDO_ADMIN })).status,
    ).toBe(200);
    expect((await appRequest(app, 'GET', `/api/v1/condominiums/${id}/buildings`, { token: RESIDENT })).status).toBe(403);
    expect((await appRequest(app, 'GET', `/api/v1/condominiums/${id}/buildings`)).status).toBe(401);
  });

  it('GET /:id/buildings returns 200 [] when the condominium exists (soft-deleted included) and has no buildings', async () => {
    const app = buildApp();
    const created = await appRequest(app, 'POST', '/api/v1/condominiums', {
      token: SUPERADMIN,
      body: { name: 'Torres del Sol' },
    });
    const { id } = (await created.json()) as { id: string };
    await connection('condominiums').where({ id }).update({ deleted_at: connection.fn.now() });

    const res = await appRequest(app, 'GET', `/api/v1/condominiums/${id}/buildings`, { token: SUPERADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /:id/buildings returns 404 when the condominium id does not exist', async () => {
    const res = await appRequest(buildApp(), 'GET', `/api/v1/condominiums/00000000-0000-4000-8000-000000000000/buildings`, {
      token: SUPERADMIN,
    });
    expect(res.status).toBe(404);
  });
});