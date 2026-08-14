import { describe, expect, it } from 'vitest';
import { BuildingCreateSchema } from '../src/schemas/building.schemas';

const VALID_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('BuildingCreateSchema', () => {
  it('accepts a valid name and condominium_id uuid', () => {
    const result = BuildingCreateSchema.safeParse({ name: 'B', condominium_id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed condominium_id', () => {
    const result = BuildingCreateSchema.safeParse({ name: 'B', condominium_id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing condominium_id', () => {
    const result = BuildingCreateSchema.safeParse({ name: 'B' });
    expect(result.success).toBe(false);
  });
});