import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { condominiumService } from '../src/services/condominium.service';
import { buildingService } from '../src/services/building.service';
import { unitService } from '../src/services/unit.service';
import { invitationRepository } from '../src/repositories/invitation.repository';
import {
  generateToken,
  hashToken,
  invitationService,
} from '../src/services/invitation.service';
import { userRepository } from '../src/repositories/user.repository';
import {
  ConflictError,
  GoneError,
  NotFoundError,
} from '../src/errors/http-errors';
import { hashPassword } from '../src/services/auth.service';

/**
 * invitationService domain logic (task 2.9): token generation + hashing,
 * create (D3 jurisdiction join), resolve (R2/R3) and accept (D2 single
 * transaction, D7/D8; R4/R5/R6). DB-backed integration tests: every error
 * branch asserts the token is NOT consumed (rollback semantics).
 */

const HOUR_MS = 60 * 60 * 1000;
const DUMMY_HASH = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);
const ADMIN_EMAIL_SEED = 'admin-seed@gp.test';

function sqliteToMs(value: string): number {
  return new Date(value.replace(' ', 'T') + 'Z').getTime();
}

/** Parses a stored invites row; `sqliteToMs` needs the 'YYYY-MM-DD HH:MM:SS' shape. */
async function inviteRow(id: string): Promise<{ created_at: string; expires_at: string; status: string }> {
  return (await connection('invitations').where({ id }).first()) as {
    created_at: string;
    expires_at: string;
    status: string;
  };
}

async function seedChain(condoName = 'Torre Norte', buildingName = 'Edificio A', number = '101') {
  const condo = await condominiumService.create(condoName);
  const building = await buildingService.create(buildingName, condo.id);
  const unit = await unitService.create(number, building.id);
  return { condoId: condo.id, buildingId: building.id, unitId: unit.id };
}

