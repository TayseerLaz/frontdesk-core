// Phone integrations — per-tenant phone lines (DIDs) routed to the Aseer-time
// voicebot. Admin-only (each line auto-issues a voice-scoped API key, same as
// the /api-keys surface). Many per org. The bot persona/knowledge comes from
// this platform's compiled voice config — the line just owns the number + key.
import {
  createPhoneIntegrationBodySchema,
  createPhoneIntegrationResponseSchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  normalizePhoneNumber,
  phoneIntegrationSchema,
  successSchema,
  updatePhoneIntegrationBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { generateOpaqueToken, hashToken } from '../../lib/crypto.js';
import type { Tx } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';

const VOICE_SCOPES = ['voice:config', 'voice:calls'];

// Prisma unique-constraint violation (the global phone_number index). We never
// say WHICH org owns it — that would leak across the tenant boundary.
function isUniquePhoneViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

type LineRow = {
  id: string;
  name: string;
  phoneNumber: string;
  isActive: boolean;
  botEnabled: boolean;
  lastCallAt: Date | null;
  createdAt: Date;
  apiKey: { prefix: string; revokedAt: Date | null } | null;
  _count: { calls: number };
};

function toDto(line: LineRow) {
  return {
    id: line.id,
    name: line.name,
    phoneNumber: line.phoneNumber,
    isActive: line.isActive,
    botEnabled: line.botEnabled,
    // A revoked key can't authenticate, so surface it as "no working key".
    keyPrefix: line.apiKey && !line.apiKey.revokedAt ? line.apiKey.prefix : null,
    lastCallAt: line.lastCallAt?.toISOString() ?? null,
    callCount: line._count.calls,
    createdAt: line.createdAt.toISOString(),
  };
}

const LINE_INCLUDE = {
  apiKey: { select: { prefix: true, revokedAt: true } },
  _count: { select: { calls: true } },
} as const;

async function findLine(tx: Tx, id: string): Promise<LineRow | null> {
  return tx.phoneIntegration.findFirst({ where: { id }, include: LINE_INCLUDE });
}

export default async function phoneIntegrationRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /phone-integrations --------------------------------------
  r.get(
    '/phone-integrations',
    {
      schema: {
        tags: ['phone-integrations'],
        summary: 'List phone lines for the active organization.',
        response: { 200: listEnvelopeSchema(phoneIntegrationSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.phoneIntegration.findMany({
          orderBy: { createdAt: 'desc' },
          include: LINE_INCLUDE,
        });
        return { data: rows.map(toDto), nextCursor: null };
      }),
  );

  // ---------- POST /phone-integrations -------------------------------------
  r.post(
    '/phone-integrations',
    {
      schema: {
        tags: ['phone-integrations'],
        summary: 'Create a phone line. Auto-issues a voice API key (secret shown ONCE).',
        body: createPhoneIntegrationBodySchema,
        response: { 201: itemEnvelopeSchema(createPhoneIntegrationResponseSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const phoneNumber = normalizePhoneNumber(req.body.phoneNumber);
      const secret = `ak_live_${generateOpaqueToken(24)}`;
      const prefix = secret.slice(0, 16);
      const keyHash = hashToken(secret);

      const line = await app.tenant(req, async (tx) => {
        // Key + line in one tx: if the (global) phone_number unique check trips,
        // the whole thing rolls back — no orphan key.
        const key = await tx.apiKey.create({
          data: {
            organizationId: orgId,
            name: `Phone line: ${req.body.name}`,
            prefix,
            keyHash,
            scopes: VOICE_SCOPES,
            createdById: req.auth!.userId,
          },
        });
        let created;
        try {
          created = await tx.phoneIntegration.create({
            data: {
              organizationId: orgId,
              name: req.body.name,
              phoneNumber,
              apiKeyId: key.id,
              createdById: req.auth!.userId,
            },
            include: LINE_INCLUDE,
          });
        } catch (err) {
          if (isUniquePhoneViolation(err)) {
            throw conflict('This phone number is already registered.');
          }
          throw err;
        }
        return created;
      });

      await recordAudit({
        action: 'phone_integration_created',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'phone_integration',
        entityId: line.id,
        metadata: { name: line.name, phoneNumber },
      });

      reply.code(201);
      return { data: { ...toDto(line), secret } };
    },
  );

  // ---------- GET /phone-integrations/:id ----------------------------------
  r.get(
    '/phone-integrations/:id',
    {
      schema: {
        tags: ['phone-integrations'],
        summary: 'Get one phone line.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(phoneIntegrationSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const line = await findLine(tx, req.params.id);
        if (!line) throw notFound('Phone line not found.');
        return { data: toDto(line) };
      }),
  );

  // ---------- PATCH /phone-integrations/:id --------------------------------
  r.patch(
    '/phone-integrations/:id',
    {
      schema: {
        tags: ['phone-integrations'],
        summary: 'Update a phone line (name / number / active / AI bot).',
        params: z.object({ id: uuidSchema }),
        body: updatePhoneIntegrationBodySchema,
        response: { 200: itemEnvelopeSchema(phoneIntegrationSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const b = req.body;
      const line = await app.tenant(req, async (tx) => {
        const existing = await tx.phoneIntegration.findFirst({ where: { id: req.params.id } });
        if (!existing) throw notFound('Phone line not found.');
        try {
          return await tx.phoneIntegration.update({
            where: { id: existing.id },
            data: {
              ...(b.name !== undefined ? { name: b.name } : {}),
              ...(b.phoneNumber !== undefined
                ? { phoneNumber: normalizePhoneNumber(b.phoneNumber) }
                : {}),
              ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
              ...(b.botEnabled !== undefined ? { botEnabled: b.botEnabled } : {}),
            },
            include: LINE_INCLUDE,
          });
        } catch (err) {
          if (isUniquePhoneViolation(err)) {
            throw conflict('This phone number is already registered.');
          }
          throw err;
        }
      });
      await recordAudit({
        action: 'phone_integration_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'phone_integration',
        entityId: line.id,
      });
      return { data: toDto(line) };
    },
  );

  // ---------- DELETE /phone-integrations/:id -------------------------------
  r.delete(
    '/phone-integrations/:id',
    {
      schema: {
        tags: ['phone-integrations'],
        summary: 'Delete a phone line and revoke its voice key. Call history is retained.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      await app.tenant(req, async (tx) => {
        const existing = await tx.phoneIntegration.findFirst({
          where: { id: req.params.id },
          select: { id: true, apiKeyId: true },
        });
        if (!existing) throw notFound('Phone line not found.');
        // Revoke the auto-issued key so it can't keep authenticating after the
        // line is gone. (voice_calls.phone_integration_id is SetNull on delete,
        // so the call history survives.)
        if (existing.apiKeyId) {
          await tx.apiKey.updateMany({
            where: { id: existing.apiKeyId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        await tx.phoneIntegration.delete({ where: { id: existing.id } });
      });
      await recordAudit({
        action: 'phone_integration_deleted',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'phone_integration',
        entityId: req.params.id,
      });
      return { ok: true as const };
    },
  );
}
