import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import connection from '../db/connection';
import { migrateToLatest } from './helpers/db';

const CONDO_ID = '11111111-1111-4111-8111-111111111111';
const BUILDING_ID = '22222222-2222-4222-8222-222222222222';

async function insertParentChain(): Promise<void> {
  await connection('condominiums').insert({ id: CONDO_ID, name: 'Migración Probes' });
  await connection('buildings').insert({ id: BUILDING_ID, condominium_id: CONDO_ID, name: 'Probe B' });
}

describe('migration 006 — units.number NOT NULL', () => {
  beforeAll(async () => {
    await migrateToLatest(connection);
  });

  afterAll(async () => {
    await connection.destroy();
  });

  it('adds a NOT NULL `number` column to units', async () => {
    const info = await connection('units').columnInfo();
    expect(info.number).toBeDefined();
    expect(info.number.nullable).toBe(false);
  });

  it('rejects inserting a unit without a number', async () => {
    await insertParentChain();
    const attempt = connection('units').insert({ id: '33333333-3333-4333-8333-333333333333', building_id: BUILDING_ID });
    await expect(attempt).rejects.toThrow();
  });

  it('down() restores the exact 003 shape (no number column)', async () => {
    // migrate.down() undoes ONLY the last migration (006) — migrate.rollback()
    // would undo the whole batch (knex records all pending migrations in batch 1).
    await connection.migrate.down();
    const info = await connection('units').columnInfo();
    expect(info.number).toBeUndefined();
    expect(info.building_id.nullable).toBe(false);
    // 003 units has NO `number` column at all: inserting one must fail.
    const attempt = connection('units').insert({
      id: '44444444-4444-4444-8444-444444444444',
      building_id: BUILDING_ID,
      number: '101',
    });
    await expect(attempt).rejects.toThrow();
  });

  it('re-runs migrate:latest cleanly, restoring the 006 shape', async () => {
    await migrateToLatest(connection);
    const info = await connection('units').columnInfo();
    expect(info.number).toBeDefined();
    expect(info.number.nullable).toBe(false);
  });
});