// Phase 4 — Contact CSV import.
//
// Streams a CSV asset from Wasabi, normalizes phone numbers to E.164, and
// upserts contacts inside batched tenant transactions. Unknown columns land
// in `attributes` JSON. v1 is synchronous (good enough for ≤ 50K rows); a
// large-import path can move to the existing import worker later.
import { parse } from 'csv-parse';

import { withTenant } from '../../lib/db.js';
import { getObjectStream } from '../../lib/storage.js';

interface ImportArgs {
  organizationId: string;
  assetId: string;
  // F8 gate (owner directive 2026-08-29): SAP columns + SAP-first merging
  // apply only when the org's contact_sap feature is enabled. Off ⇒ the
  // sap column lands in attributes like any unknown header (old behaviour).
  enableSapMerge?: boolean;
  phoneColumn?: string;
  nameColumn?: string;
  emailColumn?: string;
  localeColumn?: string;
  tagColumn?: string;
}

interface ImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; error: string }[];
}

const DEFAULT_PHONE_COLS = ['phone', 'phone_e164', 'mobile', 'whatsapp', 'msisdn'];
const DEFAULT_NAME_COLS = ['name', 'display_name', 'first_name', 'full_name'];
const DEFAULT_EMAIL_COLS = ['email', 'email_address', 'e-mail', 'mail'];
const DEFAULT_LOCALE_COLS = ['locale', 'language', 'lang'];
const DEFAULT_TAG_COLS = ['tags', 'tag'];
// F8 — external ERP reference ("SAP #"). Unique per org; used as the FIRST
// merge key (phone second) so a customer who changed numbers updates in
// place instead of duplicating.
const DEFAULT_REF_COLS = ['sap', 'sap_number', 'sap #', 'sap#', 'external_ref', 'customer_ref'];

function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

function pickColumn(
  headers: string[],
  override: string | undefined,
  defaults: string[],
): string | null {
  if (override) {
    const found = headers.find((h) => h.toLowerCase() === override.toLowerCase());
    return found ?? null;
  }
  for (const cand of defaults) {
    const found = headers.find((h) => h.toLowerCase() === cand);
    if (found) return found;
  }
  return null;
}

