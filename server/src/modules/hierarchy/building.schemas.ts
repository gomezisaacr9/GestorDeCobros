import { z } from 'zod';

/**
 * Building create body: `name` trimmed 1–255 chars, `condominium_id` must be a uuid.
 */
export const BuildingCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  condominium_id: z.string().uuid(),
});

export type BuildingCreateInput = z.infer<typeof BuildingCreateSchema>;