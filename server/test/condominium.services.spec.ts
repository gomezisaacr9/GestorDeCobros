import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest, wipe } from './helpers/db';
import { condominiumService } from '../src/services/condominium.service';
import { ConflictError } from '../src/errors/http-errors';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('condominiumService', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  beforeEach(async () => {
    await wipe(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('create returns the public shape with a uuid id and timestamps', async () => {
    const result = await condominiumService.create('Torres del Sol');

    expect(result.id).toMatch(UUID_RE);
    expect(result.name).toBe('Torres del Sol');
    expect(result.created_at).toBeTruthy();
    expect(result.updated_at).toBeTruthy();
    expect(result).not.toHaveProperty('deleted_at');
  });

  it('create rejects with ConflictError when the name already exists', async () => {
    await condominiumService.create('Alpha');

    await expect(condominiumService.create('Alpha')).rejects.toThrow(ConflictError);
  });

  it('list returns active condominiums ordered by name ASC, without deleted_at', async () => {
    await condominiumService.create('Zeta');
    await condominiumService.create('Alpha');
    const toDelete = await condominiumService.create('Beta');
    await connection('condominiums')
      .where({ id: toDelete.id })
      .update({ deleted_at: connection.fn.now() });

    const rows = await condominiumService.list();
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Zeta']);
    for (const row of rows) {
      expect(row).not.toHaveProperty('deleted_at');
    }
  });
});