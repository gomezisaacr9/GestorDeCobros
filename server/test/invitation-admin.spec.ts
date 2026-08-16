import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import cookieParser from 'cookie-parser';
import express from 'express';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { appRequest, signToken } from './helpers/http';
import { invitationRouter } from '../src/modules/invitations/invitation.routes';
import { errorHandler } from '../src/middlewares/errorHandler';
import { createApp } from '../src/app';
import { condominiumService } from '../src/modules/hierarchy/condominium.service';
import { buildingService } from '../src/modules/hierarchy/building.service';
import { unitService } from '../src/modules/hierarchy/unit.service';
import { hashToken } from '../src/modules/invitations/invitation.service';

/**
 * HTTP layer for invitation issuance (tasks 3.1–3.5). Drives the REAL Express
 * app (`createApp()` mounts the router — that IS the 3.4 mount) for the RBAC
 * happy paths, and a router-only app for the failure matrix. Admin sessions
 * come from REAL seeded `users` rows (D3 requires the DB lookup) with the
 * JWT sub matching the row id — exactly what a production login would produce.
 *
 * Spec scenarios: S1–S10 of invitation-admin (RBAC matrix, jurisdiction
 * anti-enumeration 404, soft-deleted unit, invalid body, hash-only storage,
 * default + custom expiry).
 */

const HOUR_MS = 60 * 60 * 1000;
/** Repo-test pattern: auth never validates these hashes, so any value works. */
const DUMMY_HASH = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);
const TOKEN_RE = /[0-9a-f]{64}$/;

function sqliteToMs(value: string): number {
  return new Date(value.replace(' ', 'T') + 'Z').getTime();
}

/** Router-only app for tests that must NOT depend on the global mount. */
function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/invitations', invitationRouter);
  app.use(errorHandler);
  return app;
}

/** Real hierarchy seed: condominium → building → unit (sha of the 004 rows). */
async function seedChain(condoName = 'Torre Norte', buildingName = 'Edificio A', number = '101') {
  const condo = await condominiumService.create(condoName);
  const building = await buildingService.create(buildingName, condo.id);
  const unit = await unitService.create(number, building.id);
  return { condoId: condo.id, buildingId: building.id, unitId: unit.id };
}

/** Real user row for an admin — the D3 lookup (`findById`) must find it. */
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

function session(user: { id: string; role: string }): string {
  return signToken({ sub: user.id, role: user.role });
}

