import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

import { env } from './env.js';

// Single shared connection for queue producers (api). Workers use their own.
let connection: IORedis | null = null;

function getConnection(): IORedis {
  if (connection) return connection;
  connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

// ----- Queue names ---------------------------------------------------------
export const QUEUE_IMPORT = 'import';
export const QUEUE_SYNC = 'sync';
export const QUEUE_WEBHOOK_DELIVERY = 'webhook-delivery';
export const QUEUE_EMAIL = 'email';
export const QUEUE_CRAWL = 'crawl';
export const QUEUE_DATA_EXPORT = 'data-export';
// Phase 4 — Broadcasts.
export const QUEUE_BROADCAST_FANOUT = 'broadcast-fanout';
export const QUEUE_BROADCAST_SEND = 'broadcast-send';
// Shopify integration — one queue, two phases (scrape → staging, commit → import).
export const QUEUE_SHOPIFY = 'shopify';

// ----- Job payload types (single source of truth shared with worker) ------
export interface ImportJobPayload {
  organizationId: string;
  importJobId: string;
}

export interface SyncJobPayload {
  organizationId: string;
  connectorId: string;
  /**
   * Pre-allocated SyncRun id for manual/webhook triggers. NULL for scheduled
   * (BullMQ repeatable) triggers — the worker creates the SyncRun row itself
   * because the cron payload is shared across every fire.
   */
  syncRunId: string | null;
  trigger: 'scheduled' | 'manual' | 'webhook';
}

export interface WebhookDeliveryPayload {
  organizationId: string;
  deliveryId: string;
}

export interface EmailJobPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface CrawlJobPayload {
  organizationId: string;
  crawlJobId: string;
}

export interface DataExportPayload {
  organizationId: string;
  requestedByUserId: string;
  requestedByEmail: string;
  exportId: string;
  // Which dataset sections to include (keys from shared EXPORT_SECTIONS).
  // Empty / omitted = full export.
  sections?: string[];
  // 'csv' | 'pdf'. Default csv.
  format?: string;
  // 'combined' | 'separate' (PDF only). Default combined.
  layout?: string;
}

// Phase 4 — Broadcasts.
// One job per broadcast — materializes recipients then enqueues per-recipient
// send jobs. Restart-safe: the worker filters by `BroadcastRecipient.status`
// when re-running so already-sent recipients are skipped.
export interface BroadcastFanoutPayload {
  organizationId: string;
  broadcastId: string;
}

// One job per recipient — calls Meta `/messages` for the chosen template.
export interface BroadcastSendPayload {
  organizationId: string;
  broadcastId: string;
  recipientId: string;
}

// Shopify — one payload, two phases.
//   scrape: pull from Shopify into shopify_staged_items for review.
//   commit: import the approved staged rows into the live catalog.
// scrapeRunId is pre-allocated for manual/webhook triggers; NULL for scheduled
// (the repeatable cron payload is shared across fires, so the worker creates it).
export interface ShopifyJobPayload {
  organizationId: string;
  connectionId: string;
  scrapeRunId: string | null;
  phase: 'scrape' | 'commit';
  trigger: 'scheduled' | 'manual' | 'webhook';
}

// ----- Queue singletons (lazy) --------------------------------------------
let importQueue: Queue<ImportJobPayload> | null = null;
let syncQueue: Queue<SyncJobPayload> | null = null;
let webhookQueue: Queue<WebhookDeliveryPayload> | null = null;
let emailQueue: Queue<EmailJobPayload> | null = null;

export function getImportQueue(): Queue<ImportJobPayload> {
  if (!importQueue) importQueue = new Queue(QUEUE_IMPORT, { connection: getConnection() });
  return importQueue;
}

export function getSyncQueue(): Queue<SyncJobPayload> {
  if (!syncQueue) {
    syncQueue = new Queue(QUEUE_SYNC, { connection: getConnection() });
  }
  return syncQueue;
}

export function getWebhookQueue(): Queue<WebhookDeliveryPayload> {
  if (!webhookQueue) {
    webhookQueue = new Queue(QUEUE_WEBHOOK_DELIVERY, { connection: getConnection() });
  }
  return webhookQueue;
}

export function getEmailQueue(): Queue<EmailJobPayload> {
  if (!emailQueue) emailQueue = new Queue(QUEUE_EMAIL, { connection: getConnection() });
  return emailQueue;
}

let crawlQueue: Queue<CrawlJobPayload> | null = null;
export function getCrawlQueue(): Queue<CrawlJobPayload> {
  if (!crawlQueue) crawlQueue = new Queue(QUEUE_CRAWL, { connection: getConnection() });
  return crawlQueue;
}

let dataExportQueue: Queue<DataExportPayload> | null = null;
export function getDataExportQueue(): Queue<DataExportPayload> {
  if (!dataExportQueue) {
    dataExportQueue = new Queue(QUEUE_DATA_EXPORT, { connection: getConnection() });
  }
  return dataExportQueue;
}

// Phase 4 — Broadcast queues.
let broadcastFanoutQueue: Queue<BroadcastFanoutPayload> | null = null;
export function getBroadcastFanoutQueue(): Queue<BroadcastFanoutPayload> {
  if (!broadcastFanoutQueue) {
    broadcastFanoutQueue = new Queue(QUEUE_BROADCAST_FANOUT, { connection: getConnection() });
  }
  return broadcastFanoutQueue;
}

let broadcastSendQueue: Queue<BroadcastSendPayload> | null = null;
export function getBroadcastSendQueue(): Queue<BroadcastSendPayload> {
  if (!broadcastSendQueue) {
    broadcastSendQueue = new Queue(QUEUE_BROADCAST_SEND, { connection: getConnection() });
  }
  return broadcastSendQueue;
}

// Shopify integration queue.
let shopifyQueue: Queue<ShopifyJobPayload> | null = null;
export function getShopifyQueue(): Queue<ShopifyJobPayload> {
  if (!shopifyQueue) shopifyQueue = new Queue(QUEUE_SHOPIFY, { connection: getConnection() });
  return shopifyQueue;
}

// QueueEvents — used by API to subscribe to progress (e.g. for SSE on imports).
let importEvents: QueueEvents | null = null;
export function getImportQueueEvents(): QueueEvents {
  if (!importEvents) importEvents = new QueueEvents(QUEUE_IMPORT, { connection: getConnection() });
  return importEvents;
}
