import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { condominiumService } from '../src/services/condominium.service';
import { buildingService } from '../src/services/building.service';
import { unitService } from '../src/services/unit.service';
import { invitationRepository } from '../src/repositories/invitation.repository';
import { residentUnitsRepository } from '../src/repositories/resident-units.repository';
import { userRepository } from '../src/repositories/user.repository';

/**
 * Domain-core repository layer for invitation-onboarding (PR 2 / slice 2):
 * `resident_units.linkIfAbsent` idempotence, `invitations.markUsed` guard,
 * `findUnitInJurisdiction` per-role predicates (D3), plus the `users`
 * additions (`insert`, `findAnyByEmail` incl. soft-deleted, trailing `trx?`).
 *
 * DB-backed integration tests (temp DB per fork; real knex connection).
 */

const DUMMY_HASH = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);

interface SeededChain {
  condoId: string;
  buildingId: string;
  unitId: string;
}

/** Creates a condominium → building → unit chain, returning real ids. */
async function seedChain(
  condoName = 'Torre Norte',
  buildingName = 'Edificio A',
): Promise<SeededChain> {
  const condo = await condominiumService.create(condoName);
  const building = await buildingService.create(buildingName, condo.id);
  const unit = await unitService.create('101', building.id);
  return { condoId: condo.id, buildingId: building.id, unitId: unit.id };
}

/** Same as seedChain but under an EXISTING condominium (unique-name service). */
async function seedBuildingUnder(condoId: string, buildingName: string): Promise<SeededChain> {
  const building = await buildingService.create(buildingName, condoId);
  const unit = await unitService.create('101', building.id);
  return { condoId, buildingId: building.id, unitId: unit.id };
}

/** Inserts a resident user and returns its id. */
async function seedResident(email: string): Promise<string> {
  const id = randomUUID();
  await connection('users').insert({
    id,
    email,
    password_hash: DUMMY_HASH,
    role: 'resident',
    name: null,
  });
  return id;
}

/** Inserts a CHECK-compliant admin row; superadmin leaves every FK null. */
async function seedAdmin(
  role: 'superadmin' | 'condo_admin' | 'building_admin',
  fks: { condominiumId?: string; buildingId?: string } = {},
): Promise<{ id: string; role: string; condominium_id: string | null; building_id: string | null }> {
  const id = randomUUID();
  const condominium_id = fks.condominiumId ?? null;
  const building_id = fks.buildingId ?? null;
  await connection('users').insert({
    id,
    email: `${role}-${id}@gp.test`,
    password_hash: DUMMY_HASH,
    role,
    name: null,
    condominium_id,
    building_id,
    unit_id: null,
  });
  return { id, role, condominium_id, building_id };
}

async function seedInvitation(
  unitId: string,
  createdBy: string,
  expiresAt: string | { raw: string },
): Promise<{ id: string; token_hash: string }> {
  const id = randomUUID();
  const tokenHash = `hash-${id}`;
  await invitationRepository.insert({
    id,
    token_hash: tokenHash,
    unit_id: unitId,
    created_by: createdBy,
    expires_at:
      typeof expiresAt === 'string'
        ? (expiresAt as string)
        : (connection.raw(expiresAt.raw) as never),
  });
  return { id, token_hash: tokenHash };
}

