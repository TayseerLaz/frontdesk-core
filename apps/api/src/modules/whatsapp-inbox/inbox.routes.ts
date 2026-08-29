// Phase 3 §5.1.1 — Conversation inbox routes.
//
// Replaces the legacy phone-keyed thread endpoints in whatsapp.routes.ts
// with id-keyed routes that support status, tags, assignment, internal
// notes, search, and bot-to-human handoff.
//
// All endpoints are tenant-scoped via app.tenant + RLS. Internal notes
// are persisted in the `whatsapp_notes` table, not `whatsapp_messages`,
// so they NEVER appear in the chatbot read API or in any outbound surface.
import { ApiErrorCode, itemEnvelopeSchema, listEnvelopeSchema, successSchema, uuidSchema } from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { publishInboxEvent } from '../../lib/inbox-events.js';
import { maybeAskFeedback } from '../../lib/feedback-ask.js';
import { createNotification } from '../../lib/notifications.js';

// SSE handlers write raw response headers via reply.raw.writeHead(), which
// bypasses @fastify/cors. Build the Access-Control-Allow-Origin header
// manually so EventSource clients on the web origin can connect.
function corsHeadersForSse(req: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const origin = (req.headers.origin as string | undefined) ?? '';
  const allowed = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] ?? '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

const threadStatusSchema = z.enum(['open', 'pending', 'resolved', 'escalated']);

// ---------- assignment side effects (F3/F4/F6, roadmap 2026-08-26) ----------
// On any assignee change: write a system note INSIDE the caller's tenant tx
// (so it rolls back with the change), and return a post-commit runner that
// files the bell/FCM notification + pushes the targeted SSE `notify` frame
// (the portal sound popup). Notifications run AFTER commit so a rolled-back
// assignment can never leave a ghost "assigned to you" ping.
async function recordAssignmentChange(opts: {
  tx: {
    user: {
      findMany: (args: {
        where: { id: { in: string[] } };
        select: { id: true; firstName: true; lastName: true; email: true };
      }) => Promise<{ id: string; firstName: string | null; lastName: string | null; email: string }[]>;
    };
    whatsAppNote: {
      create: (args: {
        data: { organizationId: string; threadId: string; authorUserId: string; body: string };
      }) => Promise<unknown>;
    };
  };
  orgId: string;
  threadId: string;
  actorUserId: string;
  prevAssigneeId: string | null;
  newAssigneeId: string | null;
  customerLabel: string;
  auto?: boolean;
}): Promise<() => void> {
  const ids = Array.from(
    new Set(
      [opts.actorUserId, opts.prevAssigneeId, opts.newAssigneeId].filter((v): v is string => !!v),
    ),
  );
  const users = await opts.tx.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const nameOf = (id: string | null): string => {
    if (!id) return '';
    const u = users.find((x) => x.id === id);
    return u
      ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email.split('@')[0]!
      : 'a teammate';
  };
  const actorName = nameOf(opts.actorUserId);
  const nextName = nameOf(opts.newAssigneeId);
  const prevName = nameOf(opts.prevAssigneeId);
  const noteBody =
    opts.newAssigneeId === null
      ? `${actorName} returned the conversation to the AI (unassigned).`
      : opts.newAssigneeId === opts.actorUserId
        ? opts.prevAssigneeId
          ? `${actorName} took over the conversation from ${prevName}.`
          : `${actorName} took over the conversation from the AI.`
        : `${opts.auto ? 'Auto-assigned' : 'Assigned'} to ${nextName} by ${actorName}${
            opts.prevAssigneeId ? ` (was ${prevName})` : ''
          }.`;
  await opts.tx.whatsAppNote.create({
    data: {
      organizationId: opts.orgId,
      threadId: opts.threadId,
      authorUserId: opts.actorUserId,
      body: noteBody,
    },
  });

  const { orgId, threadId, actorUserId, prevAssigneeId, newAssigneeId, customerLabel } = opts;
  return () => {
    // New assignee (someone other than the actor): bell + FCM mirror + the
    // targeted SSE frame that makes the portal chime.
    if (newAssigneeId && newAssigneeId !== actorUserId) {
      const title = 'Conversation assigned to you';
      const body = `${customerLabel} — assigned by ${actorName}`;
      void createNotification({
        organizationId: orgId,
        kind: 'thread_assigned',
        title,
        body,
        link: `/inbox?thread=${threadId}`,
        targetUserId: newAssigneeId,
        entityType: 'whatsapp_thread',
        entityId: threadId,
      });
      publishInboxEvent(orgId, {
        kind: 'thread_assigned',
        targetUserId: newAssigneeId,
        threadId,
        title,
        body,
      });
    }
    // Previous assignee lost the thread to someone else: bell only, no chime.
    if (prevAssigneeId && prevAssigneeId !== actorUserId && prevAssigneeId !== newAssigneeId) {
      void createNotification({
        organizationId: orgId,
        kind: 'thread_assigned',
        title: `${actorName} took over one of your conversations`,
        body: customerLabel,
        link: `/inbox?thread=${threadId}`,
        targetUserId: prevAssigneeId,
        entityType: 'whatsapp_thread',
        entityId: threadId,
      });
    }
  };
}

const threadDtoSchema = z.object({
  id: uuidSchema,
  // 'whatsapp' | 'messenger' | 'instagram' — drives the channel badge + the
  // channel-aware reply send.
  channel: z.string(),
  // Multi-number: which WhatsApp number this thread belongs to + its label so
  // the inbox can show a separate inbox per number and replies go from it.
  whatsAppChannelId: uuidSchema.nullable(),
  whatsAppChannelLabel: z.string().nullable(),
  whatsAppChannelPhone: z.string().nullable(),
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  customerWhatsappName: z.string().nullable(),
  status: threadStatusSchema,
  assignedToUserId: uuidSchema.nullable(),
  assignedToName: z.string().nullable(),
  requiredSkill: z.string().nullable(),
  lastMessageAt: z.string().datetime(),
  lastMessagePreview: z.string().nullable(),
  inboundCount: z.number().int(),
  outboundCount: z.number().int(),
  // Inbox filters/marks: a real conversation (customer messaged), an unread
  // inbound waiting, and whether we've replied since their last message.
  isChat: z.boolean(),
  unread: z.boolean(),
  answered: z.boolean(),
  tags: z.array(z.string()),
  noteCount: z.number().int(),
  // Phase 6 — per-thread reply-mode override. NULL = inherit BotConfig.
  botReplyMode: z.enum(['text', 'voice', 'match_customer']).nullable(),
  // Operator block: true when the matching Contact has blockedAt set. A blocked
  // customer gets NO bot auto-replies AND no outbound messages can be sent.
  blocked: z.boolean(),
  // True when the matching Contact has optedOutAt set (customer unsubscribed).
  optedOut: z.boolean(),
  createdAt: z.string().datetime(),
});

const messageDtoSchema = z.object({
  id: uuidSchema,
  direction: z.enum(['inbound', 'outbound']),
  metaMessageId: z.string().nullable(),
  fromNumber: z.string().nullable(),
  toNumber: z.string().nullable(),
  messageType: z.string().nullable(),
  body: z.string().nullable(),
  receivedAt: z.string().datetime(),
  // Phase 8 / 1.3 — surface who composed this outbound message. 'bot'
  // means it has a provenance row; 'operator' means a human sent it
  // from the portal. Null on inbound + legacy rows without rawPayload.
  sentBy: z.enum(['bot', 'operator']).nullable(),
  // Phase 8 / 1.5 — for image-type bot messages, the source: either the
  // greeting image set on /bot, or a product image identified by SKU.
  // The inline inbox UI renders an attribution line under image bubbles
  // for super-admins so they can verify the right image fired.
  imageSource: z
    .object({
      kind: z.enum(['greeting', 'product']),
      productSku: z.string().nullable(),
    })
    .nullable(),
  // Signed, directly-loadable Wasabi URL for image-type messages so the
  // chat renders the actual picture. Null when the image isn't stored
  // (e.g. a not-yet-downloaded inbound photo) or storage is unconfigured.
  mediaUrl: z.string().nullable(),
  // Quick-reply button labels the bot offered with this message (Messenger /
  // Instagram). Shown as non-interactive pills under the bubble so operators
  // see exactly what the customer could tap. Null/[] for messages without any.
  quickReplies: z.array(z.string()).nullable(),
  // Header media URL (Wasabi-backed) for media-header template messages so the
  // inbox bubble shows the picture/video/document the customer received.
  headerImageUrl: z.string().nullable(),
  // 'image' | 'video' | 'document' — how to render headerImageUrl.
  headerMediaType: z.string().nullable(),
  // Meta delivery state for OUTBOUND messages — drives the WhatsApp-style
  // ticks (sent ✓, delivered ✓✓, read ✓✓ blue, failed). Null on inbound.
  deliveryStatus: z.enum(['sent', 'delivered', 'read', 'failed']).nullable(),
  // Length of an audio/voice message in whole seconds, so a client can render
  // "🎙 0:14" on the bubble without fetching the clip. Measured from the audio
  // itself on ingest — Meta sends no duration — so it is null on non-audio
  // rows, on messages received before this was added, and whenever the
  // measurement failed. Clients must treat null as "unknown", not "0".
  durationSeconds: z.number().int().nullable(),
  // Inbound WhatsApp location messages carry coordinates (+ optional
  // name/address the sender's map picked). Surfaced so the operator can
  // actually open the spot on a map instead of seeing a bare "[location]".
  // Null for every non-location row.
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().nullable(),
      address: z.string().nullable(),
    })
    .nullable(),
});

const noteDtoSchema = z.object({
  id: uuidSchema,
  authorUserId: uuidSchema.nullable(),
  authorName: z.string().nullable(),
  authorEmail: z.string().nullable(),
  body: z.string(),
  createdAt: z.string().datetime(),
});

