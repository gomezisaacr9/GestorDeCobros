import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { buildingRepository } from '../src/repositories/building.repository';

describe('buildingRepository', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('insert returns the row with timestamps and no deleted_at', async () => {
    const condominiumId = randomUUID();
    await connection('condominiums').insert({ id: condominiumId, name: 'Torres del Sol' });

    const id = randomUUID();
    const row = await buildingRepository.insert({ id, name: 'Torre A', condominium_id: condominiumId });

    expect(row.id).toBe(id);
    expect(row.name).toBe('Torre A');
    expect(row.condominium_id).toBe(condominiumId);
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
    expect(row.deleted_at).toBeNull();
  });

  it('listByCondominium scopes to the condominium, excludes soft-deleted, orders by name ASC', async () => {
    const cidA = randomUUID();
    const cidB = randomUUID();
    await connection('condominiums').insert([
      { id: cidA, name: 'Condominio A' },
      { id: cidB, name: 'Condominio B' },
    ]);

    await buildingRepository.insert({ id: randomUUID(), name: 'Zeta', condominium_id: cidA });
    await buildingRepository.insert({ id: randomUUID(), name: 'Alpha', condominium_id: cidA });
    const deletedId = randomUUID();
    await buildingRepository.insert({ id: deletedId, name: 'Borrada', condominium_id: cidA });
    await buildingRepository.insert({ id: randomUUID(), name: 'Fuera de scope', condominium_id: cidB });

    await connection('buildings').where({ id: deletedId }).update({ deleted_at: connection.fn.now() });

    const rows = await buildingRepository.listByCondominium(cidA);
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('findActiveById returns the row for an active building and null for a soft-deleted one', async () => {
    const cid = randomUUID();
    await connection('condominiums').insert({ id: cid, name: 'C' });

    const activeId = randomUUID();
    await buildingRepository.insert({ id: activeId, name: 'Activa', condominium_id: cid });
    const row = await buildingRepository.findActiveById(activeId);
    expect(row?.name).toBe('Activa');

    const deletedId = randomUUID();
    await buildingRepository.insert({ id: deletedId, name: 'Borrada', condominium_id: cid });
    await connection('buildings').where({ id: deletedId }).update({ deleted_at: connection.fn.now() });
    expect(await buildingRepository.findActiveById(deletedId)).toBeNull();
  });

  it('existsById is true for any existing row (soft-deleted included) and false for unknown ids', async () => {
    const cid = randomUUID();
    await connection('condominiums').insert({ id: cid, name: 'C' });

    const id = randomUUID();
    await buildingRepository.insert({ id, name: 'Cualquiera', condominium_id: cid });
    expect(await buildingRepository.existsById(id)).toBe(true);

    await connection('buildings').where({ id }).update({ deleted_at: connection.fn.now() });
    expect(await buildingRepository.existsById(id)).toBe(true);
    expect(await buildingRepository.existsById(randomUUID())).toBe(false);
  });
});