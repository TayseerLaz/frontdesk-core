import {
  ApiErrorCode,
  acceptInvitationBodyWithoutTokenSchema,
  changePasswordBodySchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  loginResponseSchema,
  refreshResponseSchema,
  resetPasswordBodySchema,
  sessionResponseSchema,
  signupBodySchema,
  signupResponseSchema,
  successSchema,
  switchOrgBodySchema,
  updateProfileBodySchema,
  updateProfileResponseSchema,
  verifyEmailBodySchema,
} from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clearRefreshCookieOptions, REFRESH_COOKIE_NAME, refreshCookieOptions } from '../../lib/cookies.js';
import { env } from '../../lib/env.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { issueSseNonce } from '../../lib/sse-nonce.js';
import {
  acceptInvitation,
  changePassword,
  forgotPassword,
  getSessionContext,
  issueSession,
  login,
  logout,
  refreshSession,
  resetPassword,
  signup,
  switchOrganization,
  updateProfile,
  verifyEmail,
} from './auth.service.js';

const meta = (req: { ip: string; headers: { 'user-agent'?: string | string[] } }) => ({
  ip: req.ip,
  userAgent: Array.isArray(req.headers['user-agent'])
    ? req.headers['user-agent'][0] ?? null
    : req.headers['user-agent'] ?? null,
});