describe('invitation-admin routes (POST /api/v1/invitations)', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  describe('RBAC matrix (R1 S4/S5)', () => {
    it('S5: no session cookie → 401 from requireAuth, before any role check', async () => {
      const res = await appRequest(createApp(), 'POST', '/api/v1/invitations', {
        body: { unit_id: randomUUID() },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'No autorizado' });
    });

    it('S4: resident → 403 {error: Prohibido} and the controller never runs', async () => {
      const { unitId } = await seedChain();
      const resident = await seedUser('resident');

      const res = await appRequest(createApp(), 'POST', '/api/v1/invitations', {
        token: session(resident),
        body: { unit_id: unitId },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Prohibido' });
      // The controller never ran: no invitation row was ever attempted.
      expect((await connection('invitations').count<{ c: number }>('* as c').first())?.c).toBe(0);
    });
  });

  describe('jurisdiction (R1/R2 S1–S3, S7, S8)', () => {
    it('S1: superadmin creates for an active unit → 201 magic_link with the raw token exactly once', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');

      const res = await appRequest(createApp(), 'POST', '/api/v1/invitations', {
        token: session(superadmin),
        body: { unit_id: unitId },
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      const raw = String(body.magic_link).match(TOKEN_RE)?.[0];
      expect(raw).toBeDefined();
      expect(body.magic_link).toBe(`/api/v1/invitations/${raw}`);
      expect(String(body.magic_link).split(String(raw))).toHaveLength(2); // exactly once
    });

    it('S2: condo_admin creates for a unit inside its condominium → 201', async () => {
      const { unitId, condoId } = await seedChain();
      const condoAdmin = await seedUser('condo_admin', { condominiumId: condoId });

      const res = await appRequest(buildApp(), 'POST', '/api/v1/invitations', {
        token: session(condoAdmin),
        body: { unit_id: unitId },
      });

      expect(res.status).toBe(201);
      expect(String((await res.json()).magic_link)).toMatch(TOKEN_RE);
    });

    it('S3: building_admin creates for a unit of its building → 201', async () => {
      const { unitId, condoId, buildingId } = await seedChain();
      const buildingAdmin = await seedUser('building_admin', { condominiumId: condoId, buildingId });

      const res = await appRequest(buildApp(), 'POST', '/api/v1/invitations', {
        token: session(buildingAdmin),
        body: { unit_id: unitId },
      });

      expect(res.status).toBe(201);
      expect(String((await res.json()).magic_link)).toMatch(TOKEN_RE);
    });

    it('S7: cross-jurisdiction unit → 404 byte-identical to a nonexistent unit', async () => {
      const mine = await seedChain('Torre Norte');
      const other = await seedChain('Parque Central');
      const condoAdmin = await seedUser('condo_admin', { condominiumId: mine.condoId });
      const app = buildApp();

      const cross = await appRequest(app, 'POST', '/api/v1/invitations', {
        token: session(condoAdmin),
        body: { unit_id: other.unitId },
      });
      const unknown = await appRequest(app, 'POST', '/api/v1/invitations', {
        token: session(condoAdmin),
        body: { unit_id: randomUUID() },
      });

      expect(cross.status).toBe(404);
      expect(unknown.status).toBe(404);
      const crossBody = await cross.json();
      const unknownBody = await unknown.json();
      expect(crossBody).toEqual(unknownBody);
      expect(crossBody.error).toBe('Unidad no encontrada');
    });

    it('S8: soft-deleted unit → 404 with the same generic body', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');
      await connection('units').where({ id: unitId }).update({ deleted_at: connection.fn.now() });
      const app = buildApp();

      const deleted = await appRequest(app, 'POST', '/api/v1/invitations', {
        token: session(superadmin),
        body: { unit_id: unitId },
      });
      const unknown = await appRequest(app, 'POST', '/api/v1/invitations', {
        token: session(superadmin),
        body: { unit_id: randomUUID() },
      });

      expect(deleted.status).toBe(404);
      expect(await deleted.json()).toEqual(await unknown.json());
    });
  });

  describe('validation (S6)', () => {
    it('S6: malformed unit_id → 400 with details and no invitation created', async () => {
      const superadmin = await seedUser('superadmin');

      const res = await appRequest(buildApp(), 'POST', '/api/v1/invitations', {
        token: session(superadmin),
        body: { unit_id: 'not-a-uuid' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Solicitud inválida');
      expect(Array.isArray(body.details)).toBe(true);
      expect(body.details.length).toBeGreaterThan(0);
      expect((await connection('invitations').count<{ c: number }>('* as c').first())?.c).toBe(0);
    });

    it('S6: expires_in_hours below the 1..720 bound → 400, nothing stored', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');

      const res = await appRequest(buildApp(), 'POST', '/api/v1/invitations', {
        token: session(superadmin),
        body: { unit_id: unitId, expires_in_hours: -1 },
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Solicitud inválida');
      expect((await connection('invitations').count<{ c: number }>('* as c').first())?.c).toBe(0);
    });
  });

  describe('hash-only storage + expiry (R3/R4 S9/S10)', () => {
    it('S9: only the SHA-256 digest reaches the database — raw token never stored', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');

      const res = await appRequest(buildApp(), 'POST', '/api/v1/invitations', {
        token: session(superadmin),
        body: { unit_id: unitId },
      });
      const raw = String((await res.json()).magic_link).match(TOKEN_RE)?.[0] as string;

      const row = await connection('invitations').where({ unit_id: unitId }).first();
      expect(row.token_hash).toBe(hashToken(raw)); // stored digest matches sha256(raw)
      expect(row.token_hash).not.toBe(raw); // the raw token itself never persisted
      expect(row.status).toBe('active');
      expect(row.deleted_at).toBeNull();
    });

    it('S10: omitted expires_in_hours → expires_at exactly created_at + 72h', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');

      await appRequest(buildApp(), 'POST', '/api/v1/invitations', {
        token: session(superadmin),
        body: { unit_id: unitId },
      });

      const row = await connection('invitations').first();
      expect(sqliteToMs(row.expires_at) - sqliteToMs(row.created_at)).toBe(72 * HOUR_MS);
    });

    it('S10: custom expires_in_hours: 1 → expires_at exactly created_at + 1h', async () => {
      const { unitId } = await seedChain();
      const superadmin = await seedUser('superadmin');

      await appRequest(buildApp(), 'POST', '/api/v1/invitations', {
        token: session(superadmin),
        body: { unit_id: unitId, expires_in_hours: 1 },
      });

      const row = await connection('invitations').first();
      expect(sqliteToMs(row.expires_at) - sqliteToMs(row.created_at)).toBe(HOUR_MS);
    });
  });
});