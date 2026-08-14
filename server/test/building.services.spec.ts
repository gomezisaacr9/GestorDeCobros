import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { condominiumService } from '../src/services/condominium.service';
import { buildingService } from '../src/services/building.service';
import { NotFoundError, ConflictError } from '../src/errors/http-errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('buildingService', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('create returns the public shape for a valid active parent condominium', async () => {
    const condominium = await condominiumService.create('Torres del Sol');

    const result = await buildingService.create('Edificio A', condominium.id);

    expect(result.id).toMatch(UUID_RE);
    expect(result.name).toBe('Edificio A');
    expect(result.created_at).toBeTruthy();
    expect(result.updated_at).toBeTruthy();
    expect(result).not.toHaveProperty('deleted_at');
  });

  it('create rejects with NotFoundError when the parent is soft-deleted', async () => {
    const condominium = await condominiumService.create('Torres del Sol');
    await connection('condominiums')
      .where({ id: condominium.id })
      .update({ deleted_at: connection.fn.now() });

    await expect(buildingService.create('Edificio A', condominium.id)).rejects.toThrow(NotFoundError);
  });

  it('create rejects with ConflictError when the name already exists inside the same condominium', async () => {
    const condominium = await condominiumService.create('Torres del Sol');
    await buildingService.create('Edificio A', condominium.id);

    await expect(buildingService.create('Edificio A', condominium.id)).rejects.toThrow(ConflictError);
  });

  it('create allows the same name in a different condominium', async () => {
    const first = await condominiumService.create('Torres del Sol');
    const second = await condominiumService.create('Parque Central');

    await buildingService.create('Edificio A', first.id);
    const result = await buildingService.create('Edificio A', second.id);

    expect(result.name).toBe('Edificio A');
    expect(result.id).not.toBe((await buildingService.listByCondominium(first.id))[0].id);
  });

  it('listByCondominium returns active buildings of the scope ordered by name ASC', async () => {
    const condominium = await condominiumService.create('Torres del Sol');
    await buildingService.create('Torre B', condominium.id);
    await buildingService.create('Torre A', condominium.id);
    const toDelete = await buildingService.create('Torre C', condominium.id);
    await connection('buildings').where({ id: toDelete.id }).update({ deleted_at: connection.fn.now() });

    const rows = await buildingService.listByCondominium(condominium.id);
    expect(rows.map((r) => r.name)).toEqual(['Torre A', 'Torre B']);
  });
});