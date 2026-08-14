import { z } from 'zod';

/**
 * Unit create body: `number` trimmed 1–50 chars, `building_id` must be a uuid.
 */
export const UnitCreateSchema = z.object({
  number: z.string().trim().min(1).max(50),
  building_id: z.string().uuid(),
});

export type UnitCreateInput = z.infer<typeof UnitCreateSchema>;