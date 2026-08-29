// Phase 4 — Broadcast fanout worker.
//
// One job per Broadcast. Reads recipients (CSV, segment, or already-materialized
// manual list), assigns A/B variants, resolves per-recipient template variables,
// and enqueues per-recipient `broadcast-send` jobs.
//
// Restart-safe: only enqueues recipients in `pending` status. CSV streaming
// upserts contacts before inserting recipient rows so future broadcasts can
// reuse them.
import { Queue, Worker } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { parse } from 'csv-parse';

import { emitWebhookEvent } from '../lib/emit-webhook.js';
import { env } from '../lib/env.js';
import { getConnection } from '../lib/redis.js';
import { getObjectStream } from '../lib/storage.js';

import { prisma, withRlsBypass } from './db.js';

const QUEUE_FANOUT = 'broadcast-fanout';
const QUEUE_SEND = 'broadcast-send';
const FANOUT_CONCURRENCY = Number(process.env.BROADCAST_FANOUT_CONCURRENCY ?? 2);

interface FanoutJobData {
  organizationId: string;
  broadcastId: string;
}

interface SendJobData {
  organizationId: string;
  broadcastId: string;
  recipientId: string;
}

let sendQueue: Queue<SendJobData> | null = null;
function getSendQueue() {
  if (!sendQueue) {
    sendQueue = new Queue<SendJobData>(QUEUE_SEND, { connection: getConnection() });
  }
  return sendQueue;
}

