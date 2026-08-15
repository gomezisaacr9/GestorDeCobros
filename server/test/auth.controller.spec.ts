import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { createApp } from '../src/app';
import { appRequest, signToken } from './helpers/http';
import { migrateToLatest, wipe } from './helpers/db';
import { hashPassword } from '../src/services/auth.service';

/**
 * Approval tests for `authController` (tasks 2.7–2.8). They capture the
 * CURRENT observable behavior of login / me / rotate (status, public body,
 * cookie flags, rotation mechanics) over real HTTP. Written BEFORE the
 * session.service refactor: they pass against the controller's local
 * `setSessionCookie` and must STILL pass after delegation — any change in
 * this contract is a refactor bug (safety net for D4).
 */

const COOKIE_NAME = 'auth_token';
const COOKIE_MAX_AGE_S = 8 * 60 * 60; // 8h

const app = createApp();

async function seedUser(overrides: Partial<{ role: string; deleted_at: unknown }> = {}) {
  const id = randomUUID();
  await connection('users').insert({
    id,
    email: `seed-${id}@gp.test`,
    password_hash: await hashPassword('Password!2026'),
    role: overrides.role ?? 'superadmin',
    name: 'Seed User',
    condominium_id: null,
    building_id: null,
    unit_id: null,
    deleted_at: overrides.deleted_at ?? null,
  });
  return { id, email: `seed-${id}@gp.test` };
}

function authCookieOf(res: Response): string {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) throw new Error('no auth_token cookie in response');
  return cookie.split(';')[0].split('=')[1] ?? '';
}

describe('authController — approval / behavior freeze (pre-refactor)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('login → 200 public body + 8h HttpOnly Strict session cookie', async () => {
    const { email } = await seedUser();

    const res = await appRequest(app, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'Password!2026' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ email, role: 'superadmin', name: 'Seed User' });
    expect(typeof body.id).toBe('string');
    expect(body).not.toHaveProperty('password_hash');
    expect(body).not.toHaveProperty('deleted_at');

    const header = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain(`Max-Age=${COOKIE_MAX_AGE_S}`);
    expect(header).toContain('Path=/');
    // Current behavior frozen: vitest runs with NODE_ENV='test' (≠ 'development'),
    // so the `secure` option is true and the cookie carries Secure. The
    // refactor (D4) must preserve this exact flag set.
    expect(header).toContain('Secure');
  });

  it('login wrong password and unknown email → byte-identical 401 bodies', async () => {
    const { email } = await seedUser();

    const wrong = await appRequest(app, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'WRONG-password' },
    });
    const unknown = await appRequest(app, 'POST', '/api/v1/auth/login', {
      body: { email: 'nobody@gp.test', password: 'WRONG-password' },
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const wrongJson = (await wrong.json()) as unknown;
    const unknownJson = (await unknown.json()) as unknown;
    expect(wrongJson).toEqual(unknownJson);
    expect(wrongJson).toEqual({ error: 'Credenciales inválidas' });
  });

  it('me → 200 public body with a valid cookie', async () => {
    const { id, email } = await seedUser();
    const token = signToken({ sub: id, role: 'superadmin' });

    const res = await appRequest(app, 'GET', '/api/v1/auth/me', { token });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, email, role: 'superadmin', name: 'Seed User' });
  });

  it('me without cookie → 401', async () => {
    const res = await appRequest(app, 'GET', '/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No autorizado' });
  });

  it('me for a soft-deleted user → 401', async () => {
    const { id } = await seedUser({ deleted_at: connection.fn.now() });
    const token = signToken({ sub: id, role: 'superadmin' });

    const res = await appRequest(app, 'GET', '/api/v1/auth/me', { token });

    expect(res.status).toBe(401);
  });

  it('rotate → 200, hash replaced, old password fails, new one logs in', async () => {
    const { email } = await seedUser();
    const before = await connection('users').where({ email }).first();
    expect(before.password_hash.startsWith('$2')).toBe(true);
    const token = signToken({ sub: before.id, role: 'superadmin' });

    const res = await appRequest(app, 'PATCH', '/api/v1/auth/password/rotate', {
      token,
      body: { currentPassword: 'Password!2026', newPassword: 'Rotated!2026' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Contraseña actualizada' });

    const after = await connection('users').where({ email }).first();
    expect(after.password_hash).not.toBe(before.password_hash);

    const oldLogin = await appRequest(app, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'Password!2026' },
    });
    const newLogin = await appRequest(app, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'Rotated!2026' },
    });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
  });

  it('rotate with a wrong current password → 401, hash untouched', async () => {
    const { email } = await seedUser();
    const before = await connection('users').where({ email }).first();
    const token = signToken({ sub: before.id, role: 'superadmin' });

    const res = await appRequest(app, 'PATCH', '/api/v1/auth/password/rotate', {
      token,
      body: { currentPassword: 'Nope-Nope!', newPassword: 'Another!2026' },
    });

    expect(res.status).toBe(401);
    const after = await connection('users').where({ email }).first();
    expect(after.password_hash).toBe(before.password_hash);
  });

  it('rotate without session → 401', async () => {
    const res = await appRequest(app, 'PATCH', '/api/v1/auth/password/rotate', {
      body: { currentPassword: 'Password!2026', newPassword: 'Rotated!2026' },
    });
    expect(res.status).toBe(401);
  });
});