import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest } from './helpers/http';
import { invitationRouter } from '../src/modules/invitations/invitation.routes';
import { errorHandler } from '../src/middlewares/errorHandler';
import { createApp } from '../src/app';
import { condominiumService } from '../src/modules/hierarchy/condominium.service';
import { buildingService } from '../src/modules/hierarchy/building.service';
import { unitService } from '../src/modules/hierarchy/unit.service';
import { generateToken, hashToken } from '../src/modules/invitations/invitation.service';
import { invitationRepository } from '../src/modules/invitations/invitation.repository';
import { userRepository } from '../src/modules/auth/user.repository';

/**
 * Public accept flow (tasks 3.7 + 3.8). POST /:token/accept MUST work with NO
 * session — spec scenarios S7–S16 of invitation-public: register 201 + cookie,
 * link 200, idempotence, validation without consumption, email-conflict policy,
 * consumption semantics (409/410/404), rollback on failure, working session.
 */

const DUMMY_HASH = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);
const ADMIN_EMAIL_SEED = 'admin-holder@gp.test';

/** invitations.created_by FK → a real (non-soft-deleted) users row is required. */
async function seedSuperadmin(): Promise<string> {
  const id = randomUUID();
  await connection('users').insert({
    id,
    email: `admin-${id}@gp.test`,
    password_hash: DUMMY_HASH,
    role: 'superadmin',
    name: null,
    condominium_id: null,
    building_id: null,
    unit_id: null,
  });
  return id;
}

async function seedChain(condoName = 'Torre Norte', buildingName = 'Edificio A', number = '101') {
  const condo = await condominiumService.create(condoName);
  const building = await buildingService.create(buildingName, condo.id);
  const unit = await unitService.create(number, building.id);
  return { condoId: condo.id, buildingId: building.id, unitId: unit.id };
}

/** Inserts an invitation directly (repository). `hours` may be negative. Returns the RAW token. */
async function seedInvitation(unitId: string, hours: number): Promise<{ id: string; raw: string }> {
  const raw = generateToken();
  const id = randomUUID();
  await invitationRepository.insert({
    id,
    token_hash: hashToken(raw),
    unit_id: unitId,
    created_by: await seedSuperadmin(),
    expires_at: connection.raw(`datetime('now', '${hours >= 0 ? '+' : ''}${hours} hours')`),
  });
  return { id, raw };
}

async function seedUser(email: string, role: string, fks: { condominiumId?: string } = {}, deleted = false) {
  await connection('users').insert({
    id: randomUUID(),
    email,
    password_hash: DUMMY_HASH,
    role,
    name: null,
    condominium_id: fks.condominiumId ?? null,
    building_id: null,
    unit_id: null,
    deleted_at: deleted ? connection.fn.now() : null,
  });
}

/** Extracts the auth_token value from a Set-Cookie header. */
function cookieToken(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  const header = setCookie as string;
  const pair = header.split(';')[0];
  expect(pair.startsWith('auth_token=')).toBe(true);
  return pair.slice('auth_token='.length);
}

async function invitationStatus(id: string): Promise<string> {
  return (await connection('invitations').where({ id }).first()).status;
}

