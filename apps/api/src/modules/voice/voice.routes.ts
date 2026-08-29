// Voice media gateway API — consumed by the Aseer-time voicebot bridge.
//
// Two halves:
//   1. X-Api-Key routes (the voicebot):
//      GET  /voice/config              — compiled realtime persona/grounding
//      POST /voice/calls               — call started (idempotent upsert)
//      POST /voice/calls/:uuid/turns   — append finalized transcript turns
//      POST /voice/calls/:uuid/end     — call ended (outcome + reason)
//   2. JWT portal routes (the dashboard):
//      GET  /voice/calls               — recent calls
//      GET  /voice/calls/:id           — one call with its transcript
//
// The voicebot's client is fire-and-forget with retries, so every write here
// is idempotent and tolerates out-of-order arrival (turns/end before start
// auto-create the call row). The config response is cached in the same Redis
// keyspace as the chatbot read API, so catalog writes invalidate it too.
import {
  ApiErrorCode,
  appendVoiceTurnsBodySchema,
  endVoiceCallBodySchema,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  normalizePhoneNumber,
  startVoiceCallBodySchema,
  submitVoiceBookingBodySchema,
  submitVoiceOrderBodySchema,
  uuidSchema,
  voiceBookingResultSchema,
  voiceCallDetailSchema,
  voiceCallerContextSchema,
  voiceCallSchema,
  voiceCallUuidSchema,
  voiceConfigSchema,
  voiceOrderResultSchema,
  voiceResolveResponseSchema,
} from '@platform/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { canSendAiMessage, recordAiMessages } from '../../lib/ai-messages.js';
import { formatMoney, gatherBotData } from '../../lib/bot-engine.js';
import { computeOpenSlots } from '../../lib/booking-slots.js';

// When a tenant is out of its monthly AI-message allowance, the voicebot is
// handed this brief "unavailable" persona so callers are declined politely
// instead of running (and going further over the cap). Works with the existing
// voicebot — it just speaks whatever instructions it receives.
const VOICE_PAUSED_GREETING = "Sorry, our automated line isn't available right now.";
const VOICE_PAUSED_INSTRUCTIONS =
  'The automated assistant is temporarily unavailable. In the caller\'s language, briefly apologize that you cannot take the call right now and ask them to try again later or contact the business directly, then end the call. Keep it under 20 words. Do not answer any other questions or take any orders.';
import { withRlsBypass, withTenant } from '../../lib/db.js';
import type { Tx } from '../../lib/db.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { readCacheGet, readCacheSet } from '../../lib/read-cache.js';
import { createVoiceBooking } from '../../lib/voice-booking.js';
import { createVoiceOrder } from '../../lib/voice-order.js';
import { compileVoiceConfig } from '../../lib/voice-prompt.js';
import { decodeCursor, encodeCursor } from '../catalog/shared.js';

type VoiceConfigEnvelope = { data: z.infer<typeof voiceConfigSchema> };

// Multi-locale opt-out keywords (mirrors the WhatsApp / Messenger STOP_RE). A
// caller who SAYS a lone "stop" / "unsubscribe" / "إيقاف" on a call opts out of
// follow-up messaging; the end-of-call transcript scan flips optedOutAt.
const STOP_RE =
  /\b(stop|unsubscribe|opt\s*out|إيقاف|اوقف|الغاء|توقف)\b/i;

// A caller phone is usable only if it normalises to a real number. Withheld /
// anonymous caller IDs ("anonymous", "Restricted", "Private", "unknown") strip
// to an empty/too-short string; we must NOT store '' as a customer key (it would
// collide every withheld caller onto one Contact). Falls back to a per-call
// placeholder so the order is still traceable to its call.
function resolveCallerPhone(raw: string | null | undefined, callUuid: string): {
  phone: string;
  withheld: boolean;
} {
  const n = raw ? normalizePhoneNumber(raw) : '';
  if (n.length >= 2) return { phone: n, withheld: false };
  return { phone: `voice_${callUuid.slice(0, 8)}`, withheld: true };
}

