// Phone tasks — portal routes (JWT). Outbound AI phone calls via CALL-E.
//
// read = viewer, create/refresh = editor, settings write = admin. Every route is
// gated on the per-tenant `phone_tasks` feature. Reads run under app.tenant
// (RLS-scoped); the engine in lib/phone-tasks.ts uses the owner pool with
// explicit org filters because the tick shares it.
import {
  createPhoneTaskBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  phoneTaskListQuerySchema,
  phoneTaskRuntimeSchema,
  phoneTaskSchema,
  phoneTaskSettingsSchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { calleRuntime } from '../../lib/calle.js';
import { notFound } from '../../lib/errors.js';
import { assertOrgFeature } from '../../lib/org-feature-guard.js';
import {
  createPhoneTask,
  getSettings,
  refreshPhoneTask,
  serializePhoneTask,
  updateSettings,
} from '../../lib/phone-tasks.js';

const FEATURE = 'phone_tasks';
const FEATURE_MSG = 'Phone follow-through is not enabled for this account.';

export default async function phoneTasksRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /phone-tasks/runtime ------------------------------------
  r.get(
    '/phone-tasks/runtime',
    {
      schema: {
        tags: ['phone-tasks'],
        summary: 'Dry-run / override / configured flags the UI shows as a banner.',
        response: { 200: itemEnvelopeSchema(phoneTaskRuntimeSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      await assertOrgFeature(app, req, FEATURE, FEATURE_MSG);
      const rt = calleRuntime();
      return {
        data: {
          dryRun: rt.dryRun,
          liveOverridePhone: rt.liveOverridePhone,
          configured: rt.configured,
          supportedRegions: rt.supportedRegions,
        },
      };
    },
  );

  // ---------- GET /phone-tasks/settings -----------------------------------
  r.get(
    '/phone-tasks/settings',
    {
      schema: {
        tags: ['phone-tasks'],
        summary: 'Per-tenant automation settings.',
        response: { 200: itemEnvelopeSchema(phoneTaskSettingsSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = await assertOrgFeature(app, req, FEATURE, FEATURE_MSG);
      return { data: await getSettings(orgId) };
    },
  );

  // ---------- PATCH /phone-tasks/settings ---------------------------------
  r.patch(
    '/phone-tasks/settings',
    {
      schema: {
        tags: ['phone-tasks'],
        summary: 'Update automation settings (auto-confirm COD orders, delay, daily cap).',
        body: phoneTaskSettingsSchema.partial(),
        response: { 200: itemEnvelopeSchema(phoneTaskSettingsSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = await assertOrgFeature(app, req, FEATURE, FEATURE_MSG);
      const next = await updateSettings(orgId, req.body);
      await recordAudit({
        action: 'org_features_changed',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'phone_task_settings',
        entityId: orgId,
        metadata: next,
      });
      return { data: next };
    },
  );

  // ---------- GET /phone-tasks --------------------------------------------
  r.get(
    '/phone-tasks',
    {
      schema: {
        tags: ['phone-tasks'],
        summary: 'List phone tasks (newest first, cursor-paginated).',
        querystring: phoneTaskListQuerySchema,
        response: { 200: listEnvelopeSchema(phoneTaskSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      await assertOrgFeature(app, req, FEATURE, FEATURE_MSG);
      const q = req.query;
      return app.tenant(req, async (tx) => {
        const rows = await tx.phoneTask.findMany({
          where: {
            organizationId: req.auth!.organizationId,
            ...(q.status ? { status: q.status } : {}),
            ...(q.targetType ? { targetType: q.targetType } : {}),
            ...(q.targetId ? { targetId: q.targetId } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.limit + 1,
          ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        });
        const hasMore = rows.length > q.limit;
        const page = hasMore ? rows.slice(0, q.limit) : rows;
        return {
          data: page.map(serializePhoneTask),
          nextCursor: hasMore ? page[page.length - 1]!.id : null,
        };
      });
    },
  );

  // ---------- GET /phone-tasks/:id ----------------------------------------
  r.get(
    '/phone-tasks/:id',
    {
      schema: {
        tags: ['phone-tasks'],
        summary: 'One phone task with transcript + structured result.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(phoneTaskSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      await assertOrgFeature(app, req, FEATURE, FEATURE_MSG);
      const row = await app.tenant(req, (tx) => tx.phoneTask.findFirst({ where: { id: req.params.id } }));
      if (!row) throw notFound('Phone task not found.');
      return { data: serializePhoneTask(row) };
    },
  );

  // ---------- POST /phone-tasks -------------------------------------------
  r.post(
    '/phone-tasks',
    {
      schema: {
        tags: ['phone-tasks'],
        summary: 'Place an outbound AI phone call for an order, a booking, or a custom goal.',
        body: createPhoneTaskBodySchema,
        response: { 201: itemEnvelopeSchema(phoneTaskSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = await assertOrgFeature(app, req, FEATURE, FEATURE_MSG);
      const row = await createPhoneTask({
        orgId,
        body: req.body,
        createdById: req.auth!.userId,
        source: 'operator',
      });
      await recordAudit({
        action: 'cart_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'phone_task',
        entityId: row.id,
        metadata: { kind: row.kind, targetType: row.targetType, targetId: row.targetId, dryRun: row.dryRun },
      });
      return reply.code(201).send({ data: serializePhoneTask(row) });
    },
  );

  // ---------- POST /phone-tasks/:id/refresh -------------------------------
  r.post(
    '/phone-tasks/:id/refresh',
    {
      schema: {
        tags: ['phone-tasks'],
        summary: 'Poll CALL-E for this task now (the tick does this every 30s anyway).',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(phoneTaskSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      await assertOrgFeature(app, req, FEATURE, FEATURE_MSG);
      const row = await app.tenant(req, (tx) => tx.phoneTask.findFirst({ where: { id: req.params.id } }));
      if (!row) throw notFound('Phone task not found.');
      const updated = await refreshPhoneTask(row, { force: true });
      return { data: serializePhoneTask(updated) };
    },
  );
}
