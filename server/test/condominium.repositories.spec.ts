import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { condominiumRepository } from '../src/repositories/condominium.repository';

describe('condominiumRepository', () => {
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
    const id = randomUUID();
    const row = await condominiumRepository.insert({ id, name: 'Torres del Sol' });

    expect(row.id).toBe(id);
    expect(row.name).toBe('Torres del Sol');
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
    expect(row.deleted_at).toBeNull();
  });

  it('listByAll excludes soft-deleted and orders by name ASC', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await condominiumRepository.insert({ id: ids[0], name: 'Zeta' });
    await condominiumRepository.insert({ id: ids[1], name: 'Alpha' });
    await condominiumRepository.insert({ id: ids[2], name: 'Beta' });

    // soft-delete Zeta directly
    await connection('condominiums').where({ id: ids[0] }).update({ deleted_at: connection.fn.now() });

    const rows = await condominiumRepository.listByAll();
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta']);
  });

  it('findActiveById returns the row for an active condominium and null for a soft-deleted one', async () => {
    const activeId = randomUUID();
    await condominiumRepository.insert({ id: activeId, name: 'Activo' });
    const row = await condominiumRepository.findActiveById(activeId);
    expect(row?.name).toBe('Activo');

    const deletedId = randomUUID();
    await condominiumRepository.insert({ id: deletedId, name: 'Borrado' });
    await connection('condominiums').where({ id: deletedId }).update({ deleted_at: connection.fn.now() });
    expect(await condominiumRepository.findActiveById(deletedId)).toBeNull();
  });

  it('existsById is true for any existing row (soft-deleted included) and false for unknown ids', async () => {
    const id = randomUUID();
    await condominiumRepository.insert({ id, name: 'Cualquiera' });
    expect(await condominiumRepository.existsById(id)).toBe(true);

    await connection('condominiums').where({ id }).update({ deleted_at: connection.fn.now() });
    expect(await condominiumRepository.existsById(id)).toBe(true);
    expect(await condominiumRepository.existsById(randomUUID())).toBe(false);
  });
});