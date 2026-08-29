import { z } from 'zod';

import { OrgRole, UserStatus } from '../enums/index.js';
import { emailSchema, uuidSchema } from './common.js';

export const memberSchema = z.object({
  membershipId: uuidSchema,
  userId: uuidSchema,
  email: emailSchema,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  role: z.nativeEnum(OrgRole),
  skills: z.array(z.string()).default([]),
  // F1 — page whitelist (null = full access for the role; admins always null).
  pageAccess: z.array(z.string()).nullable().default(null),
  status: z.nativeEnum(UserStatus),
  isActive: z.boolean(),
  // Protected/owner membership — role/deactivate/remove are blocked for it.
  protected: z.boolean().default(false),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const updateMemberRoleBodySchema = z.object({
  role: z.nativeEnum(OrgRole),
});
export type UpdateMemberRoleBody = z.infer<typeof updateMemberRoleBodySchema>;

// F1 — replace a member's page whitelist. null = full access for their role.
export const updateMemberPageAccessBodySchema = z.object({
  pageAccess: z.array(z.string().trim().min(1).max(64)).max(64).nullable(),
});
export type UpdateMemberPageAccessBody = z.infer<typeof updateMemberPageAccessBodySchema>;

export const updateMemberSkillsBodySchema = z.object({
  skills: z.array(
    z.string().trim().toLowerCase().max(40).regex(/^[a-z0-9_-]+$/i, 'Use letters, numbers, _ or -.'),
  ),
});
export type UpdateMemberSkillsBody = z.infer<typeof updateMemberSkillsBodySchema>;

export const updateProfileBodySchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});
export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(12)
    .max(128)
    .refine((s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s), 'Password too weak.'),
});
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;

// Admin resets ANOTHER member's password. If `password` is omitted the server
// generates a strong temporary one and returns it once for the admin to share.
// If provided, it must meet the same strength bar as a self-chosen password.
export const adminResetMemberPasswordBodySchema = z.object({
  password: z
    .string()
    .min(12)
    .max(128)
    .refine((s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s), 'Password too weak.')
    .optional(),
});
export type AdminResetMemberPasswordBody = z.infer<typeof adminResetMemberPasswordBodySchema>;

export const adminResetMemberPasswordResponseSchema = z.object({
  email: emailSchema,
  // The temporary password — returned ONCE for the admin to share. Present only
  // when the server generated it (null when the admin supplied their own).
  temporaryPassword: z.string().nullable(),
});
export type AdminResetMemberPasswordResponse = z.infer<typeof adminResetMemberPasswordResponseSchema>;
