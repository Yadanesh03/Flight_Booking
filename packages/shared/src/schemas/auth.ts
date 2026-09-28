import { z } from 'zod';
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from '../constants.js';

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** Lowercased + trimmed, valid, <= 255 chars. */
export const emailSchema = z.string().trim().toLowerCase().max(255).pipe(z.email());

const passwordTooLong = `Password must be at most ${PASSWORD_MAX_BYTES} bytes.`;

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
    .refine((value) => byteLength(value) <= PASSWORD_MAX_BYTES, { message: passwordTooLong })
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(1)
    .refine((value) => byteLength(value) <= PASSWORD_MAX_BYTES, { message: passwordTooLong })
});
export type LoginInput = z.infer<typeof loginSchema>;
