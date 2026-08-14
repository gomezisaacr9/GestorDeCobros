import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { unitRepository } from '../src/repositories/unit.repository';

describe('unitRepository', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  async function seedBuilding(condominiumId?: string, buildingId?: string): Promise<string> {
    const cid = condominiumId ?? randomUUID();
    const bid = buildingId ?? randomUUID();
    await connection('condominiums').insert({ id: cid, name: 'C' });
    await connection('buildings').insert({ id: bid, condominium_id: cid, name: 'B' });
    return bid;
  }

  it('insert returns the row with timestamps and no deleted_at', async () => {
    const buildingId = await seedBuilding();
    const id = randomUUID();
    const row = await unitRepository.insert({ id, number: '101', building_id: buildingId });

    expect(row.id).toBe(id);
    expect(row.number).toBe('101');
    expect(row.building_id).toBe(buildingId);
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
    expect(row.deleted_at).toBeNull();
  });

  it('listByBuilding scopes to the building, excludes soft-deleted, orders by number ASC', async () => {
    const buildingId = await seedBuilding();
    const otherBuildingId = await seedBuilding();

    await unitRepository.insert({ id: randomUUID(), number: '203', building_id: buildingId });
    await unitRepository.insert({ id: randomUUID(), number: '101', building_id: buildingId });
    const deletedId = randomUUID();
    await unitRepository.insert({ id: deletedId, number: '102', building_id: buildingId });
    await unitRepository.insert({ id: randomUUID(), number: '999', building_id: otherBuildingId });

    await connection('units').where({ id: deletedId }).update({ deleted_at: connection.fn.now() });

    const rows = await unitRepository.listByBuilding(buildingId);
    expect(rows.map((r) => r.number)).toEqual(['101', '203']);
  });

  it('findActiveById returns the row for an active unit and null for a soft-deleted one', async () => {
    const buildingId = await seedBuilding();

    const activeId = randomUUID();
    await unitRepository.insert({ id: activeId, number: '1A', building_id: buildingId });
    const row = await unitRepository.findActiveById(activeId);
    expect(row?.number).toBe('1A');

    const deletedId = randomUUID();
    await unitRepository.insert({ id: deletedId, number: '1B', building_id: buildingId });
    await connection('units').where({ id: deletedId }).update({ deleted_at: connection.fn.now() });
    expect(await unitRepository.findActiveById(deletedId)).toBeNull();
  });

  it('existsById is true for any existing row (soft-deleted included) and false for unknown ids', async () => {
    const buildingId = await seedBuilding();

    const id = randomUUID();
    await unitRepository.insert({ id, number: '2A', building_id: buildingId });
    expect(await unitRepository.existsById(id)).toBe(true);

    await connection('units').where({ id }).update({ deleted_at: connection.fn.now() });
    expect(await unitRepository.existsById(id)).toBe(true);
    expect(await unitRepository.existsById(randomUUID())).toBe(false);
  });
});