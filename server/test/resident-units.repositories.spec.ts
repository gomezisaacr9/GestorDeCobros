import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { residentUnitsRepository } from '../src/repositories/resident-units.repository';

/**
 * `listUnitIdsByUser` (PR-1 Foundation, task 1.4 / design "resident-units
 * ADDED") — the BLOCKER for PR-2's resident panel: the membership filter
 * backing `GET /api/v1/expenses/mine` (spec R2). Returns the caller's unit
 * ids from a single SQL filter, or an empty array when there are none —
 * never null, never a throw.
 */

const PW = 'scrypt$16384$8$1$000102030405060708090a0b0c0d0e0f' + 'a'.repeat(128);

async function seedChain(): Promise<{ unitIdA: string; unitIdB: string }> {
  const condoId = randomUUID();
  const buildingId = randomUUID();
  const unitIdA = randomUUID();
  const unitIdB = randomUUID();
  await connection('condominiums').insert({ id: condoId, name: 'Mine Norte' });
  await connection('buildings').insert({ id: buildingId, condominium_id: condoId, name: 'Edificio A' });
  await connection('units').insert({ id: unitIdA, building_id: buildingId, number: '101' });
  await connection('units').insert({ id: unitIdB, building_id: buildingId, number: '102' });
  return { unitIdA, unitIdB };
}

async function seedResident(): Promise<string> {
  const id = randomUUID();
  await connection('users').insert({
    id,
    email: `mine-${id}@gp.test`,
    password_hash: PW,
    role: 'resident',
    name: null,
  });
  return id;
}

describe('resident-units repository — listUnitIdsByUser', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('returns every unit id the user is linked to (M:N membership)', async () => {
    const { unitIdA, unitIdB } = await seedChain();
    const userId = await seedResident();

    await residentUnitsRepository.linkIfAbsent(userId, unitIdA);
    await residentUnitsRepository.linkIfAbsent(userId, unitIdB);

    const ids = await residentUnitsRepository.listUnitIdsByUser(userId);
    expect(ids.sort()).toEqual([unitIdA, unitIdB].sort());
  });

  it('returns the ids of other users untouched (neighbor isolation)', async () => {
    const { unitIdA, unitIdB } = await seedChain();
    const me = await seedResident();
    const neighbor = await seedResident();

    await residentUnitsRepository.linkIfAbsent(me, unitIdA);
    await residentUnitsRepository.linkIfAbsent(neighbor, unitIdB);

    const ids = await residentUnitsRepository.listUnitIdsByUser(me);
    expect(ids).toEqual([unitIdA]);
  });

  it('returns an empty array for a user with no links', async () => {
    const { unitIdA } = await seedChain();
    const userId = await seedResident();
    const other = await seedResident();

    // Membership exists but belongs to `other`.
    await residentUnitsRepository.linkIfAbsent(other, unitIdA);

    expect(await residentUnitsRepository.listUnitIdsByUser(userId)).toEqual([]);
  });

  it('returns an empty array for a nonexistent user', async () => {
    expect(await residentUnitsRepository.listUnitIdsByUser(randomUUID())).toEqual([]);
  });
});