export async function importContactsFromCsv(args: ImportArgs): Promise<ImportResult> {
  const { organizationId, assetId } = args;

  const stream = await withTenant(organizationId, async (tx) => {
    const asset = await tx.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw new Error('Asset not found.');
    return getObjectStream(asset.storageKey);
  });

  const parser = stream.pipe(
    parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }),
  );

  const result: ImportResult = { total: 0, created: 0, updated: 0, skipped: 0, errors: [] };

  type Row = Record<string, string>;
  const rows: Row[] = [];
  let headers: string[] = [];

  for await (const record of parser) {
    const row = record as Row;
    if (headers.length === 0) headers = Object.keys(row);
    rows.push(row);
  }

  if (rows.length === 0 || headers.length === 0) return result;

  const phoneCol = pickColumn(headers, args.phoneColumn, DEFAULT_PHONE_COLS);
  const nameCol = pickColumn(headers, args.nameColumn, DEFAULT_NAME_COLS);
  const emailCol = pickColumn(headers, args.emailColumn, DEFAULT_EMAIL_COLS);
  const localeCol = pickColumn(headers, args.localeColumn, DEFAULT_LOCALE_COLS);
  const tagCol = pickColumn(headers, args.tagColumn, DEFAULT_TAG_COLS);
  const refCol = args.enableSapMerge ? pickColumn(headers, undefined, DEFAULT_REF_COLS) : null;
  // In-file duplicate SAP #s are row errors, never silent overwrites.
  const seenRefs = new Set<string>();

  if (!phoneCol) {
    result.errors.push({
      row: 0,
      error: `No phone column found. Looked for one of: ${DEFAULT_PHONE_COLS.join(', ')}, or pass phoneColumn.`,
    });
    return result;
  }

  const BATCH = 500;
  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    await withTenant(organizationId, async (tx) => {
      for (let i = 0; i < batch.length; i++) {
        const rowIndex = start + i + 2;
        const row = batch[i]!;
        result.total += 1;
        const phoneRaw = row[phoneCol] ?? '';
        const phoneE164 = normalizeE164(phoneRaw);
        if (!phoneE164) {
          result.skipped += 1;
          if (result.errors.length < 100) {
            result.errors.push({ row: rowIndex, error: `Invalid phone: ${phoneRaw}` });
          }
          continue;
        }
        const displayName = nameCol ? row[nameCol] || null : null;
        const email = emailCol ? row[emailCol]?.trim() || null : null;
        const locale = localeCol ? row[localeCol] || null : null;
        const externalRef = refCol ? row[refCol]?.trim().slice(0, 60) || null : null;
        if (externalRef) {
          const refKey = externalRef.toLowerCase();
          if (seenRefs.has(refKey)) {
            result.skipped += 1;
            if (result.errors.length < 100) {
              result.errors.push({ row: rowIndex, error: `Duplicate SAP # in file: ${externalRef}` });
            }
            continue;
          }
          seenRefs.add(refKey);
        }

        const attributes: Record<string, string> = {};
        for (const h of headers) {
          if (h === phoneCol) continue;
          if (h === nameCol || h === emailCol || h === localeCol || h === tagCol || h === refCol) continue;
          const v = row[h];
          if (v !== undefined && v !== '') attributes[h] = v;
        }

        try {
          // F8 merge order: SAP # first (the stable ERP identity), phone
          // second. A customer found by SAP # with a NEW phone updates in
          // place — unless that phone already belongs to a different contact,
          // which is a row error rather than a silent merge.
          let existing = externalRef
            ? await tx.contact.findFirst({ where: { organizationId, externalRef } })
            : null;
          if (existing && existing.phoneE164 !== phoneE164) {
            const phoneHolder = await tx.contact.findUnique({
              where: { organizationId_phoneE164: { organizationId, phoneE164 } },
              select: { id: true },
            });
            if (phoneHolder && phoneHolder.id !== existing.id) {
              result.skipped += 1;
              if (result.errors.length < 100) {
                result.errors.push({
                  row: rowIndex,
                  error: `SAP # ${externalRef}: phone ${phoneE164} already belongs to another contact`,
                });
              }
              continue;
            }
          }
          existing ??= await tx.contact.findUnique({
            where: { organizationId_phoneE164: { organizationId, phoneE164 } },
          });
          if (existing) {
            await tx.contact.update({
              where: { id: existing.id },
              data: {
                deletedAt: null,
                phoneE164, // SAP-matched rows may carry the customer's new number
                displayName: displayName ?? existing.displayName,
                email: email ?? existing.email,
                externalRef: externalRef ?? existing.externalRef,
                locale: locale ?? existing.locale,
                attributes: { ...((existing.attributes as object) || {}), ...attributes } as never,
                source: 'csv',
              },
            });
            result.updated += 1;
          } else {
            await tx.contact.create({
              data: {
                organizationId,
                phoneE164,
                displayName,
                email,
                externalRef,
                locale,
                attributes: attributes as never,
                source: 'csv',
              },
            });
            result.created += 1;
          }

          if (tagCol && row[tagCol]) {
            const tagList = row[tagCol]
              .split(/[,;|]/)
              .map((t) => t.trim())
              .filter((t) => t.length > 0 && t.length <= 40);
            if (tagList.length > 0) {
              const contact = await tx.contact.findUniqueOrThrow({
                where: { organizationId_phoneE164: { organizationId, phoneE164 } },
                select: { id: true },
              });
              await tx.contactTag.createMany({
                data: tagList.map((tag) => ({
                  organizationId,
                  contactId: contact.id,
                  tag,
                })),
                skipDuplicates: true,
              });
            }
          }
        } catch (err) {
          result.skipped += 1;
          if (result.errors.length < 100) {
            result.errors.push({
              row: rowIndex,
              error: err instanceof Error ? err.message : 'unknown error',
            });
          }
        }
      }
    });
  }

  return result;
}