describe('invitation repositories — domain core', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  describe('residentUnitsRepository.linkIfAbsent', () => {
    it('links once and stays idempotent (S8b: composite PK never trips)', async () => {
      const { unitId } = await seedChain();
      const resident = await connection('users').insert({
        id: randomUUID(),
        email: 'resident-link@gp.test',
        password_hash: DUMMY_HASH,
        role: 'resident',
        name: null,
      });
      const userId = (await connection('users').where({ email: 'resident-link@gp.test' }).first()).id;

      await residentUnitsRepository.linkIfAbsent(userId, unitId);
      await residentUnitsRepository.linkIfAbsent(userId, unitId); // second call must not throw

      const rows = await connection('resident_units').where({ user_id: userId, unit_id: unitId });
      expect(rows).toHaveLength(1);
    });

    it('existsLink reports absence before and presence after linking', async () => {
      const { unitId } = await seedChain();
      const userId = await seedResident('resident-exists@gp.test');

      expect(await residentUnitsRepository.existsLink(userId, unitId)).toBe(false);
      await residentUnitsRepository.linkIfAbsent(userId, unitId);
      expect(await residentUnitsRepository.existsLink(userId, unitId)).toBe(true);
    });

    it('supports M:N membership — one resident linked to two units', async () => {
      const a = await seedChain('Torre Norte', 'Edificio A');
      await unitService.create('202', a.buildingId);
      const secondUnit = (await unitService.listByBuilding(a.buildingId))[1];
      const userId = await seedResident('resident-mn2@gp.test');

      await residentUnitsRepository.linkIfAbsent(userId, a.unitId);
      await residentUnitsRepository.linkIfAbsent(userId, secondUnit.id);

      const rows = await connection('resident_units').where({ user_id: userId });
      expect(rows).toHaveLength(2);
    });
  });

  describe('invitationRepository.markUsed', () => {
    it('flips active → used once and reports the guard (0 rows on second call)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, { raw: "datetime('now', '+72 hours')" });

      expect(await invitationRepository.markUsed(inv.id)).toBe(1);
      expect(await invitationRepository.markUsed(inv.id)).toBe(0); // WHERE status='active' matched nothing

      const row = await connection('invitations').where({ id: inv.id }).first();
      expect(row.status).toBe('used');
    });

    it('does not touch soft-deleted invitations (0 rows)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, { raw: "datetime('now', '+72 hours')" });
      await connection('invitations').where({ id: inv.id }).update({ deleted_at: connection.fn.now() });

      expect(await invitationRepository.markUsed(inv.id)).toBe(0);
    });
  });

  describe('invitationRepository.findUnitInJurisdiction (D3 per-role predicates)', () => {
    it('superadmin resolves any active unit — two chains from different condominiums', async () => {
      const mine = await seedChain('Torre Norte', 'Edificio A');
      const other = await seedChain('Parque Central', 'Edificio B');
      const admin = await seedAdmin('superadmin');

      const inScope = await invitationRepository.findUnitInJurisdiction(mine.unitId, admin);
      const otherScope = await invitationRepository.findUnitInJurisdiction(other.unitId, admin);
      expect(inScope?.unit_number).toBe('101');
      expect(otherScope?.unit_number).toBe('101');
      expect(inScope?.condominium_name).toBe('Torre Norte');
      expect(otherScope?.condominium_name).toBe('Parque Central');
    });

    it('condo_admin resolves only units whose condominium matches', async () => {
      const mine = await seedChain('Torre Norte', 'Edificio A');
      const other = await seedChain('Parque Central', 'Edificio B');
      const admin = await seedAdmin('condo_admin', { condominiumId: mine.condoId });

      const inScope = await invitationRepository.findUnitInJurisdiction(mine.unitId, admin);
      const cross = await invitationRepository.findUnitInJurisdiction(other.unitId, admin);
      expect(inScope?.unit_number).toBe('101');
      expect(cross).toBeUndefined(); // cross-jurisdiction unit is invisible
    });

    it('building_admin resolves only units of its own building', async () => {
      const mine = await seedChain('Torre Norte', 'Edificio A');
      const other = await seedBuildingUnder(mine.condoId, 'Edificio B'); // same condo, different building
      const admin = await seedAdmin('building_admin', {
        condominiumId: mine.condoId,
        buildingId: mine.buildingId,
      });

      const inScope = await invitationRepository.findUnitInJurisdiction(mine.unitId, admin);
      const otherBuilding = await invitationRepository.findUnitInJurisdiction(other.unitId, admin);
      expect(inScope?.building_name).toBe('Edificio A');
      expect(otherBuilding).toBeUndefined();
    });

    it('treats soft-deleted unit / building / condominium as absent (S8)', async () => {
      const { unitId, buildingId, condoId } = await seedChain();
      const admin = await seedAdmin('superadmin');

      await connection('units').where({ id: unitId }).update({ deleted_at: connection.fn.now() });
      expect(await invitationRepository.findUnitInJurisdiction(unitId, admin)).toBeUndefined();

      const chain2 = await seedChain('Segunda', 'Edificio C');
      await connection('buildings').where({ id: chain2.buildingId }).update({ deleted_at: connection.fn.now() });
      expect(await invitationRepository.findUnitInJurisdiction(chain2.unitId, admin)).toBeUndefined();

      const chain3 = await seedChain('Tercera', 'Edificio D');
      await connection('condominiums').where({ id: chain3.condoId }).update({ deleted_at: connection.fn.now() });
      expect(await invitationRepository.findUnitInJurisdiction(chain3.unitId, admin)).toBeUndefined();
      void buildingId;
      void condoId;
    });
  });

  describe('invitationRepository.findActiveByTokenHash + findUnitChain', () => {
    it('returns the active row for a known hash and undefined for an unknown one', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, { raw: "datetime('now', '+72 hours')" });

      const found = await invitationRepository.findActiveByTokenHash(inv.token_hash);
      expect(found?.id).toBe(inv.id);
      expect(found?.status).toBe('active');
      expect(found?.unit_id).toBe(unitId);
      expect(found?.created_by).toBe(admin.id);

      expect(await invitationRepository.findActiveByTokenHash('never-issued-hash')).toBeUndefined();
    });

    it('treats soft-deleted invitations as never existing (404 semantics)', async () => {
      const { unitId } = await seedChain();
      const admin = await seedAdmin('superadmin');
      const inv = await seedInvitation(unitId, admin.id, { raw: "datetime('now', '+72 hours')" });
      await connection('invitations').where({ id: inv.id }).update({ deleted_at: connection.fn.now() });

      expect(await invitationRepository.findActiveByTokenHash(inv.token_hash)).toBeUndefined();
    });

    it('findUnitChain returns read-only names of the active chain', async () => {
      const { unitId, condoId, buildingId } = await seedChain('Torre Norte', 'Edificio A');

      const chain = await invitationRepository.findUnitChain(unitId);
      expect(chain).toEqual({
        unit_id: unitId,
        unit_number: '101',
        building_id: buildingId,
        building_name: 'Edificio A',
        condominium_id: condoId,
        condominium_name: 'Torre Norte',
      });
    });

    it('findUnitChain returns undefined for a missing or soft-deleted unit', async () => {
      const ghost = await seedChain('Fantasma', 'Edificio F');
      expect(await invitationRepository.findUnitChain(randomUUID())).toBeUndefined();
      await connection('units').where({ id: ghost.unitId }).update({ deleted_at: connection.fn.now() });
      expect(await invitationRepository.findUnitChain(ghost.unitId)).toBeUndefined();
    });
  });

  describe('userRepository additions (insert, findAnyByEmail, trailing trx)', () => {
    it('insert persists a user retrievable by findAnyByEmail', async () => {
      const id = randomUUID();
      await userRepository.insert({
        id,
        email: 'new-resident@gp.test',
        password_hash: DUMMY_HASH,
        role: 'resident',
        name: 'New Resident',
      });

      const row = await userRepository.findAnyByEmail('new-resident@gp.test');
      expect(row?.id).toBe(id);
      expect(row?.role).toBe('resident');
      expect(row?.name).toBe('New Resident');
      expect(row?.password_hash).toBe(DUMMY_HASH);
      expect(row?.deleted_at).toBeNull();
    });

    it('findAnyByEmail also finds soft-deleted holders while findByEmail skips them', async () => {
      const id = randomUUID();
      await connection('users').insert({
        id,
        email: 'soft-deleted@gp.test',
        password_hash: DUMMY_HASH,
        role: 'resident',
        name: null,
        deleted_at: connection.fn.now(),
      });

      const any = await userRepository.findAnyByEmail('soft-deleted@gp.test');
      expect(any?.id).toBe(id);
      expect(any?.deleted_at).not.toBeNull(); // physical row IS returned — S11 conflict branch needs it

      expect(await userRepository.findByEmail('soft-deleted@gp.test')).toBeUndefined();
    });

    it('insert inside a transaction rolls back with the trx (trailing trx? honored)', async () => {
      const trx = await connection.transaction();
      await userRepository.insert(
        {
          id: randomUUID(),
          email: 'trx-rollback@gp.test',
          password_hash: DUMMY_HASH,
          role: 'resident',
          name: null,
        },
        trx,
      );
      await trx.rollback();

      expect(await userRepository.findAnyByEmail('trx-rollback@gp.test')).toBeUndefined();

      const trx2 = await connection.transaction();
      await userRepository.insert(
        {
          id: randomUUID(),
          email: 'trx-commit@gp.test',
          password_hash: DUMMY_HASH,
          role: 'resident',
          name: null,
        },
        trx2,
      );
      await trx2.commit();
      expect(await userRepository.findAnyByEmail('trx-commit@gp.test')).toBeDefined();
    });
  });
});