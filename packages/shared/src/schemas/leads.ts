import { z } from 'zod';

// Public capture — what the marketing site posts. The form strips non-digits
// from the phone field client-side; we keep server validation loose enough to
// accept an optional leading + and 6–18 digits (E.164-ish, Gulf numbers etc.).
export const leadCaptureBodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{6,18}$/, 'Enter a valid number (digits only).'),
  source: z.string().trim().max(60).optional(),
  // Honeypot: a hidden field real users never fill. Bots auto-fill every input,
  // so a non-empty value means a bot — the server silently drops it.
  website: z.string().max(200).optional(),
});
export type LeadCaptureBody = z.infer<typeof leadCaptureBodySchema>;

export const leadStatusSchema = z.enum(['new', 'contacted', 'converted', 'archived']);
export type LeadStatusValue = z.infer<typeof leadStatusSchema>;

export const leadSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  phone: z.string(),
  source: z.string(),
  status: leadStatusSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type LeadDto = z.infer<typeof leadSchema>;

export const adminListLeadsQuerySchema = z.object({
  q: z.string().optional(),
  status: leadStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const adminUpdateLeadBodySchema = z.object({
  status: leadStatusSchema.optional(),
  note: z.string().max(2000).nullable().optional(),
});
