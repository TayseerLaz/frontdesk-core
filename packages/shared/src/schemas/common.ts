import { z } from 'zod';

/** UUID v4 format used everywhere by Prisma `gen_random_uuid()`. */
export const uuidSchema = z.string().uuid();

/** Slugs: lowercase, alphanumeric, hyphens, 3–48 chars. */
export const slugSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/, 'Use lowercase letters, numbers, and hyphens.');

/** Email — trimmed and lowercased; max 254 per RFC 5321. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

/**
 * Password policy:
 *   - 12+ chars
 *   - at least one upper, one lower, one digit
 *   - special char optional (NIST 800-63B prefers length over complexity, but
 *     we keep a soft requirement to deter trivially-guessable passwords).
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .refine((s) => /[a-z]/.test(s), 'Include at least one lowercase letter.')
  .refine((s) => /[A-Z]/.test(s), 'Include at least one uppercase letter.')
  .refine((s) => /[0-9]/.test(s), 'Include at least one digit.');

/** Pagination query params used on every list endpoint. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Standard list response envelope. */
export const listEnvelopeSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative().optional(),
  });

/** Standard single-item response envelope. */
export const itemEnvelopeSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: item });

export const successSchema = z.object({ ok: z.literal(true) });
export type SuccessResponse = z.infer<typeof successSchema>;
