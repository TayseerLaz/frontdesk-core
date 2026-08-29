import { z } from 'zod';

import { OrgRole } from '../enums/index.js';
import { emailSchema, passwordSchema, slugSchema, uuidSchema } from './common.js';

// ---------- signup ----------------------------------------------------------
export const signupBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  organizationName: z.string().trim().min(2).max(120),
  organizationSlug: slugSchema,
});
export type SignupBody = z.infer<typeof signupBodySchema>;

export const signupResponseSchema = z.object({
  user: z.object({
    id: uuidSchema,
    email: emailSchema,
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
  }),
  organization: z.object({
    id: uuidSchema,
    slug: slugSchema,
    name: z.string(),
  }),
  emailVerificationRequired: z.boolean(),
});

// ---------- login -----------------------------------------------------------
export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
  organizationSlug: slugSchema.optional(), // pick org if user belongs to many
  // Phase 5.5 — TOTP 2FA. 6-digit numeric code OR an 8-char recovery code.
  totpCode: z.string().trim().min(6).max(20).optional(),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
  user: z.object({
    id: uuidSchema,
    email: emailSchema,
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    isSuperAdmin: z.boolean(),
  }),
  organization: z.object({
    id: uuidSchema,
    slug: slugSchema,
    name: z.string(),
    role: z.nativeEnum(OrgRole),
    // super-admin per-tenant access control (disabled feature keys).
    disabledFeatures: z.array(z.string()).default([]),
  }),
  availableOrganizations: z.array(
    z.object({
      id: uuidSchema,
      slug: slugSchema,
      name: z.string(),
      role: z.nativeEnum(OrgRole),
    }),
  ),
});

// ---------- refresh / logout ------------------------------------------------
export const refreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string().datetime(),
});

// ---------- forgot / reset password ----------------------------------------
export const forgotPasswordBodySchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;

export const resetPasswordBodySchema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
});
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;

// ---------- email verification ---------------------------------------------
export const verifyEmailBodySchema = z.object({
  token: z.string().min(20),
});
export type VerifyEmailBody = z.infer<typeof verifyEmailBodySchema>;

// ---------- profile ---------------------------------------------------------
// `updateProfileBodySchema` and `changePasswordBodySchema` live in schemas/user.ts.
export const updateProfileResponseSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
});

// ---------- invitations -----------------------------------------------------
export const createInvitationBodySchema = z.object({
  email: emailSchema,
  role: z.nativeEnum(OrgRole),
  // F1 — page whitelist the new membership starts with (null/omitted = all).
  pageAccess: z.array(z.string().trim().min(1).max(64)).max(64).nullable().optional(),
});
export type CreateInvitationBody = z.infer<typeof createInvitationBodySchema>;

// Base object kept separate so callers can `.omit()` / `.pick()` (the refined
// version is a ZodEffects which doesn't expose those helpers).
const acceptInvitationBaseSchema = z.object({
  token: z.string().min(20),
  // Required only if no account exists yet for the invited email.
  password: passwordSchema.optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
});

const acceptInvitationRefinement = (v: { password?: string; firstName?: string; lastName?: string }) =>
  v.password ? !!(v.firstName && v.lastName) : true;
const acceptInvitationRefinementMessage =
  'firstName and lastName are required when creating a new account.';

export const acceptInvitationBodySchema = acceptInvitationBaseSchema.refine(
  acceptInvitationRefinement,
  acceptInvitationRefinementMessage,
);
export type AcceptInvitationBody = z.infer<typeof acceptInvitationBodySchema>;

/** Body without `token` (used when the token is in the URL). Same refinement applied. */
export const acceptInvitationBodyWithoutTokenSchema = acceptInvitationBaseSchema
  .omit({ token: true })
  .refine(acceptInvitationRefinement, acceptInvitationRefinementMessage);
export type AcceptInvitationBodyWithoutToken = z.infer<typeof acceptInvitationBodyWithoutTokenSchema>;

export const invitationListItemSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  role: z.nativeEnum(OrgRole),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  invitedById: uuidSchema,
  invitedByName: z.string().nullable(),
  acceptedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

// ---------- session / current user -----------------------------------------
export const sessionResponseSchema = z.object({
  user: z.object({
    id: uuidSchema,
    email: emailSchema,
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    isSuperAdmin: z.boolean(),
  }),
  organization: z.object({
    id: uuidSchema,
    slug: slugSchema,
    name: z.string(),
    role: z.nativeEnum(OrgRole),
    // super-admin per-tenant access control (disabled feature keys).
    disabledFeatures: z.array(z.string()).default([]),
    // F1 — this member's page whitelist. null = full access for their role
    // (also always null for admins). The web intersects this with
    // disabledFeatures when rendering nav + guarding routes.
    pageAccess: z.array(z.string()).nullable().default(null),
  }),
  availableOrganizations: z.array(
    z.object({
      id: uuidSchema,
      slug: slugSchema,
      name: z.string(),
      role: z.nativeEnum(OrgRole),
    }),
  ),
});

// ---------- switch org ------------------------------------------------------
export const switchOrgBodySchema = z.object({
  organizationId: uuidSchema,
});
export type SwitchOrgBody = z.infer<typeof switchOrgBodySchema>;