const cannedResponseDtoSchema = z.object({
  id: uuidSchema,
  shortcut: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Contacts store phones as E.164 (`+…`); thread.customerPhone may or may not
// carry the leading `+`. Normalise so block lookups match either form.
function toE164(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

// Render a legacy template message (older rows stored only the template name)
// from its current definition. Uses the template's example {{n}} values since
// the per-recipient values weren't persisted on those rows. Returns the full
// header+body+footer text, the button labels, and the header image URL.
function renderLegacyTemplate(
  components: unknown,
  bodyText: string,
  name: string,
  language: string,
): { body: string; quickReplies: string[]; headerImageUrl: string | null } {
  const comps = Array.isArray(components) ? (components as Record<string, unknown>[]) : [];
  const byType = (want: string) =>
    comps.find((c) => String((c as { type?: string }).type ?? '').toUpperCase() === want) as
      | {
          format?: string;
          text?: string;
          buttons?: { text?: string }[];
          example?: { header_handle?: string[]; body_text?: string[][] };
        }
      | undefined;
  const header = byType('HEADER');
  const headerFmt = String(header?.format ?? '').toUpperCase();
  const body = byType('BODY');
  const ex = body?.example?.body_text?.[0] ?? [];
  const interp = (t: string) =>
    t.replace(/{{\s*(\d+)\s*}}/g, (_m, i: string) => ex[Number(i) - 1] ?? `{{${i}}}`);
  const headerText = header && headerFmt === 'TEXT' && header.text ? String(header.text) : '';
  const renderedBody = body?.text ? interp(String(body.text)) : bodyText;
  const footer = byType('FOOTER')?.text ? String(byType('FOOTER')!.text) : '';
  const quickReplies = (byType('BUTTONS')?.buttons ?? [])
    .map((b) => String(b.text ?? '').trim())
    .filter(Boolean);
  const headerImageUrl =
    headerFmt === 'IMAGE' ? (header?.example?.header_handle?.[0] ?? null) : null;
  const tagLine = `📨 Template · ${name}${language && language !== 'en_US' ? ` (${language})` : ''}`;
  const full = [headerText, renderedBody, footer].filter(Boolean).join('\n\n');
  return { body: full ? `${tagLine}\n\n${full}` : tagLine, quickReplies, headerImageUrl };
}

// Helper — pull the joined fields the UI needs for a thread row.
function serializeThread(t: {
  id: string;
  channel?: string;
  whatsAppChannelId?: string | null;
  whatsAppChannel?: { label: string | null; displayPhoneNumber: string | null } | null;
  customerPhone: string;
  customerName: string | null;
  customerWhatsappName?: string | null;
  status: string;
  assignedToUserId: string | null;
  requiredSkill?: string | null;
  botReplyMode?: string | null;
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  inboundCount: number;
  outboundCount: number;
  lastInboundAt?: Date | null;
  lastReadAt?: Date | null;
  createdAt: Date;
  assignedTo?: { firstName: string | null; lastName: string | null; email: string } | null;
  tags?: { tag: string }[];
  _count?: { notes: number };
  // Set by the route from the matching Contact's blockedAt. Defaults false.
  blocked?: boolean;
  // Set by the route from the matching Contact's optedOutAt. Defaults false.
  optedOut?: boolean;
}) {
  const rawMode = (t.botReplyMode ?? null) as
    | 'text'
    | 'voice'
    | 'match_customer'
    | null
    | string;
  // Read/answered marks derived from the timestamps.
  const lastInboundMs = t.lastInboundAt ? t.lastInboundAt.getTime() : null;
  const lastReadMs = t.lastReadAt ? t.lastReadAt.getTime() : null;
  const isChat = t.inboundCount > 0;
  const unread = isChat && lastInboundMs != null && (lastReadMs == null || lastInboundMs > lastReadMs);
  // Answered = we sent something after their last inbound (last message is ours).
  const answered = isChat && (lastInboundMs == null || t.lastMessageAt.getTime() > lastInboundMs);
  return {
    id: t.id,
    blocked: t.blocked ?? false,
    optedOut: t.optedOut ?? false,
    channel: t.channel ?? 'whatsapp',
    whatsAppChannelId: t.whatsAppChannelId ?? null,
    whatsAppChannelLabel: t.whatsAppChannel?.label ?? null,
    whatsAppChannelPhone: t.whatsAppChannel?.displayPhoneNumber ?? null,
    customerPhone: t.customerPhone,
    customerName: t.customerName,
    customerWhatsappName: t.customerWhatsappName ?? null,
    status: t.status as z.infer<typeof threadStatusSchema>,
    assignedToUserId: t.assignedToUserId,
    assignedToName:
      t.assignedTo
        ? [t.assignedTo.firstName, t.assignedTo.lastName].filter(Boolean).join(' ') ||
          t.assignedTo.email
        : null,
    requiredSkill: t.requiredSkill ?? null,
    botReplyMode:
      rawMode && ['text', 'voice', 'match_customer'].includes(rawMode)
        ? (rawMode as 'text' | 'voice' | 'match_customer')
        : null,
    lastMessageAt: t.lastMessageAt.toISOString(),
    lastMessagePreview: t.lastMessagePreview,
    isChat,
    unread,
    answered,
    inboundCount: t.inboundCount,
    outboundCount: t.outboundCount,
    tags: (t.tags ?? []).map((tg) => tg.tag),
    noteCount: t._count?.notes ?? 0,
    createdAt: t.createdAt.toISOString(),
  };
}

export default async function inboxRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ===================================================================
  // THREADS
  // ===================================================================

  // ---------- GET /inbox/threads ---------------------------------------
  r.get(
    '/inbox/threads',
    {
      schema: {
        tags: ['inbox'],
        summary: 'List conversation threads with filters.',
        querystring: z.object({
          q: z.string().trim().optional(),
          status: threadStatusSchema.optional(),
          tag: z.string().trim().optional(),
          assignee: uuidSchema.optional(),
          // 'whatsapp' | 'messenger' | 'instagram' — filter to one channel.
          channel: z.enum(['whatsapp', 'messenger', 'instagram']).optional(),
          // Multi-number: filter to a single WhatsApp number (its inbox).
          whatsAppChannelId: uuidSchema.optional(),
          // Multi-select chips: comma-separated platform tokens
          // (whatsapp,messenger,instagram) and/or WhatsApp channel ids. Any
          // selected chip matches (OR). Coexists with the legacy single params.
          channels: z.string().max(200).optional(),
          whatsAppChannelIds: z.string().max(500).optional(),
          // Cursor (a thread id) for "load more" beyond the first page.
          cursor: uuidSchema.optional(),
          // Inbox view filter: all | chats (real convos) | unread | unanswered | answered
          // | unassigned (waiting for a human: pending/escalated, nobody took it)
          // | ai (bot actively replying: open, no assignee).
          view: z
            .enum(['all', 'chats', 'unread', 'unanswered', 'answered', 'unassigned', 'ai'])
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: listEnvelopeSchema(threadDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const q = req.query;
      return app.tenant(req, async (tx) => {
        // Read/answered view filters compare two columns → Prisma field refs.
        const f = tx.whatsAppThread.fields;
        const viewClause =
          q.view === 'chats'
            ? { inboundCount: { gt: 0 } }
            : q.view === 'unread'
              ? {
                  inboundCount: { gt: 0 },
                  lastInboundAt: { not: null },
                  OR: [{ lastReadAt: null }, { lastReadAt: { lt: f.lastInboundAt } }],
                }
              : q.view === 'unanswered'
                ? {
                    // No reply sent after the customer's last message (the last
                    // message in the thread is inbound). The actionable list.
                    inboundCount: { gt: 0 },
                    lastInboundAt: { not: null },
                    lastMessageAt: { lte: f.lastInboundAt },
                  }
                : q.view === 'answered'
                  ? {
                      inboundCount: { gt: 0 },
                      OR: [{ lastInboundAt: null }, { lastMessageAt: { gt: f.lastInboundAt } }],
                    }
                  : q.view === 'unassigned'
                    ? {
                        // Waiting for a human: handed off / escalated, nobody took it.
                        assignedToUserId: null,
                        status: { in: ['pending', 'escalated'] as never },
                      }
                    : q.view === 'ai'
                      ? {
                          // Bot actively replying: open thread with no human owner.
                          assignedToUserId: null,
                          status: 'open' as never,
                        }
                      : null;
        // Multi-select channel chips -> one OR group (any selected chip
        // matches), nested under AND so it can't clash with the search OR.
        const chanTokens = (q.channels ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter((t): t is 'whatsapp' | 'messenger' | 'instagram' =>
            ['whatsapp', 'messenger', 'instagram'].includes(t),
          );
        const waIds = (q.whatsAppChannelIds ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t),
          );
        const channelOr = [
          ...waIds.map((id) => ({ whatsAppChannelId: id })),
          ...chanTokens.map((t) =>
            t === 'whatsapp'
              ? { NOT: { channel: { in: ['messenger', 'instagram'] } as never } }
              : { channel: t as never },
          ),
        ];
        const andClauses = [
          ...(viewClause ? [viewClause] : []),
          ...(channelOr.length ? [{ OR: channelOr }] : []),
        ];
        const where = {
          ...(andClauses.length ? { AND: andClauses } : {}),
          ...(q.status ? { status: q.status as never } : {}),
          ...(q.assignee ? { assignedToUserId: q.assignee } : {}),
          ...(q.tag ? { tags: { some: { tag: q.tag } } } : {}),
          // Channel filter. Legacy WhatsApp rows may predate the `channel`
          // column (null) — treat anything that isn't messenger/instagram as
          // WhatsApp (avoids an `OR` key that would clash with search below).
          ...(q.channel
            ? q.channel === 'whatsapp'
              ? { NOT: { channel: { in: ['messenger', 'instagram'] } as never } }
              : { channel: q.channel as never }
            : {}),
          // Per-number inbox: restrict to one WhatsApp number.
          ...(q.whatsAppChannelId ? { whatsAppChannelId: q.whatsAppChannelId } : {}),
          // Search uses the rolling search_text blob OR matches the phone
          // / preview directly so users can search for `+1415` as well.
          ...(q.q
            ? {
                OR: [
                  { customerPhone: { contains: q.q } },
                  { customerName: { contains: q.q, mode: 'insensitive' as const } },
                  { lastMessagePreview: { contains: q.q, mode: 'insensitive' as const } },
                  { searchText: { contains: q.q.toLowerCase() } },
                ],
              }
            : {}),
        };
        // total = real count for this filter (so the UI shows e.g. "148"),
        // independent of how many are loaded into the list (cursor-paged).
        const [total, rows] = await Promise.all([
          tx.whatsAppThread.count({ where }),
          tx.whatsAppThread.findMany({
            where,
            // Stable order needs a tiebreaker so the cursor never skips/repeats.
            orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
            take: q.limit + 1,
            ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
            include: {
              assignedTo: { select: { firstName: true, lastName: true, email: true } },
              whatsAppChannel: { select: { label: true, displayPhoneNumber: true } },
              tags: { select: { tag: true } },
              _count: { select: { notes: true } },
            },
          }),
        ]);
        const hasMore = rows.length > q.limit;
        if (hasMore) rows.pop();
        // Batch-resolve which of these customers are blocked (one query) so
        // the list can show a blocked indicator without an N+1.
        const phones = Array.from(new Set(rows.map((r) => toE164(r.customerPhone))));
        const flagRows = phones.length
          ? await tx.contact.findMany({
              where: {
                organizationId: req.auth!.organizationId,
                deletedAt: null,
                OR: [{ blockedAt: { not: null } }, { optedOutAt: { not: null } }],
                phoneE164: { in: phones },
              },
              select: { phoneE164: true, blockedAt: true, optedOutAt: true },
            })
          : [];
        const blockedSet = new Set(
          flagRows.filter((c) => c.blockedAt).map((c) => c.phoneE164),
        );
        const optedOutSet = new Set(
          flagRows.filter((c) => c.optedOutAt).map((c) => c.phoneE164),
        );
        return {
          data: rows.map((r) =>
            serializeThread({
              ...r,
              blocked: blockedSet.has(toE164(r.customerPhone)),
              optedOut: optedOutSet.has(toE164(r.customerPhone)),
            }),
          ),
          nextCursor: hasMore ? (rows[rows.length - 1]?.id ?? null) : null,
          total,
        };
      });
    },
  );

  // ---------- GET /inbox/counts ----------------------------------------
  // Lightweight aggregate for the sidebar badge. We surface the count of
  // chats the bot has flagged as needing a real human ("escalated") so
  // the Inbox nav item can show a red number next to it.
  r.get(
    '/inbox/counts',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Aggregate thread counts (escalated etc.) for the sidebar badge.',
        response: {
          200: z.object({
            data: z.object({
              escalated: z.number().int().nonnegative(),
              pending: z.number().int().nonnegative(),
              open: z.number().int().nonnegative(),
              // F7 — the left-bar tab badges: my active conversations, and
              // handed-off/escalated conversations nobody has taken yet
              // (mirrors the list route's `view=unassigned` semantics).
              mine: z.number().int().nonnegative(),
              unassigned: z.number().int().nonnegative(),
            }),
          }),
        },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const me = req.auth!.userId;
        const [escalated, pending, open, mine, unassigned] = await Promise.all([
          tx.whatsAppThread.count({ where: { status: 'escalated' as never } }),
          tx.whatsAppThread.count({ where: { status: 'pending' as never } }),
          tx.whatsAppThread.count({ where: { status: 'open' as never } }),
          tx.whatsAppThread.count({
            where: {
              assignedToUserId: me,
              status: { in: ['open', 'pending', 'escalated'] as never },
            },
          }),
          tx.whatsAppThread.count({
            where: { assignedToUserId: null, status: { in: ['pending', 'escalated'] as never } },
          }),
        ]);
        return { data: { escalated, pending, open, mine, unassigned } };
      }),
  );

  // ---------- GET /inbox/threads/:id -----------------------------------
  r.get(
    '/inbox/threads/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Get one thread by id.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const t = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            whatsAppChannel: { select: { label: true, displayPhoneNumber: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        if (!t) throw notFound('Thread not found.');
        const flags = await tx.contact.findFirst({
          where: {
            organizationId: req.auth!.organizationId,
            deletedAt: null,
            phoneE164: toE164(t.customerPhone),
          },
          select: { blockedAt: true, optedOutAt: true },
        });
        return {
          data: serializeThread({
            ...t,
            blocked: !!flags?.blockedAt,
            optedOut: !!flags?.optedOutAt,
          }),
        };
      }),
  );

  // ---------- GET /inbox/threads/:id/messages --------------------------
  r.get(
    '/inbox/threads/:id/messages',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Message history for a thread (chronological, recent-first paged).',
        params: z.object({ id: uuidSchema }),
        // `before` = load the page of messages OLDER than this ISO timestamp
        // (for "load earlier messages"). Omitted = the most recent page.
        querystring: z.object({
          before: z.string().datetime().optional(),
          // Default 1000 so the initial open shows the full conversation for
          // virtually every thread in one load; "load earlier" pages beyond.
          limit: z.coerce.number().int().min(1).max(1000).default(1000),
        }),
        response: { 200: listEnvelopeSchema(messageDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        // Opening a thread (loading the most recent page) marks it read.
        if (!req.query.before) {
          await tx.whatsAppThread
            .updateMany({ where: { id: req.params.id }, data: { lastReadAt: new Date() } })
            .catch(() => undefined);
        }
        // Fetch the most RECENT `limit` messages (older than `before` if
        // paging back), then reverse to chronological order for display.
        // Previously this used `orderBy: asc, take: 500`, returning the OLDEST
        // 500 — so on any thread with >500 messages the recent conversation
        // silently vanished from the chat view (the nav preview still showed
        // the latest message, hence "it answered but doesn't appear in the
        // chat"). The "Boss" thread had 625. We fetch one extra row to know
        // whether older messages remain (nextCursor) so the UI can page back
        // through the FULL history of any size of thread.
        const limit = req.query.limit;
        const rows = await tx.whatsAppMessage.findMany({
          where: {
            threadId: req.params.id,
            ...(req.query.before ? { receivedAt: { lt: new Date(req.query.before) } } : {}),
          },
          orderBy: { receivedAt: 'desc' },
          take: limit + 1,
        });
        const hasOlder = rows.length > limit;
        const page = hasOlder ? rows.slice(0, limit) : rows;
        const messages = page.reverse();
        // Cursor for the NEXT (older) page = the oldest message in this page.
        const olderCursor =
          hasOlder && messages.length > 0 ? messages[0]!.receivedAt.toISOString() : null;

        // ---- Inline image URLs ------------------------------------------
        // Turn each image message into a signed, directly-loadable Wasabi URL
        // so the chat renders the actual picture instead of an "[image]" tag.
        // The URL loads straight from Wasabi (CSP allows *.wasabisys.com), so
        // there's no API-auth-in-<img> problem and no new data surface — the
        // signature IS the (short-lived) capability. Sources, in priority:
        //   1. a stored Asset (operator-sent media + downloaded inbound), via
        //      mediaAssetId;
        //   2. a storageKey stamped on the rawPayload (bot images, going fwd);
        //   3. older bot images: the product image looked up by SKU, or the
        //      greeting image from the bot config.
        // Media bubbles whose file we presign a GET URL for: images AND voice
        // notes (audio). Audio carries only mediaAssetId (no SKU/greeting
        // fallback), so it just hits the stored-asset path below.
        const imageMsgs = messages.filter((m) => {
          const t = (m.messageType ?? '').toLowerCase();
          // Video + document join images/voice: the webhook now stores them, so
          // the inbox can play the clip / link the file.
          return (
            t === 'image' ||
            t === 'audio' ||
            t === 'voice' ||
            t === 'sticker' ||
            t === 'video' ||
            t === 'document'
          );
        });
        const mediaUrlByMsgId = new Map<string, string>();
        if (imageMsgs.length > 0) {
          const { presignGetUrl } = await import('../../lib/storage.js');
          const rawOf = (m: (typeof imageMsgs)[number]) =>
            (m.rawPayload ?? null) as
              | { storageKey?: unknown; sku?: unknown; kind?: unknown }
              | null;

          // 1. Stored assets.
          const assetIds = Array.from(
            new Set(imageMsgs.map((m) => m.mediaAssetId).filter((x): x is string => !!x)),
          );
          const assets = assetIds.length
            ? await tx.asset.findMany({
                where: { id: { in: assetIds } },
                select: { id: true, storageKey: true },
              })
            : [];
          const keyByAssetId = new Map(assets.map((a) => [a.id, a.storageKey]));

          // 3a. Older bot images by SKU → primary product image's storageKey.
          const skus = Array.from(
            new Set(
              imageMsgs
                .map(rawOf)
                .filter(
                  (r): r is { sku: string } =>
                    !!r && typeof r.sku === 'string' && typeof r.storageKey !== 'string',
                )
                .map((r) => r.sku),
            ),
          );
          const keyBySku = new Map<string, string>();
          if (skus.length) {
            const prods = await tx.product.findMany({
              where: { sku: { in: skus } },
              select: {
                sku: true,
                images: {
                  select: { asset: { select: { storageKey: true } } },
                  orderBy: { isPrimary: 'desc' },
                  take: 1,
                },
              },
            });
            for (const p of prods) {
              const k = p.images[0]?.asset?.storageKey;
              if (k) keyBySku.set(p.sku, k);
            }
          }

          // 3b. Greeting image storageKey from the bot config (older greeting
          // images stored only `kind:'greeting'` without the key).
          let greetingKey: string | null = null;
          if (
            imageMsgs.some((m) => {
              const r = rawOf(m);
              return r?.kind === 'greeting' && typeof r.storageKey !== 'string';
            })
          ) {
            const cfg = await tx.botConfig.findFirst({
              select: { greetingImageStorageKey: true },
            });
            greetingKey = cfg?.greetingImageStorageKey ?? null;
          }

          await Promise.all(
            imageMsgs.map(async (m) => {
              const r = rawOf(m);
              let key: string | null = null;
              if (m.mediaAssetId && keyByAssetId.has(m.mediaAssetId)) {
                key = keyByAssetId.get(m.mediaAssetId)!;
              } else if (r && typeof r.storageKey === 'string') {
                key = r.storageKey;
              } else if (r && typeof r.sku === 'string' && keyBySku.has(r.sku)) {
                key = keyBySku.get(r.sku)!;
              } else if (r && r.kind === 'greeting' && greetingKey) {
                key = greetingKey;
              }
              if (key) {
                try {
                  mediaUrlByMsgId.set(m.id, await presignGetUrl(key, 24 * 3600));
                } catch {
                  /* storage unconfigured / sign failure → fall back to tag */
                }
              }
            }),
          );
        }

        // Template messages: (1) render legacy name-only bodies from the current
        // template definition; (2) resolve the header media (IMAGE/VIDEO/DOCUMENT)
        // into a Wasabi-backed, CSP-safe URL (Meta's header_handle is CSP-blocked
        // + expires) — cached on the template after the first fetch.
        const tplNameOf = (mm: {
          messageType: string | null;
          body: string | null;
          rawPayload: unknown;
        }): string | null => {
          const r = (mm.rawPayload ?? null) as { templateName?: unknown } | null;
          if (r && typeof r.templateName === 'string') return r.templateName;
          return mm.messageType === 'template' &&
            mm.body &&
            !mm.body.includes('\n') &&
            !mm.body.startsWith('📨')
            ? mm.body
            : null;
        };
        const tplNames = [
          ...new Set(
            messages
              .filter((m) => m.messageType === 'template')
              .map((m) => tplNameOf(m))
              .filter((x): x is string => !!x),
          ),
        ];
        const legacyByName = new Map<
          string,
          { body: string; quickReplies: string[]; headerImageUrl: string | null }
        >();
        const headerMediaByName = new Map<string, { url: string; type: string }>();
        if (tplNames.length > 0) {
          const { presignGetUrl, putObject, buildStorageKey, isStorageConfigured } = await import(
            '../../lib/storage.js'
          );
          const { safeFetch } = await import('../../lib/safe-fetch.js');
          const { randomUUID } = await import('node:crypto');
          const tpls = await tx.whatsAppTemplate.findMany({
            where: { name: { in: tplNames } },
            select: {
              id: true,
              organizationId: true,
              name: true,
              language: true,
              bodyText: true,
              components: true,
              headerMediaStorageKey: true,
              headerMediaType: true,
            },
          });
          for (const t of tpls) {
            if (!legacyByName.has(t.name)) {
              legacyByName.set(t.name, renderLegacyTemplate(t.components, t.bodyText, t.name, t.language));
            }
            if (headerMediaByName.has(t.name)) continue;
            if (t.headerMediaStorageKey && t.headerMediaType) {
              try {
                headerMediaByName.set(t.name, {
                  url: await presignGetUrl(t.headerMediaStorageKey, 24 * 3600),
                  type: t.headerMediaType,
                });
              } catch {
                /* sign failure → skip */
              }
              continue;
            }
            const comps = Array.isArray(t.components)
              ? (t.components as Record<string, unknown>[])
              : [];
            const header = comps.find(
              (c) => String((c as { type?: string }).type ?? '').toUpperCase() === 'HEADER',
            ) as { format?: string; example?: { header_handle?: string[] } } | undefined;
            const fmt = String(header?.format ?? '').toUpperCase();
            const handle = header?.example?.header_handle?.[0];
            if (
              !['IMAGE', 'VIDEO', 'DOCUMENT'].includes(fmt) ||
              typeof handle !== 'string' ||
              !isStorageConfigured()
            ) {
              continue;
            }
            try {
              const res = await safeFetch(handle);
              if (!res.ok) continue;
              const buf = Buffer.from(await res.arrayBuffer());
              const ct =
                res.headers.get('content-type') ??
                (fmt === 'IMAGE' ? 'image/jpeg' : 'application/octet-stream');
              const type = fmt.toLowerCase();
              const ext = fmt === 'IMAGE' ? '.jpg' : fmt === 'VIDEO' ? '.mp4' : '.pdf';
              const storageKey = buildStorageKey({
                organizationId: t.organizationId,
                kind: 'template-header',
                assetId: randomUUID(),
                filename: `header${ext}`,
              });
              await putObject({ storageKey, body: buf, contentType: ct });
              await tx.whatsAppTemplate.update({
                where: { id: t.id },
                data: { headerMediaStorageKey: storageKey, headerMediaType: type },
              });
              headerMediaByName.set(t.name, {
                url: await presignGetUrl(storageKey, 24 * 3600),
                type,
              });
            } catch {
              /* best-effort: text + buttons still render */
            }
          }
        }

        return {
          data: messages.map((m) => {
            const raw = (m.rawPayload ?? null) as
              | {
                  sentBy?: unknown;
                  kind?: unknown;
                  sku?: unknown;
                  quickReplies?: unknown;
                  headerImageUrl?: unknown;
                  location?: {
                    latitude?: unknown;
                    longitude?: unknown;
                    name?: unknown;
                    address?: unknown;
                  };
                }
              | null;
            const quickReplies =
              raw && Array.isArray(raw.quickReplies)
                ? raw.quickReplies.filter((x): x is string => typeof x === 'string')
                : null;
            // Resolve template header media to a Wasabi-backed URL (+ type) for
            // both new and legacy template messages; never use the CSP-blocked
            // Meta scontent URL directly.
            const resolvedName = tplNameOf(m);
            const media = resolvedName ? headerMediaByName.get(resolvedName) ?? null : null;
            const headerImageUrl = media ? media.url : null;
            const headerMediaType = media ? media.type : null;
            // Legacy name-only template rows → render body/buttons from the definition.
            const legacy =
              m.messageType === 'template' &&
              m.body &&
              !m.body.includes('\n') &&
              !m.body.startsWith('📨')
                ? legacyByName.get(m.body) ?? null
                : null;
            const sentByRaw = raw && typeof raw.sentBy === 'string' ? raw.sentBy : null;
            const sentBy: 'bot' | 'operator' | null =
              m.direction === 'outbound'
                ? sentByRaw === 'bot'
                  ? 'bot'
                  : 'operator'
                : null;
            // Phase 8 / 1.5 — derive imageSource from the rawPayload the
            // bot send paths write. The 3095 image-attach path sets
            // either `kind: 'greeting'` (greeting image) or `sku: '...'`
            // (product image). Non-bot or non-image rows return null.
            let imageSource: { kind: 'greeting' | 'product'; productSku: string | null } | null =
              null;
            if (m.direction === 'outbound' && sentByRaw === 'bot' && m.messageType === 'image') {
              if (raw && raw.kind === 'greeting') {
                imageSource = { kind: 'greeting', productSku: null };
              } else if (raw && typeof raw.sku === 'string') {
                imageSource = { kind: 'product', productSku: raw.sku };
              }
            }
            // Inbound shared-location → surface the coordinates so the inbox can
            // render a map link. Meta's inbound shape is m.location =
            // { latitude, longitude, name?, address? }, stored verbatim on
            // rawPayload. Guard on finite numbers so a malformed payload is
            // treated as no-location rather than crashing the DTO.
            let location: {
              latitude: number;
              longitude: number;
              name: string | null;
              address: string | null;
            } | null = null;
            if (m.messageType === 'location' && raw && raw.location) {
              const lat = Number(raw.location.latitude);
              const lng = Number(raw.location.longitude);
              if (Number.isFinite(lat) && Number.isFinite(lng)) {
                location = {
                  latitude: lat,
                  longitude: lng,
                  name: typeof raw.location.name === 'string' ? raw.location.name : null,
                  address: typeof raw.location.address === 'string' ? raw.location.address : null,
                };
              }
            }
            return {
              id: m.id,
              direction: m.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const),
              metaMessageId: m.metaMessageId,
              fromNumber: m.fromNumber,
              toNumber: m.toNumber,
              messageType: m.messageType,
              body: legacy ? legacy.body : m.body,
              receivedAt: m.receivedAt.toISOString(),
              sentBy,
              imageSource,
              mediaUrl: mediaUrlByMsgId.get(m.id) ?? null,
              quickReplies: legacy
                ? legacy.quickReplies.length
                  ? legacy.quickReplies
                  : null
                : quickReplies && quickReplies.length
                  ? quickReplies
                  : null,
              headerImageUrl,
              headerMediaType,
              deliveryStatus:
                m.direction === 'outbound' &&
                (m.metaStatus === 'sent' ||
                  m.metaStatus === 'delivered' ||
                  m.metaStatus === 'read' ||
                  m.metaStatus === 'failed')
                  ? (m.metaStatus as 'sent' | 'delivered' | 'read' | 'failed')
                  : null,
              durationSeconds: m.durationSeconds ?? null,
              location,
            };
          }),
          nextCursor: olderCursor,
        };
      }),
  );

  // ---------- PATCH /inbox/threads/:id ---------------------------------
  // Update status / customerName / assignedToUserId. Assigning to a
  // non-member of the org is rejected.
  r.patch(
    '/inbox/threads/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Update thread status, customer name, or assignee.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          status: threadStatusSchema.optional(),
          customerName: z.string().trim().max(120).nullable().optional(),
          assignedToUserId: uuidSchema.nullable().optional(),
          // Phase 6 — per-thread bot reply-mode override. NULL clears
          // the override and inherits BotConfig.replyMode again.
          botReplyMode: z.enum(['text', 'voice', 'match_customer']).nullable().optional(),
        }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      // Post-commit side effects (assignment notification + SSE sound frame) —
      // collected inside the tx, executed only after it commits.
      const sideEffects: Array<() => void> = [];
      const result = await app.tenant(req, async (tx) => {
        const current = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          select: { status: true, assignedToUserId: true, customerName: true, customerPhone: true },
        });
        if (!current) throw notFound('Thread not found.');
        // Opt-in (owner directive 2026-08-29): the teamwork behaviours
        // (permission matrix + assignment notes/notifications) apply only
        // when HQ enabled inbox_teamwork — otherwise pre-roadmap behaviour.
        const orgRow = await tx.organization.findUnique({
          where: { id: orgId },
          select: { disabledFeatures: true },
        });
        const teamworkOn = !(orgRow?.disabledFeatures ?? []).includes('inbox_teamwork');
        if (req.body.assignedToUserId) {
          const m = await tx.membership.findFirst({
            where: { userId: req.body.assignedToUserId, isActive: true },
          });
          if (!m) {
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              'Cannot assign to a user who is not an active member of this organization.',
            );
          }
        }
        // Permission matrix (F3): editors may CLAIM an unassigned thread for
        // themselves or RELEASE their own thread back to the AI. Assigning
        // someone else, or touching a thread that belongs to another agent
        // (steal/unassign), is admin-only.
        const target = req.body.assignedToUserId;
        const assigneeChanging = target !== undefined && target !== current.assignedToUserId;
        if (teamworkOn && assigneeChanging && req.auth!.role !== 'admin') {
          const me = req.auth!.userId;
          const claimingForSelf = target === me && current.assignedToUserId === null;
          const releasingSelf = target === null && current.assignedToUserId === me;
          if (!claimingForSelf && !releasingSelf) {
            throw forbidden(
              ApiErrorCode.FORBIDDEN,
              'Only an admin can reassign a conversation that is assigned to someone else.',
            );
          }
        }
        // Auto-clear the "escalated" flag when an operator takes the
        // chat back. Triggers: (a) explicitly setting status to
        // anything else, (b) assigning a user when status was
        // escalated. This is what makes the sidebar Inbox badge
        // decrement immediately when someone picks up the chat
        // instead of waiting for the operator to also manually flip
        // the status dropdown.
        let resolvedStatus = (req.body.status as never) ?? undefined;
        if (resolvedStatus === undefined && req.body.assignedToUserId && current.status === 'escalated') {
          resolvedStatus = 'open' as never;
        }

        const updated = await tx.whatsAppThread.update({
          where: { id: req.params.id },
          data: {
            status: resolvedStatus,
            customerName:
              req.body.customerName === undefined ? undefined : req.body.customerName,
            assignedToUserId:
              req.body.assignedToUserId === undefined ? undefined : req.body.assignedToUserId,
            botReplyMode:
              req.body.botReplyMode === undefined ? undefined : req.body.botReplyMode,
          },
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        // When the operator renames a thread, mirror the change onto the
        // Contact row that shares this phone (creating the contact if
        // missing) so /contacts stays in sync — operators can edit
        // either page and the other reflects it immediately.
        if (req.body.customerName !== undefined && updated.customerPhone) {
          const phoneE164 = updated.customerPhone.startsWith('+')
            ? updated.customerPhone
            : `+${updated.customerPhone}`;
          await tx.contact.upsert({
            where: {
              organizationId_phoneE164: { organizationId: orgId, phoneE164 },
            },
            create: {
              organizationId: orgId,
              phoneE164,
              displayName: req.body.customerName,
              source: 'inbox_auto',
            },
            update: { displayName: req.body.customerName },
          }).catch(() => undefined);
        }
        // System note + (post-commit) notification/sound on a real assignee
        // change. Self-claims still get the note; the runner itself skips
        // notifying the actor about their own action.
        if (teamworkOn && assigneeChanging) {
          sideEffects.push(await recordAssignmentChange({
            tx,
            orgId,
            threadId: updated.id,
            actorUserId: req.auth!.userId,
            prevAssigneeId: current.assignedToUserId,
            newAssigneeId: target ?? null,
            customerLabel: updated.customerName || updated.customerPhone,
          }));
        }
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_thread',
          entityId: updated.id,
          metadata: { event: 'thread_updated', fields: Object.keys(req.body) },
        });
        const dto = serializeThread(updated);
        publishInboxEvent(orgId); // push status/assignment changes instantly
        return { data: dto };
      });
      for (const fn of sideEffects) fn();
      // F2 — the operator resolving a conversation is the CSAT trigger. Fire
      // and forget AFTER commit; every eligibility guard (feature gate, tenant
      // toggle, 24h window, opt-out, one-ask-per-thread, 30-day throttle)
      // lives inside the helper, and it never throws.
      if (req.body.status === 'resolved') {
        void maybeAskFeedback({ organizationId: orgId, threadId: req.params.id, log: req.log });
      }
      return result;
    },
  );

  // ---------- POST /inbox/threads/:id/reply  (operator manual reply) ------
  // Channel-aware send. WhatsApp replies still go through /whatsapp/send (the
  // UI routes those there); this handles Messenger + Instagram threads via the
  // Page Send API. Persists the outbound + bumps the thread.
  r.post(
    '/inbox/threads/:id/reply',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Send an operator reply on a Messenger/Instagram thread.',
        params: z.object({ id: uuidSchema }),
        body: z.object({ body: z.string().trim().min(1).max(4000) }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const thread = await app.tenant(req, (tx) =>
        tx.whatsAppThread.findUnique({ where: { id: req.params.id } }),
      );
      if (!thread) throw notFound('Thread not found.');
      if (thread.channel === 'whatsapp') {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Use /whatsapp/send for WhatsApp threads.');
      }
      // Per-channel access control: if super-admin turned this channel off,
      // operators can't send on it either (inbound is still stored + visible).
      if (thread.channel === 'messenger' || thread.channel === 'instagram') {
        const org = await app.tenant(req, (tx) =>
          tx.organization.findUnique({
            where: { id: orgId },
            select: { disabledFeatures: true },
          }),
        );
        if (org?.disabledFeatures?.includes(thread.channel)) {
          throw badRequest(
            ApiErrorCode.FEATURE_DISABLED,
            `${thread.channel === 'instagram' ? 'Instagram' : 'Messenger'} is turned off for this workspace.`,
          );
        }
      }
      const recipient = thread.channelUserId ?? thread.customerPhone;
      const { sendMessengerText } = await import('../../lib/messenger-send.js');
      const metaId = await sendMessengerText(orgId, recipient, req.body.body, req.log);
      if (metaId === null) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Send failed — check the Messenger channel is connected and active.',
        );
      }
      await app.tenant(req, async (tx) => {
        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: orgId,
            channel: thread.channel,
            direction: 'outbound',
            metaMessageId: metaId,
            toNumber: recipient,
            messageType: 'text',
            body: req.body.body,
            rawPayload: { sentBy: 'operator' } as never,
          },
        });
        await tx.whatsAppThread.update({
          where: { id: thread.id },
          data: {
            lastMessageAt: new Date(),
            lastMessagePreview: req.body.body.slice(0, 200),
            outboundCount: { increment: 1 },
            status: 'open',
            // A human is now handling this chat — claim it for the replying
            // operator so the bot PAUSES (the reply path gates on
            // assignedToUserId). The operator clicks "AI" in the inbox to hand
            // it back when they're done. Without this the bot would resume and
            // talk over the human on the next customer message.
            assignedToUserId: req.auth!.userId,
          },
        });
      });
      publishInboxEvent(orgId); // push the operator reply to the inbox instantly
      return { ok: true as const };
    },
  );

  // ---------- POST /inbox/threads/:id/auto-assign ----------------------
  // Pick the next active org member who has the fewest open threads.
  // Skill-aware: if the thread carries `requiredSkill`, only members
  // whose `skills[]` includes it are eligible. Falls back to all active
  // members if no one has the skill (with a clear error message instead
  // of silently dumping it on a random agent).
  r.post(
    '/inbox/threads/:id/auto-assign',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Auto-assign this thread to the lightest-loaded eligible member (skill-aware).',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const sideEffects: Array<() => void> = [];
      const result = await app.tenant(req, async (tx) => {
        const thread = await tx.whatsAppThread.findUnique({ where: { id: req.params.id } });
        if (!thread) throw notFound('Thread not found.');

        const candidates = await tx.membership.findMany({
          where: {
            isActive: true,
            ...(thread.requiredSkill ? { skills: { has: thread.requiredSkill } } : {}),
          },
          select: { userId: true, createdAt: true, skills: true },
        });
        if (candidates.length === 0) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            thread.requiredSkill
              ? `No active members carry the "${thread.requiredSkill}" skill. Add it on /members or clear the thread's required skill.`
              : 'No active members to assign.',
          );
        }
        const loads = await Promise.all(
          candidates.map(async (m) => ({
            userId: m.userId,
            joinedAt: m.createdAt,
            load: await tx.whatsAppThread.count({
              where: { assignedToUserId: m.userId, status: { in: ['open', 'pending'] as never } },
            }),
          })),
        );
        loads.sort((a, b) => a.load - b.load || a.joinedAt.getTime() - b.joinedAt.getTime());
        const next = loads[0]!;
        const updated = await tx.whatsAppThread.update({
          where: { id: req.params.id },
          data: { assignedToUserId: next.userId },
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        const aaOrg = await tx.organization.findUnique({
          where: { id: req.auth!.organizationId },
          select: { disabledFeatures: true },
        });
        const aaTeamworkOn = !(aaOrg?.disabledFeatures ?? []).includes('inbox_teamwork');
        if (aaTeamworkOn && next.userId !== thread.assignedToUserId) {
          sideEffects.push(await recordAssignmentChange({
            tx,
            orgId: req.auth!.organizationId,
            threadId: updated.id,
            actorUserId: req.auth!.userId,
            prevAssigneeId: thread.assignedToUserId,
            newAssigneeId: next.userId,
            customerLabel: updated.customerName || updated.customerPhone,
            auto: true,
          }));
        }
        return { data: serializeThread(updated) };
      });
      for (const fn of sideEffects) fn();
      publishInboxEvent(req.auth!.organizationId);
      return result;
    },
  );

  // ---------- DELETE /inbox/threads/:id --------------------------------
  // Hard-delete the thread + all its messages + provenance + notes + tags.
  // Bookings + carts that referenced this thread keep their rows but get
  // their thread_id set to NULL (FK behaviour) — those are business records
  // we don't want to silently drop.
  //
  // The customer disappears from the inbox immediately. Their next inbound
  // WhatsApp message will create a brand-new thread row via the webhook's
  // upsert, so this is a non-destructive "kick from inbox" operation as
  // far as the customer relationship goes.
  r.delete(
    '/inbox/threads/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Permanently delete a thread + its messages. Customer reappears on next inbound.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const thread = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          select: { id: true, customerPhone: true, customerName: true },
        });
        if (!thread) throw notFound('Thread not found.');
        // Delete messages first because the FK from whatsapp_messages.thread_id
        // is ON DELETE SET NULL — leaving them in place would orphan rows
        // that the operator clearly meant to discard. Cascade on the message
        // table handles message_provenances rows automatically.
        await tx.whatsAppMessage.deleteMany({ where: { threadId: req.params.id } });
        // CASCADE handles whatsapp_notes + whatsapp_thread_tags.
        // SET NULL preserves bookings + carts as standalone records.
        await tx.whatsAppThread.delete({ where: { id: req.params.id } });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_thread',
          entityId: thread.id,
          metadata: {
            event: 'thread_deleted',
            customerPhone: thread.customerPhone,
            customerName: thread.customerName,
          },
        });
        return { ok: true as const };
      }),
  );

  // ---------- DELETE /inbox/threads/:id/purge --------------------------
  // "Delete this person from contacts + their chat + everything." Removes the
  // conversation(s) AND the contact record AND the AI's memory of them. More
  // destructive than the plain thread delete (which keeps the contact), so it
  // requires admin. Orders/bookings are PRESERVED as standalone business
  // records (their threadId is SET NULL), matching the plain delete.
  r.delete(
    '/inbox/threads/:id/purge',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Delete the conversation AND the contact (+ AI memory). Everything about this person.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const thread = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          select: { id: true, customerPhone: true, customerName: true },
        });
        if (!thread) throw notFound('Thread not found.');
        // Threads store the phone WITHOUT a leading "+", contacts WITH it —
        // match every variant so we catch the contact + memory + any sibling
        // threads (e.g. multi-number WhatsApp).
        const raw = thread.customerPhone;
        const digits = raw.replace(/[^0-9]/g, '');
        const phones = Array.from(new Set([raw, digits, `+${digits}`].filter(Boolean)));

        // 1) The chat(s): delete messages first (FK is SET NULL), then threads
        //    (CASCADE clears notes + tags).
        const threads = await tx.whatsAppThread.findMany({
          where: { customerPhone: { in: phones } },
          select: { id: true },
        });
        const threadIds = threads.map((t) => t.id);
        if (threadIds.length) {
          await tx.whatsAppMessage.deleteMany({ where: { threadId: { in: threadIds } } });
          await tx.whatsAppThread.deleteMany({ where: { id: { in: threadIds } } });
        }

        // 2) The AI's per-contact memory.
        await tx.contactMemory.deleteMany({ where: { phoneE164: { in: phones } } });

        // 3) The contact record itself (hard delete — remove tags first in case
        //    the FK isn't cascading).
        const contacts = await tx.contact.findMany({
          where: { phoneE164: { in: phones } },
          select: { id: true },
        });
        const contactIds = contacts.map((c) => c.id);
        if (contactIds.length) {
          await tx.contactTag.deleteMany({ where: { contactId: { in: contactIds } } });
          await tx.contact.deleteMany({ where: { id: { in: contactIds } } });
        }

        await recordAudit({
          action: 'contact_deleted',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'contact',
          entityId: contactIds[0] ?? thread.id,
          metadata: {
            event: 'contact_and_chat_purged',
            customerPhone: thread.customerPhone,
            customerName: thread.customerName,
            threadsDeleted: threadIds.length,
            contactsDeleted: contactIds.length,
          },
        });
        return { ok: true as const };
      }),
  );

  // ---------- POST /inbox/threads/:id/reset ----------------------------
  // Wipe the message history but keep the thread row + customer name +
  // assignment metadata. Used when the operator wants to "start a fresh
  // conversation" with the same person without losing their renamed
  // customer name or tags. Counts go back to 0, lastMessagePreview is
  // cleared, status flips to 'open'.
  r.post(
    '/inbox/threads/:id/reset',
    {
      schema: {
        tags: ['inbox'],
        summary: "Clear a thread's chat history. Keeps the thread row, name, and tags.",
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const thread = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          select: { id: true },
        });
        if (!thread) throw notFound('Thread not found.');
        await tx.whatsAppMessage.deleteMany({ where: { threadId: req.params.id } });
        const updated = await tx.whatsAppThread.update({
          where: { id: req.params.id },
          data: {
            inboundCount: 0,
            outboundCount: 0,
            lastMessageAt: new Date(),
            lastMessagePreview: null,
            searchText: '',
            status: 'open' as never,
          },
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: req.auth!.organizationId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_thread',
          entityId: thread.id,
          metadata: { event: 'thread_reset' },
        });
        return { data: serializeThread(updated) };
      }),
  );

  // ---------- PATCH /inbox/threads/:id/required-skill ------------------
  r.patch(
    '/inbox/threads/:id/required-skill',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Set or clear the required skill that auto-assign should match.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          requiredSkill: z
            .string()
            .trim()
            .max(40)
            .regex(/^[a-z0-9_-]+$/i, 'Use letters, numbers, _ or -.')
            .nullable(),
        }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.whatsAppThread.update({
          where: { id: req.params.id },
          data: {
            requiredSkill: req.body.requiredSkill
              ? req.body.requiredSkill.toLowerCase()
              : null,
          },
        });
        return { ok: true as const };
      }),
  );

  // ===================================================================
  // BLOCK / UNBLOCK
  // ===================================================================

  // Block (or unblock) the customer on this thread. Blocking sets blockedAt on
  // the matching Contact (creating it if the inbound landed before a contact
  // row existed). Effect: the bot stops auto-replying AND no outbound message
  // can be sent (enforced in /whatsapp/send + /whatsapp/send-media). Inbound
  // messages still arrive + are stored so the operator keeps full context.
  r.post(
    '/inbox/threads/:id/block',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Block or unblock the customer on this thread (stops the bot + all outbound sends).',
        params: z.object({ id: uuidSchema }),
        body: z.object({ blocked: z.boolean() }),
        response: { 200: itemEnvelopeSchema(threadDtoSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const orgId = req.auth!.organizationId;
        const thread = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          include: {
            assignedTo: { select: { firstName: true, lastName: true, email: true } },
            whatsAppChannel: { select: { label: true, displayPhoneNumber: true } },
            tags: { select: { tag: true } },
            _count: { select: { notes: true } },
          },
        });
        if (!thread) throw notFound('Thread not found.');
        const phoneE164 = toE164(thread.customerPhone);
        const blockedAt = req.body.blocked ? new Date() : null;
        await tx.contact.upsert({
          where: { organizationId_phoneE164: { organizationId: orgId, phoneE164 } },
          create: {
            organizationId: orgId,
            phoneE164,
            source: 'inbox_auto',
            blockedAt,
            displayName: thread.customerName ?? undefined,
            whatsappName: thread.customerWhatsappName ?? undefined,
          },
          update: { blockedAt },
        });
        await recordAudit({
          action: 'contact_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'contact',
          entityId: thread.id,
          metadata: { event: req.body.blocked ? 'blocked' : 'unblocked', via: 'inbox', phoneE164 },
        });
        return { data: serializeThread({ ...thread, blocked: req.body.blocked }) };
      }),
  );

  // ===================================================================
  // TAGS
  // ===================================================================

  r.post(
    '/inbox/threads/:id/tags',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Add a tag to a thread.',
        params: z.object({ id: uuidSchema }),
        body: z.object({ tag: z.string().trim().min(1).max(40) }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const tag = req.body.tag.toLowerCase();
        const orgId = req.auth!.organizationId;
        await tx.whatsAppThreadTag
          .create({
            data: {
              organizationId: orgId,
              threadId: req.params.id,
              tag,
            },
          })
          .catch(() => undefined); // duplicate is fine
        // Mirror to the matching Contact's tag set so /contacts and
        // segment filters see the same labels operators apply in the
        // inbox. Find the thread to discover its phone, find/create
        // the contact (rare case: inbound landed before contact
        // creation), then upsert the contact_tag row.
        const thread = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          select: { customerPhone: true },
        });
        if (thread?.customerPhone) {
          const phoneE164 = thread.customerPhone.startsWith('+')
            ? thread.customerPhone
            : `+${thread.customerPhone}`;
          const contact = await tx.contact.upsert({
            where: {
              organizationId_phoneE164: { organizationId: orgId, phoneE164 },
            },
            create: { organizationId: orgId, phoneE164, source: 'inbox_auto' },
            update: {},
          });
          await tx.contactTag
            .create({
              data: { organizationId: orgId, contactId: contact.id, tag },
            })
            .catch(() => undefined);
        }
        return { ok: true as const };
      }),
  );

  r.delete(
    '/inbox/threads/:id/tags/:tag',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Remove a tag.',
        params: z.object({ id: uuidSchema, tag: z.string().min(1).max(40) }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const tag = decodeURIComponent(req.params.tag).toLowerCase();
        const orgId = req.auth!.organizationId;
        await tx.whatsAppThreadTag.deleteMany({
          where: { threadId: req.params.id, tag },
        });
        // Mirror the removal: pull the contact row for the same phone
        // and delete its matching contact_tag, if any.
        const thread = await tx.whatsAppThread.findUnique({
          where: { id: req.params.id },
          select: { customerPhone: true },
        });
        if (thread?.customerPhone) {
          const phoneE164 = thread.customerPhone.startsWith('+')
            ? thread.customerPhone
            : `+${thread.customerPhone}`;
          const contact = await tx.contact.findUnique({
            where: { organizationId_phoneE164: { organizationId: orgId, phoneE164 } },
            select: { id: true },
          });
          if (contact) {
            await tx.contactTag.deleteMany({
              where: { contactId: contact.id, tag },
            });
          }
        }
        return { ok: true as const };
      }),
  );

  // ===================================================================
  // INTERNAL NOTES
  // ===================================================================

  r.get(
    '/inbox/threads/:id/notes',
    {
      schema: {
        tags: ['inbox'],
        summary: 'List internal notes (visible to org members only).',
        params: z.object({ id: uuidSchema }),
        response: { 200: listEnvelopeSchema(noteDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppNote.findMany({
          where: { threadId: req.params.id },
          orderBy: { createdAt: 'asc' },
        });
        // Hydrate author display name in a second query (cheap; small N).
        const ids = [...new Set(rows.map((r) => r.authorUserId).filter((u): u is string => !!u))];
        const users = ids.length
          ? await tx.user.findMany({
              where: { id: { in: ids } },
              select: { id: true, firstName: true, lastName: true, email: true },
            })
          : [];
        const userMap = new Map(users.map((u) => [u.id, u]));
        return {
          data: rows.map((r) => {
            const u = r.authorUserId ? userMap.get(r.authorUserId) : null;
            return {
              id: r.id,
              authorUserId: r.authorUserId,
              authorName: u
                ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email
                : null,
              authorEmail: u?.email ?? null,
              body: r.body,
              createdAt: r.createdAt.toISOString(),
            };
          }),
          nextCursor: null,
        };
      }),
  );

  r.post(
    '/inbox/threads/:id/notes',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Add an internal note. Never sent to the customer via WhatsApp.',
        params: z.object({ id: uuidSchema }),
        body: z.object({ body: z.string().trim().min(1).max(4000) }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const created = await tx.whatsAppNote.create({
          data: {
            organizationId: req.auth!.organizationId,
            threadId: req.params.id,
            authorUserId: req.auth!.userId,
            body: req.body.body,
          },
        });
        return { data: { id: created.id } };
      }),
  );

  // ===================================================================
  // BOT-TO-HUMAN HANDOFF
  // ===================================================================
  // Marks a thread as `pending`, posts an internal "Bot escalated" note,
  // emits a notification. Authenticated by JWT (an authenticated agent
  // calling it) OR by API key with scope `read:catalog` (a chatbot
  // escalating). For Session 4 we accept JWT-only; chatbot-side handoff
  // can come later when Phase 2's bot runtime calls it.
  r.post(
    '/inbox/threads/:id/handoff',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Hand off a thread from the bot to a human.',
        params: z.object({ id: uuidSchema }),
        body: z.object({ reason: z.string().trim().min(1).max(500).optional() }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const thread = await tx.whatsAppThread.findUnique({ where: { id: req.params.id } });
        if (!thread) throw notFound('Thread not found.');
        await tx.whatsAppThread.update({
          where: { id: thread.id },
          data: { status: 'pending' },
        });
        await tx.whatsAppNote.create({
          data: {
            organizationId: orgId,
            threadId: thread.id,
            authorUserId: req.auth!.userId,
            body: `🤖 → 👤 Bot escalated to human${req.body.reason ? `: ${req.body.reason}` : ''}.`,
          },
        });
        await tx.notification.create({
          data: {
            organizationId: orgId,
            kind: 'generic',
            severity: 'warning',
            title: 'Conversation needs a human',
            body: `Thread with ${thread.customerPhone} was handed off${req.body.reason ? ` (${req.body.reason})` : ''}.`,
            link: '/inbox',
            entityType: 'whatsapp_thread',
            entityId: thread.id,
          },
        });
        return { ok: true as const };
      });
    },
  );

  // ===================================================================
  // AGENT-TYPING PRESENCE
  // ===================================================================
  // When agent A is typing into thread X, the client POSTs /typing every
  // 2 s. Server sets a Redis key with 5 s TTL. Other agents on /inbox SSE
  // see the key in the next tick and render an "agent X is typing…"
  // indicator. We can't surface customer-typing — Meta's WhatsApp Cloud
  // API does not emit typing events for inbound from customers.
  r.post(
    '/inbox/threads/:id/typing',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Heartbeat: this agent is typing in this thread.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const userId = req.auth!.userId;
      const { getRedis } = await import('../../lib/redis.js');
      const redis = getRedis();
      const key = `inbox:typing:${orgId}:${req.params.id}:${userId}`;
      // 5 s TTL — client beats every 2 s. Meta-style timing.
      await redis.set(key, '1', 'EX', 5);
      return { ok: true as const };
    },
  );

  // Returns the set of {userId, displayName} currently typing in a
  // thread. Polled (or read on every SSE tick) by clients viewing that
  // thread. Cheap because we read at most ~10 keys per request.
  r.get(
    '/inbox/threads/:id/typing',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Who is currently typing in this thread (excluding me).',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const me = req.auth!.userId;
      const { getRedis } = await import('../../lib/redis.js');
      const redis = getRedis();
      const pattern = `inbox:typing:${orgId}:${req.params.id}:*`;
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 50);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0' && keys.length < 50);
      const userIds = keys
        .map((k) => k.split(':').pop())
        .filter((u): u is string => !!u && u !== me);
      if (userIds.length === 0) return { data: [] as { userId: string; name: string }[] };
      return app.tenant(req, async (tx) => {
        const users = await tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, lastName: true, email: true },
        });
        return {
          data: users.map((u) => ({
            userId: u.id,
            name:
              [u.firstName, u.lastName].filter(Boolean).join(' ') ||
              u.email.split('@')[0]!,
          })),
        };
      });
    },
  );

  // ===================================================================
  // SSE REALTIME
  // ===================================================================
  // Server-Sent Events stream that ticks every 2s with a tiny "you should
  // refetch" signal. Cheaper than WebSockets, avoids socket.io overhead,
  // and the React Query layer in the client treats the tick as an
  // invalidation trigger so threads + active thread auto-refresh
  // sub-1-second perceived. True bidirectional WebSockets remain a
  // future polish item if the SSE poll proves too coarse.
  r.get(
    '/inbox/sse',
    {
      schema: { tags: ['inbox'], summary: 'SSE: emits a ping every 2s for inbox refresh.' },
      preHandler: [app.requireRole('viewer')],
    },
    async (req, reply) => {
      const orgId = req.auth!.organizationId;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeadersForSse(req),
      });
      reply.raw.write(`retry: 5000\n\n`);
      reply.raw.write(`event: hello\ndata: ${JSON.stringify({ orgId })}\n\n`);
      const myUserId = req.auth!.userId;
      const push = (event?: import('../../lib/inbox-events.js').InboxUserEvent) => {
        try {
          // Targeted per-user frame (F6): only the connection authenticated as
          // the event's target hears about it — this is what drives the
          // portal-wide chime + toast when a conversation is assigned to you.
          if (event && event.targetUserId === myUserId) {
            reply.raw.write(
              `event: notify\ndata: ${JSON.stringify({
                kind: event.kind,
                threadId: event.threadId,
                title: event.title,
                body: event.body ?? null,
              })}\n\n`,
            );
          }
          reply.raw.write(`event: tick\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
        } catch {
          /* socket likely closed */
        }
      };
      // Event-driven: push the instant a message is written for this org.
      const { subscribeInboxEvents } = await import('../../lib/inbox-events.js');
      const unsubscribe = subscribeInboxEvents(orgId, push);
      // Heartbeat — keep-alive through proxies + the refresh cadence for write
      // paths that don't yet publish events (e.g. WhatsApp). Messenger/Instagram
      // + operator replies push instantly via subscribeInboxEvents above, so
      // this 3s tick is just the floor, not the latency for those.
      const interval = setInterval(push, 3000);
      const cleanup = () => {
        clearInterval(interval);
        unsubscribe();
        try {
          reply.raw.end();
        } catch {
          /* noop */
        }
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);
      // Fastify needs us to keep the reply alive; do not return.
      return reply;
    },
  );

  // ===================================================================
  // CANNED RESPONSES
  // ===================================================================

  r.get(
    '/canned-responses',
    {
      schema: {
        tags: ['inbox'],
        summary: 'List canned responses for the org.',
        response: { 200: listEnvelopeSchema(cannedResponseDtoSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.cannedResponse.findMany({ orderBy: { shortcut: 'asc' } });
        return {
          data: rows.map((r) => ({
            id: r.id,
            shortcut: r.shortcut,
            body: r.body,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  r.post(
    '/canned-responses',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Create a canned response. Body supports {first_name}, {phone} variables.',
        body: z.object({
          shortcut: z.string().trim().min(1).max(40),
          body: z.string().trim().min(1).max(4000),
        }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const created = await tx.cannedResponse.create({
          data: {
            organizationId: req.auth!.organizationId,
            shortcut: req.body.shortcut.toLowerCase().replace(/^\/+/, ''),
            body: req.body.body,
          },
        });
        return { data: { id: created.id } };
      }),
  );

  r.patch(
    '/canned-responses/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Update a canned response.',
        params: z.object({ id: uuidSchema }),
        body: z.object({
          shortcut: z.string().trim().min(1).max(40).optional(),
          body: z.string().trim().min(1).max(4000).optional(),
        }),
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.cannedResponse.update({
          where: { id: req.params.id },
          data: {
            shortcut: req.body.shortcut?.toLowerCase().replace(/^\/+/, ''),
            body: req.body.body,
          },
        });
        return { ok: true as const };
      }),
  );

  r.delete(
    '/canned-responses/:id',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Delete a canned response.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        await tx.cannedResponse.deleteMany({ where: { id: req.params.id } });
        return { ok: true as const };
      }),
  );

  // ===================================================================
  // PROVENANCE — Super-admin only. Phase 8 / 1.3.
  //
  // Returns the full audit trail for one outbound bot message:
  //   • inputs we fed the LLM (system prompt body via the snapshot table,
  //     user message, trimmed history, candidate KB ids)
  //   • outputs (citations + hallucinations from the post-LLM scanner)
  //   • LLM call metadata
  //   • dereferenced source rows for the cited products / services / faqs
  //     so the UI can render names without a second hop.
  //
  // Gated by requireSuperAdmin (regular org admins do NOT see this).
  // Uses withRlsBypass so an super-admin can audit any tenant's reply.
  // ===================================================================
  r.get(
    '/inbox/messages/:messageId/provenance',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Super-admin only — fetch the AI message provenance audit trail.',
        params: z.object({ messageId: uuidSchema }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      const { withRlsBypass } = await import('../../lib/db.js');
      const result = await withRlsBypass(async (tx) => {
        const prov = await tx.messageProvenance.findUnique({
          where: { messageId: req.params.messageId },
          include: {
            systemPromptSnapshot: { select: { sha256: true, body: true } },
            message: {
              select: {
                id: true,
                body: true,
                messageType: true,
                receivedAt: true,
                threadId: true,
                organizationId: true,
              },
            },
          },
        });
        if (!prov) return null;
        // Dereference candidate rows so the UI can render names.
        const [products, services, faqs] = await Promise.all([
          prov.candidateProductIds.length > 0
            ? tx.product.findMany({
                where: { id: { in: prov.candidateProductIds } },
                select: { id: true, name: true, sku: true, priceMinor: true, currency: true },
              })
            : Promise.resolve([]),
          prov.candidateServiceIds.length > 0
            ? tx.service.findMany({
                where: { id: { in: prov.candidateServiceIds } },
                select: {
                  id: true,
                  name: true,
                  basePriceMinor: true,
                  currency: true,
                },
              })
            : Promise.resolve([]),
          prov.candidateFaqIds.length > 0
            ? tx.fAQ.findMany({
                where: { id: { in: prov.candidateFaqIds } },
                select: { id: true, question: true, answer: true },
              })
            : Promise.resolve([]),
        ]);
        // Load any existing flag decisions so the UI can show "already
        // marked" state on each hallucination row.
        const decisions = await tx.provenanceFlagDecision.findMany({
          where: { provenanceId: prov.id },
          select: { flagIndex: true, decision: true, decidedAt: true, note: true },
        });
        return { prov, products, services, faqs, decisions };
      });
      if (!result) {
        reply.code(404);
        return { error: { code: ApiErrorCode.NOT_FOUND, message: 'No provenance for this message.' } };
      }
      const { prov, products, services, faqs, decisions } = result;
      return {
        data: {
          messageId: prov.messageId,
          organizationId: prov.organizationId,
          // Inputs
          systemPrompt: {
            sha256: prov.systemPromptSnapshot.sha256,
            body: prov.systemPromptSnapshot.body,
          },
          userPrompt: prov.userPrompt,
          historyJson: prov.historyJson,
          // Candidate set (with dereferenced rows for the UI)
          candidates: {
            products,
            services,
            faqs,
            policyKinds: prov.candidatePolicyKinds,
            businessInfoFields: prov.businessInfoFields,
          },
          // Outputs
          citations: prov.citations,
          hallucinations: prov.hallucinations,
          // Phase 13 — per-station pipeline trace (received → sent)
          pipelineTimings: prov.pipelineTimings ?? null,
          // Per-flag decisions the operator already made.
          flagDecisions: decisions.map((d) => ({
            flagIndex: d.flagIndex,
            decision: d.decision as 'false_positive' | 'true_positive' | 'skip',
            decidedAt: d.decidedAt.toISOString(),
            note: d.note,
          })),
          // LLM call metadata
          model: prov.model,
          temperature: prov.temperature,
          promptTokens: prov.promptTokens,
          completionTokens: prov.completionTokens,
          latencyMs: prov.latencyMs,
          createdAt: prov.createdAt.toISOString(),
          message: prov.message
            ? {
                id: prov.message.id,
                body: prov.message.body,
                messageType: prov.message.messageType,
                receivedAt: prov.message.receivedAt.toISOString(),
                threadId: prov.message.threadId,
              }
            : null,
        },
      };
    },
  );

  // ---------- GET /inbox/threads/flagged-summary -----------------------
  // Returns a Map<threadId, hallucinationCount> across all open threads.
  // Used by the inbox list to render the per-thread red-dot when an
  // super-admin opens /inbox. One round-trip; no N+1.
  r.get(
    '/inbox/threads/flagged-summary',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Super-admin only — per-thread hallucination counts for the inbox list.',
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      void req;
      const { withRlsBypass } = await import('../../lib/db.js');
      const rows = await withRlsBypass(async (tx) => {
        return tx.$queryRaw<{ thread_id: string; flagged_count: bigint }[]>`
          SELECT
            m.thread_id::text AS thread_id,
            COUNT(*)::bigint AS flagged_count
          FROM message_provenances p
          JOIN whatsapp_messages m ON m.id = p.message_id
          WHERE jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) > 0
            AND m.thread_id IS NOT NULL
          GROUP BY m.thread_id
        `;
      });
      return {
        data: rows.map((r) => ({
          threadId: r.thread_id,
          flaggedCount: Number(r.flagged_count),
        })),
      };
    },
  );

  // ---------- GET /inbox/threads/:id/flagged-counts --------------------
  // Returns the count of message_provenances with non-empty hallucinations
  // on this thread. Used by the inbox list to render the red-dot badge
  // when threads have flagged bot replies. Super-admin only.
  r.get(
    '/inbox/threads/:id/flagged-counts',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Super-admin only — count of bot replies on this thread with hallucination flags.',
        params: z.object({ id: uuidSchema }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req) => {
      const { withRlsBypass } = await import('../../lib/db.js');
      const rows = await withRlsBypass(async (tx) => {
        // Raw SQL: count provenance rows where jsonb_array_length(hallucinations) > 0.
        return tx.$queryRaw<{ flagged_count: bigint; flagged_message_ids: string[] }[]>`
          SELECT
            COALESCE(SUM(CASE WHEN jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) > 0 THEN 1 ELSE 0 END), 0)::bigint AS flagged_count,
            COALESCE(ARRAY_AGG(p.message_id) FILTER (WHERE jsonb_array_length(COALESCE(p.hallucinations, '[]'::jsonb)) > 0), ARRAY[]::uuid[]) AS flagged_message_ids
          FROM message_provenances p
          JOIN whatsapp_messages m ON m.id = p.message_id
          WHERE m.thread_id = ${req.params.id}::uuid
        `;
      });
      const first = rows[0];
      return {
        data: {
          flaggedCount: first ? Number(first.flagged_count) : 0,
          flaggedMessageIds: first ? first.flagged_message_ids : [],
        },
      };
    },
  );

  // ===================================================================
  // Phase 8 / 1.7 — operator feedback loop.
  //
  // POST /inbox/messages/:messageId/flags/:flagIndex/decide
  //
  // super-admin clicks one of the buttons on a hallucination row:
  //   ✓ Not a problem  → decision='false_positive', auto-suppress the
  //                      phrase for this org so the scanner stops
  //                      flagging it on future replies
  //   ⚠ Yes wrong      → decision='true_positive', no suppression
  //   🤷 Skip           → decision='skip', no suppression
  //
  // Upsert by (provenance_id, flag_index) so re-clicking overwrites.
  // ===================================================================
  r.post(
    '/inbox/messages/:messageId/flags/:flagIndex/decide',
    {
      schema: {
        tags: ['inbox'],
        summary: 'Super-admin only — mark a hallucination as fp/tp/skip.',
        params: z.object({
          messageId: uuidSchema,
          flagIndex: z.coerce.number().int().min(0),
        }),
        body: z.object({
          decision: z.enum(['false_positive', 'true_positive', 'skip']),
          note: z.string().trim().max(500).optional(),
        }),
      },
      preHandler: [app.requireSuperAdmin],
    },
    async (req, reply) => {
      const { withRlsBypass } = await import('../../lib/db.js');
      const { normalisePhraseForSuppression } = await import(
        '../../lib/provenance-scanner.js'
      );
      const result = await withRlsBypass(async (tx) => {
        const prov = await tx.messageProvenance.findUnique({
          where: { messageId: req.params.messageId },
          select: { id: true, organizationId: true, hallucinations: true },
        });
        if (!prov) return { error: 'not_found' as const };
        const hals = Array.isArray(prov.hallucinations)
          ? (prov.hallucinations as Array<{ matchedText?: string }>)
          : [];
        const flag = hals[req.params.flagIndex];
        if (!flag) return { error: 'flag_index_out_of_range' as const };
        const flaggedText = String(flag.matchedText ?? '').trim();
        if (!flaggedText) return { error: 'flag_has_no_text' as const };

        // Upsert the decision.
        await tx.provenanceFlagDecision.upsert({
          where: {
            provenanceId_flagIndex: {
              provenanceId: prov.id,
              flagIndex: req.params.flagIndex,
            },
          },
          create: {
            organizationId: prov.organizationId,
            provenanceId: prov.id,
            flagIndex: req.params.flagIndex,
            flaggedText,
            decision: req.body.decision,
            decidedByUserId: req.auth!.userId,
            note: req.body.note ?? null,
          },
          update: {
            decision: req.body.decision,
            decidedByUserId: req.auth!.userId,
            decidedAt: new Date(),
            note: req.body.note ?? null,
          },
        });

        // For false_positive: also create the suppression row so the
        // scanner skips this phrase on future replies. The unique index
        // on (organization_id, phrase) is partial (org_id IS NOT NULL),
        // so we use findFirst + create instead of upsert — duplicate
        // clicks just no-op.
        if (req.body.decision === 'false_positive') {
          const normalised = normalisePhraseForSuppression(flaggedText);
          if (normalised.length > 0) {
            const existing = await tx.provenanceSuppression.findFirst({
              where: { organizationId: prov.organizationId, phrase: normalised },
              select: { id: true },
            });
            if (!existing) {
              await tx.provenanceSuppression.create({
                data: {
                  organizationId: prov.organizationId,
                  phrase: normalised,
                  note: req.body.note ?? 'Marked as not a problem from /inbox',
                  createdByUserId: req.auth!.userId,
                },
              });
            }
          }
        }

        return { ok: true as const };
      });

      if ('error' in result) {
        reply.code(result.error === 'not_found' ? 404 : 400);
        return {
          error: {
            code:
              result.error === 'not_found'
                ? ApiErrorCode.NOT_FOUND
                : ApiErrorCode.VALIDATION_ERROR,
            message: result.error,
          },
        };
      }
      return { ok: true as const };
    },
  );
}
