import { z } from 'zod';

import {
  ConnectorAuthKind,
  ConnectorStatus,
  IMPORT_ENTITY_KINDS,
  SyncRunStatus,
  SyncTrigger,
  type ImportEntityKind,
} from '../enums/day3.js';
import { uuidSchema } from './common.js';

// Auth config shapes per kind. Stored as opaque JSON; UI validates per kind.
export const connectorAuthConfigSchema = z.union([
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('bearer'), token: z.string().min(1) }),
  z.object({
    kind: z.literal('api_key'),
    headerName: z.string().min(1).max(100),
    value: z.string().min(1),
  }),
  z.object({ kind: z.literal('basic'), username: z.string().min(1), password: z.string().min(1) }),
  z.object({ kind: z.literal('hmac'), secret: z.string().min(1), header: z.string().min(1) }),
]);
export type ConnectorAuthConfig = z.infer<typeof connectorAuthConfigSchema>;

export const connectorSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  entityKind: z.enum(IMPORT_ENTITY_KINDS as [ImportEntityKind, ...ImportEntityKind[]]),
  endpointUrl: z.string().url().nullable(),
  authKind: z.nativeEnum(ConnectorAuthKind),
  scheduleCron: z.string().nullable(),
  status: z.nativeEnum(ConnectorStatus),
  webhookUrl: z.string().url().nullable(), // exposed only when webhookSecret set
  lastRunAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  consecutiveFailures: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ConnectorDto = z.infer<typeof connectorSchema>;

export const createConnectorBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  entityKind: z.enum(IMPORT_ENTITY_KINDS as [ImportEntityKind, ...ImportEntityKind[]]),
  endpointUrl: z.string().url().optional().nullable(),
  authKind: z.nativeEnum(ConnectorAuthKind).default('none'),
  authConfig: connectorAuthConfigSchema.optional(),
  scheduleCron: z.string().min(1).optional().nullable(),
  // v1: flat { sourceKey: targetKey } rename. v2 (the website wizard):
  // { __v: 2, arrayPath, fields: { targetField: sourceDotPath }, priceUnit }.
  columnMapping: z
    .union([
      z.record(z.string(), z.string()),
      z.object({
        __v: z.literal(2),
        arrayPath: z.string().max(200).optional().nullable(),
        fields: z.record(z.string(), z.string().max(300)),
        priceUnit: z.enum(['major', 'minor']).optional(),
      }),
    ])
    .optional(),
  enableInboundWebhook: z.boolean().optional(),
});
export type CreateConnectorBody = z.infer<typeof createConnectorBodySchema>;

export const updateConnectorBodySchema = createConnectorBodySchema.partial().extend({
  status: z.nativeEnum(ConnectorStatus).optional(),
});

// ---------- sync runs -------------------------------------------------------
export const syncRunSchema = z.object({
  id: uuidSchema,
  connectorId: uuidSchema,
  trigger: z.nativeEnum(SyncTrigger),
  status: z.nativeEnum(SyncRunStatus),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  recordsFetched: z.number().int(),
  recordsUpserted: z.number().int(),
  recordsFailed: z.number().int(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type SyncRunDto = z.infer<typeof syncRunSchema>;

// Accept null + undefined + empty-object so clients can POST /sync with or
// without a body without hitting Zod's `expected object, received null`.
export const triggerSyncBodySchema = z.object({}).optional().nullable();
