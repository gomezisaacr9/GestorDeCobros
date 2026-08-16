import { describe, expect, it } from 'vitest';
import { CondominiumCreateSchema } from '../src/modules/hierarchy/condominium.schemas';

describe('CondominiumCreateSchema', () => {
  it('accepts a valid name', () => {
    const result = CondominiumCreateSchema.safeParse({ name: 'A' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = CondominiumCreateSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a name longer than 255 chars', () => {
    const result = CondominiumCreateSchema.safeParse({ name: 'x'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('trims surrounding whitespace (whitespace-only fails after trim)', () => {
    const trimmed = CondominiumCreateSchema.safeParse({ name: '  Torre Norte  ' });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) {
      expect(trimmed.data.name).toBe('Torre Norte');
    }

    const whitespaceOnly = CondominiumCreateSchema.safeParse({ name: '   ' });
    expect(whitespaceOnly.success).toBe(false);
  });
});