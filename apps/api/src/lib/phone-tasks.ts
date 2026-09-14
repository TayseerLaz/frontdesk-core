// Phone tasks engine — CALL-E phone follow-through for records the chat bot opened.
//
// Three kinds, one pipeline:
//   cod_order_confirm  a cash-on-delivery cart in status 'new' → the AI calls the
//                      customer, reads back the REAL cart rows (never an LLM
//                      item list — invariant 16), confirms the address, and the
//                      result flips the cart to confirmed / cancelled, or parks
//                      it for a human as needs_review.
//   booking_confirm    a booking → can the customer still attend? confirmed /
//                      cancelled / needs_review.
//   custom             an operator-typed goal for a thread or a raw number; the
//                      result is only ever an inbox note (no record mutation).
//
// Write-back discipline (applyResult):
//   - compare-and-set on appliedAt so a webhook + a poll racing apply once;
//   - a record is only mutated when CALL-E says task_completed with confidence
//     ≥ APPLY_MIN_CONFIDENCE AND the extracted disposition is explicit AND
//     uncontradicted by the rest of the extraction (phone-task-decision.ts);
//     everything else, ambiguity included, becomes needs_review for a human;
//   - every outcome (including failures) leaves an inbox note on the thread
//     the order came from, so the conversation history stays the single
//     source of truth for the operator.
//
// DB access: bare `prisma` with EXPLICIT organizationId filters on every query
// (the documented exception for engines shared by routes and ticks; the API
// pool is a superuser so RLS does not filter here — the WHERE clause does).
import type { Prisma, PhoneTask } from '@platform/db';
import {
  ApiErrorCode,
  phoneTaskSettingsSchema,
  type CreatePhoneTaskBody,
  type PhoneTaskDto,
  type PhoneTaskSettings,
} from '@platform/shared';

import { formatMoney } from './bot-engine.js';
import {
  CalleRegionUnsupportedError,
  calleRuntime,
  completeFakeCall,
  createCalleCall,
  getCalleCall,
  normalizeLocale,
  type CalleCall,
} from './calle.js';
import { prisma } from './db.js';
import { decideWriteBack } from './phone-task-decision.js';
import { env } from './env.js';
import { badRequest, forbidden, notFound, serviceUnavailable } from './errors.js';
import { createNotification } from './notifications.js';
import { emitWebhookEvent } from './webhooks.js';

/** Dry-run calls "ring" for this long before the tick completes them. */
export const DRY_RUN_RING_MS = 15_000;

type J = Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function parseSettings(raw: unknown): PhoneTaskSettings {
  const parsed = phoneTaskSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : phoneTaskSettingsSchema.parse({});
}

export async function getSettings(orgId: string): Promise<PhoneTaskSettings> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { phoneTaskSettings: true },
  });
  return parseSettings(org?.phoneTaskSettings);
}

export async function updateSettings(orgId: string, patch: Partial<PhoneTaskSettings>) {
  const current = await getSettings(orgId);
  const next = phoneTaskSettingsSchema.parse({ ...current, ...patch });
  await prisma.organization.update({
    where: { id: orgId },
    data: { phoneTaskSettings: next as unknown as J },
  });
  return next;
}

// ---------------------------------------------------------------------------
// Task specs — the spoken instruction + the JSON schema CALL-E extracts into.
// Enum values are ordered HAPPY-FIRST on purpose: the dry-run synthesiser picks
// the first value of each enum.
// ---------------------------------------------------------------------------

