// Self-serve account endpoints (GDPR-adjacent):
//   - GET /account/export → downloads a JSON blob of everything about the
//     current user (profile, memberships, sessions, audit entries the user
//     authored). Tenant-scoped via RLS bypass because we explicitly want
//     data across every org the user belongs to.
//   - DELETE /account → soft-deletes the user, revokes all sessions, then
//     removes memberships. Refuses if the user is the last admin of any
//     org (mirroring the members-deactivate guard).
//
// Both are authenticated (JWT bearer, no role requirement — any member can
// manage their own data). Export is rate-limited separately from the
// global limiter to prevent a single user hammering a ~few-MB response.
//
// Security notes:
//   * audit metadata is filtered via `sanitiseAuditMetadata` before export
//     so any accidentally-logged secret or error trace does not leak.
//   * API key prefixes are omitted from the export — the UI is the only
//     place they should ever appear.
//   * /account delete uses a Postgres advisory lock per-org to serialize
//     concurrent deletes so two admins cannot both pass the last-admin
//     check and orphan the org.
import { ApiErrorCode, successSchema } from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { recordAudit } from '../../lib/audit.js';
import { withRlsBypass } from '../../lib/db.js';
import { badRequest } from '../../lib/errors.js';

export default async function accountRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /account/export ----------------------------------------
  r.get(
    '/account/export',
    {
      schema: {
        tags: ['account'],
        summary: 'Download a JSON export of the current user’s personal data.',
      },
      // Hard-cap exports at 5 per hour per user. The global rate limit is
      // per-IP and too permissive for a ~multi-MB endpoint that walks
      // multiple tables.
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
          keyGenerator: (req: { auth?: { userId?: string }; ip: string }) =>
            req.auth?.userId ?? req.ip,
        },
      },
      preHandler: [app.requireAuth],
    },
    async (req, reply) => {
      const userId = req.auth!.userId;

      const bundle = await withRlsBypass(async (tx) => {
        const [user, memberships, sessions, auditEntries, apiKeys] = await Promise.all([
          tx.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
              status: true,
              emailVerifiedAt: true,
              lastLoginAt: true,
              createdAt: true,
              updatedAt: true,
              isSuperAdmin: true,
            },
          }),
          tx.membership.findMany({
            where: { userId },
            include: {
              organization: { select: { id: true, slug: true, name: true, status: true } },
            },
          }),
          tx.session.findMany({
            where: { userId },
            select: {
              id: true,
              organizationId: true,
              userAgent: true,
              ipAddress: true,
              createdAt: true,
              lastUsedAt: true,
              revokedAt: true,
              expiresAt: true,
            },
          }),
          tx.auditLog.findMany({
            where: { actorUserId: userId },
            orderBy: { createdAt: 'desc' },
            take: 1000, // cap — export is user-controlled but no point shipping 10K rows
            select: {
              id: true,
              organizationId: true,
              action: true,
              entityType: true,
              entityId: true,
              metadata: true,
              createdAt: true,
            },
          }),
          tx.apiKey.findMany({
            where: { createdById: userId },
            // Deliberately NOT selecting `prefix` — it's displayable in the
            // UI where needed, but has no place in a portable export
            // (correlates keys across exfiltrated dumps for free).
            select: {
              id: true,
              organizationId: true,
              name: true,
              scopes: true,
              createdAt: true,
              revokedAt: true,
            },
          }),
        ]);

        return {
          exportedAt: new Date().toISOString(),
          exportVersion: 1,
          user,
          memberships: memberships.map((m) => ({
            organizationId: m.organizationId,
            organizationSlug: m.organization.slug,
            organizationName: m.organization.name,
            role: m.role,
            isActive: m.isActive,
            joinedAt: m.createdAt.toISOString(),
          })),
          sessions: sessions.map((s) => ({
            ...s,
            createdAt: s.createdAt.toISOString(),
            lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
            revokedAt: s.revokedAt?.toISOString() ?? null,
            expiresAt: s.expiresAt.toISOString(),
          })),
          apiKeysIssued: apiKeys.map((k) => ({
            ...k,
            createdAt: k.createdAt.toISOString(),
            revokedAt: k.revokedAt?.toISOString() ?? null,
          })),
          auditEntries: auditEntries.map((a) => ({
            ...a,
            metadata: sanitiseAuditMetadata(a.metadata),
            createdAt: a.createdAt.toISOString(),
          })),
        };
      });

      await recordAudit({
        action: 'user_updated',
        organizationId: req.auth!.organizationId,
        actorUserId: userId,
        entityType: 'user',
        entityId: userId,
        metadata: { event: 'account_export_downloaded' },
      });

      const filename = `aligned-account-${userId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
      reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(JSON.stringify(bundle, null, 2));
    },
  );

  // ---------- DELETE /account --------------------------------------------
  r.delete(
    '/account',
    {
      schema: {
        tags: ['account'],
        summary: 'Delete the current user. Refused if they are the last admin of any org.',
        response: { 200: successSchema },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const userId = req.auth!.userId;

      await withRlsBypass(async (tx) => {
        // Collect every org this user admins. For each, count remaining
        // active admins; if any would drop to zero, block.
        const adminMemberships = await tx.membership.findMany({
          where: { userId, role: 'admin', isActive: true },
          select: { organizationId: true },
        });
        // Take a per-org advisory lock for every org the user admins.
        // Two concurrent self-deletes hit the same lock so the second
        // waits until the first commits and re-reads the admin count.
        // Lock is held for the duration of this transaction only.
        for (const m of adminMemberships) {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            `aligned:admin-check:${m.organizationId}`,
          );
        }
        for (const m of adminMemberships) {
          const remaining = await tx.membership.count({
            where: {
              organizationId: m.organizationId,
              role: 'admin',
              isActive: true,
              userId: { not: userId },
            },
          });
          if (remaining === 0) {
            throw badRequest(
              ApiErrorCode.CONFLICT,
              'You are the last admin of at least one organization — transfer admin to someone else first.',
            );
          }
        }

        // Revoke all sessions so their JWT stops working on refresh.
        await tx.session.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        // Deactivate all memberships. We intentionally do NOT hard-delete
        // the user row — audit trails and invitations reference it. Mark
        // status=disabled and zero out PII so the record is effectively a
        // tombstone but tenant-isolation invariants hold.
        await tx.membership.updateMany({ where: { userId }, data: { isActive: false } });
        await tx.user.update({
          where: { id: userId },
          data: {
            status: 'disabled',
            email: `deleted-${userId}@aligned.invalid`,
            firstName: null,
            lastName: null,
            avatarUrl: null,
            passwordHash: '!deleted!',
          },
        });
      });

      await recordAudit({
        action: 'user_deactivated',
        organizationId: req.auth!.organizationId,
        actorUserId: userId,
        entityType: 'user',
        entityId: userId,
        metadata: { event: 'self_delete' },
      });

      return { ok: true as const };
    },
  );
}

// Audit log metadata is a freeform JSON blob — mostly safe fields like
// `entityKind`, `from/to` for role changes, but historical writers have
// occasionally dumped error messages or request context. For a GDPR-style
// self-export, allow-list the keys we KNOW are safe; everything else is
// replaced with a redaction marker so exfiltration never turns into a
// secret leak. If something important was redacted the user can always
// see the original via the in-portal audit log page.
const AUDIT_METADATA_ALLOWED_KEYS = new Set([
  'entityKind',
  'from',
  'to',
  'role',
  'name',
  'slug',
  'scopes',
  'url',
  'eventKind',
  'event',
  'action',
  'reason',
  'membershipId',
  'invitationId',
  'kind',
]);

function sanitiseAuditMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (AUDIT_METADATA_ALLOWED_KEYS.has(k) && isPrimitive(v)) {
      out[k] = v;
    } else {
      out[k] = '[redacted]';
    }
  }
  return out;
}

function isPrimitive(v: unknown): boolean {
  return v == null || ['string', 'number', 'boolean'].includes(typeof v);
}
