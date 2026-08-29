import {
  parsePageAccess,
  updateMemberPageAccessBodySchema,
  adminResetMemberPasswordBodySchema,
  adminResetMemberPasswordResponseSchema,
  ApiErrorCode,
  createInvitationBodySchema,
  invitationListItemSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  memberSchema,
  successSchema,
  updateMemberRoleBodySchema,
  updateMemberSkillsBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { generateTempPassword, hashPassword } from '../../lib/crypto.js';
import { prisma } from '../../lib/db.js';
import { getRedis } from '../../lib/redis.js';
import { pageAccessCacheKey } from '../../plugins/auth.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { syncHqAdminForOrgChange } from '../../lib/hq-admin.js';
import { createInvitation } from '../auth/auth.service.js';

// Human-readable subject for audit metadata, so the activity log shows a name
// ("membership · John Doe") instead of just the membership id.
function subjectMeta(user: { firstName: string | null; lastName: string | null; email: string }) {
  return {
    subjectName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
    subjectEmail: user.email,
  };
}

export default async function memberRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /members --------------------------------------------------
  // Phase 5.6 — added cursor pagination + search to handle orgs with hundreds
  // of members without bloating the response.
  r.get(
    '/members',
    {
      schema: {
        tags: ['members'],
        summary: 'List members of the active organization (cursor-paginated).',
        querystring: z.object({
          search: z.string().trim().max(120).optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: listEnvelopeSchema(memberSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const { search, cursor, limit } = req.query;
        const where: Record<string, unknown> = {};
        if (search) {
          const trimmed = search.trim();
          where.user = {
            OR: [
              { email: { contains: trimmed, mode: 'insensitive' } },
              { firstName: { contains: trimmed, mode: 'insensitive' } },
              { lastName: { contains: trimmed, mode: 'insensitive' } },
            ],
          };
        }
        const memberships = await tx.membership.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { user: true },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        const hasMore = memberships.length > limit;
        const slice = hasMore ? memberships.slice(0, limit) : memberships;
        return {
          data: slice.map((m) => ({
            membershipId: m.id,
            userId: m.userId,
            email: m.user.email,
            firstName: m.user.firstName,
            lastName: m.user.lastName,
            avatarUrl: m.user.avatarUrl,
            role: m.role,
            skills: m.skills,
            pageAccess: m.role === 'admin' ? null : parsePageAccess(m.pageAccess),
            status: m.user.status,
            isActive: m.isActive,
            protected: m.isProtected,
            lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
            createdAt: m.createdAt.toISOString(),
          })),
          nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
        };
      });
    },
  );

  // ---------- PATCH /members/:id/skills ------------------------------------
  r.patch(
    '/members/:id/skills',
    {
      schema: {
        tags: ['members'],
        summary: 'Replace the member’s skill tags. Used by skill-based routing.',
        params: z.object({ id: uuidSchema }),
        body: updateMemberSkillsBodySchema,
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.membership.update({
          where: { id: req.params.id },
          data: { skills: req.body.skills },
        });
        return { ok: true as const };
      }),
  );

  // ---------- PATCH /members/:id/page-access (F1) --------------------------
  r.patch(
    '/members/:id/page-access',
    {
      schema: {
        tags: ['members'],
        summary: "Replace the member's page whitelist (null = full access for their role).",
        params: z.object({ id: uuidSchema }),
        body: updateMemberPageAccessBodySchema,
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const target = await app.tenant(req, async (tx) => {
        const membership = await tx.membership.findUnique({
          where: { id: req.params.id },
          select: { id: true, userId: true, role: true, isProtected: true },
        });
        if (!membership) throw notFound('Member not found.');
        // Admins are ALWAYS exempt from page whitelists (lock-out protection):
        // to restrict someone, change their role to editor/viewer first.
        if (membership.role === 'admin') {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Admins always have full access. Change their role to editor or viewer first.',
          );
        }
        await tx.membership.update({
          where: { id: membership.id },
          data: { pageAccess: (req.body.pageAccess ?? null) as never },
        });
        return membership;
      });
      // The auth plugin caches the whitelist 60s — drop it so this applies now.
      await getRedis()
        .del(pageAccessCacheKey(target.userId, orgId))
        .catch(() => undefined);
      await recordAudit({
        action: 'user_role_changed',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'membership',
        entityId: req.params.id,
        metadata: {
          event: 'page_access_changed',
          pageAccess: req.body.pageAccess ?? null,
        },
      });
      return { ok: true as const };
    },
  );

  // ---------- PATCH /members/:id/role --------------------------------------
  r.patch(
    '/members/:id/role',
    {
      schema: {
        tags: ['members'],
        summary: 'Change a member’s role.',
        params: z.object({ id: uuidSchema }),
        body: updateMemberRoleBodySchema,
        response: { 200: itemEnvelopeSchema(memberSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const result = await app.tenant(req, async (tx) => {
        const membership = await tx.membership.findUnique({ where: { id: req.params.id } });
        if (!membership) throw notFound('Member not found.');

        // Protected/owner account — its role can't be changed by anyone.
        if (membership.isProtected) {
          throw forbidden(
            ApiErrorCode.FORBIDDEN,
            'This account is protected — its role cannot be changed.',
          );
        }

        // Prevent demoting the last admin.
        if (membership.role === 'admin' && req.body.role !== 'admin') {
          const adminCount = await tx.membership.count({ where: { role: 'admin', isActive: true } });
          if (adminCount <= 1) throw badRequest(ApiErrorCode.CONFLICT, 'You cannot demote the last admin.');
        }

        const updated = await tx.membership.update({
          where: { id: req.params.id },
          data: { role: req.body.role },
          include: { user: true },
        });

        // Make the change take effect immediately on a DOWNGRADE. Roles are
        // enforced server-side from the JWT `role` claim, and the refresh flow
        // re-reads the role from the DB — so any change propagates on the next
        // token refresh (≤ the 15-min access-token TTL). For a demotion that
        // lag is a privilege-persistence window, so we revoke the member's
        // sessions in this org: their next refresh fails, they re-authenticate,
        // and the new (lower) role is in force right away. Promotions don't need
        // this — the extra power simply appears on the next refresh, no logout.
        const RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3 };
        const isDowngrade = (RANK[req.body.role] ?? 0) < (RANK[membership.role] ?? 0);
        if (isDowngrade) {
          await prisma.session.updateMany({
            where: {
              userId: updated.userId,
              organizationId: req.auth!.organizationId,
              revokedAt: null,
            },
            data: { revokedAt: new Date() },
          });
        }

        await recordAudit({
          action: 'user_role_changed',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'membership',
          entityId: updated.id,
          metadata: { from: membership.role, to: req.body.role, ...subjectMeta(updated.user) },
        });

        return {
          data: {
            membershipId: updated.id,
            userId: updated.userId,
            email: updated.user.email,
            firstName: updated.user.firstName,
            lastName: updated.user.lastName,
            avatarUrl: updated.user.avatarUrl,
            role: updated.role,
            skills: updated.skills,
            status: updated.user.status,
            isActive: updated.isActive,
            protected: updated.isProtected,
            lastLoginAt: updated.user.lastLoginAt?.toISOString() ?? null,
            createdAt: updated.createdAt.toISOString(),
          },
        };
      });
      // Auto-sync platform HQ access: if this role change is in the the platform org,
      // an admin there becomes a full HQ admin (isSuperAdmin), and a demotion
      // revokes it — so HQ access mirrors the platform-org admin status exactly.
      await syncHqAdminForOrgChange(req.auth!.organizationId, result.data.userId);
      return result;
    },
  );

  // ---------- POST /members/:id/reset-password -----------------------------
  // An admin resets another member's password. Sets a new password (supplied,
  // or a strong server-generated temporary one returned once), clears any login
  // lockout, and revokes ALL the member's sessions so they must sign in again
  // with the new password. Passwords are a global user credential, so the
  // update + session revoke use the owner client (not the tenant tx); the
  // membership lookup stays tenant-scoped so an admin can only reset members of
  // their own org.
  r.post(
    '/members/:id/reset-password',
    {
      schema: {
        tags: ['members'],
        summary: 'Reset a member’s password (admin sets a temporary password).',
        params: z.object({ id: uuidSchema }),
        body: adminResetMemberPasswordBodySchema,
        response: { 200: itemEnvelopeSchema(adminResetMemberPasswordResponseSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const membership = await app.tenant(req, async (tx) =>
        tx.membership.findUnique({ where: { id: req.params.id }, include: { user: true } }),
      );
      if (!membership) throw notFound('Member not found.');
      if (membership.isProtected) {
        throw forbidden(
          ApiErrorCode.FORBIDDEN,
          'This account is protected — its password cannot be reset here.',
        );
      }
      if (membership.userId === req.auth!.userId) {
        throw badRequest(
          ApiErrorCode.CONFLICT,
          'Use your profile settings to change your own password.',
        );
      }

      const generated = req.body.password ? null : generateTempPassword(16);
      const newPassword = req.body.password ?? generated!;
      const passwordHash = await hashPassword(newPassword);

      await prisma.user.update({
        where: { id: membership.userId },
        data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
      });
      // Global credential change → revoke every active session for this user
      // (across all orgs), forcing a fresh login with the new password.
      await prisma.session.updateMany({
        where: { userId: membership.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await recordAudit({
        action: 'password_reset_by_admin',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'membership',
        entityId: membership.id,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: subjectMeta(membership.user),
      });

      // Return the temp password ONLY when the server generated it — never echo
      // an admin-supplied one back.
      return { data: { email: membership.user.email, temporaryPassword: generated } };
    },
  );

  // ---------- POST /members/:id/deactivate ---------------------------------
  r.post(
    '/members/:id/deactivate',
    {
      schema: {
        tags: ['members'],
        summary: 'Deactivate a member (revokes their sessions).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const membership = await tx.membership.findUnique({
          where: { id: req.params.id },
          include: { user: true },
        });
        if (!membership) throw notFound('Member not found.');
        if (membership.isProtected) {
          throw forbidden(
            ApiErrorCode.FORBIDDEN,
            'This account is protected and cannot be deactivated.',
          );
        }
        if (membership.userId === req.auth!.userId) {
          throw forbidden(ApiErrorCode.FORBIDDEN, 'You cannot deactivate yourself.');
        }
        if (membership.role === 'admin') {
          const adminCount = await tx.membership.count({ where: { role: 'admin', isActive: true } });
          if (adminCount <= 1) throw badRequest(ApiErrorCode.CONFLICT, 'You cannot deactivate the last admin.');
        }
        await tx.membership.update({ where: { id: membership.id }, data: { isActive: false } });

        // Revoke all sessions for this user in this org.
        await prisma.session.updateMany({
          where: { userId: membership.userId, organizationId: orgId, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        await recordAudit({
          action: 'user_deactivated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'membership',
          entityId: membership.id,
          metadata: subjectMeta(membership.user),
        });

        // Losing an active the platform-org admin membership revokes HQ access.
        await syncHqAdminForOrgChange(orgId, membership.userId);
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /members/:id/reactivate ---------------------------------
  r.post(
    '/members/:id/reactivate',
    {
      schema: {
        tags: ['members'],
        summary: 'Reactivate a previously deactivated member.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const membership = await tx.membership.findUnique({
          where: { id: req.params.id },
          include: { user: true },
        });
        if (!membership) throw notFound('Member not found.');
        if (membership.isActive) {
          // Idempotent: already active — nothing to do.
          return { ok: true as const };
        }
        await tx.membership.update({ where: { id: membership.id }, data: { isActive: true } });
        await recordAudit({
          action: 'user_reactivated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'membership',
          entityId: membership.id,
          metadata: subjectMeta(membership.user),
        });
        // Reactivating an the platform-org admin restores their HQ access.
        await syncHqAdminForOrgChange(orgId, membership.userId);
        return { ok: true as const };
      });
    },
  );

  // ---------- DELETE /members/:id ------------------------------------------
  // Removes the member from THIS organization (deletes the membership row).
  // Guards mirror deactivate (no self, no last admin). Threads assigned to them
  // in this org are unassigned, and their sessions for this org are revoked.
  //
  // Email reuse: if this was the user's LAST membership anywhere, we release
  // their email so it can be used for a fresh signup again. We do NOT hard-
  // delete the User row — Invitation.invitedBy/acceptedBy are FK-restricted
  // (every invited user is referenced as an acceptedBy), so a delete would
  // fail. Instead we tombstone the email + disable the account, which frees the
  // original address while preserving audit + invitation history. If they still
  // belong to other orgs, the account is left fully intact.
  r.delete(
    '/members/:id',
    {
      schema: {
        tags: ['members'],
        summary: 'Remove a member from the active organization.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const subject = await app.tenant(req, async (tx) => {
        const membership = await tx.membership.findUnique({
          where: { id: req.params.id },
          include: { user: true },
        });
        if (!membership) throw notFound('Member not found.');
        if (membership.isProtected) {
          throw forbidden(ApiErrorCode.FORBIDDEN, 'This account is protected and cannot be removed.');
        }
        if (membership.userId === req.auth!.userId) {
          throw forbidden(ApiErrorCode.FORBIDDEN, 'You cannot remove yourself.');
        }
        if (membership.role === 'admin') {
          const adminCount = await tx.membership.count({ where: { role: 'admin', isActive: true } });
          if (adminCount <= 1) {
            throw badRequest(ApiErrorCode.CONFLICT, 'You cannot remove the last admin.');
          }
        }

        // Unassign any threads owned by this user in this org so we don't leave
        // dangling assignments pointing at a removed member.
        await tx.whatsAppThread.updateMany({
          where: { organizationId: orgId, assignedToUserId: membership.userId },
          data: { assignedToUserId: null },
        });

        await tx.membership.delete({ where: { id: membership.id } });

        // Revoke their sessions for this org (uses the non-tenant client; the
        // session row carries organizationId).
        await prisma.session.updateMany({
          where: { userId: membership.userId, organizationId: orgId, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        await recordAudit({
          action: 'user_removed',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'membership',
          entityId: membership.id,
          metadata: subjectMeta(membership.user),
        });

        return { userId: membership.userId };
      });

      // Removing an the platform-org admin revokes their platform HQ access.
      await syncHqAdminForOrgChange(orgId, subject.userId);

      // Post-commit: was that their last membership anywhere? If so, release the
      // email + disable the account so the address can be reused for signup.
      const remaining = await prisma.membership.count({ where: { userId: subject.userId } });
      if (remaining === 0) {
        await prisma.user.update({
          where: { id: subject.userId },
          data: {
            email: `removed+${subject.userId}@deleted.invalid`,
            status: 'disabled',
            passwordHash: '!', // unusable — they can no longer log in
            emailVerificationTokenHash: null,
            passwordResetTokenHash: null,
            totpEnabled: false,
            totpSecret: null,
            // Drop all remaining sessions globally (no org context left).
            sessions: { updateMany: { where: { revokedAt: null }, data: { revokedAt: new Date() } } },
          },
        });
      }

      return { ok: true as const };
    },
  );

  // ---------- GET /invitations ---------------------------------------------
  r.get(
    '/invitations',
    {
      schema: {
        tags: ['members'],
        summary: 'List invitations for the active organization.',
        response: { 200: listEnvelopeSchema(invitationListItemSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const invites = await tx.invitation.findMany({
          orderBy: { createdAt: 'desc' },
          include: { invitedBy: true },
        });
        return {
          data: invites.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            status: i.status,
            invitedById: i.invitedById,
            invitedByName:
              [i.invitedBy.firstName, i.invitedBy.lastName].filter(Boolean).join(' ') || i.invitedBy.email,
            acceptedAt: i.acceptedAt?.toISOString() ?? null,
            expiresAt: i.expiresAt.toISOString(),
            createdAt: i.createdAt.toISOString(),
          })),
          nextCursor: null,
        };
      });
    },
  );

  // ---------- POST /invitations --------------------------------------------
  r.post(
    '/invitations',
    {
      schema: {
        tags: ['members'],
        summary: 'Invite a teammate to the active organization.',
        body: createInvitationBodySchema,
        response: { 201: itemEnvelopeSchema(invitationListItemSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const invite = await createInvitation({
        organizationId: req.auth!.organizationId,
        email: req.body.email,
        role: req.body.role,
        // F1 — meaningless for admin invites (always full access).
        pageAccess: req.body.role === 'admin' ? null : (req.body.pageAccess ?? null),
        invitedById: req.auth!.userId,
        meta: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
      });
      reply.code(201);
      return {
        data: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          status: invite.status,
          invitedById: invite.invitedById,
          invitedByName:
            [invite.invitedBy.firstName, invite.invitedBy.lastName].filter(Boolean).join(' ') ||
            invite.invitedBy.email,
          acceptedAt: invite.acceptedAt?.toISOString() ?? null,
          expiresAt: invite.expiresAt.toISOString(),
          createdAt: invite.createdAt.toISOString(),
        },
      };
    },
  );

  // ---------- POST /invitations/:id/revoke ---------------------------------
  r.post(
    '/invitations/:id/revoke',
    {
      schema: {
        tags: ['members'],
        summary: 'Revoke a pending invitation.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const invite = await tx.invitation.findUnique({ where: { id: req.params.id } });
        if (!invite) throw notFound('Invitation not found.');
        if (invite.status !== 'pending') {
          throw badRequest(ApiErrorCode.CONFLICT, 'Only pending invitations can be revoked.');
        }
        await tx.invitation.update({ where: { id: invite.id }, data: { status: 'revoked' } });
        await recordAudit({
          action: 'invitation_revoked',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'invitation',
          entityId: invite.id,
        });
        return { ok: true as const };
      });
    },
  );
}