interface TaskSpec {
  task: string;
  resultSchema: Record<string, unknown>;
  phoneE164: string;
  customerName: string | null;
  threadId: string | null;
  targetType: 'cart' | 'booking' | 'thread' | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

interface BizContext {
  businessName: string;
  timezone: string;
  currency: string;
  deliveryPolicy: string | null;
  language: string | null;
}

function clean(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function loadBiz(orgId: string): Promise<BizContext> {
  const [org, biz, policies, bot] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    prisma.businessInfo.findFirst({
      where: { organizationId: orgId },
      select: { legalName: true, timezone: true, currency: true },
    }),
    prisma.policy.findMany({
      where: { organizationId: orgId, kind: { in: ['shipping', 'delivery', 'return'] } },
      select: { kind: true, content: true },
      take: 3,
    }),
    prisma.botConfig.findUnique({ where: { organizationId: orgId }, select: { languages: true } }),
  ]);
  const shipping = policies.find((p) => p.kind === 'shipping' || p.kind === 'delivery');
  return {
    businessName: biz?.legalName?.trim() || org?.name || 'the shop',
    timezone: biz?.timezone ?? 'UTC',
    currency: biz?.currency ?? 'USD',
    deliveryPolicy: shipping ? clean(shipping.content, 400) || null : null,
    language: bot?.languages ? clean(bot.languages, 40) || null : null,
  };
}

type FieldAnswer = { key?: string; label?: string; value?: unknown };
function pickField(fields: unknown, re: RegExp): string | null {
  if (!Array.isArray(fields)) return null;
  for (const f of fields as FieldAnswer[]) {
    const hay = `${f.key ?? ''} ${f.label ?? ''}`;
    if (re.test(hay) && f.value != null && String(f.value).trim()) return String(f.value).trim();
  }
  return null;
}

const GUARDRAILS =
  'Rules: never invent items, prices, discounts or delivery times that are not in this brief. ' +
  'If asked something you do not know, say a team member will follow up. ' +
  'Be brief and natural — this call should take under two minutes. ' +
  'If you reach voicemail, leave a short message saying who you are and that we will try again, then end the call.';

async function specForCart(orgId: string, cartId: string): Promise<TaskSpec> {
  const cart = await prisma.cart.findFirst({
    where: { id: cartId, organizationId: orgId },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  });
  if (!cart) throw notFound('Order not found.');
  if (cart.items.length === 0) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'This order has no items to confirm.');
  const biz = await loadBiz(orgId);
  const currency = cart.currency || biz.currency;
  const lines = cart.items
    .map((it) => {
      const label = it.variantLabel ? `${it.name} (${it.variantLabel})` : it.name;
      return `${it.quantity} x ${clean(label, 80)} at ${formatMoney(Number(it.unitPriceMinor), currency)}`;
    })
    .join('; ');
  const address = pickField(cart.fields, /address|location|street|area|city|building|deliver/i);
  const name = cart.customerName?.trim() || pickField(cart.fields, /name/i);
  const ref = cart.id.slice(0, 8).toUpperCase();
  const placed = new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: biz.timezone,
  }).format(cart.createdAt);

  const task = [
    `You are calling on behalf of ${biz.businessName} to confirm a cash-on-delivery order before it is prepared and dispatched.`,
    `Customer: ${name ?? 'the customer'}. Order reference ${ref}, placed ${placed} via ${cart.channel}.`,
    `Items: ${lines}.`,
    cart.deliveryMinor > 0n ? `Delivery fee: ${formatMoney(Number(cart.deliveryMinor), currency)}.` : null,
    `Total to pay in cash on delivery: ${formatMoney(Number(cart.totalMinor), currency)}.`,
    address ? `Delivery address on file: ${clean(address, 200)}.` : 'No delivery address is on file — ask for it.',
    biz.deliveryPolicy ? `Delivery policy: ${biz.deliveryPolicy}` : null,
    'Goal: 1) greet and say you are calling from the shop to confirm their order; 2) read back the items and the total; 3) confirm the delivery address (or collect it); 4) ask if they want any change — record it precisely; 5) if they no longer want the order, accept politely and record that.',
    biz.language ? `Speak ${biz.language} unless the customer switches language.` : null,
    GUARDRAILS,
  ]
    .filter(Boolean)
    .join(' ');

  const resultSchema = {
    type: 'object',
    required: ['disposition', 'confirmed'],
    properties: {
      disposition: {
        type: 'string',
        description: 'What happened on the call',
        enum: ['confirmed', 'changed', 'cancelled', 'voicemail', 'no_answer', 'wrong_number', 'needs_human'],
      },
      confirmed: {
        type: 'string',
        description: 'Did the customer confirm they want this order as read back',
        enum: ['yes', 'no', 'unknown'],
      },
      address_correct: {
        type: 'string',
        description: 'Did the customer confirm the delivery address',
        enum: ['yes', 'no', 'unknown'],
      },
      delivery_address: { type: 'string', description: 'Delivery address as the customer stated it, if given' },
      requested_changes: { type: 'string', description: 'Exact changes the customer asked for, if any' },
      preferred_delivery_window: { type: 'string', description: 'Any delivery time preference the customer stated' },
      customer_notes: { type: 'string', description: 'Anything else the team should know' },
    },
  };

  return {
    task,
    resultSchema,
    phoneE164: cart.customerPhone,
    customerName: name,
    threadId: cart.threadId,
    targetType: 'cart',
    targetId: cart.id,
    metadata: { kind: 'cod_order_confirm', cartId: cart.id, orderRef: ref },
  };
}