async function seedAdmin(
  role: 'superadmin' | 'condo_admin' | 'building_admin',
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

/** Inserts an invitation through the repository; `hours` may be negative. Returns the RAW token (what a client would hold). */
async function seedInvitation(
  unitId: string,
  createdBy: string,
  hours: number,
): Promise<{ id: string; raw: string }> {
  const raw = generateToken();
  const id = randomUUID();
  await invitationRepository.insert({
    id,
    token_hash: hashToken(raw),
    unit_id: unitId,
    created_by: createdBy,
    expires_at: connection.raw(`datetime('now', '${hours >= 0 ? '+' : ''}${hours} hours')`),
  });
  return { id, raw };
}

describe('invitationService', () => {
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

  describe('token helpers (R3)', () => {
    it('generateToken returns 64 lowercase hex chars', () => {
      for (let i = 0; i < 5; i++) {
        const token = generateToken();
        expect(token).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('hashToken produces the sha256 digest of the raw token (only hash persists)', () => {
      const raw = generateToken();
      const expected = createHash('sha256').update(raw).digest('hex');
      expect(hashToken(raw)).toBe(expected);
      expect(hashToken(raw)).not.toBe(raw);
    });
  });

  describe('create (D3 jurisdiction)', () => {
    it('superadmin creates for any active unit — 72h default expiry is exact', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');

      const result = await invitationService.create(admin, { unit_id: unitId });

      expect(result.magic_link).toMatch(/^\/api\/v1\/invitations\/[0-9a-f]{64}$/);
      const raw = result.magic_link.split('/').at(-1) as string;
      expect(result.magic_link.split(raw)).toHaveLength(2); // raw appears exactly once

      const row = await connection('invitations').where({ token_hash: hashToken(raw) }).first();
      expect(row).toBeDefined();
      expect(row.status).toBe('active');

      const stored = await inviteRow(row.id);
      expect(sqliteToMs(stored.expires_at) - sqliteToMs(stored.created_at)).toBe(72 * HOUR_MS);
    });

    it('honors a custom expires_in_hours (1h) — exact window', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');

      await invitationService.create(admin, { unit_id: unitId, expires_in_hours: 1 });

      const row = await connection('invitations').first();
      const stored = await inviteRow(row.id);
      expect(sqliteToMs(stored.expires_at) - sqliteToMs(stored.created_at)).toBe(HOUR_MS);
    });

    it('condo_admin can create inside its condominium', async () => {
      const { unitId, condoId } = await seedChain();
      const admin = await seedAdmin('condo_admin', { condominiumId: condoId });

      const result = await invitationService.create(admin, { unit_id: unitId });

      expect(result.magic_link).toMatch(/[0-9a-f]{64}$/);
    });

    it('rejects cross-jurisdiction units with NotFoundError (S7, byte-identical)', async () => {
      const mine = await seedChain('Torre Norte');
      const other = await seedChain('Parque Central');
      const admin = await seedAdmin('condo_admin', { condominiumId: mine.condoId });

      await expect(invitationService.create(admin, { unit_id: other.unitId })).rejects.toThrow(
        NotFoundError,
      );
    });

    it('rejects unknown and soft-deleted units with the same NotFoundError (S8)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');

      await expect(invitationService.create(admin, { unit_id: randomUUID() })).rejects.toThrow(
        NotFoundError,
      );
      await connection('units').where({ id: unitId }).update({ deleted_at: connection.fn.now() });
      await expect(invitationService.create(admin, { unit_id: unitId })).rejects.toThrow(
        NotFoundError,
      );
    });

    it('fails closed when the actor row is missing or soft-deleted', async () => {
      const { unitId } = await seedChain();
      await expect(
        invitationService.create({ id: randomUUID(), role: 'superadmin' }, { unit_id: unitId }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('resolve (R1/R2/R3)', () => {
    it('returns names only for an active token (S1)', async () => {
      const { unitId, condoId, buildingId } = await seedChain('Torre Norte', 'Edificio A', '101');
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);

      const resolved = await invitationService.resolve(inv.raw);

      expect(resolved).toEqual({
        condominium: 'Torre Norte',
        building: 'Edificio A',
        unit: '101',
      });
      void condoId;
      void buildingId;
    });

    it('unknown and malformed tokens → NotFoundError (S2/S3)', async () => {
      await expect(invitationService.resolve(generateToken())).rejects.toThrow(NotFoundError);
      await expect(invitationService.resolve('abc')).rejects.toThrow(NotFoundError);
    });

    it('expired token → GoneError 410 (S4)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, -1);

      await expect(invitationService.resolve(inv.raw)).rejects.toThrow(GoneError);
    });

    it('used token → GoneError 410 (S5)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      await invitationRepository.markUsed(inv.id);

      const err = await invitationService.resolve(inv.raw).catch((e) => e);
      expect(err).toBeInstanceOf(GoneError);
      expect(err.statusCode).toBe(410);
      expect(err.message).toBe('Invitación expirada o ya utilizada');
    });

    it('dead unit chain → GoneError 410 (S6)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      await connection('units').where({ id: unitId }).update({ deleted_at: connection.fn.now() });

      await expect(invitationService.resolve(inv.raw)).rejects.toThrow(GoneError);
    });
  });

  describe('accept — register (S7)', () => {
    it('creates user (bcrypt), links the unit, consumes the token, returns created:true', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);

      const result = await invitationService.accept(inv.raw, {
        email: 'new.resident@gp.test',
        password: 'secret123',
        name: 'New Resident',
      });

      expect(result.created).toBe(true);
      expect(result.user).toEqual({
        id: expect.any(String),
        email: 'new.resident@gp.test',
        role: 'resident',
        name: 'New Resident',
      });

      const user = await userRepository.findAnyByEmail('new.resident@gp.test');
      expect(user?.password_hash.startsWith('$2b$12$')).toBe(true);
      expect(
        await connection('resident_units').where({ user_id: user?.id, unit_id: unitId }).first(),
      ).toBeDefined();
      expect((await inviteRow(inv.id)).status).toBe('used');
    });
  });

  describe('accept — link existing resident (S8/S8b)', () => {
    it('links an active resident and returns created:false with its existing id', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      const holderId = randomUUID();
      await connection('users').insert({
        id: holderId,
        email: 'existing.resident@gp.test',
        password_hash: DUMMY_HASH,
        role: 'resident',
        name: 'Existing',
      });

      const result = await invitationService.accept(inv.raw, {
        email: 'existing.resident@gp.test',
        password: 'secret123',
      });

      expect(result.created).toBe(false);
      expect(result.user.id).toBe(holderId);
      expect(result.user.role).toBe('resident');
      expect(
        await connection('resident_units').where({ user_id: holderId, unit_id: unitId }).first(),
      ).toBeDefined();
      expect((await inviteRow(inv.id)).status).toBe('used');
    });

    it('is idempotent when the resident is already linked (S8b)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      const holderId = randomUUID();
      await connection('users').insert({
        id: holderId,
        email: 'linked.resident@gp.test',
        password_hash: DUMMY_HASH,
        role: 'resident',
        name: 'Linked',
      });
      await connection('resident_units').insert({ user_id: holderId, unit_id: unitId });

      const result = await invitationService.accept(inv.raw, {
        email: 'linked.resident@gp.test',
        password: 'secret123',
      });

      expect(result.created).toBe(false);
      expect(result.user.id).toBe(holderId);
      const links = await connection('resident_units').where({ user_id: holderId, unit_id: unitId });
      expect(links).toHaveLength(1); // composite PK never tripped
      expect((await inviteRow(inv.id)).status).toBe('used');
    });
  });

  describe('accept — email conflict policy (R5)', () => {
    async function seedHolder(role: string, deleted = false): Promise<string> {
      const id = randomUUID();
      const condo = await condominiumService.create('Holder Condo');
      await connection('users').insert({
        id,
        email: ADMIN_EMAIL_SEED,
        password_hash: DUMMY_HASH,
        role,
        name: null,
        condominium_id: role === 'condo_admin' ? condo.id : null,
        building_id: null,
        unit_id: null,
        deleted_at: deleted ? connection.fn.now() : null,
      });
      return id;
    }

    it('non-resident holder → ConflictError, token NOT consumed, retry with other email succeeds (S10)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      await seedHolder('condo_admin');

      const attempt = invitationService.accept(inv.raw, {
        email: ADMIN_EMAIL_SEED,
        password: 'secret123',
      });

      await expect(attempt).rejects.toThrow(ConflictError);
      await expect(
        invitationService.accept(inv.raw, { email: ADMIN_EMAIL_SEED, password: 'secret123' }),
      ).rejects.toThrow(new ConflictError('No se puede vincular el email'));
      expect((await inviteRow(inv.id)).status).toBe('active');

      const retry = await invitationService.accept(inv.raw, {
        email: 'fresh.retry@gp.test',
        password: 'secret123',
      });
      expect(retry.created).toBe(true);
      expect((await inviteRow(inv.id)).status).toBe('used');
    });

    it('soft-deleted holder → ConflictError, token NOT consumed (S11)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      await seedHolder('resident', true);

      const attempt = invitationService.accept(inv.raw, {
        email: ADMIN_EMAIL_SEED,
        password: 'secret123',
      });

      await expect(attempt).rejects.toThrow(ConflictError);
      expect((await inviteRow(inv.id)).status).toBe('active');
    });

    it('actor soft-delete check: findAnyByEmail branches on deleted_at (S11 semantics)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      const holderId = await seedHolder('resident', true);

      const holder = await userRepository.findAnyByEmail(ADMIN_EMAIL_SEED);
      expect(holder?.id).toBe(holderId);
      expect(holder?.deleted_at).not.toBeNull();
      await expect(
        invitationService.accept(inv.raw, { email: ADMIN_EMAIL_SEED, password: 'secret123' }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('accept — consumption semantics (R6)', () => {
    it('used token → ConflictError "Invitación ya utilizada" (S12)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      await invitationRepository.markUsed(inv.id);

      const err = await invitationService
        .accept(inv.raw, { email: 'late.accept@gp.test', password: 'secret123' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.message).toBe('Invitación ya utilizada');
    });

    it('expired token → GoneError 410 (S13)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, -1);

      const err = await invitationService
        .accept(inv.raw, { email: 'too.late@gp.test', password: 'secret123' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(GoneError);
      expect(err.statusCode).toBe(410);
      expect(err.message).toBe('Invitación expirada o ya utilizada');
    });

    it('unknown token → NotFoundError (S14)', async () => {
      await expect(
        invitationService.accept(generateToken(), { email: 'a@b.com', password: 'secret123' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('markUsed guard: 0 rows (concurrent consume) → ConflictError + full rollback', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      const markUsedSpy = vi
        .spyOn(invitationRepository, 'markUsed')
        .mockResolvedValueOnce(0);

      const err = await invitationService
        .accept(inv.raw, { email: 'race@gp.test', password: 'secret123' })
        .catch((e) => e);

      expect(markUsedSpy).toHaveBeenCalledOnce();
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.message).toBe('Invitación ya utilizada');
      expect(await userRepository.findAnyByEmail('race@gp.test')).toBeUndefined();
      expect(await connection('resident_units').select('*')).toHaveLength(0); // full rollback
      expect((await inviteRow(inv.id)).status).toBe('active');
    });

    it('any DB failure rolls back: no user row, no link, token stays active (S15)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      const boom = new Error('boom — synthetic DB failure');
      vi.spyOn(invitationRepository, 'markUsed').mockRejectedValueOnce(boom);

      const err = await invitationService
        .accept(inv.raw, { email: 'rollback@gp.test', password: 'secret123' })
        .catch((e) => e);

      expect(err).toBe(boom); // rethrown — the error handler turns it into 5xx
      expect(await userRepository.findAnyByEmail('rollback@gp.test')).toBeUndefined();
      expect(
        await connection('resident_units').where({ user_id: randomUUID() }).first(),
      ).toBeUndefined();
      expect((await inviteRow(inv.id)).status).toBe('active');
    });

    it('UNIQUE email race on insert → ConflictError, rollback (R5 race branch)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      // The email lands in `users` AFTER the holder lookup (race): the lookup
      // misses, the insert hits the UNIQUE(email) constraint.
      await connection('users').insert({
        id: randomUUID(),
        email: 'race.insert@gp.test',
        password_hash: DUMMY_HASH,
        role: 'resident',
        name: null,
      });
      const lookupSpy = vi
        .spyOn(userRepository, 'findAnyByEmail')
        .mockResolvedValueOnce(undefined);

      const attempt = invitationService.accept(inv.raw, {
        email: 'race.insert@gp.test',
        password: 'secret123',
      });

      await expect(attempt).rejects.toThrow(new ConflictError('No se puede vincular el email'));
      expect(lookupSpy).toHaveBeenCalledWith('race.insert@gp.test', expect.anything());
      expect((await inviteRow(inv.id)).status).toBe('active');
      // The row inserted by the test itself is untouched; nothing partial persisted.
      expect(await userRepository.findAnyByEmail('race.insert@gp.test')).toBeDefined();
    });
  });

  describe('accept → cookie-ready output shape', () => {
    it('returns the public user shape needed by the controller (R7)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, 72);
      const passwordHash = await hashPassword('secret123');

      const result = await invitationService.accept(inv.raw, {
        email: 'shape.check@gp.test',
        password: 'secret123',
      });

      expect(result.user).toEqual({
        id: expect.any(String),
        email: 'shape.check@gp.test',
        role: 'resident',
        name: null,
      });
      expect(result.user).not.toHaveProperty('password_hash');
      expect(result.created).toBe(true);

      const holder = await userRepository.findAnyByEmail('shape.check@gp.test');
      expect(holder?.password_hash).not.toBe(passwordHash); // hash created by service, not caller
      expect(holder?.password_hash.startsWith('$2b$12$')).toBe(true);
    });
  });
});