// Deterministic A/B split (must match assignVariant in the API).
function assignVariant(phone: string, abTest: boolean): 'A' | 'B' {
  if (!abTest) return 'A';
  let h = 0;
  for (let i = 0; i < phone.length; i++) {
    h = (h * 31 + phone.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 2 === 0 ? 'A' : 'B';
}

function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

const DEFAULT_PHONE_COLS = ['phone', 'phone_e164', 'mobile', 'whatsapp', 'msisdn'];
const DEFAULT_NAME_COLS = ['name', 'display_name', 'first_name', 'full_name'];

interface VariableSourceCsv {
  kind: 'csv';
  column: string;
}
interface VariableSourceAttribute {
  kind: 'attribute';
  key: string;
  fallback?: string;
}
interface VariableSourceField {
  kind: 'field';
  field: 'display_name' | 'phone_e164' | 'locale';
  fallback?: string;
}
interface VariableSourceStatic {
  kind: 'static';
  value: string;
}
type VariableSource =
  | VariableSourceCsv
  | VariableSourceAttribute
  | VariableSourceField
  | VariableSourceStatic;

type VariableMapping = Record<string, VariableSource>;

interface RecipientContext {
  phone: string;
  attributes: Record<string, unknown>;
  displayName: string | null;
  locale: string | null;
  csvRow?: Record<string, string>;
}

function resolveVariables(
  mapping: VariableMapping,
  ctx: RecipientContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [idx, src] of Object.entries(mapping)) {
    let val = '';
    switch (src.kind) {
      case 'static':
        val = src.value;
        break;
      case 'csv':
        val = ctx.csvRow?.[src.column] ?? '';
        break;
      case 'attribute': {
        const v = ctx.attributes[src.key];
        val = typeof v === 'string' ? v : v != null ? String(v) : (src.fallback ?? '');
        break;
      }
      case 'field': {
        if (src.field === 'phone_e164') val = ctx.phone;
        else if (src.field === 'display_name') val = ctx.displayName ?? src.fallback ?? '';
        else if (src.field === 'locale') val = ctx.locale ?? src.fallback ?? '';
        break;
      }
    }
    out[idx] = val;
  }
  return out;
}

async function streamCsvRecipients(
  storageKey: string,
  organizationId: string,
  broadcastId: string,
  abTest: boolean,
  variantAVariables: VariableMapping,
  variantBVariables: VariableMapping | null,
  log: (...args: unknown[]) => void,
): Promise<number> {
  const stream = await getObjectStream(storageKey);
  const parser = stream.pipe(
    parse({
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }),
  );

  let headers: string[] = [];
  let phoneCol: string | null = null;
  let nameCol: string | null = null;
  const buffer: { phone: string; row: Record<string, string> }[] = [];
  const seen = new Set<string>();

  for await (const record of parser) {
    const row = record as Record<string, string>;
    if (headers.length === 0) {
      headers = Object.keys(row);
      phoneCol =
        headers.find((h) => DEFAULT_PHONE_COLS.includes(h.toLowerCase())) ?? headers[0] ?? null;
      nameCol = headers.find((h) => DEFAULT_NAME_COLS.includes(h.toLowerCase())) ?? null;
    }
    if (!phoneCol) continue;
    const phone = normalizeE164(row[phoneCol] ?? '');
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    buffer.push({ phone, row });
  }

  log(`csv parsed: ${buffer.length} unique recipients`);
  let total = 0;
  const BATCH = 500;
  for (let i = 0; i < buffer.length; i += BATCH) {
    const slice = buffer.slice(i, i + BATCH);
    await withRlsBypass(async (tx) => {
      // Upsert contacts so future broadcasts can reuse them.
      for (const { phone, row } of slice) {
        const attrs: Record<string, string> = {};
        for (const h of headers) {
          if (h === phoneCol || h === nameCol) continue;
          const v = row[h];
          if (v !== undefined && v !== '') attrs[h] = v;
        }
        const displayName = nameCol ? row[nameCol] || null : null;
        await tx.contact.upsert({
          where: { organizationId_phoneE164: { organizationId, phoneE164: phone } },
          create: {
            organizationId,
            phoneE164: phone,
            displayName,
            attributes: attrs as never,
            source: 'csv',
          },
          update: { deletedAt: null, attributes: attrs as never, source: 'csv' },
        });
      }

      // Insert BroadcastRecipient rows in bulk.
      const rows = await Promise.all(
        slice.map(async ({ phone, row }) => {
          const contact = await tx.contact.findUnique({
            where: { organizationId_phoneE164: { organizationId, phoneE164: phone } },
            select: {
              id: true,
              displayName: true,
              locale: true,
              attributes: true,
              optedOutAt: true,
            },
          });
          const variant = assignVariant(phone, abTest);
          const ctx: RecipientContext = {
            phone,
            attributes:
              (contact?.attributes as Record<string, unknown> | null) ?? {},
            displayName: contact?.displayName ?? null,
            locale: contact?.locale ?? null,
            csvRow: row,
          };
          const mapping = variant === 'A' ? variantAVariables : variantBVariables ?? variantAVariables;
          const variables = resolveVariables(mapping, ctx);
          return {
            organizationId,
            broadcastId,
            contactId: contact?.id ?? null,
            phoneE164: phone,
            variant,
            variables: variables as unknown as Prisma.InputJsonValue,
            // Carried out of the map so opted-out rows can be filtered below.
            _optedOut: !!(contact as { optedOutAt?: Date | null } | null)?.optedOutAt,
          };
        }),
      );
      // Never materialize a recipient for an unsubscribed contact. The send
      // worker also re-checks by phone, but dropping them here keeps the
      // recipient list (and its counts) honest.
      const sendable = rows.filter((r) => !r._optedOut).map(({ _optedOut, ...rest }) => rest);
      await tx.broadcastRecipient.createMany({ data: sendable, skipDuplicates: true });
    });
    total += slice.length;
  }
  return total;
}

async function resolveExistingRecipientVariables(
  organizationId: string,
  broadcastId: string,
  variantAVariables: VariableMapping,
  variantBVariables: VariableMapping | null,
): Promise<void> {
  // For segment/manual audiences we already inserted recipients with empty
  // variables. Resolve them now (cheap because contacts are already loaded).
  const recipients = await prisma.broadcastRecipient.findMany({
    where: { broadcastId, status: 'pending', variables: { equals: {} } },
    include: {
      contact: {
        select: { displayName: true, locale: true, attributes: true },
      },
    },
    take: 100_000,
  });
  for (const r of recipients) {
    const ctx: RecipientContext = {
      phone: r.phoneE164,
      attributes:
        (r.contact?.attributes as Record<string, unknown> | null) ?? {},
      displayName: r.contact?.displayName ?? null,
      locale: r.contact?.locale ?? null,
    };
    const mapping = r.variant === 'A' ? variantAVariables : variantBVariables ?? variantAVariables;
    const variables = resolveVariables(mapping, ctx);
    await prisma.broadcastRecipient.update({
      where: { id: r.id },
      data: { variables: variables as unknown as Prisma.InputJsonValue },
    });
  }
  void organizationId;
}

export function startBroadcastFanoutWorker() {
  const worker = new Worker<FanoutJobData>(
    QUEUE_FANOUT,
    async (job) => {
      const { organizationId, broadcastId } = job.data;
      const log = (...args: unknown[]) =>
        console.log(`[broadcast-fanout ${broadcastId.slice(0, 8)}]`, ...args);

      const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
      if (!broadcast || broadcast.organizationId !== organizationId) {
        log('broadcast missing or org mismatch — bail');
        return;
      }
      // Only run when sending or scheduled-but-now-due.
      if (broadcast.status === 'paused' || broadcast.status === 'cancelled') {
        log(`status is ${broadcast.status} — bail`);
        return;
      }
      if (broadcast.status === 'scheduled') {
        // The job's delay has fired. Promote to sending.
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { status: 'sending', startedAt: new Date() },
        });
        await prisma.broadcastEvent.create({
          data: { organizationId, broadcastId, kind: 'started' },
        });
        await emitWebhookEvent({
          organizationId,
          eventKind: 'broadcast_started',
          payload: {
            broadcastId,
            name: broadcast.name,
            scheduledFor: broadcast.scheduledFor?.toISOString() ?? null,
          },
        });
      } else if (broadcast.status === 'sending' && !broadcast.startedAt) {
        // Send-now path — mark started + emit on first fanout.
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { startedAt: new Date() },
        });
        await emitWebhookEvent({
          organizationId,
          eventKind: 'broadcast_started',
          payload: { broadcastId, name: broadcast.name, scheduledFor: null },
        });
      }

      const variantA = (broadcast.variantAVariables ?? {}) as unknown as VariableMapping;
      const variantB = broadcast.variantBVariables
        ? (broadcast.variantBVariables as unknown as VariableMapping)
        : null;

      // Materialize CSV recipients if this audience is CSV and no recipients yet.
      if (broadcast.audienceKind === 'csv' && broadcast.csvAssetId) {
        const existing = await prisma.broadcastRecipient.count({ where: { broadcastId } });
        if (existing === 0) {
          const asset = await prisma.asset.findUnique({ where: { id: broadcast.csvAssetId } });
          if (!asset) throw new Error('CSV asset missing');
          const total = await streamCsvRecipients(
            asset.storageKey,
            organizationId,
            broadcastId,
            broadcast.abTest,
            variantA,
            variantB,
            log,
          );
          await prisma.broadcast.update({
            where: { id: broadcastId },
            data: { totalRecipients: total },
          });
          log(`materialized ${total} CSV recipients`);
        }
      } else {
        // Resolve variables on already-materialized recipients (segment/manual).
        await resolveExistingRecipientVariables(organizationId, broadcastId, variantA, variantB);
      }

      // Multi-number: assign each recipient a sending number. With one number,
      // everyone uses it; with several, split round-robin (deterministic by id)
      // so each contact is messaged exactly once, load spread across numbers.
      const sendChannelIds =
        broadcast.channelIds && broadcast.channelIds.length > 0
          ? broadcast.channelIds
          : [broadcast.channelId];
      if (sendChannelIds.length <= 1) {
        await prisma.broadcastRecipient.updateMany({
          where: { broadcastId, whatsAppChannelId: null },
          data: { whatsAppChannelId: sendChannelIds[0] },
        });
      } else {
        const placeholders = sendChannelIds.map((_, i) => `$${i + 1}::uuid`).join(',');
        const bidParam = `$${sendChannelIds.length + 1}`;
        await prisma.$executeRawUnsafe(
          `WITH ordered AS (
             SELECT id, ((row_number() OVER (ORDER BY id) - 1) % ${sendChannelIds.length})::int AS slot
             FROM broadcast_recipients
             WHERE broadcast_id = ${bidParam}::uuid AND whatsapp_channel_id IS NULL
           )
           UPDATE broadcast_recipients r
           SET whatsapp_channel_id = (ARRAY[${placeholders}])[ordered.slot + 1]
           FROM ordered
           WHERE r.id = ordered.id`,
          ...sendChannelIds,
          broadcastId,
        );
      }
      log(`assigned sending number(s): ${sendChannelIds.length}`);

      // Enqueue per-recipient send jobs in batches.
      //
      // Batched/throttled send: when batchSize > 0 AND batchIntervalMinutes > 0,
      // recipients are released in waves — the first `batchSize` fire now, the
      // next wave is delayed by one interval, and so on. We stamp each send job
      // with a BullMQ `delay = waveNumber * interval`, computed from the
      // recipient's global position. 0 = no batching (everything fires at once,
      // still paced by the per-number rate limit + send window). The wave delay
      // is RELATIVE to the fanout running, which (for a scheduled broadcast)
      // already runs at scheduledFor — so the first wave lands at the start time.
      const sendQ = getSendQueue();
      const batchSize =
        broadcast.batchSize && broadcast.batchSize > 0 && broadcast.batchIntervalMinutes > 0
          ? broadcast.batchSize
          : 0;
      const batchIntervalMs = (broadcast.batchIntervalMinutes ?? 0) * 60_000;
      const PAGE = 500;
      let cursor: string | undefined;
      let queued = 0;
      while (true) {
        const batch = await prisma.broadcastRecipient.findMany({
          where: { broadcastId, status: 'pending' },
          take: PAGE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: 'asc' },
          select: { id: true },
        });
        if (batch.length === 0) break;
        const pageStart = queued; // global index of the first recipient on this page
        await sendQ.addBulk(
          batch.map((r, idx) => {
            const globalIndex = pageStart + idx;
            const wave = batchSize > 0 ? Math.floor(globalIndex / batchSize) : 0;
            const delay = wave * batchIntervalMs;
            return {
              name: 'send',
              data: { organizationId, broadcastId, recipientId: r.id },
              opts: {
                ...(delay > 0 ? { delay } : {}),
                attempts: 5,
                backoff: { type: 'exponential', delay: 5000 },
                removeOnComplete: { age: 24 * 60 * 60 },
                removeOnFail: { age: 7 * 24 * 60 * 60 },
              },
            };
          }),
        );
        await prisma.broadcastRecipient.updateMany({
          where: { id: { in: batch.map((r) => r.id) } },
          data: { status: 'queued', queuedAt: new Date() },
        });
        queued += batch.length;
        cursor = batch[batch.length - 1]!.id;
        if (batch.length < PAGE) break;
      }
      await prisma.broadcast.update({
        where: { id: broadcastId },
        data: { queuedCount: { increment: queued } },
      });
      log(`enqueued ${queued} send jobs`);
    },
    {
      connection: getConnection(),
      concurrency: FANOUT_CONCURRENCY,
    },
  );
  worker.on('error', (err) => console.error('[broadcast-fanout] worker error', err));
  // After max retries, BullMQ marks the job failed. Mark the broadcast failed
  // (terminal) and emit the broadcast_failed webhook so subscribers know.
  worker.on('failed', async (job, err) => {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const { organizationId, broadcastId } = job.data;
    try {
      await prisma.broadcast.update({
        where: { id: broadcastId },
        data: { status: 'failed', completedAt: new Date() },
      });
      await prisma.broadcastEvent.create({
        data: {
          organizationId,
          broadcastId,
          kind: 'failed',
          detail: { error: err.message?.slice(0, 500) ?? 'fanout exhausted' },
        },
      });
      await emitWebhookEvent({
        organizationId,
        eventKind: 'broadcast_failed',
        payload: { broadcastId, error: err.message?.slice(0, 500) ?? 'fanout exhausted' },
      });
    } catch (e) {
      console.error('[broadcast-fanout] failed-handler error', e);
    }
  });
  return worker;
}

void env; // keep env import side-effects if any are added later
