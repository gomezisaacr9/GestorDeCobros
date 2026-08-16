import { describe, expect, it } from 'vitest';
import { UnitCreateSchema } from '../src/modules/hierarchy/unit.schemas';

const VALID_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('UnitCreateSchema', () => {
  it('accepts a valid number and building_id uuid', () => {
    const result = UnitCreateSchema.safeParse({ number: '101', building_id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  it('rejects an empty number', () => {
    const result = UnitCreateSchema.safeParse({ number: '', building_id: VALID_UUID });
    expect(result.success).toBe(false);
  });

  it('rejects a number longer than 50 chars', () => {
    const result = UnitCreateSchema.safeParse({ number: '5'.repeat(51), building_id: VALID_UUID });
    expect(result.success).toBe(false);
  });
});