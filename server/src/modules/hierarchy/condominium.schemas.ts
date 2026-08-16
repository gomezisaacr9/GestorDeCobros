import { z } from 'zod';

/**
 * Condominium create body: `name` trimmed, 1–255 chars.
 */
export const CondominiumCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
});

export type CondominiumCreateInput = z.infer<typeof CondominiumCreateSchema>;