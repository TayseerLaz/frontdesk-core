import { z } from 'zod';

import {
  IMPORT_ENTITY_KINDS,
  ImportJobStatus,
  ImportRowStatus,
  type ImportEntityKind,
} from '../enums/day3.js';
import { uuidSchema } from './common.js';

// ---------- import job ------------------------------------------------------
export const importJobSchema = z.object({
  id: uuidSchema,
  entityKind: z.enum(IMPORT_ENTITY_KINDS as [ImportEntityKind, ...ImportEntityKind[]]),
  status: z.nativeEnum(ImportJobStatus),
  sourceFilename: z.string().nullable(),
  totalRows: z.number().int().nonnegative(),
  processedRows: z.number().int().nonnegative(),
  succeededRows: z.number().int().nonnegative(),
  failedRows: z.number().int().nonnegative(),
  skippedRows: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ImportJobDto = z.infer<typeof importJobSchema>;

export const importJobRowSchema = z.object({
  id: uuidSchema,
  rowNumber: z.number().int().nonnegative(),
  status: z.nativeEnum(ImportRowStatus),
  resultEntityId: uuidSchema.nullable(),
  rawData: z.record(z.string(), z.unknown()).nullable(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
});
export type ImportJobRowDto = z.infer<typeof importJobRowSchema>;

export const startImportBodySchema = z.object({
  entityKind: z.enum(IMPORT_ENTITY_KINDS as [ImportEntityKind, ...ImportEntityKind[]]),
  // Either a previously uploaded CSV asset (preferred — matches Day 2 upload flow)
  // or an inline preview using a tiny set of rows (e.g. paste).
  sourceAssetId: uuidSchema.optional(),
  // Optional column mapping: { "Product Name": "name", "Cost": "priceMinor" }
  columnMapping: z.record(z.string(), z.string()).optional(),
  // Optional dry-run hint: if true, worker validates and reports rows but does not upsert.
  dryRun: z.boolean().optional(),
});
export type StartImportBody = z.infer<typeof startImportBodySchema>;

// ---------- preview (peek at first N rows + headers) ------------------------
export const previewImportBodySchema = z.object({
  sourceAssetId: uuidSchema,
  rowLimit: z.number().int().min(1).max(50).default(20),
});

export const importPreviewSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  totalDetectedRows: z.number().int().nonnegative(),
});
export type ImportPreviewDto = z.infer<typeof importPreviewSchema>;

// ---------- target field hints (for the mapping UI) -------------------------
export const importFieldHintSchema = z.object({
  field: z.string(),
  label: z.string(),
  required: z.boolean(),
  description: z.string().optional(),
});
export type ImportFieldHint = z.infer<typeof importFieldHintSchema>;
