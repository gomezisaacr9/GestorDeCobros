import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { condominiumService } from '../src/modules/hierarchy/condominium.service';
import { buildingService } from '../src/modules/hierarchy/building.service';
import { unitService } from '../src/modules/hierarchy/unit.service';
import { NotFoundError, ConflictError } from '../src/errors/http-errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function seedBuilding(): Promise<string> {
  const condominium = await condominiumService.create('Torres del Sol');
  const building = await buildingService.create('Edificio A', condominium.id);
  return building.id;
}

describe('unitService', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('create returns the public shape for a valid active parent building', async () => {
    const buildingId = await seedBuilding();

    const result = await unitService.create('101', buildingId);

    expect(result.id).toMatch(UUID_RE);
    expect(result.number).toBe('101');
    expect(result.created_at).toBeTruthy();
    expect(result.updated_at).toBeTruthy();
    expect(result).not.toHaveProperty('deleted_at');
  });

  it('create rejects with NotFoundError when the parent building does not exist', async () => {
    await expect(unitService.create('101', randomUUID())).rejects.toThrow(NotFoundError);
  });

  it('create rejects with NotFoundError when the parent building is soft-deleted', async () => {
    const buildingId = await seedBuilding();
    await connection('buildings').where({ id: buildingId }).update({ deleted_at: connection.fn.now() });

    await expect(unitService.create('101', buildingId)).rejects.toThrow(NotFoundError);
  });

  it('create rejects with ConflictError when the number already exists inside the same building', async () => {
    const buildingId = await seedBuilding();
    await unitService.create('101', buildingId);

    await expect(unitService.create('101', buildingId)).rejects.toThrow(ConflictError);
  });

  it('create allows the same number in a different building', async () => {
    const first = await seedBuilding();
    const second = await (async () => {
      const condominium = await condominiumService.create('Parque Central');
      return (await buildingService.create('Edificio B', condominium.id)).id;
    })();

    await unitService.create('101', first);
    const result = await unitService.create('101', second);

    expect(result.number).toBe('101');
    expect(result.id).not.toBe((await unitService.listByBuilding(first))[0].id);
  });

  it('listByBuilding returns active units of the scope ordered by number ASC', async () => {
    const buildingId = await seedBuilding();
    await unitService.create('2', buildingId);
    await unitService.create('10', buildingId);
    const toDelete = await unitService.create('1', buildingId);
    await connection('units').where({ id: toDelete.id }).update({ deleted_at: connection.fn.now() });

    const rows = await unitService.listByBuilding(buildingId);
    expect(rows.map((r) => r.number)).toEqual(['10', '2']);
  });
});