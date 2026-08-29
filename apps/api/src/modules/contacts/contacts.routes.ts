// Phase 4 — Contacts CRUD.
//
// Persistent per-org address book. Used as a recipient source for broadcasts
// (manual + segment audiences) and auto-populated from the inbox when a new
// customer message arrives. All queries are tenant-scoped via app.tenant().
import type { ContactSource, Prisma } from '@platform/db';
import {
  ApiErrorCode,
  bulkContactsBodySchema,
  contactDtoSchema,
  createContactBodySchema,
  itemEnvelopeSchema,
  listContactsQuerySchema,
  listEnvelopeSchema,
  successSchema,
  updateContactBodySchema,
  uuidSchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { createHash } from 'node:crypto';

import { recordAudit } from '../../lib/audit.js';
import { setContactOperatorNote } from '../../lib/contact-memory.js';
import { withRlsBypass } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';



const tagBodySchema = z.object({ tag: z.string().trim().min(1).max(40) });

// Keep contact tags and inbox thread tags in sync so a tag added on either
// surface shows on both. Threads store the phone without a leading "+",
// contacts with it — match every variant. `tx` is already tenant-scoped.
async function mirrorTagToThreads(
  tx: Prisma.TransactionClient,
  organizationId: string,
  phoneE164: string,
  tag: string,
  op: 'add' | 'remove',
): Promise<void> {
  const digits = phoneE164.replace(/[^0-9]/g, '');
  const phones = Array.from(new Set([phoneE164, digits, `+${digits}`].filter(Boolean)));
  const threads = await tx.whatsAppThread.findMany({
    where: { customerPhone: { in: phones } },
    select: { id: true },
  });
  if (threads.length === 0) return;
  if (op === 'add') {
    for (const th of threads) {
      await tx.whatsAppThreadTag
        .create({ data: { organizationId, threadId: th.id, tag } })
        .catch(() => undefined); // duplicate (org, thread, tag) is fine
    }
  } else {
    await tx.whatsAppThreadTag.deleteMany({
      where: { threadId: { in: threads.map((t) => t.id) }, tag },
    });
  }
}

interface ContactRow {
  id: string;
  phoneE164: string;
  email: string | null;
  displayName: string | null;
  whatsappName: string | null;
  locale: string | null;
  optedInAt: Date | null;
  optedOutAt: Date | null;
  blockedAt: Date | null;
  timezone: string | null;
  channel?: string;
  attributes: unknown;
  source: ContactSource;
  syncedFromLabel?: string | null;
  externalRef?: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tags?: { tag: string }[];
}

function toContactDto(row: ContactRow) {
  return {
    id: row.id,
    phoneE164: row.phoneE164,
    email: row.email,
    displayName: row.displayName,
    whatsappName: row.whatsappName,
    locale: row.locale,
    optedInAt: row.optedInAt?.toISOString() ?? null,
    optedOutAt: row.optedOutAt?.toISOString() ?? null,
    blockedAt: row.blockedAt?.toISOString() ?? null,
    timezone: row.timezone,
    channel: row.channel ?? 'whatsapp',
    attributes:
      row.attributes && typeof row.attributes === 'object'
        ? (row.attributes as Record<string, string | number | boolean | null>)
        : {},
    source: row.source,
    syncedFromLabel: row.syncedFromLabel ?? null,
    externalRef: row.externalRef ?? null,
    tags: (row.tags ?? []).map((t) => t.tag),
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: row.lastOutboundAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function contactsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /contacts/overview ---------------------------------------
  // Everything we know about ONE customer, keyed by phone (E.164). Powers the
  // "User info" slide-over in both the inbox and the contacts page: profile +
  // tags + the AI's per-contact memory + recent orders + recent bookings +
  // message activity. All reads are tenant-scoped via app.tenant().
  const overviewResponse = itemEnvelopeSchema(
    z.object({
      contact: z
        .object({
          id: uuidSchema,
          phoneE164: z.string(),
          email: z.string().nullable(),
          displayName: z.string().nullable(),
          whatsappName: z.string().nullable(),
          optedInAt: z.string().nullable(),
          optedOutAt: z.string().nullable(),
          timezone: z.string().nullable(),
          source: z.string(),
          tags: z.array(z.string()),
          lastInboundAt: z.string().nullable(),
          lastOutboundAt: z.string().nullable(),
          createdAt: z.string().nullable(),
        })
        .nullable(),
      memory: z
        .object({
          persona: z.string().nullable(),
          // Operator-curated "User info" (overrides persona for the bot).
          operatorNote: z.string().nullable(),
          operatorNoteAt: z.string().nullable(),
          language: z.string().nullable(),
          facts: z.record(z.string(), z.unknown()),
          lastSummaryAt: z.string().nullable(),
        })
        .nullable(),
      orders: z.array(
        z.object({
          id: uuidSchema,
          createdAt: z.string(),
          status: z.string(),
          totalMinor: z.number(),
          currency: z.string(),
          itemsCount: z.number(),
          items: z.array(z.object({ name: z.string(), quantity: z.number() })),
        }),
      ),
      bookings: z.array(
        z.object({
          id: uuidSchema,
          status: z.string(),
          appointmentAt: z.string().nullable(),
          notes: z.string().nullable(),
          createdAt: z.string(),
          // The actual form answers (Full name, Preferred date, …) — this is
          // the real content; appointmentAt is often null for free-text dates.
          fields: z.array(z.object({ label: z.string(), value: z.string() })),
        }),
      ),
      stats: z.object({
        inboundCount: z.number(),
        outboundCount: z.number(),
        threadId: uuidSchema.nullable(),
      }),
    }),
  );

  r.get(
    '/contacts/overview',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Full profile for one customer (by phone): info, memory, orders, bookings.',
        querystring: z.object({ phone: z.string().trim().min(3).max(32) }),
        response: { 200: overviewResponse },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        // Phone formats are inconsistent across tables: the bot stores
        // threads / carts / bookings / contact_memory WITHOUT a leading "+"
        // (raw Meta wa_id), while contacts are stored WITH it (E.164). So we
        // match against BOTH forms — otherwise the inbox (no "+") would miss
        // the contact/tags and the contacts page ("+") would miss memory +
        // orders + bookings. Querying all variants makes both surfaces show
        // the identical, complete profile.
        const rawPhone = req.query.phone.trim();
        const digits = rawPhone.replace(/[^0-9]/g, '');
        const phones = Array.from(new Set([rawPhone, digits, `+${digits}`].filter(Boolean)));
        // RLS scopes every query to the caller's org.
        const [contact, memory, carts, bookings, thread] = await Promise.all([
          tx.contact.findFirst({
            where: { phoneE164: { in: phones }, deletedAt: null },
            include: { tags: { select: { tag: true } } },
          }),
          tx.contactMemory.findFirst({ where: { phoneE164: { in: phones } } }),
          tx.cart.findMany({
            where: { customerPhone: { in: phones }, itemsCount: { gt: 0 } },
            orderBy: { createdAt: 'desc' },
            take: 10,
            include: { items: { select: { name: true, quantity: true } } },
          }),
          tx.booking.findMany({
            where: { customerPhone: { in: phones } },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
          tx.whatsAppThread.findFirst({
            where: { customerPhone: { in: phones } },
            select: { id: true, inboundCount: true, outboundCount: true },
          }),
        ]);

        const facts =
          memory?.facts && typeof memory.facts === 'object' && !Array.isArray(memory.facts)
            ? (memory.facts as Record<string, unknown>)
            : {};


        return {
          data: {
            contact: contact
              ? {
                  id: contact.id,
                  phoneE164: contact.phoneE164,
                  email: contact.email,
                  displayName: contact.displayName,
                  whatsappName: contact.whatsappName,
                  optedInAt: contact.optedInAt?.toISOString() ?? null,
                  optedOutAt: contact.optedOutAt?.toISOString() ?? null,
                  timezone: contact.timezone,
                  source: contact.source,
                  tags: contact.tags.map((t) => t.tag),
                  lastInboundAt: contact.lastInboundAt?.toISOString() ?? null,
                  lastOutboundAt: contact.lastOutboundAt?.toISOString() ?? null,
                  createdAt: contact.createdAt.toISOString(),
                }
              : null,
            memory: memory
              ? {
                  persona: memory.persona,
                  operatorNote: memory.operatorNote ?? null,
                  operatorNoteAt: memory.operatorNoteAt?.toISOString() ?? null,
                  language: memory.language,
                  facts,
                  lastSummaryAt: memory.lastSummaryAt?.toISOString() ?? null,
                }
              : null,
            orders: carts.map((c) => ({
              id: c.id,
              createdAt: c.createdAt.toISOString(),
              status: c.status,
              totalMinor: Number(c.totalMinor),
              currency: c.currency,
              itemsCount: c.itemsCount,
              items: c.items.map((i) => ({ name: i.name, quantity: i.quantity })),
            })),
            bookings: bookings.map((b) => ({
              id: b.id,
              status: b.status,
              appointmentAt: b.appointmentAt?.toISOString() ?? null,
              notes: b.notes,
              createdAt: b.createdAt.toISOString(),
              fields: Array.isArray(b.fields)
                ? (b.fields as { label?: unknown; key?: unknown; value?: unknown }[])
                    .filter((f) => f && f.value != null && String(f.value).trim() !== '')
                    .map((f) => ({
                      label: String(f.label ?? f.key ?? ''),
                      value: String(f.value),
                    }))
                : [],
            })),
            stats: {
              inboundCount: thread?.inboundCount ?? 0,
              outboundCount: thread?.outboundCount ?? 0,
              threadId: thread?.id ?? null,
            },
          },
        };
      }),
  );

  // ---------- PUT /contacts/memory -----------------------------------------
  // Save the operator-curated "User info" for a customer (by phone). This is
  // stored on contact_memory.operator_note, which the AI summarizer NEVER
  // overwrites and which SUPERSEDES the AI persona in the bot's system prompt —
  // so whatever staff write here is what the bot considers on future replies.
  r.put(
    '/contacts/memory',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Save operator-edited User info for a customer (fed into the bot prompt).',
        body: z.object({
          phone: z.string().trim().min(3).max(32),
          // Empty string clears the override (bot falls back to AI persona).
          userInfo: z.string().max(4000),
        }),
        response: { 200: itemEnvelopeSchema(z.object({ operatorNote: z.string().nullable() })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const rawPhone = req.body.phone.trim();
      const digits = rawPhone.replace(/[^0-9]/g, '');
      if (!digits) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Invalid phone.');
      const phones = Array.from(new Set([rawPhone, digits, `+${digits}`].filter(Boolean)));

      // Write onto the SAME row the bot reads. The bot looks memory up by the
      // raw wa_id (digits, no "+"); reuse an existing row's key if present.
      const existing = await app.tenant(req, (tx) =>
        tx.contactMemory.findFirst({ where: { phoneE164: { in: phones } }, select: { phoneE164: true } }),
      );
      const targetPhone = existing?.phoneE164 ?? digits;
      const note = req.body.userInfo.trim() || null;
      await setContactOperatorNote({ organizationId: orgId, phoneE164: targetPhone, note });

      await recordAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        action: 'business_info_updated',
        entityType: 'contact_memory',
        entityId: targetPhone,
        metadata: { event: 'contact_user_info_edited', cleared: note === null },
      });
      return { data: { operatorNote: note } };
    },
  );

  // ---------- GET /contacts -------------------------------------------------
  r.get(
    '/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: 'List contacts (tenant-scoped, soft-deleted excluded).',
        querystring: listContactsQuerySchema,
        response: { 200: listEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const { search, tag, channel, source, cursor, page, limit } = req.query;
        const where: Record<string, unknown> = { deletedAt: null };
        if (search) {
          const trimmed = search.trim();
          where.OR = [
            { phoneE164: { contains: trimmed, mode: 'insensitive' } },
            { displayName: { contains: trimmed, mode: 'insensitive' } },
            { email: { contains: trimmed, mode: 'insensitive' } },
            { externalRef: { contains: trimmed, mode: 'insensitive' } },
          ];
        }
        if (tag) {
          where.tags = { some: { tag } };
        }
        // Channel filter. Legacy rows predating the column are 'whatsapp'.
        if (channel === 'whatsapp') {
          where.NOT = { channel: { in: ['instagram', 'messenger'] } };
        } else if (channel) {
          where.channel = channel;
        }
        // Source filter — how the contact got into the book. Enum-validated by
        // the query schema. No dedicated index: the org+createdAt index still
        // drives the scan and `source` is a cheap filter at contact-book sizes.
        if (source) {
          where.source = source;
        }

        // Page-offset mode (numbered pages + total). The contacts UI uses this.
        if (page !== undefined) {
          const [total, rows] = await Promise.all([
            tx.contact.count({ where }),
            tx.contact.findMany({
              where,
              include: { tags: { select: { tag: true } } },
              take: limit,
              skip: (page - 1) * limit,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            }),
          ]);
          return { data: rows.map(toContactDto), nextCursor: null, total };
        }

        // Cursor mode (default) — used by the broadcast wizard's infinite list.
        const rows = await tx.contact.findMany({
          where,
          include: { tags: { select: { tag: true } } },
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const hasMore = rows.length > limit;
        const slice = hasMore ? rows.slice(0, limit) : rows;
        return {
          data: slice.map(toContactDto),
          nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
        };
      }),
  );

  // ---------- GET /contacts/phones -----------------------------------------
  // Lightweight: every matching contact's phone (E.164), no pagination, for the
  // broadcast "select all contacts" audience. Same search/tag filters as the
  // list. Capped at 50k (the manual-audience ceiling).
  r.get(
    '/contacts/phones',
    {
      schema: {
        tags: ['contacts'],
        summary: 'All matching contact phone numbers (for broadcast audiences).',
        querystring: z.object({
          search: z.string().trim().max(120).optional(),
          tag: z.string().trim().max(40).optional(),
        }),
        response: {
          200: z.object({ data: z.array(z.string()), total: z.number() }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const { search, tag } = req.query;
        // Only real, WhatsApp-able numbers: E.164 starts with "+". This excludes
        // Instagram/Messenger contacts (their PSID is stored in phoneE164) and
        // blocked contacts — broadcasts go over WhatsApp.
        const where: Record<string, unknown> = {
          // A contact imported from a phone address book WITHOUT the tenant attesting consent is
          // not broadcast-eligible. Scoped to source:'phone_sync' on purpose: optedInAt is
          // documented as informational and nothing has ever read it, so a fleet-wide gate would
          // silently zero every existing tenant's audience. This makes the attestation checkbox
          // mean exactly what its copy promises, for the one source that shows that copy.
          NOT: { source: 'phone_sync', optedInAt: null },
          deletedAt: null,
          blockedAt: null,
          phoneE164: { startsWith: '+' },
        };
        if (search) {
          const trimmed = search.trim();
          where.AND = [
            {
              OR: [
                { phoneE164: { contains: trimmed, mode: 'insensitive' } },
                { displayName: { contains: trimmed, mode: 'insensitive' } },
              ],
            },
          ];
        }
        if (tag) where.tags = { some: { tag } };
        const rows = await tx.contact.findMany({
          where,
          select: { phoneE164: true },
          take: 10000, // matches the broadcast manualPhones cap
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        const phones = rows.map((r) => r.phoneE164).filter((p) => p && p.startsWith('+'));
        return { data: phones, total: phones.length };
      }),
  );

  // ---------- POST /contacts ------------------------------------------------
  r.post(
    '/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Create a contact.',
        body: createContactBodySchema,
        response: { 201: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      const body = req.body;
      const result = await app.tenant(req, async (tx) => {
        // Soft-undelete if the phone exists but is marked deleted.
        const existing = await tx.contact.findUnique({
          where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: body.phoneE164 } },
        });
        if (existing && !existing.deletedAt) {
          throw conflict('A contact with this phone number already exists.');
        }
        const optedInAt = body.optedIn === true ? new Date() : body.optedIn === false ? null : undefined;
        const optedOutAt =
          body.optedOut === true ? new Date() : body.optedOut === false ? null : undefined;
        const blockedAt =
          body.blocked === true ? new Date() : body.blocked === false ? null : undefined;
        // Normalize email: empty string clears it; undefined leaves it unset.
        const email = body.email !== undefined ? body.email?.trim() || null : undefined;
        // F8 — SAP # is unique per org (partial unique index). Pre-check for a
        // friendly message; the index is the real guarantee under races.
        const externalRef = body.externalRef !== undefined ? body.externalRef?.trim() || null : undefined;
        if (externalRef) {
          const dupRef = await tx.contact.findFirst({
            where: { organizationId: orgId, externalRef, deletedAt: null },
            select: { id: true, phoneE164: true },
          });
          if (dupRef && dupRef.phoneE164 !== body.phoneE164) {
            throw conflict(`That SAP # already belongs to ${dupRef.phoneE164}.`);
          }
        }
        const upserted = await tx.contact.upsert({
          where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: body.phoneE164 } },
          create: {
            organizationId: orgId,
            phoneE164: body.phoneE164,
            email: email ?? null,
            displayName: body.displayName ?? null,
            externalRef: externalRef ?? null,
            locale: body.locale ?? null,
            timezone: body.timezone ?? null,
            optedInAt: optedInAt ?? null,
            optedOutAt: optedOutAt ?? null,
            blockedAt: blockedAt ?? null,
            attributes: (body.attributes ?? {}) as never,
            source: 'manual',
          },
          update: {
            deletedAt: null,
            email,
            displayName: body.displayName ?? null,
            externalRef,
            locale: body.locale ?? null,
            timezone: body.timezone ?? undefined,
            optedInAt,
            optedOutAt,
            blockedAt,
            attributes: (body.attributes ?? {}) as never,
          },
          include: { tags: { select: { tag: true } } },
        });
        if (body.tags && body.tags.length > 0) {
          await tx.contactTag.createMany({
            data: body.tags.map((tag) => ({
              organizationId: orgId,
              contactId: upserted.id,
              tag,
            })),
            skipDuplicates: true,
          });
          upserted.tags = await tx.contactTag.findMany({
            where: { contactId: upserted.id },
            select: { tag: true },
          });
        }
        return upserted;
      });
      await recordAudit({
        action: 'contact_created',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact',
        entityId: result.id,
      });
      reply.code(201);
      return { data: toContactDto(result) };
    },
  );

  // ---------- PATCH /contacts/:id ------------------------------------------
  r.patch(
    '/contacts/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Update a contact.',
        params: z.object({ id: uuidSchema }),
        body: updateContactBodySchema,
        response: { 200: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const body = req.body;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.contact.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) throw notFound('Contact not found.');
        // Phone changes require uniqueness check.
        if (body.phoneE164 && body.phoneE164 !== existing.phoneE164) {
          const dup = await tx.contact.findUnique({
            where: {
              organizationId_phoneE164: { organizationId: orgId, phoneE164: body.phoneE164 },
            },
          });
          if (dup && dup.id !== id) throw conflict('That phone number belongs to another contact.');
        }
        // F8 — SAP # uniqueness pre-check (partial unique index is the real
        // guarantee; this just gives a friendly message).
        const nextExternalRef =
          body.externalRef !== undefined ? body.externalRef?.trim() || null : undefined;
        if (nextExternalRef) {
          const dupRef = await tx.contact.findFirst({
            where: { organizationId: orgId, externalRef: nextExternalRef, deletedAt: null, id: { not: id } },
            select: { phoneE164: true },
          });
          if (dupRef) throw conflict(`That SAP # already belongs to ${dupRef.phoneE164}.`);
        }
        const updated = await tx.contact.update({
          where: { id },
          data: {
            phoneE164: body.phoneE164 ?? undefined,
            // Empty string clears; undefined leaves it unchanged.
            email: body.email !== undefined ? body.email?.trim() || null : undefined,
            externalRef: nextExternalRef,
            displayName: body.displayName !== undefined ? body.displayName : undefined,
            locale: body.locale !== undefined ? body.locale : undefined,
            attributes: body.attributes !== undefined ? (body.attributes as never) : undefined,
            // Block / unblock toggle (true = block now, false = unblock).
            blockedAt:
              body.blocked === true ? new Date() : body.blocked === false ? null : undefined,
            optedOutAt:
              body.optedOut === true ? new Date() : body.optedOut === false ? null : undefined,
          },
          include: { tags: { select: { tag: true } } },
        });
        // Bidirectional name sync: when /contacts updates displayName,
        // mirror it onto any matching WhatsApp thread's customerName so
        // the inbox header reflects the rename. Thread → contact is
        // already wired in the /inbox patch route. Match by the raw
        // phone (threads strip the leading "+") as well as the E.164
        // form, since older rows might have either.
        if (body.displayName !== undefined) {
          const stripped = updated.phoneE164.replace(/^\+/, '');
          await tx.whatsAppThread.updateMany({
            where: {
              organizationId: orgId,
              OR: [
                { customerPhone: updated.phoneE164 },
                { customerPhone: stripped },
              ],
            },
            data: { customerName: body.displayName },
          });
        }
        if (body.tags) {
          // Replace-set semantics for tags.
          await tx.contactTag.deleteMany({ where: { contactId: id } });
          if (body.tags.length > 0) {
            await tx.contactTag.createMany({
              data: body.tags.map((tag) => ({
                organizationId: orgId,
                contactId: id,
                tag,
              })),
              skipDuplicates: true,
            });
          }
          updated.tags = await tx.contactTag.findMany({
            where: { contactId: id },
            select: { tag: true },
          });
        }
        return updated;
      });
      await recordAudit({
        action: 'contact_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact',
        entityId: id,
      });
      return { data: toContactDto(result) };
    },
  );

  // ---------- DELETE /contacts/:id (soft) -----------------------------------
  r.delete(
    '/contacts/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Soft-delete a contact (recipient lookups still work for past broadcasts).',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      await app.tenant(req, async (tx) => {
        const existing = await tx.contact.findUnique({ where: { id } });
        if (!existing) throw notFound('Contact not found.');
        if (!existing.deletedAt) {
          await tx.contact.update({ where: { id }, data: { deletedAt: new Date() } });
        }
      });
      await recordAudit({
        action: 'contact_deleted',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact',
        entityId: id,
      });
      return { ok: true as const };
    },
  );

  // ---------- POST /contacts/bulk -------------------------------------------
  // Select-with-actions on the contacts list: one action per call over up to
  // 500 ids. Editor for block/unblock/tags; delete requires admin (same as the
  // single-row DELETE — enforced by re-running the guard for that action).
  // Ids outside this org are unreachable (RLS + the explicit org filter), so
  // `affected` reflects rows actually changed, not rows requested. There are
  // deliberately NO opt-out actions: opt-out is the customer's own STOP signal.
  r.post(
    '/contacts/bulk',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Apply one action (block / unblock / add_tag / remove_tag / delete) to many contacts.',
        body: bulkContactsBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ affected: z.number().int() })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const { ids, action, tag } = req.body;
      if (action === 'delete') await app.requireRole('admin')(req);
      const affected = await app.tenant(req, async (tx) => {
        switch (action) {
          case 'block':
            return (
              await tx.contact.updateMany({
                where: { id: { in: ids }, organizationId: orgId, deletedAt: null, blockedAt: null },
                data: { blockedAt: new Date() },
              })
            ).count;
          case 'unblock':
            return (
              await tx.contact.updateMany({
                where: {
                  id: { in: ids },
                  organizationId: orgId,
                  deletedAt: null,
                  blockedAt: { not: null },
                },
                data: { blockedAt: null },
              })
            ).count;
          case 'delete':
            return (
              await tx.contact.updateMany({
                where: { id: { in: ids }, organizationId: orgId, deletedAt: null },
                data: { deletedAt: new Date() },
              })
            ).count;
          case 'add_tag': {
            const targets = await tx.contact.findMany({
              where: { id: { in: ids }, organizationId: orgId, deletedAt: null },
              select: { id: true },
            });
            return (
              await tx.contactTag.createMany({
                data: targets.map((c) => ({ organizationId: orgId, contactId: c.id, tag: tag! })),
                skipDuplicates: true,
              })
            ).count;
          }
          case 'remove_tag':
            return (
              await tx.contactTag.deleteMany({
                where: { organizationId: orgId, contactId: { in: ids }, tag: tag! },
              })
            ).count;
        }
      });
      await recordAudit({
        action: action === 'delete' ? 'contact_deleted' : 'contact_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'contact_bulk',
        metadata: { action, tag: tag ?? undefined, requested: ids.length, affected },
      });
      return { data: { affected } };
    },
  );

  // ---------- POST /contacts/:id/tags --------------------------------------
  r.post(
    '/contacts/:id/tags',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Add a tag to a contact.',
        params: z.object({ id: uuidSchema }),
        body: tagBodySchema,
        response: { 200: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const id = req.params.id;
      const tag = req.body.tag;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.contact.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) throw notFound('Contact not found.');
        await tx.contactTag.upsert({
          where: { contactId_tag: { contactId: id, tag } },
          create: { organizationId: orgId, contactId: id, tag },
          update: {},
        });
        // Mirror to the matching inbox thread(s) so the tag also shows under
        // the customer's name in /inbox. Threads store the phone WITHOUT a
        // leading "+", contacts WITH it — match both forms. (The reverse
        // mirror, inbox→contact, already lives in the inbox tag endpoints.)
        await mirrorTagToThreads(tx, orgId, existing.phoneE164, tag, 'add');
        return tx.contact.findUniqueOrThrow({
          where: { id },
          include: { tags: { select: { tag: true } } },
        });
      });
      return { data: toContactDto(result) };
    },
  );

  // ---------- DELETE /contacts/:id/tags/:tag --------------------------------
  r.delete(
    '/contacts/:id/tags/:tag',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Remove a tag from a contact.',
        params: z.object({
          id: uuidSchema,
          tag: z.string().trim().min(1).max(40),
        }),
        response: { 200: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const id = req.params.id;
      const tag = req.params.tag;
      const result = await app.tenant(req, async (tx) => {
        const existing = await tx.contact.findUnique({ where: { id } });
        if (!existing || existing.deletedAt) throw notFound('Contact not found.');
        await tx.contactTag
          .delete({ where: { contactId_tag: { contactId: id, tag } } })
          .catch(() => undefined);
        // Mirror the removal to the inbox thread(s) too.
        await mirrorTagToThreads(tx, req.auth!.organizationId, existing.phoneE164, tag, 'remove');
        return tx.contact.findUniqueOrThrow({
          where: { id },
          include: { tags: { select: { tag: true } } },
        });
      });
      return { data: toContactDto(result) };
    },
  );

  // ---------- GET /contacts/tags --------------------------------------------
  // Returns the distinct tag list with counts. Used by the segment editor.
  r.get(
    '/contacts/tags',
    {
      schema: {
        tags: ['contacts'],
        summary: 'List distinct tags used by contacts (with counts).',
        response: {
          200: z.object({
            data: z.array(z.object({ tag: z.string(), count: z.number().int() })),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const grouped = await tx.contactTag.groupBy({
          by: ['tag'],
          _count: { tag: true },
          orderBy: { _count: { tag: 'desc' } },
          take: 200,
        });
        return {
          data: grouped.map((g) => ({ tag: g.tag, count: g._count.tag })),
        };
      }),
  );

  // ---------- GET /contacts/:id ---------------------------------------------
  r.get(
    '/contacts/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Fetch a contact by id.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(contactDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const row = await tx.contact.findUnique({
          where: { id: req.params.id },
          include: { tags: { select: { tag: true } } },
        });
        if (!row || row.deletedAt) throw notFound('Contact not found.');
        return { data: toContactDto(row) };
      }),
  );

  // ---------- POST /contacts/import (CSV via existing asset) ---------------
  // Streams a previously-uploaded CSV asset and upserts contacts. Synchronous
  // for v1 (good enough for ≤ 50K rows); large imports can move to the
  // existing import worker later if needed.
  r.post(
    '/contacts/import',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Import contacts from a CSV asset already uploaded via /assets/upload-csv.',
        body: z.object({
          assetId: uuidSchema,
          // Optional column overrides — by default we look for "phone", "name",
          // "email", "locale", and the rest land in attributes.
          phoneColumn: z.string().optional(),
          nameColumn: z.string().optional(),
          emailColumn: z.string().optional(),
          localeColumn: z.string().optional(),
          tagColumn: z.string().optional(), // comma-separated tags per row
        }),
        response: {
          200: z.object({
            data: z.object({
              total: z.number().int(),
              created: z.number().int(),
              updated: z.number().int(),
              skipped: z.number().int(),
              errors: z.array(z.object({ row: z.number().int(), error: z.string() })).max(100),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      // Defer the streaming logic to a small helper kept alongside the broadcast
      // module so we don't pull a heavy CSV path into routes.
      const { importContactsFromCsv } = await import('./import-csv.js');
      // F8 gate — SAP-first merging only when the org's contact_sap is on.
      const orgRow = await withRlsBypass((tx) =>
        tx.organization.findUnique({
          where: { id: req.auth!.organizationId },
          select: { disabledFeatures: true },
        }),
      );
      const result = await importContactsFromCsv({
        organizationId: req.auth!.organizationId,
        enableSapMerge: !(orgRow?.disabledFeatures ?? []).includes('contact_sap'),
        assetId: req.body.assetId,
        phoneColumn: req.body.phoneColumn,
        nameColumn: req.body.nameColumn,
        emailColumn: req.body.emailColumn,
        localeColumn: req.body.localeColumn,
        tagColumn: req.body.tagColumn,
      });
      if (result.total === 0) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'CSV had no readable rows.');
      }
      return { data: result };
    },
  );

  // ---------- GET /contacts/duplicates -------------------------------------
  // Surface likely-duplicate numbers — the same phone written differently
  // (+961…, 00961…, or local) that landed as separate contacts. Grouped by the
  // trailing 9 digits. Only real phone contacts (WhatsApp); Messenger/IG store
  // a PSID in phoneE164, not a phone, so they're never "duplicate numbers".
  r.get(
    '/contacts/duplicates',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Groups of contacts that look like the same phone number.',
        response: {
          200: itemEnvelopeSchema(
            z.object({
              groupCount: z.number().int(),
              groups: z.array(
                z.object({
                  key: z.string(),
                  sameName: z.boolean(),
                  contacts: z.array(
                    z.object({
                      id: uuidSchema,
                      phoneE164: z.string(),
                      displayName: z.string().nullable(),
                      whatsappName: z.string().nullable(),
                      lastInboundAt: z.string().nullable(),
                    }),
                  ),
                }),
              ),
            }),
          ),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.contact.findMany({
          // Real phone contacts only — Messenger/IG hold a PSID in phoneE164.
          where: { deletedAt: null, channel: { notIn: ['messenger', 'instagram'] } },
          select: {
            id: true,
            phoneE164: true,
            displayName: true,
            whatsappName: true,
            lastInboundAt: true,
            createdAt: true,
          },
          take: 20000,
        });
        const norm = (p: string) => {
          const d = p.replace(/[^\d]/g, '').replace(/^0+/, '');
          return d.length >= 9 ? d.slice(-9) : d;
        };
        const byKey = new Map<string, typeof rows>();
        for (const r of rows) {
          const k = norm(r.phoneE164);
          if (!k) continue;
          const arr = byKey.get(k);
          if (arr) arr.push(r);
          else byKey.set(k, [r]);
        }
        const groups = [...byKey.entries()]
          .filter(([, list]) => list.length >= 2)
          .map(([key, list]) => {
            const names = Array.from(
              new Set(
                list
                  .map((c) => (c.displayName ?? c.whatsappName ?? '').trim())
                  .filter((n) => n.length > 0),
              ),
            );
            return {
              key,
              sameName: names.length <= 1,
              contacts: list
                .slice()
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                .map((c) => ({
                  id: c.id,
                  phoneE164: c.phoneE164,
                  displayName: c.displayName,
                  whatsappName: c.whatsappName,
                  lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
                })),
            };
          });
        return { data: { groupCount: groups.length, groups } };
      }),
  );

  // ---------- POST /contacts/merge -----------------------------------------
  // Merge duplicate contacts into one: move every tag onto the kept contact,
  // adopt a name if the kept one has none, then delete the dropped contacts
  // (their tags/enrollments cascade away).
  r.post(
    '/contacts/merge',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Merge duplicate contacts into keepId, deleting dropIds.',
        body: z.object({ keepId: uuidSchema, dropIds: z.array(uuidSchema).min(1).max(50) }),
        response: { 200: itemEnvelopeSchema(z.object({ merged: z.number().int() })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const { keepId } = req.body;
        const ids = req.body.dropIds.filter((d) => d !== keepId);
        const keep = await tx.contact.findUnique({ where: { id: keepId } });
        if (!keep) throw notFound('Kept contact not found.');
        if (ids.length === 0) return { data: { merged: 0 } };
        const tags = await tx.contactTag.findMany({
          where: { contactId: { in: ids } },
          select: { tag: true },
        });
        const uniqueTags = Array.from(new Set(tags.map((t) => t.tag)));
        if (uniqueTags.length) {
          await tx.contactTag.createMany({
            data: uniqueTags.map((tag) => ({
              organizationId: keep.organizationId,
              contactId: keepId,
              tag,
            })),
            skipDuplicates: true,
          });
        }
        if (!keep.displayName) {
          const named = await tx.contact.findFirst({
            where: { id: { in: ids }, displayName: { not: null } },
            select: { displayName: true },
          });
          if (named?.displayName) {
            await tx.contact.update({ where: { id: keepId }, data: { displayName: named.displayName } });
          }
        }
        // Carry phone-sync ORIGIN onto the survivor, exactly like displayName above and like
        // the tags a few lines up.
        //
        // Without this, merge was backwards: it copied the tags (which PATCH /contacts/:id
        // can destroy) and then deleted the rows holding synced_from_label (which nothing
        // else can). Merging a duplicate — a routine tidy-up, and one this page actively
        // prompts for — silently destroyed the durable half of provenance while keeping the
        // fragile half. Only fills a GAP: a survivor that already has an origin keeps it,
        // because it was there first and merge must not rewrite who introduced whom.
        if (!keep.syncedFromLabel) {
          const synced = await tx.contact.findFirst({
            where: { id: { in: ids }, syncedFromLabel: { not: null } },
            select: { syncedFromLabel: true, syncedFromSessionId: true },
          });
          if (synced?.syncedFromLabel) {
            await tx.contact.update({
              where: { id: keepId },
              data: {
                syncedFromLabel: synced.syncedFromLabel,
                syncedFromSessionId: synced.syncedFromSessionId,
              },
            });
          }
        }
        const del = await tx.contact.deleteMany({ where: { id: { in: ids } } });
        return { data: { merged: del.count } };
      }),
  );

  // ==================== F5 — back-in-stock watches ==========================
  // Created automatically by the bot's capture hook; these routes are the
  // operator surfaces: list them (contact profile + product page), add one by
  // hand, remove one. Gated by the org-level `stock_watch` feature via data
  // presence only — reading an empty list when the feature is off leaks
  // nothing, and DELETE must keep working even after HQ turns the feature off
  // (the sales-scan revocation lesson: never gate the off-switch).

  const stockWatchDto = z.object({
    id: uuidSchema,
    entityKind: z.enum(['product', 'service']),
    entityId: uuidSchema,
    entityName: z.string(),
    isAvailable: z.boolean(),
    contactId: uuidSchema,
    contactName: z.string().nullable(),
    contactPhone: z.string(),
    inquiryText: z.string().nullable(),
    source: z.string(),
    createdAt: z.string().datetime(),
    notifiedAt: z.string().datetime().nullable(),
  });

  r.get(
    '/stock-watches',
    {
      schema: {
        tags: ['contacts'],
        summary: 'List back-in-stock watches, filtered by contact phone or product/service.',
        querystring: z.object({
          phone: z.string().trim().min(3).max(32).optional(),
          productId: uuidSchema.optional(),
          serviceId: uuidSchema.optional(),
        }),
        response: { 200: listEnvelopeSchema(stockWatchDto) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const orgId = req.auth!.organizationId;
        const where: Record<string, unknown> = { organizationId: orgId };
        if (req.query.phone) {
          const digits = req.query.phone.replace(/[^0-9]/g, '');
          const contact = await tx.contact.findFirst({
            where: { organizationId: orgId, phoneE164: { in: [digits, `+${digits}`] } },
            select: { id: true },
          });
          if (!contact) return { data: [], nextCursor: null };
          where.contactId = contact.id;
        }
        if (req.query.productId) where.productId = req.query.productId;
        if (req.query.serviceId) where.serviceId = req.query.serviceId;
        const rows = await tx.stockWatch.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: {
            product: { select: { id: true, name: true, isAvailable: true } },
            service: { select: { id: true, name: true, isAvailable: true } },
            contact: { select: { id: true, displayName: true, phoneE164: true } },
          },
        });
        return {
          data: rows.map((w) => ({
            id: w.id,
            entityKind: (w.productId ? 'product' : 'service') as 'product' | 'service',
            entityId: (w.productId ?? w.serviceId)!,
            entityName: w.product?.name ?? w.service?.name ?? '(deleted)',
            isAvailable: w.product?.isAvailable ?? w.service?.isAvailable ?? false,
            contactId: w.contactId,
            contactName: w.contact.displayName,
            contactPhone: w.contact.phoneE164,
            inquiryText: w.inquiryText,
            source: w.source,
            createdAt: w.createdAt.toISOString(),
            notifiedAt: w.notifiedAt?.toISOString() ?? null,
          })),
          nextCursor: null,
        };
      }),
  );

  r.post(
    '/stock-watches',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Manually watch a product/service for a contact (operator add).',
        body: z
          .object({
            contactId: uuidSchema,
            productId: uuidSchema.optional(),
            serviceId: uuidSchema.optional(),
          })
          .refine((b) => !!b.productId !== !!b.serviceId, {
            message: 'Provide exactly one of productId / serviceId.',
          }),
        response: { 200: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const orgId = req.auth!.organizationId;
        const where = {
          organizationId: orgId,
          contactId: req.body.contactId,
          ...(req.body.productId
            ? { productId: req.body.productId }
            : { serviceId: req.body.serviceId }),
        };
        const existing = await tx.stockWatch.findFirst({ where, select: { id: true } });
        if (existing) {
          await tx.stockWatch.update({ where: { id: existing.id }, data: { notifiedAt: null } });
          return { data: { id: existing.id } };
        }
        const created = await tx.stockWatch.create({
          data: { ...where, source: 'operator' },
          select: { id: true },
        });
        return { data: { id: created.id } };
      }),
  );

  r.delete(
    '/stock-watches/:id',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Remove a back-in-stock watch.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.stockWatch.deleteMany({
          where: { id: req.params.id, organizationId: req.auth!.organizationId },
        });
        return { ok: true as const };
      }),
  );
}