// Compile (or fetch from the 60s-fresh / 5min-stale Redis cache) the org's
// realtime voice config. Shared by GET /voice/config (api-key) and
// GET /voice/resolve (gateway) so both serve byte-identical, co-invalidated
// config. The cache key is the same one catalog writes flush.
async function loadVoiceConfig(
  orgId: string,
  log?: { warn: (o: unknown, m?: string) => void },
): Promise<{ value: VoiceConfigEnvelope; cache: 'HIT' | 'STALE' | 'MISS' }> {
  // Per-tenant access control: super-admin can turn the phone/voice
  // integration off. With it off the voicebot gets no persona/config, so it
  // can't operate for this tenant. Checked before the cache so flipping the
  // toggle takes effect immediately.
  const org0 = await withRlsBypass((tx) =>
    tx.organization.findUnique({ where: { id: orgId }, select: { disabledFeatures: true } }),
  );
  if (org0?.disabledFeatures?.includes('phone')) {
    throw forbidden(
      ApiErrorCode.FEATURE_DISABLED,
      'Phone / voice integration is turned off for this organization.',
    );
  }
  const hit = await readCacheGet<VoiceConfigEnvelope>(orgId, 'voice-config', null);
  if (hit && !hit.stale) return { value: hit.value, cache: 'HIT' };
  // Gather grounding (FAQ gate RELAXED for voice — published-only, since a call
  // can't render the public/private distinction) + org name in one tenant tx;
  // booking slots are computed AFTER (computeOpenSlots opens its own tx).
  const gathered = await withTenant(orgId, async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    const data = await gatherBotData(tx, orgId, { includePrivateFaqs: true });
    return { orgName: org?.name ?? 'this business', data };
  });
  let openSlots: string[] = [];
  const av = gathered.data.bookingForm?.availability;
  if (av?.enabled) {
    openSlots = (await computeOpenSlots(orgId, av, new Date(), 8)).map((s) => s.label);
  }
  const compiled = compileVoiceConfig(gathered.data, gathered.orgName, openSlots);
  const { truncatedSections, ...wire } = compiled;
  if (truncatedSections.length > 0 && log) {
    log.warn(
      { orgId, dropped: truncatedSections },
      'voice config exceeded budget; sections dropped',
    );
  }
  const value: VoiceConfigEnvelope = { data: wire };
  await readCacheSet(orgId, 'voice-config', null, value);
  return { value, cache: hit?.stale ? 'STALE' : 'MISS' };
}

// Per-line bot switch (M1): the voicebot calls /voice/config with the LINE's
// API key. If that line has botEnabled=false the AI brain is off for it (the
// line still records calls, but gets no persona). Checked per-request (not
// cached) so toggling takes effect immediately. Returns the line id if found.
async function lineBotGate(apiKeyId: string): Promise<void> {
  const line = await withRlsBypass((tx) =>
    tx.phoneIntegration.findFirst({
      where: { apiKeyId },
      select: { botEnabled: true, isActive: true },
    }),
  );
  if (line && (!line.botEnabled || !line.isActive)) {
    throw forbidden(
      ApiErrorCode.FEATURE_DISABLED,
      'The AI bot is turned off for this phone line.',
    );
  }
}

// Resolved identity for a call-lifecycle write. Two credentials map onto it:
//   • X-Api-Key  → org from the key; line by apiKeyId (attribution).
//   • X-Voice-Gateway-Secret + X-Phone-Integration-Id → org + line from the
//     referenced phone integration (shared gateway mode, cross-tenant).
type VoiceWriteCtx = { orgId: string; phoneIntegrationId: string | null };