async function specForBooking(orgId: string, bookingId: string): Promise<TaskSpec> {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, organizationId: orgId } });
  if (!booking) throw notFound('Booking not found.');
  if (!booking.appointmentAt) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'This booking has no appointment time.');
  const biz = await loadBiz(orgId);
  const when = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    dateStyle: undefined,
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: biz.timezone,
  }).format(booking.appointmentAt);
  const service = pickField(booking.fields, /service|treatment|type/i);
  const name = booking.customerName?.trim() || pickField(booking.fields, /name/i);

  const task = [
    `You are calling on behalf of ${biz.businessName} to confirm an existing appointment.`,
    `Customer: ${name ?? 'the customer'}. Appointment: ${when}${service ? ` for ${clean(service, 80)}` : ''}.`,
    'Goal: 1) greet and say you are calling from the business about their upcoming appointment; 2) ask whether they can still attend at that time; 3) if not, ask what day and time would suit them and record it exactly — do NOT promise the new slot, say the team will confirm it; 4) if they want to cancel, accept politely.',
    biz.language ? `Speak ${biz.language} unless the customer switches language.` : null,
    GUARDRAILS,
  ]
    .filter(Boolean)
    .join(' ');

  const resultSchema = {
    type: 'object',
    required: ['disposition', 'can_attend'],
    properties: {
      disposition: {
        type: 'string',
        description: 'What happened on the call',
        enum: ['confirmed', 'reschedule_requested', 'declined', 'voicemail', 'no_answer', 'wrong_number', 'needs_human'],
      },
      can_attend: { type: 'string', description: 'Can the customer attend the appointment as scheduled', enum: ['yes', 'no', 'unknown'] },
      requested_time: { type: 'string', description: 'Requested alternative day/time in the customer words, if any' },
      customer_notes: { type: 'string', description: 'Anything else the team should know' },
    },
  };

  return {
    task,
    resultSchema,
    phoneE164: booking.customerPhone,
    customerName: name,
    threadId: booking.threadId,
    targetType: 'booking',
    targetId: booking.id,
    metadata: { kind: 'booking_confirm', bookingId: booking.id },
  };
}

