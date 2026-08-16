import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest, signToken } from './helpers/http';
import { invitationRouter } from '../src/modules/invitations/invitation.routes';
import { errorHandler } from '../src/middlewares/errorHandler';
import { createApp } from '../src/app';
import { condominiumService } from '../src/modules/hierarchy/condominium.service';
import { buildingService } from '../src/modules/hierarchy/building.service';
import { unitService } from '../src/modules/hierarchy/unit.service';
import { generateToken, hashToken } from '../src/modules/invitations/invitation.service';
import { invitationRepository } from '../src/modules/invitations/invitation.repository';

/**
 * Public names-only resolution (tasks 3.6, part of 3.8). GET /:token MUST
 * work with NO session — the token is the sole authorization. Spec scenarios
 * S1–S6 of invitation-public: names-only, unknown 404, malformed 404,
 * expired/used/dead-link 410 (one shared body).
 */

const GENERIC_410 = 'Invitación expirada o ya utilizada';
const DUMMY_HASH = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);

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

async function seedChain(condoName = 'Torre Norte', buildingName = 'Edificio A', number = '101') {
  const condo = await condominiumService.create(condoName);
  const building = await buildingService.create(buildingName, condo.id);
  const unit = await unitService.create(number, building.id);
  return { condoId: condo.id, buildingId: building.id, unitId: unit.id };
}

describe('invitation-public resolve (GET /api/v1/invitations/:token)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('S1: active token resolves names only — with NO session cookie at all', async () => {
    const { unitId } = await seedChain('Torre Norte', 'Edificio A', '101');
    const { raw } = await seedInvitation(unitId, 72);

    // No `token`/`headers` passed — the request carries zero credentials.
    const res = await appRequest(createApp(), 'GET', `/api/v1/invitations/${raw}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      condominium: 'Torre Norte',
      building: 'Edificio A',
      unit: '101',
    });
  });

  it('S1: response contains ONLY the three name keys — no ids/timestamps/status', async () => {
    const { unitId } = await seedChain('Parque Central', 'Edificio B', '202');
    const { raw } = await seedInvitation(unitId, 72);

    const res = await appRequest(createApp(), 'GET', `/api/v1/invitations/${raw}`);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(['building', 'condominium', 'unit']);
    expect(body).toEqual({ condominium: 'Parque Central', building: 'Edificio B', unit: '202' });
  });

  it('public endpoints ignore an unrelated session cookie — token alone authorizes', async () => {
    const { unitId } = await seedChain();
    const { raw } = await seedInvitation(unitId, 72);
    const unrelated = signToken({ sub: 'someone-else', role: 'resident' });

    const ok = await appRequest(createApp(), 'GET', `/api/v1/invitations/${raw}`, {
      token: unrelated,
    });
    expect(ok.status).toBe(200); // not 401: the route is NOT behind requireAuth

    const missing = await appRequest(createApp(), 'GET', `/api/v1/invitations/${generateToken()}`, {
      token: unrelated,
    });
    expect(missing.status).toBe(404); // still anti-enumeration, never 401
  });

  it('S2: a random never-issued token → 404 with the generic body (no existence hint)', async () => {
    const res = await appRequest(createApp(), 'GET', `/api/v1/invitations/${generateToken()}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Invitación no encontrada' });
  });

  it('S3: malformed token ("abc") → 404 byte-identical to the unknown-token case — no 400', async () => {
    const malformed = await appRequest(createApp(), 'GET', '/api/v1/invitations/abc');
    const unknown = await appRequest(createApp(), 'GET', `/api/v1/invitations/${generateToken()}`);

    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual(await unknown.json());
  });

  it('S4: expired token → 410 with the shared Gone body', async () => {
    const { unitId } = await seedChain();
    const { raw } = await seedInvitation(unitId, -1);

    const res = await appRequest(createApp(), 'GET', `/api/v1/invitations/${raw}`);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: GENERIC_410 });
  });

  it('S5: used token → 410 with the SAME body as the expired case', async () => {
    const { unitId } = await seedChain();
    const { id, raw } = await seedInvitation(unitId, 72);
    await invitationRepository.markUsed(id);

    const res = await appRequest(createApp(), 'GET', `/api/v1/invitations/${raw}`);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: GENERIC_410 });
  });

  it('S6: soft-deleted unit → 410 with the same body — the link once existed', async () => {
    const { unitId } = await seedChain();
    const { raw } = await seedInvitation(unitId, 72);
    await connection('units').where({ id: unitId }).update({ deleted_at: connection.fn.now() });

    const res = await appRequest(createApp(), 'GET', `/api/v1/invitations/${raw}`);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: GENERIC_410 });
  });
});