import { z } from 'zod';

import { ORG_FEATURE_KEYS } from '../constants/org-features.js';
import { OrgStatus } from '../enums/index.js';
import { slugSchema, uuidSchema } from './common.js';

export const organizationSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  status: z.nativeEnum(OrgStatus),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const updateOrganizationBodySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
});
export type UpdateOrganizationBody = z.infer<typeof updateOrganizationBodySchema>;

// Platform-admin-only ops
export const adminListOrgsQuerySchema = z.object({
  q: z.string().optional(),
  status: z.nativeEnum(OrgStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const adminUpdateOrgBodySchema = z.object({
  status: z.nativeEnum(OrgStatus).optional(),
  name: z.string().trim().min(2).max(120).optional(),
});

// Platform-admin tenant creation. Bypasses email-verify because the operator
// is vouching for the customer; the admin user lands `active` + verified.
// `password` is optional — if not supplied, the server generates a strong
// one and returns it once in the response so the operator can copy it.
export const adminCreateTenantBodySchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  organizationSlug: slugSchema.optional(),
  planCode: z.enum(['free', 'starter', 'growth', 'enterprise']).optional(),
  adminFirstName: z.string().trim().min(1).max(60),
  adminLastName: z.string().trim().min(0).max(60).default(''),
  adminEmail: z.string().trim().toLowerCase().email(),
  // Operator-provided password (≥12 chars) or null/undefined to let the
  // server generate one. Plain text in transit; over TLS only.
  adminPassword: z.string().min(12).max(128).optional(),
  // When true (default), the new admin gets an email with the login URL +
  // their credentials. Disable to onboard silently for QA / migrations.
  sendWelcomeEmail: z.boolean().default(true),
  // Features to DISABLE for this tenant from the start (keys from the shared
  // ORG_FEATURES registry). Empty = full access. Can be changed later from the
  // org detail page's "Access & features" card.
  // Cap is a sanity bound, not a business rule — keep it comfortably above
  // ORG_FEATURE_KEYS.length or saving all-features-off silently 400s. Bumped
  // 20 -> 40 when `sales_scan` became the 20th key (zero headroom at 20).
  // A ceiling test in apps/api/test guards the next bump.
  disabledFeatures: z
    .array(z.enum(ORG_FEATURE_KEYS as [string, ...string[]]))
    .max(40)
    .default([]),
  // AI model tier: basic (Groq Llama 3.3 — cheap/fast), middle (GPT-4o —
  // premium quality), max/ultra (Claude — best reasoning + persona memory).
  // Drives reply quality AND our cost. Defaults to 'basic'.
  aiPlan: z.enum(['basic', 'middle', 'max', 'ultra']).optional(),
  // Monthly AI-message allowance for the new tenant (1 message = 1 bot reply /
  // voice turn). Omit = column default (2000); null = Unlimited.
  monthlyAiMessageCap: z.number().int().min(0).max(10_000_000).nullable().optional(),
  // WhatsApp wallet (metered billing). Metering OFF by default so broadcasts
  // aren't gated. A per-message price ($0.08 default) + optional starting
  // balance can be set here; a top-up auto-enables metering.
  walletMeteringEnabled: z.boolean().default(false),
  walletPricePerMessageUsd: z.number().min(0.0375).max(100).optional(),
  walletInitialTopUpUsd: z.number().min(0).max(1_000_000).optional(),
});
export type AdminCreateTenantBody = z.infer<typeof adminCreateTenantBodySchema>;

export const adminCreateTenantResponseSchema = z.object({
  data: z.object({
    organization: organizationSchema,
    admin: z.object({
      id: uuidSchema,
      email: z.string().email(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
    }),
    // Only present when the server generated the password (i.e. operator
    // left it blank). Shown to the operator ONCE — never persisted to a UI
    // store or query cache. Email also contains it for the end user.
    generatedPassword: z.string().nullable(),
    welcomeEmailSent: z.boolean(),
  }),
});