async function specForCustom(
  orgId: string,
  body: Extract<CreatePhoneTaskBody, { kind: 'custom' }>,
): Promise<TaskSpec> {
  let phone = body.phoneE164 ?? null;
  let name: string | null = null;
  let threadId: string | null = null;
  if (body.threadId) {
    const thread = await prisma.whatsAppThread.findFirst({
      where: { id: body.threadId, organizationId: orgId },
      select: { id: true, customerPhone: true, customerName: true },
    });
    if (!thread) throw notFound('Conversation not found.');
    phone = phone ?? thread.customerPhone;
    name = thread.customerName;
    threadId = thread.id;
  }
  if (!phone) throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'A phone number or a conversation is required.');
  const biz = await loadBiz(orgId);
  const task = [
    `You are calling on behalf of ${biz.businessName}.${name ? ` The customer is ${name}.` : ''}`,
    `Goal from the team: ${clean(body.goal, 2000)}`,
    biz.language ? `Speak ${biz.language} unless the customer switches language.` : null,
    GUARDRAILS,
  ]
    .filter(Boolean)
    .join(' ');
  const resultSchema = {
    type: 'object',
    required: ['outcome'],
    properties: {
      outcome: { type: 'string', description: 'Overall outcome', enum: ['achieved', 'partially_achieved', 'not_achieved', 'voicemail', 'no_answer', 'wrong_number'] },
      answer: { type: 'string', description: 'The substantive answer or information the customer gave' },
      follow_up_needed: { type: 'string', description: 'What a human should do next, if anything' },
    },
  };
  return {
    task,
    resultSchema,
    phoneE164: phone,
    customerName: name,
    threadId,
    targetType: threadId ? 'thread' : null,
    targetId: threadId,
    metadata: { kind: 'custom', goal: clean(body.goal, 200) },
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function utcDayStart(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function toE164(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  return `+${digits}`;
}

export async function createPhoneTask(args: {
  orgId: string;
  body: CreatePhoneTaskBody;
  createdById: string | null;
  source: 'operator' | 'auto';
}): Promise<PhoneTask> {
  const rt = calleRuntime();
  if (!rt.dryRun && !rt.configured) {
    throw serviceUnavailable('CALL-E is not configured: set CALLE_API_KEY or leave CALLE_DRY_RUN=true.');
  }

  const spec =
    args.body.kind === 'cod_order_confirm'
      ? await specForCart(args.orgId, args.body.cartId)
      : args.body.kind === 'booking_confirm'
        ? await specForBooking(args.orgId, args.body.bookingId)
        : await specForCustom(args.orgId, args.body);

  const phoneE164 = toE164(spec.phoneE164);

  // Consent gate: a contact who opted out or was blocked is never called.
  const contact = await prisma.contact.findFirst({
    where: {
      organizationId: args.orgId,
      deletedAt: null,
      OR: [{ phoneE164 }, { phoneE164: phoneE164.slice(1) }],
    },
    select: { id: true, locale: true, optedOutAt: true, blockedAt: true, displayName: true },
  });
  if (contact?.optedOutAt || contact?.blockedAt) {
    throw forbidden(ApiErrorCode.PHONE_TASK_CONTACT_OPTED_OUT, 'This contact opted out or is blocked — no call will be placed.');
  }

  // Daily cap: env ceiling AND the tenant's own (lower) ceiling.
  const settings = await getSettings(args.orgId);
  const cap = Math.min(env.PHONE_TASK_DAILY_CAP, settings.dailyCap);
  const today = await prisma.phoneTask.count({
    where: { organizationId: args.orgId, createdAt: { gte: utcDayStart() } },
  });
  if (today >= cap) {
    throw forbidden(ApiErrorCode.PHONE_TASK_DAILY_CAP, `Daily phone-call cap reached (${cap}). Raise it in Phone tasks settings.`);
  }

  // Durable idempotency key: one per (target, attempt). Persisted BEFORE the
  // CALL-E request so a retry after a crash reuses the same key.
  const attempt = spec.targetId
    ? (await prisma.phoneTask.count({
        where: { organizationId: args.orgId, targetType: spec.targetType, targetId: spec.targetId },
      })) + 1
    : Date.now();
  const idempotencyKey = `phone-task:${args.orgId}:${args.body.kind}:${spec.targetId ?? phoneE164}:${attempt}:v1`;

  const row = await prisma.phoneTask.create({
    data: {
      organizationId: args.orgId,
      kind: args.body.kind,
      targetType: spec.targetType,
      targetId: spec.targetId,
      contactId: contact?.id ?? null,
      threadId: spec.threadId,
      phoneE164,
      locale: normalizeLocale(contact?.locale),
      task: spec.task,
      resultSchema: spec.resultSchema as J,
      metadata: { ...spec.metadata, source: args.source, customerName: spec.customerName } as J,
      idempotencyKey,
      dryRun: rt.dryRun,
      status: 'queued',
      createdById: args.createdById,
    },
  });

  const webhookUrl =
    env.CALLE_WEBHOOK_TOKEN && !/localhost|127\.0\.0\.1/.test(env.API_PUBLIC_URL)
      ? `${env.API_PUBLIC_URL}/api/v1/calle/webhook/${args.orgId}?token=${encodeURIComponent(env.CALLE_WEBHOOK_TOKEN)}`
      : null;

  try {
    const out = await createCalleCall({
      task: spec.task,
      phoneE164,
      locale: row.locale,
      resultSchema: spec.resultSchema,
      metadata: { ...spec.metadata, phoneTaskId: row.id, organizationId: args.orgId },
      idempotencyKey,
      webhookUrl,
    });
    const updated = await prisma.phoneTask.update({
      where: { id: row.id },
      data: {
        calleCallId: out.call.id,
        dialedPhone: out.dialedPhone,
        region: out.region,
        status: mapStatus(out.call.status),
      },
    });
    // A terminal answer on create (rare, but the API allows it) is applied now.
    if (isTerminal(out.call.status)) return applyResult(updated, out.call);
    return updated;
  } catch (err) {
    const message =
      err instanceof CalleRegionUnsupportedError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'CALL-E request failed';
    const failed = await prisma.phoneTask.update({
      where: { id: row.id },
      data: { status: 'failed', error: message.slice(0, 1000), completedAt: new Date() },
    });
    await leaveNote(failed, `📵 Phone call could not be placed: ${message}`);
    if (err instanceof CalleRegionUnsupportedError) {
      throw badRequest(ApiErrorCode.PHONE_TASK_REGION_UNSUPPORTED, err.message, { taskId: failed.id });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Poll / refresh
// ---------------------------------------------------------------------------

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

function mapStatus(status: string): string {
  switch (status) {
    case 'queued':
    case 'in_progress':
    case 'completed':
    case 'failed':
    case 'canceled':
      return status;
    default:
      return 'in_progress';
  }
}

/**
 * Pull the latest state from CALL-E (or complete a dry-run call once it has
 * "rung" long enough) and apply it when terminal. Safe to call repeatedly.
 */
export async function refreshPhoneTask(task: PhoneTask, opts: { force?: boolean } = {}): Promise<PhoneTask> {
  if (isTerminal(task.status) || task.status === 'needs_review') return task;
  if (!task.calleCallId) return task;

  let call: CalleCall;
  if (task.dryRun) {
    const age = Date.now() - task.createdAt.getTime();
    if (!opts.force && age < DRY_RUN_RING_MS) return task;
    call = completeFakeCall(
      {
        id: task.calleCallId,
        object: 'call_task',
        status: 'in_progress',
        task: task.task,
        recipients: [
          {
            id: `${task.calleCallId}_r1`,
            phones: [task.dialedPhone ?? task.phoneE164],
            locale: task.locale,
            region: task.region,
            status: 'in_progress',
            structuredResult: null,
            summary: null,
            attempts: [],
          },
        ],
        structuredResult: null,
        summary: null,
        taskCompleted: null,
        completionConfidence: null,
        evidence: [],
        metadata: (task.metadata ?? {}) as Record<string, unknown>,
        failureCode: null,
        failureMessage: null,
        createdAt: task.createdAt.toISOString(),
        completedAt: null,
      },
      task.resultSchema as Record<string, unknown>,
    );
  } else {
    call = await getCalleCall(task.calleCallId);
  }

  if (!isTerminal(call.status)) {
    const status = mapStatus(call.status);
    if (status !== task.status) {
      return prisma.phoneTask.update({ where: { id: task.id }, data: { status } });
    }
    return task;
  }
  return applyResult(task, call);
}

// ---------------------------------------------------------------------------
// Apply — the only place a call result touches a business record
// ---------------------------------------------------------------------------

function transcriptOf(call: CalleCall): { speaker: string; text: string; offsetMs: number | null }[] {
  const out: { speaker: string; text: string; offsetMs: number | null }[] = [];
  for (const r of call.recipients ?? []) {
    for (const a of r.attempts ?? []) {
      for (const t of (a.transcriptTurns ?? []) as Array<Record<string, unknown>>) {
        const secs = t.offset_seconds ?? t.offsetSeconds ?? null;
        const ms = t.offset_ms ?? t.offsetMs ?? null;
        out.push({
          speaker: String(t.speaker ?? 'unknown'),
          text: String(t.text ?? ''),
          offsetMs: typeof ms === 'number' ? ms : typeof secs === 'number' ? Math.round(secs * 1000) : null,
        });
      }
    }
  }
  return out;
}

type Decision =
  | { action: 'confirmed' | 'cancelled'; reason: string }
  | { action: 'needs_review'; reason: string }
  | { action: 'noop'; reason: string };

function decide(task: PhoneTask, call: CalleCall, result: Record<string, unknown> | null): Decision {
  // The rule itself lives in phone-task-decision.ts (pure, unit-tested).
  return decideWriteBack({
    kind: task.kind,
    status: call.status,
    failureMessage: call.failureMessage ?? null,
    taskCompleted: call.taskCompleted === true,
    confidence: call.completionConfidence?.score ?? 0,
    result,
  }) as Decision;
}

function noteFor(task: PhoneTask, call: CalleCall, decision: Decision, result: Record<string, unknown> | null): string {
  const head =
    decision.action === 'confirmed'
      ? '✅ Phone confirmation'
      : decision.action === 'cancelled'
        ? '❌ Cancelled by phone'
        : decision.action === 'needs_review'
          ? '⚠️ Phone call needs review'
          : '📞 Phone call result';
  const conf = call.completionConfidence ? ` · confidence ${Math.round((call.completionConfidence.score ?? 0) * 100)}%` : '';
  const dry = task.dryRun ? ' · DRY RUN (no call placed)' : '';
  const lines = [
    `${head}${conf}${dry}`,
    decision.reason,
    call.summary ? `Summary: ${call.summary}` : null,
    result
      ? Object.entries(result)
          .filter(([, v]) => v !== '' && v != null)
          .map(([k, v]) => `• ${k}: ${String(v)}`)
          .join('\n')
      : null,
  ].filter(Boolean);
  return lines.join('\n').slice(0, 3900);
}

async function leaveNote(task: PhoneTask, body: string): Promise<void> {
  if (!task.threadId) return;
  try {
    await prisma.whatsAppNote.create({
      data: { organizationId: task.organizationId, threadId: task.threadId, authorUserId: null, body },
    });
  } catch (err) {
    console.error('[phone-tasks] note failed', err);
  }
}

export async function applyResult(task: PhoneTask, call: CalleCall): Promise<PhoneTask> {
  // Compare-and-set: the first of webhook / poll to get here wins; the other
  // sees 0 rows and returns the current row untouched.
  const claim = await prisma.phoneTask.updateMany({
    where: { id: task.id, organizationId: task.organizationId, appliedAt: null },
    data: { appliedAt: new Date() },
  });
  if (claim.count === 0) {
    return (await prisma.phoneTask.findUnique({ where: { id: task.id } })) ?? task;
  }

  const result = (call.recipients?.[0]?.structuredResult ?? call.structuredResult ?? null) as Record<string, unknown> | null;
  const decision = decide(task, call, result);

  // Mutate the target record — only on an unambiguous, confident answer.
  if (decision.action === 'confirmed' || decision.action === 'cancelled') {
    if (task.targetType === 'cart' && task.targetId) {
      const before = await prisma.cart.findFirst({ where: { id: task.targetId, organizationId: task.organizationId } });
      if (before && before.status === 'new') {
        await prisma.cart.update({ where: { id: before.id }, data: { status: decision.action } });
        void emitWebhookEvent({
          organizationId: task.organizationId,
          eventKind: 'cart_status_changed',
          payload: { id: before.id, from: before.status, to: decision.action, source: 'phone_task', phoneTaskId: task.id },
        });
      }
    } else if (task.targetType === 'booking' && task.targetId) {
      const before = await prisma.booking.findFirst({ where: { id: task.targetId, organizationId: task.organizationId } });
      if (before && (before.status === 'new' || before.status === 'confirmed')) {
        await prisma.booking.update({ where: { id: before.id }, data: { status: decision.action } });
        void emitWebhookEvent({
          organizationId: task.organizationId,
          eventKind: 'booking_status_changed',
          payload: { id: before.id, from: before.status, to: decision.action, source: 'phone_task', phoneTaskId: task.id },
        });
      }
    }
  }

  const finalStatus =
    decision.action === 'needs_review' ? 'needs_review' : mapStatus(call.status);
  const updated = await prisma.phoneTask.update({
    where: { id: task.id },
    data: {
      status: finalStatus,
      structuredResult: (result ?? undefined) as J | undefined,
      summary: call.summary ?? null,
      taskCompleted: call.taskCompleted ?? null,
      confidence: call.completionConfidence?.score ?? null,
      transcript: transcriptOf(call) as unknown as J,
      error: call.failureMessage ?? null,
      appliedAction: decision.action,
      completedAt: call.completedAt ? new Date(call.completedAt) : new Date(),
    },
  });

  await leaveNote(updated, noteFor(updated, call, decision, result));

  const who = (updated.metadata as Record<string, unknown> | null)?.customerName ?? updated.phoneE164;
  await createNotification({
    organizationId: updated.organizationId,
    kind: 'generic',
    severity: decision.action === 'needs_review' ? 'warning' : 'info',
    title:
      decision.action === 'confirmed'
        ? `Order confirmed by phone — ${who}`
        : decision.action === 'cancelled'
          ? `Cancelled by phone — ${who}`
          : decision.action === 'needs_review'
            ? `Phone call needs review — ${who}`
            : `Phone call finished — ${who}`,
    body: decision.reason,
    link: '/phone-tasks',
    entityType: 'phone_task',
    entityId: updated.id,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export function serializePhoneTask(row: PhoneTask): PhoneTaskDto {
  return {
    id: row.id,
    kind: row.kind as PhoneTaskDto['kind'],
    targetType: (row.targetType as PhoneTaskDto['targetType']) ?? null,
    targetId: row.targetId,
    contactId: row.contactId,
    threadId: row.threadId,
    phoneE164: row.phoneE164,
    dialedPhone: row.dialedPhone,
    region: row.region,
    locale: row.locale,
    task: row.task,
    resultSchema: (row.resultSchema ?? {}) as Record<string, unknown>,
    status: row.status as PhoneTaskDto['status'],
    dryRun: row.dryRun,
    calleCallId: row.calleCallId,
    structuredResult: (row.structuredResult as Record<string, unknown> | null) ?? null,
    summary: row.summary,
    taskCompleted: row.taskCompleted,
    confidence: row.confidence,
    transcript: (row.transcript as PhoneTaskDto['transcript']) ?? null,
    error: row.error,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    appliedAction: row.appliedAction,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