describe('invitation-public accept (POST /api/v1/invitations/:token/accept)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('S7: register a new user → 201 {id,email,role} + valid session cookie; user/link/consume persist', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);

    // No cookie, no headers — fully anonymous.
    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'r@x.com', password: 'secret123', name: 'R' },
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.email).toBe('r@x.com');
    expect(body.role).toBe('resident');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('auth_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const user = await userRepository.findAnyByEmail('r@x.com');
    expect(user?.password_hash.startsWith('$2b$12$')).toBe(true); // real bcrypt
    expect(
      await connection('resident_units').where({ user_id: user?.id, unit_id: unitId }).first(),
    ).toBeDefined();
    expect(await invitationStatus(id)).toBe('used');
  });

  it('S8: link an existing ACTIVE resident → 200 with its id and the token consumed', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);
    await seedUser('existing.resident@gp.test', 'resident');

    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'existing.resident@gp.test', password: 'secret123' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe('existing.resident@gp.test');
    expect(body.role).toBe('resident');
    const holder = await userRepository.findAnyByEmail('existing.resident@gp.test');
    expect(body.id).toBe(holder?.id);
    expect(
      await connection('resident_units').where({ user_id: holder?.id, unit_id: unitId }).first(),
    ).toBeDefined();
    expect(await invitationStatus(id)).toBe('used');
  });

  it('S8b: an already-linked resident is idempotent → 200, single membership row, token consumed', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);
    const holderId = randomUUID();
    await connection('users').insert({
      id: holderId,
      email: 'linked.resident@gp.test',
      password_hash: DUMMY_HASH,
      role: 'resident',
      name: 'Linked',
    });
    await connection('resident_units').insert({ user_id: holderId, unit_id: unitId });

    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'linked.resident@gp.test', password: 'secret123' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(holderId);
    const links = await connection('resident_units').where({ user_id: holderId, unit_id: unitId });
    expect(links).toHaveLength(1); // composite PK never tripped
    expect(await invitationStatus(id)).toBe('used');
  });

  it('S9: invalid body → 400 with details and the invitation is NOT consumed', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);

    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'nope', password: 'short' },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Solicitud inválida');
    expect(body.details.length).toBeGreaterThan(0);
    expect(await invitationStatus(id)).toBe('active');
  });

  it('S10: non-resident email holder → 409, token NOT consumed, retry with another email succeeds', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);
    const condo = await condominiumService.create('Holder Condo');
    await seedUser(ADMIN_EMAIL_SEED, 'condo_admin', { condominiumId: condo.id });

    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: ADMIN_EMAIL_SEED, password: 'secret123' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No se puede vincular el email' });
    expect(await invitationStatus(id)).toBe('active');

    const retry = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'fresh.retry@gp.test', password: 'secret123' },
    });
    expect(retry.status).toBe(201);
    expect(await invitationStatus(id)).toBe('used');
  });

  it('S11: soft-deleted holder → 409 and the token is NOT consumed', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);
    await seedUser('ghost.holder@gp.test', 'resident', {}, true);

    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'ghost.holder@gp.test', password: 'secret123' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'No se puede vincular el email' });
    expect(await invitationStatus(id)).toBe('active');
  });

  it('S12: used token at accept → 409 {error: "Invitación ya utilizada"}', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);
    await invitationRepository.markUsed(id);

    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'late.accept@gp.test', password: 'secret123' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Invitación ya utilizada' });
  });

  it('S13: expired token at accept → 410 with the shared Gone body', async () => {
    const { unitId } = await seedChain();
    const { raw } = await seedInvitation(unitId, -1);

    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'too.late@gp.test', password: 'secret123' },
    });

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'Invitación expirada o ya utilizada' });
  });

  it('S14: unknown token at accept → 404 with the generic body — no existence leak', async () => {
    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${generateToken()}/accept`, {
      body: { email: 'a@b.com', password: 'secret123' },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Invitación no encontrada' });
  });

  it('S15: DB failure mid-transaction → 5xx; NO user row, NO link, token stays active (rollback)', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);
    vi.spyOn(invitationRepository, 'markUsed').mockRejectedValueOnce(
      new Error('boom — synthetic DB failure'),
    );

    const res = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'rollback@gp.test', password: 'secret123' },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Error interno del servidor' });
    expect(await userRepository.findAnyByEmail('rollback@gp.test')).toBeUndefined();
    expect((await connection('resident_units').count<{ c: number }>('* as c').first())?.c).toBe(0);
    expect(await invitationStatus(id)).toBe('active');
  });

  it('S16: the issued cookie is a working session — GET /api/v1/auth/me returns the resident', async () => {
    const { unitId } = await seedChain();
    const { raw } = await seedInvitation(unitId, 72);

    const acceptRes = await appRequest(createApp(), 'POST', `/api/v1/invitations/${raw}/accept`, {
      body: { email: 'cookie.holder@gp.test', password: 'secret123', name: 'Cookie Holder' },
    });
    expect(acceptRes.status).toBe(201);
    const token = cookieToken(acceptRes.headers.get('set-cookie'));

    const me = await appRequest(createApp(), 'GET', '/api/v1/auth/me', { token });

    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      id: expect.any(String),
      email: 'cookie.holder@gp.test',
      role: 'resident',
      name: 'Cookie Holder',
    });
  });
});