import { z } from 'zod';

/**
 * Login body: `email` must be a well-formed email, `password` a non-empty string.
 * bcrypt truncates at 72 bytes, so `newPassword` is capped at 128 in RotateSchema.
 */
export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const RotateSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(128),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RotateInput = z.infer<typeof RotateSchema>;