export default async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Stricter rate limit on auth endpoints. Env-driven so local QA can raise it.
  // `keyGenerator` takes a FastifyRequest at runtime; using the full type
  // satisfies @fastify/rate-limit's RateLimitOptions augmentation of
  // FastifyContextConfig (Fastify expects an intersection with its base
  // context-config shape, not just our literal object).
  const authLimit: { rateLimit: import('@fastify/rate-limit').RateLimitOptions } = {
    rateLimit: {
      max: env.RATE_LIMIT_AUTH_PER_MINUTE,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => `${req.ip}:${req.routeOptions.url ?? ''}`,
    },
  };

  // Tighter per-email cap for password reset. Caps enumeration via response
  // timing (paired with the equalised timing in forgotPassword itself) and
  // limits how often an attacker can spray reset emails at a known address.
  const forgotPasswordLimit: { rateLimit: import('@fastify/rate-limit').RateLimitOptions } = {
    rateLimit: {
      max: 3,
      timeWindow: '15 minutes',
      keyGenerator: (req: FastifyRequest) => {
        const body = req.body as { email?: string } | undefined;
        const email = body?.email?.toLowerCase().trim();
        return email ? `forgot:${email}` : `forgot-ip:${req.ip}`;
      },
    },
  };

  // L-7 — bound the refresh endpoint. It's a DB-heavy path and the one a token
  // thief probes against the reuse/grace logic; browsers legitimately rotate on
  // load and across tabs, so the cap is generous but not unbounded.
  const refreshLimit: { rateLimit: import('@fastify/rate-limit').RateLimitOptions } = {
    rateLimit: {
      max: 60,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => `refresh:${req.ip}`,
    },
  };

  // L-9 — defence-in-depth CSRF guard for the cookie-authenticated /auth/refresh
  // endpoint. SameSite=Lax already blocks most cross-site cookie sends; this
  // additionally rejects any request whose Origin header is present and not in
  // the configured allowlist. Requests with no Origin (native/mobile clients,
  // server-to-server) pass — they carry no browser cookie-CSRF risk.
  const allowedOrigins = new Set(
    env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  );
  const csrfOriginGuard = async (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !allowedOrigins.has(origin)) {
      throw forbidden(ApiErrorCode.FORBIDDEN, 'Cross-origin request rejected.');
    }
  };

  // ---------- POST /auth/signup ---------------------------------------------
  r.post(
    '/auth/signup',
    {
      schema: {
        tags: ['auth'],
        summary: 'Create a new organization + admin user.',
        body: signupBodySchema,
        response: { 201: signupResponseSchema },
      },
      config: authLimit,
    },
    async (req, reply) => {
      const result = await signup({ ...req.body, meta: meta(req) });
      reply.code(201);
      return {
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
        },
        organization: {
          id: result.organization.id,
          slug: result.organization.slug,
          name: result.organization.name,
        },
        emailVerificationRequired: true,
      };
    },
  );

  // ---------- POST /auth/login ---------------------------------------------
  r.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange credentials for an access token (refresh in cookie).',
        body: loginBodySchema,
        response: { 200: loginResponseSchema },
      },
      config: authLimit,
    },
    async (req, reply) => {
      const result = await login({ ...req.body, meta: meta(req) });
      reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions());
      return {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt.toISOString(),
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          isSuperAdmin: result.user.isSuperAdmin,
        },
        organization: {
          id: result.organization.id,
          slug: result.organization.slug,
          name: result.organization.name,
          role: result.organization.role,
        },
        availableOrganizations: result.availableOrganizations,
      };
    },
  );

  // ---------- POST /auth/refresh -------------------------------------------
  r.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotate refresh cookie and issue a fresh access token.',
        response: { 200: refreshResponseSchema },
      },
      config: refreshLimit,
      preHandler: [csrfOriginGuard],
    },
    async (req, reply) => {
      const cookie = req.cookies[REFRESH_COOKIE_NAME];
      if (!cookie) throw unauthorized();
      const result = await refreshSession(cookie, meta(req));
      // Grace-window concurrent-refresh path returns refreshToken=null —
      // the client's cookie is the already-rotated value (set by the
      // first parallel /refresh that's still in flight), so we leave it
      // untouched. Setting it again here with a different value would
      // cause whichever response committed last to win the cookie, and
      // we want the first call's T2 to stay.
      if (result.refreshToken) {
        reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions());
      }
      return { accessToken: result.accessToken, expiresAt: result.expiresAt.toISOString() };
    },
  );

  // ---------- POST /auth/logout --------------------------------------------
  r.post(
    '/auth/logout',
    {
      schema: { tags: ['auth'], summary: 'Revoke current session.', response: { 200: successSchema } },
      preHandler: [app.requireAuth],
    },
    async (req, reply) => {
      await logout(req.auth!.sessionId, meta(req));
      reply.clearCookie(REFRESH_COOKIE_NAME, clearRefreshCookieOptions());
      return { ok: true as const };
    },
  );

  // ---------- POST /auth/verify-email --------------------------------------
  r.post(
    '/auth/verify-email',
    {
      schema: {
        tags: ['auth'],
        summary: 'Verify email via single-use token.',
        body: verifyEmailBodySchema,
        response: { 200: successSchema },
      },
      config: authLimit,
    },
    async (req) => verifyEmail(req.body.token),
  );

  // ---------- POST /auth/forgot-password -----------------------------------
  r.post(
    '/auth/forgot-password',
    {
      schema: {
        tags: ['auth'],
        summary: 'Request a password reset email.',
        body: forgotPasswordBodySchema,
        response: { 200: successSchema },
      },
      config: forgotPasswordLimit,
    },
    async (req) => forgotPassword(req.body.email, meta(req)),
  );

  // ---------- POST /auth/reset-password ------------------------------------
  r.post(
    '/auth/reset-password',
    {
      schema: {
        tags: ['auth'],
        summary: 'Set a new password using a single-use reset token.',
        body: resetPasswordBodySchema,
        response: { 200: successSchema },
      },
      config: authLimit,
    },
    async (req) => resetPassword(req.body.token, req.body.password, meta(req)),
  );

  // ---------- POST /auth/invites/:token/accept -----------------------------
  r.post(
    '/auth/invites/:token/accept',
    {
      schema: {
        tags: ['auth'],
        summary: 'Accept an invitation (creates user if needed) and sign in.',
        params: z.object({ token: z.string().min(20) }),
        body: acceptInvitationBodyWithoutTokenSchema,
        response: {
          200: z.object({
            accessToken: z.string().nullable(),
            expiresAt: z.string().datetime().nullable(),
            requiresLogin: z.boolean(),
          }),
        },
      },
      config: authLimit,
    },
    async (req, reply) => {
      const { user, invitation, isNewUser } = await acceptInvitation({
        token: req.params.token,
        ...req.body,
        meta: meta(req),
      });
      // H-4 — only auto-login a BRAND-NEW user, who just set their password in
      // this request. An EXISTING account has proven nothing but possession of
      // the invite link, so it must NOT get a session off the token (that was a
      // passwordless, 2FA-bypassing login-as-anyone). The membership is added;
      // the caller signs in normally.
      if (!isNewUser) {
        return { accessToken: null, expiresAt: null, requiresLogin: true };
      }
      const session = await issueSession({
        userId: user.id,
        organizationId: invitation.organizationId,
        role: invitation.role,
        isSuperAdmin: user.isSuperAdmin,
        meta: meta(req),
      });
      reply.setCookie(REFRESH_COOKIE_NAME, session.refreshToken, refreshCookieOptions());
      return {
        accessToken: session.accessToken,
        expiresAt: session.expiresAt.toISOString(),
        requiresLogin: false,
      };
    },
  );

  // ---------- POST /auth/sse-nonce -----------------------------------------
  // Issues a short-lived (30s) single-use nonce so the SPA can open an
  // EventSource (which can't set Authorization headers) without leaking the
  // access token through URL access logs, browser history, or Referer.
  r.post(
    '/auth/sse-nonce',
    {
      schema: {
        tags: ['auth'],
        summary: 'Issue a 30s single-use nonce for EventSource (SSE) authentication.',
        response: { 200: z.object({ nonce: z.string(), ttlSeconds: z.number() }) },
      },
      config: authLimit,
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const nonce = await issueSseNonce({
        userId: req.auth!.userId,
        organizationId: req.auth!.organizationId,
        role: req.auth!.role,
        isSuperAdmin: req.auth!.isSuperAdmin,
        sessionId: req.auth!.sessionId,
      });
      return { nonce, ttlSeconds: 30 };
    },
  );

  // ---------- GET /auth/session --------------------------------------------
  r.get(
    '/auth/session',
    {
      schema: {
        tags: ['auth'],
        summary: 'Get current user + active org + available orgs.',
        response: { 200: sessionResponseSchema },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      const ctx = await getSessionContext(
        req.auth!.userId,
        req.auth!.organizationId,
        req.auth!.sessionId,
      );
      return {
        user: {
          id: ctx.user.id,
          email: ctx.user.email,
          firstName: ctx.user.firstName,
          lastName: ctx.user.lastName,
          avatarUrl: ctx.user.avatarUrl,
          isSuperAdmin: ctx.user.isSuperAdmin,
        },
        organization: ctx.organization,
        availableOrganizations: ctx.availableOrganizations,
      };
    },
  );

  // ---------- PATCH /auth/me ----------------------------------------------
  r.patch(
    '/auth/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Update the signed-in user\'s name fields.',
        body: updateProfileBodySchema,
        response: { 200: updateProfileResponseSchema },
      },
      preHandler: [app.requireAuth],
    },
    async (req) => {
      return updateProfile(req.auth!.userId, req.body, meta(req));
    },
  );

  // ---------- POST /auth/change-password ----------------------------------
  r.post(
    '/auth/change-password',
    {
      schema: {
        tags: ['auth'],
        summary: 'Change the signed-in user\'s password (requires current).',
        body: changePasswordBodySchema,
        response: { 200: successSchema },
      },
      config: authLimit,
      preHandler: [app.requireAuth],
    },
    async (req) => {
      await changePassword(
        req.auth!.userId,
        {
          currentPassword: req.body.currentPassword,
          newPassword: req.body.newPassword,
          currentSessionId: req.auth!.sessionId,
        },
        meta(req),
      );
      return { ok: true as const };
    },
  );

  // ---------- POST /auth/switch-org ----------------------------------------
  r.post(
    '/auth/switch-org',
    {
      schema: {
        tags: ['auth'],
        summary: 'Switch active organization for the session.',
        body: switchOrgBodySchema,
        response: { 200: refreshResponseSchema },
      },
      preHandler: [app.requireAuth],
    },
    async (req, reply) => {
      const result = await switchOrganization({
        userId: req.auth!.userId,
        sessionId: req.auth!.sessionId,
        newOrganizationId: req.body.organizationId,
        isSuperAdmin: req.auth!.isSuperAdmin,
        meta: meta(req),
      });
      reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions());
      return { accessToken: result.accessToken, expiresAt: result.expiresAt.toISOString() };
    },
  );
}