async function authenticateVoiceWrite(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<VoiceWriteCtx> {
  const gwRaw = req.headers['x-voice-gateway-secret'];
  const gw = Array.isArray(gwRaw) ? gwRaw[0] : gwRaw;
  if (gw) {
    await app.requireVoiceGateway(req);
    const pidRaw = req.headers['x-phone-integration-id'];
    const pid = Array.isArray(pidRaw) ? pidRaw[0] : pidRaw;
    const parsed = uuidSchema.safeParse(pid);
    if (!parsed.success) {
      throw badRequest(
        ApiErrorCode.VALIDATION_ERROR,
        'Gateway mode requires a valid X-Phone-Integration-Id header.',
      );
    }
    const line = await withRlsBypass((tx) =>
      tx.phoneIntegration.findFirst({
        where: { id: parsed.data, isActive: true },
        select: { id: true, organizationId: true },
      }),
    );
    if (!line) throw notFound('Phone integration not found or inactive.');
    return { orgId: line.organizationId, phoneIntegrationId: line.id };
  }
  // Dedicated single-line mode — the existing X-Api-Key path.
  await app.requireApiKey(req);
  requireScope(req, 'voice:calls');
  const orgId = req.apiKey!.organizationId;
  const line = await withRlsBypass((tx) =>
    tx.phoneIntegration.findFirst({
      where: { apiKeyId: req.apiKey!.id },
      select: { id: true },
    }),
  );
  return { orgId, phoneIntegrationId: line?.id ?? null };
}

// Cumulative ceiling per call. A real phone call produces a few hundred turns
// at most; the cap exists so a leaked voice:calls key cannot grow one call's
// transcript without bound (the per-request zod cap alone doesn't stop a loop).
const MAX_TURNS_PER_CALL = 2000;

function requireScope(req: FastifyRequest, scope: string) {
  if (!req.apiKey?.scopes.includes(scope)) {
    throw forbidden(ApiErrorCode.ROLE_INSUFFICIENT, `API key missing required scope: ${scope}`);
  }
}

// Find-or-create the call row. Turns/end can arrive before the start event
// (the voicebot's queue is best-effort), so ingestion never 404s on a
// missing call — it materializes one with startedAt=now instead.
async function ensureCall(tx: Tx, orgId: string, callUuid: string) {
  return tx.voiceCall.upsert({
    where: { organizationId_callUuid: { organizationId: orgId, callUuid } },
    update: {},
    create: { organizationId: orgId, callUuid, startedAt: new Date() },
    select: { id: true },
  });
}

export default async function voiceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ===========================================================================
  // API-key half — the voicebot bridge
  // ===========================================================================

  // ---------- GET /voice/config ---------------------------------------------
  r.get(
    '/voice/config',
    {
      schema: {
        tags: ['voice'],
        summary:
          'Compiled per-tenant realtime persona + grounding for the voicebot. Cached 60s; invalidated on catalog writes.',
        response: { 200: itemEnvelopeSchema(voiceConfigSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req, reply) => {
      requireScope(req, 'voice:config');
      await lineBotGate(req.apiKey!.id);
      const orgId = req.apiKey!.organizationId;
      const { value, cache } = await loadVoiceConfig(orgId, req.log);
      reply.header('x-cache', cache);
      // Monthly AI-message allowance — when exhausted, decline new calls with a
      // brief "unavailable" persona instead of running the full bot.
      if (!(await canSendAiMessage(orgId))) {
        reply.header('x-ai-paused', '1');
        return {
          data: { ...value.data, instructions: VOICE_PAUSED_INSTRUCTIONS, greeting: VOICE_PAUSED_GREETING },
        };
      }
      return value;
    },
  );

  // ---------- POST /voice/calls ---------------------------------------------
  r.post(
    '/voice/calls',
    {
      schema: {
        tags: ['voice'],
        summary: 'Register a call start. Idempotent on (org, callUuid).',
        body: startVoiceCallBodySchema,
        response: { 201: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
        security: [{ apiKey: [] }],
      },
    },
    async (req, reply) => {
      const { orgId, phoneIntegrationId } = await authenticateVoiceWrite(app, req);
      const b = req.body;
      // Normalise the caller for returning-caller recognition + opt-out gating.
      // Withheld/anonymous callers strip to a too-short string → no Contact (we
      // must NOT key every withheld caller onto phone='').
      const normalized = b.callerId ? normalizePhoneNumber(b.callerId) : '';
      const callerPhoneNormalized = normalized.length >= 2 ? normalized : null;
      const row = await withTenant(orgId, async (tx) => {
        // Auto-upsert a Contact (parity with WhatsApp/Messenger inbound) so the
        // operator block button + /contacts + opt-out work for voice callers too.
        // channel='voice' only on CREATE — an existing WhatsApp contact who calls
        // keeps their channel (and broadcast eligibility).
        let contactId: string | null = null;
        if (callerPhoneNormalized) {
          const contact = await tx.contact.upsert({
            where: {
              organizationId_phoneE164: { organizationId: orgId, phoneE164: callerPhoneNormalized },
            },
            create: {
              organizationId: orgId,
              phoneE164: callerPhoneNormalized,
              channel: 'voice',
              lastInboundAt: new Date(),
              source: 'inbox_auto',
            },
            update: { lastInboundAt: new Date() },
            select: { id: true },
          });
          contactId = contact.id;
        }
        // Never overwrite stored metadata (call records are historical), but
        // DO fill nulls: when turns/end arrived first, ensureCall created the
        // row with no callerId/dialedExten/line and the late start event
        // carries them.
        const call = await tx.voiceCall.upsert({
          where: { organizationId_callUuid: { organizationId: orgId, callUuid: b.callUuid } },
          update: {},
          create: {
            organizationId: orgId,
            callUuid: b.callUuid,
            callerId: b.callerId ?? null,
            callerPhoneNormalized,
            contactId,
            dialedExten: b.dialedExten ?? null,
            phoneIntegrationId,
            startedAt: b.startedAt ? new Date(b.startedAt) : new Date(),
          },
          select: { id: true },
        });
        if (b.callerId != null) {
          await tx.voiceCall.updateMany({
            where: { id: call.id, callerId: null },
            data: { callerId: b.callerId },
          });
        }
        if (callerPhoneNormalized) {
          await tx.voiceCall.updateMany({
            where: { id: call.id, callerPhoneNormalized: null },
            data: { callerPhoneNormalized, contactId },
          });
        }
        if (b.dialedExten != null) {
          await tx.voiceCall.updateMany({
            where: { id: call.id, dialedExten: null },
            data: { dialedExten: b.dialedExten },
          });
        }
        if (phoneIntegrationId != null) {
          await tx.voiceCall.updateMany({
            where: { id: call.id, phoneIntegrationId: null },
            data: { phoneIntegrationId },
          });
          // Best-effort recency stamp for the line (updateMany = no-op if gone).
          await tx.phoneIntegration.updateMany({
            where: { id: phoneIntegrationId },
            data: { lastCallAt: new Date() },
          });
        }
        return call;
      });
      reply.code(201);
      return { data: { id: row.id } };
    },
  );

  // ---------- POST /voice/calls/:callUuid/turns -----------------------------
  r.post(
    '/voice/calls/:callUuid/turns',
    {
      schema: {
        tags: ['voice'],
        summary: 'Append finalized transcript turns to a call.',
        params: z.object({ callUuid: voiceCallUuidSchema }),
        body: appendVoiceTurnsBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ appended: z.number().int() })) },
        security: [{ apiKey: [] }],
      },
    },
    async (req) => {
      const { orgId } = await authenticateVoiceWrite(app, req);
      const { callUuid } = req.params;
      const appended = await withTenant(orgId, async (tx) => {
        const call = await ensureCall(tx, orgId, callUuid);
        const existing = await tx.voiceCallTurn.count({ where: { voiceCallId: call.id } });
        if (existing + req.body.turns.length > MAX_TURNS_PER_CALL) {
          throw conflict(`Call transcript is full (max ${MAX_TURNS_PER_CALL} turns).`);
        }
        // skipDuplicates + the (voiceCallId, seq) unique constraint make a
        // retried batch (committed first attempt, lost response) a no-op.
        const result = await tx.voiceCallTurn.createMany({
          data: req.body.turns.map((t) => ({
            organizationId: orgId,
            voiceCallId: call.id,
            seq: t.seq,
            role: t.role,
            text: t.text,
            at: t.at ? new Date(t.at) : new Date(),
          })),
          skipDuplicates: true,
        });
        return result.count;
      });
      return { data: { appended } };
    },
  );

  // ---------- POST /voice/calls/:callUuid/end -------------------------------
  r.post(
    '/voice/calls/:callUuid/end',
    {
      schema: {
        tags: ['voice'],
        summary: 'Mark a call ended with its outcome.',
        params: z.object({ callUuid: voiceCallUuidSchema }),
        body: endVoiceCallBodySchema,
        response: { 200: itemEnvelopeSchema(z.object({ id: uuidSchema })) },
        security: [{ apiKey: [] }],
      },
    },
    async (req) => {
      const { orgId } = await authenticateVoiceWrite(app, req);
      const { callUuid } = req.params;
      const b = req.body;
      const row = await withTenant(orgId, async (tx) => {
        const call = await ensureCall(tx, orgId, callUuid);
        // Ended calls are immutable history: only the FIRST end event lands;
        // replays (or a hostile key re-posting months later) are no-ops.
        const upd = await tx.voiceCall.updateMany({
          where: { id: call.id, endedAt: null },
          data: {
            outcome: b.outcome,
            handoffReason: b.reason ?? null,
            endedAt: b.endedAt ? new Date(b.endedAt) : new Date(),
          },
        });
        // Count the call's bot turns against the monthly AI-message allowance —
        // ONLY on the first end event (upd.count===1) so replays don't double-count.
        let assistantTurns = 0;
        if (upd.count === 1) {
          assistantTurns = await tx.voiceCallTurn.count({
            where: { voiceCallId: call.id, role: 'assistant' },
          });
        }
        // Compliance (C2): if the caller SAID a lone "stop"/"unsubscribe" during
        // the call, flip the contact's optedOutAt so follow-up bills/broadcasts
        // stay silent. Parity with the WhatsApp/Messenger STOP handling.
        const full = await tx.voiceCall.findUnique({
          where: { id: call.id },
          select: { callerPhoneNormalized: true },
        });
        if (full?.callerPhoneNormalized) {
          const callerTurns = await tx.voiceCallTurn.findMany({
            where: { voiceCallId: call.id, role: 'caller' },
            select: { text: true },
          });
          if (callerTurns.some((t) => STOP_RE.test(t.text))) {
            await tx.contact.updateMany({
              where: {
                organizationId: orgId,
                phoneE164: full.callerPhoneNormalized,
                optedOutAt: null,
              },
              data: { optedOutAt: new Date() },
            });
          }
        }
        return { call, assistantTurns };
      });
      if (row.assistantTurns > 0) void recordAiMessages(orgId, row.assistantTurns);
      return { data: { id: row.call.id } };
    },
  );

  // ---------- POST /voice/calls/:callUuid/order -----------------------------
  // The voicebot's `submit_order` tool. Captures a finalized order into a real
  // Cart ('new') — same as the WhatsApp/Messenger bot — so it lands in /cart and
  // alerts operators. Spoken item names are matched to the catalog server-side.
  r.post(
    '/voice/calls/:callUuid/order',
    {
      schema: {
        tags: ['voice'],
        summary: 'Submit a finalized order captured during a voice call.',
        params: z.object({ callUuid: voiceCallUuidSchema }),
        body: submitVoiceOrderBodySchema,
        response: { 200: itemEnvelopeSchema(voiceOrderResultSchema) },
        security: [{ apiKey: [] }],
      },
    },
    async (req) => {
      const { orgId, phoneIntegrationId } = await authenticateVoiceWrite(app, req);
      const { callUuid } = req.params;
      const b = req.body;

      // Resolve/auto-create the call and load the catalog + shop config. The
      // contact tells us whether to suppress the WhatsApp bill (opt-out).
      const ctx = await withTenant(orgId, async (tx) => {
        const call = await ensureCall(tx, orgId, callUuid);
        const full = await tx.voiceCall.findUnique({
          where: { id: call.id },
          select: { callerId: true, callerPhoneNormalized: true, phoneIntegrationId: true },
        });
        const data = await gatherBotData(tx, orgId);
        const phone = full?.callerPhoneNormalized ?? null;
        const contact = phone
          ? await tx.contact.findFirst({
              where: { organizationId: orgId, phoneE164: phone },
              select: { optedOutAt: true, blockedAt: true },
            })
          : null;
        return {
          callerId: full?.callerId ?? null,
          linePhoneIntegrationId: full?.phoneIntegrationId ?? phoneIntegrationId ?? null,
          data,
          optedOut: !!(contact?.optedOutAt || contact?.blockedAt),
        };
      });

      if (!ctx.data.shopForm) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Ordering is not enabled for this business.');
      }

      // Withheld/anonymous caller → a per-call placeholder, never an empty phone.
      const { phone: callerPhone } = resolveCallerPhone(b.phone ?? ctx.callerId, callUuid);

      const outcome = await createVoiceOrder({
        orgId,
        callUuid,
        callerPhone,
        customerName: b.customerName ?? null,
        items: b.items,
        // Field answers keyed by the tenant's configured shopForm keys — this is
        // the fix: they land in the right operator columns (no synthetic notes).
        fields: b.fields ?? {},
        data: ctx.data,
        phoneIntegrationId: ctx.linePhoneIntegrationId,
        continueExisting: b.continueExisting === true,
        suppressBill: ctx.optedOut,
      });

      if (!outcome.ok) {
        const shop = ctx.data.shopForm;
        if (outcome.reason === 'missing_required') {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            `Missing required detail(s): ${outcome.missing.join(', ')}. Ask the caller for them before confirming.`,
          );
        }
        if (outcome.reason === 'below_min') {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            `Order is below the ${formatMoney(outcome.minOrderMinor, outcome.currency)} minimum (currently ${formatMoney(outcome.subtotalMinor, outcome.currency)}). Ask the caller to add more.`,
          );
        }
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          shop ? 'Could not capture any order items.' : 'Ordering is not enabled for this business.',
        );
      }

      return { data: outcome.result };
    },
  );

  // ---------- POST /voice/calls/:callUuid/booking ---------------------------
  // The voicebot's `submit_booking` tool. Captures a finalized appointment into
  // a real Booking ('new') so it lands in /bookings and alerts operators.
  r.post(
    '/voice/calls/:callUuid/booking',
    {
      schema: {
        tags: ['voice'],
        summary: 'Submit a finalized booking captured during a voice call.',
        params: z.object({ callUuid: voiceCallUuidSchema }),
        body: submitVoiceBookingBodySchema,
        response: { 200: itemEnvelopeSchema(voiceBookingResultSchema) },
        security: [{ apiKey: [] }],
      },
    },
    async (req) => {
      const { orgId } = await authenticateVoiceWrite(app, req);
      const { callUuid } = req.params;
      const b = req.body;

      const ctx = await withTenant(orgId, async (tx) => {
        const call = await ensureCall(tx, orgId, callUuid);
        const full = await tx.voiceCall.findUnique({
          where: { id: call.id },
          select: { callerId: true, callerPhoneNormalized: true },
        });
        const data = await gatherBotData(tx, orgId);
        return { callerId: full?.callerId ?? null, data };
      });

      if (!ctx.data.bookingForm) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Bookings are not enabled for this business.');
      }

      const { phone: callerPhone } = resolveCallerPhone(b.phone ?? ctx.callerId, callUuid);

      const outcome = await createVoiceBooking({
        orgId,
        callUuid,
        callerPhone,
        customerName: b.customerName ?? null,
        fields: b.fields,
        bookingForm: ctx.data.bookingForm,
      });

      if (!outcome.ok) {
        if (outcome.reason === 'missing_required') {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            `Missing required detail(s): ${outcome.missing.join(', ')}. Ask the caller for them before confirming.`,
          );
        }
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Bookings are not enabled for this business.');
      }

      return { data: outcome.result };
    },
  );

  // ---------- GET /voice/caller-context -------------------------------------
  // Per-caller history fetched by the voicebot at call start (it has the caller
  // ID) and injected into the realtime prompt: greet by name, surface an
  // in-progress order to resume, and offer to reorder a recent order. NEVER
  // cached (caller-specific). Also returns opt-out/block so the voicebot can
  // decline to engage an opted-out/blocked caller.
  r.get(
    '/voice/caller-context',
    {
      schema: {
        tags: ['voice'],
        summary: 'Per-caller history (name, open order, recent orders) for the realtime prompt.',
        querystring: z.object({ phone: z.string().trim().min(1).max(40) }),
        response: { 200: itemEnvelopeSchema(voiceCallerContextSchema) },
        security: [{ apiKey: [] }],
      },
      preHandler: [app.requireApiKey],
    },
    async (req) => {
      requireScope(req, 'voice:config');
      const orgId = req.apiKey!.organizationId;
      const phone = normalizePhoneNumber(req.query.phone);
      const empty = {
        known: false,
        name: null,
        optedOut: false,
        blocked: false,
        openOrder: null,
        pastOrders: [],
      };
      if (phone.length < 2) return { data: empty };

      const ctx = await withTenant(orgId, async (tx) => {
        const contact = await tx.contact.findFirst({
          where: { organizationId: orgId, phoneE164: phone },
          select: { displayName: true, whatsappName: true, optedOutAt: true, blockedAt: true },
        });
        const carts = await tx.cart.findMany({
          where: { organizationId: orgId, customerPhone: phone },
          orderBy: { createdAt: 'desc' },
          take: 6,
          include: { items: { select: { name: true, quantity: true } } },
        });
        return { contact, carts };
      });

      const summarize = (items: { name: string; quantity: number }[]) =>
        items
          .map((i) => `${i.quantity}x ${i.name}`)
          .join(', ')
          .slice(0, 200);
      const open =
        ctx.carts.find(
          (c) => (c.status === 'new' || c.status === 'confirmed') && c.paymentStatus !== 'paid',
        ) ?? null;
      const past = ctx.carts.filter((c) => c.id !== open?.id).slice(0, 3);
      const name =
        ctx.contact?.displayName ||
        ctx.contact?.whatsappName ||
        ctx.carts.find((c) => c.customerName)?.customerName ||
        null;

      return {
        data: {
          known: !!ctx.contact || ctx.carts.length > 0,
          name,
          optedOut: !!ctx.contact?.optedOutAt,
          blocked: !!ctx.contact?.blockedAt,
          openOrder: open
            ? {
                itemsSummary: summarize(open.items),
                totalMinor: Number(open.totalMinor),
                currency: open.currency,
                status: open.status,
                createdAt: open.createdAt.toISOString(),
              }
            : null,
          pastOrders: past.map((c) => ({
            itemsSummary: summarize(c.items),
            totalMinor: Number(c.totalMinor),
            currency: c.currency,
            createdAt: c.createdAt.toISOString(),
          })),
        },
      };
    },
  );

  // ---------- GET /voice/resolve --------------------------------------------
  // Shared gateway mode: map an inbound dialed number (DID) to the tenant phone
  // line that owns it + the compiled (org-wide) voice config. Auth is the
  // platform gateway secret, not an org key — this is the one cross-tenant read.
  r.get(
    '/voice/resolve',
    {
      schema: {
        tags: ['voice'],
        summary:
          'Resolve a dialed number to its tenant phone line + compiled voice config (gateway-secret auth).',
        querystring: z.object({ did: z.string().trim().min(1).max(40) }),
        response: { 200: itemEnvelopeSchema(voiceResolveResponseSchema) },
      },
      preHandler: [app.requireVoiceGateway],
    },
    async (req, reply) => {
      const did = normalizePhoneNumber(req.query.did);
      if (did.length < 2) throw notFound('No phone line matches that number.');
      const line = await withRlsBypass((tx) =>
        tx.phoneIntegration.findFirst({
          where: { phoneNumber: did, isActive: true },
          select: { id: true, organizationId: true, botEnabled: true },
        }),
      );
      if (!line) throw notFound('No active phone line matches that number.');
      // Per-line AI switch (M1) — a line with the bot off resolves no config.
      if (!line.botEnabled) {
        throw forbidden(ApiErrorCode.FEATURE_DISABLED, 'The AI bot is turned off for this phone line.');
      }

      const { value, cache } = await loadVoiceConfig(line.organizationId, req.log);
      reply.header('x-cache', cache);
      return {
        data: {
          ...value.data,
          phoneIntegrationId: line.id,
          organizationId: line.organizationId,
        },
      };
    },
  );

  // ===========================================================================
  // Portal half — dashboard (JWT)
  // ===========================================================================

  // ---------- GET /voice/calls ----------------------------------------------
  r.get(
    '/voice/calls',
    {
      schema: {
        tags: ['voice'],
        summary: 'List voice calls (newest first, cursor-paginated).',
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
          // Restrict to one phone line (used by the per-line "Calls" view).
          phoneIntegrationId: uuidSchema.optional(),
        }),
        response: { 200: listEnvelopeSchema(voiceCallSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const cursor = decodeCursor<{ id: string }>(req.query.cursor);
        const rows = await tx.voiceCall.findMany({
          where: req.query.phoneIntegrationId
            ? { phoneIntegrationId: req.query.phoneIntegrationId }
            : undefined,
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: req.query.limit + 1,
          ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
          include: { _count: { select: { turns: true } } },
        });
        const hasMore = rows.length > req.query.limit;
        const page = hasMore ? rows.slice(0, req.query.limit) : rows;
        return {
          data: page.map((c) => ({
            id: c.id,
            callUuid: c.callUuid,
            callerId: c.callerId,
            dialedExten: c.dialedExten,
            outcome: c.outcome,
            handoffReason: c.handoffReason,
            startedAt: c.startedAt.toISOString(),
            endedAt: c.endedAt ? c.endedAt.toISOString() : null,
            turnCount: c._count.turns,
          })),
          nextCursor: hasMore ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
        };
      });
    },
  );

  // ---------- GET /voice/calls/:id ------------------------------------------
  r.get(
    '/voice/calls/:id',
    {
      schema: {
        tags: ['voice'],
        summary: 'Get one voice call with its full transcript.',
        params: z.object({ id: uuidSchema }),
        response: { 200: itemEnvelopeSchema(voiceCallDetailSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      return app.tenant(req, async (tx) => {
        const c = await tx.voiceCall.findFirst({
          where: { id: req.params.id },
          // seq breaks ties when a batch shares one `at` millisecond; the
          // take matches MAX_TURNS_PER_CALL so the response stays bounded.
          include: {
            turns: { orderBy: [{ at: 'asc' }, { seq: 'asc' }], take: MAX_TURNS_PER_CALL },
          },
        });
        if (!c) throw notFound('Voice call not found.');
        return {
          data: {
            id: c.id,
            callUuid: c.callUuid,
            callerId: c.callerId,
            dialedExten: c.dialedExten,
            outcome: c.outcome,
            handoffReason: c.handoffReason,
            startedAt: c.startedAt.toISOString(),
            endedAt: c.endedAt ? c.endedAt.toISOString() : null,
            turns: c.turns.map((t) => ({
              id: t.id,
              role: t.role as 'caller' | 'assistant',
              text: t.text,
              at: t.at.toISOString(),
            })),
          },
        };
      });
    },
  );
}
