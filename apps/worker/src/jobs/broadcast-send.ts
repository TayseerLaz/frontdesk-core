// Phase 4 — Broadcast send worker.
//
// One job per BroadcastRecipient. Calls Meta /messages with a template payload
// (resolved variables become `body` component parameters), updates the recipient
// row, and increments campaign counters. Honors a per-org Redis token bucket so
// the global send rate stays under Meta's tier limit.
//
// Auto-pause: after RECIPIENT_FAIL_BURST consecutive recipient failures inside
// a short window, the broadcast is paused and a `recipient_failed_burst` event
// is emitted.
import { DelayedError, Worker } from 'bullmq';

import { emitWebhookEvent } from '../lib/emit-webhook.js';
import { getConnection } from '../lib/redis.js';
import { safeFetch } from '../lib/safe-fetch.js';
import { canAfford, chargeAtSend, notifyBalanceCapped } from '../lib/wallet.js';
import { getObjectStream } from '../lib/storage.js';

import { prisma } from './db.js';
import { recordOutboundTemplate } from './inbox-consistency.js';

// Resolve a template's media-header (IMAGE/VIDEO/DOCUMENT) sample into a WhatsApp
// media id usable in a send-time header component. Uploads the sample to
// /{phone_number_id}/media once and caches the id per template (Redis, 24h) so a
// broadcast to N recipients uploads once, not N times.
async function resolveTemplateHeaderMedia(
  template: { id: string; components: unknown },
  channel: { phoneNumberId: string | null; accessToken: string | null },
): Promise<{ format: 'image' | 'video' | 'document'; id: string } | { error: string } | null> {
  const comps = Array.isArray(template.components)
    ? (template.components as Record<string, unknown>[])
    : [];
  const header = comps.find(
    (c) =>
      String(c.type ?? '').toUpperCase() === 'HEADER' &&
      ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(c.format ?? '').toUpperCase()),
  );
  if (!header) return null; // text-only template — nothing to do
  if (!channel.phoneNumberId || !channel.accessToken) {
    return { error: 'WhatsApp channel is missing its phone number or access token.' };
  }
  const phoneNumberId = channel.phoneNumberId;
  const accessToken = channel.accessToken;
  const format = String(header.format).toLowerCase() as 'image' | 'video' | 'document';
  const example = (header.example ?? {}) as { header_handle?: unknown };
  const handleUrl = Array.isArray(example.header_handle) ? example.header_handle[0] : null;
  if (typeof handleUrl !== 'string' || !handleUrl) {
    return { error: 'This template’s header has no sample media to broadcast.' };
  }

  const redis = getConnection();
  // Bust the cache automatically if the sample image changes.
  let hash = 0;
  for (let i = 0; i < handleUrl.length; i++) hash = (hash * 31 + handleUrl.charCodeAt(i)) | 0;
  const cacheKey = `wa-tpl-media:${template.id}:${(hash >>> 0).toString(36)}`;
  const cached = await redis.get(cacheKey);
  if (cached) return { format, id: cached };

  const mimeFor = (s: string): string => {
    const ext = (s.split('?')[0]!.split('.').pop() ?? '').toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'pdf') return 'application/pdf';
    return 'image/jpeg';
  };

  // Fetch the sample bytes — prefer our own storage (private bucket), else the
  // external URL via the SSRF-safe fetcher.
  let bytes: Buffer;
  let mime = mimeFor(handleUrl);
  try {
    const storageKey = decodeURIComponent(new URL(handleUrl).pathname.replace(/^\/+/, ''));
    const stream = await getObjectStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Buffer));
    bytes = Buffer.concat(chunks);
  } catch {
    try {
      const res = await safeFetch(handleUrl, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { error: `Couldn’t fetch the header media (HTTP ${res.status}).` };
      mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim() || mime;
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      return { error: 'Couldn’t read the template’s header media.' };
    }
  }

  // Upload to WhatsApp media → reusable media id.
  try {
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', mime);
    fd.append('file', new Blob([bytes], { type: mime }), `header.${mime.split('/')[1] ?? 'bin'}`);
    const up = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(phoneNumberId)}/media`,
      { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: fd },
    );
    const upj = (await up.json().catch(() => null)) as { id?: string; error?: unknown } | null;
    if (!up.ok || !upj?.id) {
      return { error: `WhatsApp rejected the header media: ${JSON.stringify(upj?.error ?? upj)}` };
    }
    await redis.set(cacheKey, upj.id, 'EX', 86_400);
    return { format, id: upj.id };
  } catch (err) {
    return { error: `Header media upload failed: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

const QUEUE_SEND = 'broadcast-send';
const SEND_CONCURRENCY = Number(process.env.BROADCAST_SEND_CONCURRENCY ?? 10);
const TOKEN_LIMIT = Number(process.env.WHATSAPP_SEND_TOKENS_PER_SECOND ?? 80);
const RECIPIENT_FAIL_BURST = 25;

interface SendJobData {
  organizationId: string;
  broadcastId: string;
  recipientId: string;
}

// Permanent Meta error codes — don't retry these. See Meta's WhatsApp errors:
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const PERMANENT_META_CODES = new Set([
  '131005', // re-engagement-message
  '131008', // required parameter missing
  '131009', // parameter value invalid
  '131021', // recipient cannot receive (e.g. blocked)
  '131026', // unable to deliver — maybe not WA user
  '131047', // re-engagement-message
  '131048', // spam rate limit
  '132000', // template name not found
  '132001', // template translation not found
  '132005', // template hydrated text exceeds limit
  '132007', // template format character policy violated
  '132012', // template parameter format mismatch
  '132015', // template paused
  '132016', // template disabled
  '132068', // flow blocked
]);

// Phase 5.3 — TZ helpers. Use Intl.DateTimeFormat with the tz to get the
// hour/minute "as the recipient sees it"; avoids pulling in luxon/date-fns.
function nowInTz(tz: string): { hour: number; minute: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    // Some locales render "24" for midnight — normalize to 0.
    return { hour: h % 24, minute: m };
  } catch {
    const d = new Date();
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
}

function msUntilHour(tz: string, targetHour: number): number {
  // How many milliseconds until the next time the local clock in `tz`
  // shows targetHour:00. Conservative — clamps to ≤ 24h, ≥ 60s.
  const { hour, minute } = nowInTz(tz);
  let hoursToWait = (targetHour - hour + 24) % 24;
  if (hoursToWait === 0 && minute > 0) hoursToWait = 24; // already past this hour today
  const ms = hoursToWait * 3600 * 1000 - minute * 60 * 1000;
  return Math.max(60_000, Math.min(ms, 24 * 3600 * 1000));
}

// Keyed PER NUMBER (phone_number_id) — Meta's throughput limit is per-number,
// so with multi-number sending each number gets its own bucket. Falls back to
// the org id when no phone number id is available.
async function consumeSendToken(bucketKey: string): Promise<{ ok: boolean; retryAfterMs: number }> {
  const redis = getConnection();
  const key = `wasend:${bucketKey}:${Math.floor(Date.now() / 1000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 2);
  if (count > TOKEN_LIMIT) return { ok: false, retryAfterMs: 1000 };
  return { ok: true, retryAfterMs: 0 };
}

async function bumpFailureBurst(orgId: string, broadcastId: string): Promise<number> {
  const redis = getConnection();
  const key = `bcburst:${broadcastId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count;
}

async function clearFailureBurst(broadcastId: string): Promise<void> {
  await getConnection().del(`bcburst:${broadcastId}`);
}

interface MetaResponse {
  messages?: { id?: string }[];
  error?: { code?: number | string; message?: string };
}

// Render the full customer-facing template for the inbox bubble: header (text)
// + body + footer with {{n}}/header_text interpolated, the button labels, and
// the header image URL (IMAGE templates). Mirrors the WhatsApp test-send path so
// broadcast-sent templates look identical in the inbox.
function renderTemplatePreview(
  components: Record<string, unknown>[],
  variables: Record<string, string>,
  templateName: string,
  language: string,
): { body: string; quickReplies: string[]; headerImageUrl: string | null } {
  const interpolate = (tpl: string, vals: string[]) =>
    tpl.replace(/{{\s*(\d+)\s*}}/g, (_m, idx: string) => vals[Number(idx) - 1] ?? `{{${idx}}}`);
  const byType = (want: string) =>
    components.find((c) => String((c as { type?: string }).type ?? '').toUpperCase() === want) as
      | {
          format?: string;
          text?: string;
          buttons?: { text?: string }[];
          example?: { header_handle?: string[] };
        }
      | undefined;

  const bodyParams = Object.keys(variables)
    .filter((k) => /^\d+$/.test(k))
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => variables[String(i)] ?? '');

  const header = byType('HEADER');
  const headerFmt = String(header?.format ?? '').toUpperCase();
  const headerText =
    header && headerFmt === 'TEXT' && header.text
      ? interpolate(String(header.text), variables.header_text ? [variables.header_text] : [])
      : '';
  const bodyComp = byType('BODY');
  const bodyText = bodyComp?.text ? interpolate(String(bodyComp.text), bodyParams) : '';
  const footerText = byType('FOOTER')?.text ? String(byType('FOOTER')!.text) : '';
  const quickReplies = (byType('BUTTONS')?.buttons ?? [])
    .map((b) => String(b.text ?? '').trim())
    .filter(Boolean);
  const headerImageUrl =
    headerFmt === 'IMAGE' ? (header?.example?.header_handle?.[0] ?? null) : null;

  const tagLine = `📨 Template · ${templateName}${language !== 'en_US' ? ` (${language})` : ''}`;
  const full = [headerText, bodyText, footerText].filter(Boolean).join('\n\n');
  return { body: full ? `${tagLine}\n\n${full}` : tagLine, quickReplies, headerImageUrl };
}

async function callMeta(args: {
  token: string;
  phoneNumberId: string;
  to: string;
  templateName: string;
  language: string;
  variables: Record<string, string>;
  headerMedia?: { format: 'image' | 'video' | 'document'; id: string };
  // The template's full component spec — used to place a dynamic TEXT-header
  // value and dynamic URL-button parameters in the right send components.
  components?: Record<string, unknown>[];
}): Promise<{
  ok: boolean;
  metaMessageId: string | null;
  metaErrorCode: string | null;
  metaErrorMessage: string | null;
  status: number;
  permanent: boolean;
}> {
  // Meta expects `components: [{ type: "body", parameters: [{ type: "text", text }, ...] }]`
  // with parameters in the order matching {{1}}, {{2}}, ... in the template body.
  const indices = Object.keys(args.variables)
    .filter((k) => /^\d+$/.test(k))
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  const parameters = indices.map((idx) => ({
    type: 'text' as const,
    text: args.variables[String(idx)] ?? '',
  }));

  const tplComps = Array.isArray(args.components) ? args.components : [];
  const components: Record<string, unknown>[] = [];

  // HEADER: media (uploaded id) OR a dynamic TEXT header ({{1}} → variables.header_text).
  if (args.headerMedia) {
    components.push({
      type: 'header',
      parameters: [
        { type: args.headerMedia.format, [args.headerMedia.format]: { id: args.headerMedia.id } },
      ],
    });
  } else {
    const textHeader = tplComps.find(
      (c) =>
        String(c.type ?? '').toUpperCase() === 'HEADER' &&
        String(c.format ?? '').toUpperCase() === 'TEXT',
    );
    const headerVal = args.variables.header_text;
    if (textHeader && /\{\{\s*1\s*\}\}/.test(String(textHeader.text ?? '')) && headerVal) {
      components.push({ type: 'header', parameters: [{ type: 'text', text: headerVal }] });
    }
  }

  // BODY: positional {{1}}, {{2}}, … from numeric variable keys.
  if (parameters.length > 0) components.push({ type: 'body', parameters });

  // BUTTONS: dynamic URL buttons ({{1}} in the URL → variables.button_url_<index>).
  const buttonsComp = tplComps.find((c) => String(c.type ?? '').toUpperCase() === 'BUTTONS') as
    | { buttons?: { type?: string; url?: string }[] }
    | undefined;
  (buttonsComp?.buttons ?? []).forEach((b, i) => {
    if (String(b.type ?? '').toUpperCase() !== 'URL') return;
    if (!/\{\{\s*1\s*\}\}/.test(String(b.url ?? ''))) return;
    const val = args.variables[`button_url_${i}`];
    if (!val) return;
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(i),
      parameters: [{ type: 'text', text: val }],
    });
  });

  const payload = {
    messaging_product: 'whatsapp',
    to: args.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: args.templateName,
      language: { code: args.language },
      ...(components.length > 0 ? { components } : {}),
    },
  };

  let res: Response;
  try {
    res = await fetch(
      `https://graph.facebook.com/v25.0/${encodeURIComponent(args.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err) {
    return {
      ok: false,
      metaMessageId: null,
      metaErrorCode: null,
      metaErrorMessage: err instanceof Error ? err.message : 'fetch failed',
      status: 0,
      permanent: false,
    };
  }

  const text = await res.text();
  let parsed: MetaResponse | null = null;
  try {
    parsed = JSON.parse(text) as MetaResponse;
  } catch {
    parsed = null;
  }

  if (res.status >= 200 && res.status < 300 && parsed?.messages?.[0]?.id) {
    return {
      ok: true,
      metaMessageId: parsed.messages[0].id ?? null,
      metaErrorCode: null,
      metaErrorMessage: null,
      status: res.status,
      permanent: false,
    };
  }

  const code = parsed?.error?.code != null ? String(parsed.error.code) : null;
  const message = parsed?.error?.message ?? text.slice(0, 500);
  const permanent =
    (code != null && PERMANENT_META_CODES.has(code)) ||
    (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
  return {
    ok: false,
    metaMessageId: null,
    metaErrorCode: code,
    metaErrorMessage: message,
    status: res.status,
    permanent,
  };
}

export function startBroadcastSendWorker() {
  const worker = new Worker<SendJobData>(
    QUEUE_SEND,
    async (job) => {
      const { organizationId, broadcastId, recipientId } = job.data;

      // Re-check broadcast status.
      // - cancelled → terminal: mark recipient skipped, don't retry.
      // - paused → don't send, but leave recipient `queued` so resume picks
      //   it up. We move the BullMQ job back to delayed (~5 min) instead of
      //   failing it, so it self-retries when the operator un-pauses.
      const broadcast = await prisma.broadcast.findUnique({ where: { id: broadcastId } });
      if (!broadcast) return;
      // SECURITY (H-2): the worker runs with the RLS-bypassing owner client, so
      // guard the broadcast against the job payload's org — mirror the fanout
      // worker's own-org check. Refuse a broadcast/org mismatch so a crafted or
      // stale job can't drive a send under the wrong tenant.
      if (broadcast.organizationId !== organizationId) return;
      if (broadcast.status === 'cancelled' || broadcast.status === 'completed') {
        // Cancelled, or reaped after the 1-hour send window closed — don't send
        // late. Any still-unsent recipient becomes skipped.
        await prisma.broadcastRecipient.updateMany({
          where: { id: recipientId, status: { in: ['queued', 'pending'] } },
          data: { status: 'skipped' },
        });
        return;
      }
      if (broadcast.status === 'paused') {
        // Re-queue with a 30s delay so the job self-retries when the operator
        // un-pauses. moveToDelayed + DelayedError is the BullMQ v5 idiom for
        // "park this job; don't count an attempt."
        if (job.token) await job.moveToDelayed(Date.now() + 30_000, job.token);
        throw new DelayedError();
      }

      const recipient = await prisma.broadcastRecipient.findUnique({
        where: { id: recipientId },
        include: { contact: { select: { optedOutAt: true, blockedAt: true, timezone: true } } },
      });
      if (!recipient) return;
      if (
        recipient.status === 'sent' ||
        recipient.status === 'delivered' ||
        recipient.status === 'read' ||
        recipient.status === 'skipped'
      ) {
        return; // Already handled (terminal).
      }

      // Phase 5.3 — opt-out gate. Skip without retry; counts as failed-soft.
      // Blocked contacts are ALWAYS skipped (operator block). Opted-out
      // (unsubscribed) contacts are skipped UNLESS the operator chose "send
      // anyway" on this broadcast (broadcast.includeOptedOut).
      //
      // CRITICAL: never trust the contact LINK alone. Manual audiences (and any
      // CSV row whose contact lookup missed) create recipients with
      // contactId = null, so `recipient.contact` is null and an unsubscribed
      // person sails through this gate — that is exactly how opted-out
      // customers received broadcasts in production. Always resolve the contact
      // by PHONE when the link is missing, so the gate is keyed on the person,
      // not on the row's bookkeeping.
      let contactState = recipient.contact as
        | { optedOutAt: Date | null; blockedAt: Date | null; timezone: string | null }
        | null;
      if (!contactState && recipient.phoneE164) {
        contactState = await prisma.contact.findFirst({
          where: {
            organizationId: recipient.organizationId,
            phoneE164: recipient.phoneE164,
            deletedAt: null,
          },
          select: { optedOutAt: true, blockedAt: true, timezone: true },
        });
      }
      // Opt-out must survive phone-format DUPLICATES. The same person is often
      // stored twice — e.g. +9613330707 and +96103330707, the national trunk
      // "0" kept or dropped — and in production the unsubscribe landed on one
      // row while the broadcast was addressed to the other, so the customer
      // kept receiving campaigns after tapping Unsubscribe.
      //
      // Matching on a trailing-digit window would be unsafe (+9613330707 and
      // +9743330707 are different people in different countries). Instead match
      // only numbers related by a SINGLE inserted/removed zero, which is
      // precisely the trunk-prefix mistake, and never collides across
      // countries.
      if (!contactState?.optedOutAt && !contactState?.blockedAt) {
        const digits = (recipient.phoneE164 ?? '').replace(/\D/g, '');
        const variants = new Set<string>();
        for (let i = 0; i < digits.length; i++) {
          if (digits[i] === '0') variants.add(digits.slice(0, i) + digits.slice(i + 1)); // drop a zero
          variants.add(digits.slice(0, i) + '0' + digits.slice(i)); // insert a zero
        }
        variants.delete(digits);
        if (variants.size > 0) {
          const twin = await prisma.contact.findFirst({
            where: {
              organizationId: recipient.organizationId,
              deletedAt: null,
              phoneE164: { in: [...variants].map((v) => `+${v}`) },
              OR: [{ optedOutAt: { not: null } }, { blockedAt: { not: null } }],
            },
            select: { optedOutAt: true, blockedAt: true, timezone: true },
          });
          if (twin) contactState = { ...(contactState ?? { timezone: null }), ...twin };
        }
      }
      const blocked = !!contactState?.blockedAt;
      const optedOut = !!contactState?.optedOutAt && !broadcast.includeOptedOut;
      if (blocked || optedOut) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'skipped',
            metaErrorCode: blocked ? 'blocked' : 'opted_out',
            metaErrorMessage: blocked
              ? 'Recipient is blocked by the operator.'
              : 'Recipient opted out of broadcasts.',
          },
        });
        return;
      }

      // Phase 5.3 — send-window enforcement. If outside the configured
      // window, requeue the job to fire at the next window-open.
      if (broadcast.sendWindowStartHour != null && broadcast.sendWindowEndHour != null) {
        const tz = contactState?.timezone || broadcast.sendWindowTimezone || 'UTC';
        const nowParts = nowInTz(tz);
        const startH = broadcast.sendWindowStartHour;
        const endH = broadcast.sendWindowEndHour;
        const hour = nowParts.hour;
        const inWindow =
          startH <= endH ? hour >= startH && hour < endH : hour >= startH || hour < endH;
        if (!inWindow) {
          // Compute milliseconds until the window opens.
          const delayMs = msUntilHour(tz, startH);
          if (job.token) await job.moveToDelayed(Date.now() + delayMs, job.token);
          throw new DelayedError();
        }
      }

      // Multi-number: send from the number this recipient was assigned at
      // fanout; fall back to the broadcast's primary number for legacy rows.
      const sendChannelId = recipient.whatsAppChannelId ?? broadcast.channelId;
      // SECURITY (H-2): scope the channel load to the broadcast's own org. The
      // owner client bypasses RLS, so a `channelId` that was PATCHed to point at
      // ANOTHER org's number would otherwise load that org's decrypted Meta
      // credentials and send on them. A cross-tenant (or missing) channel now
      // returns null and falls into the "unconfigured" branch below — no send.
      const channel = await prisma.whatsAppChannel.findFirst({
        where: { id: sendChannelId, organizationId: broadcast.organizationId },
      });
      if (!channel || !channel.accessToken || !channel.phoneNumberId) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorCode: 'channel_unconfigured',
            metaErrorMessage: 'WhatsApp channel missing access token or phone number ID.',
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { failedCount: { increment: 1 } },
        });
        return;
      }

      // Metered billing (docs/wallet-billing-plan.md). A broadcast carries a
      // per-message price snapshot iff the tenant was metered at accept time.
      // Charge-at-send per recipient: if the balance can't cover this message,
      // skip it (cap-to-balance — never overspend) and notify the tenant once.
      const meteredPriceMicros = broadcast.billingUnitPriceMicros;
      if (meteredPriceMicros != null) {
        const affordable = await canAfford(organizationId, Number(meteredPriceMicros));
        if (!affordable) {
          await prisma.broadcastRecipient.update({
            where: { id: recipientId },
            data: {
              status: 'skipped',
              metaErrorCode: 'insufficient_balance',
              metaErrorMessage: 'WhatsApp balance exhausted — top up to send the rest.',
            },
          });
          await notifyBalanceCapped(organizationId, broadcastId);
          return;
        }
      }

      // Token bucket (per number — Meta limits throughput per phone_number_id).
      // Consumed only once we know the send will actually go out (after the
      // opt-out / send-window gates), so skips/delays don't waste tokens. If
      // exhausted, throw to let BullMQ retry with backoff.
      const tok = await consumeSendToken(channel.phoneNumberId ?? organizationId);
      if (!tok.ok) {
        throw new Error(`token-bucket: retry in ${tok.retryAfterMs}ms`);
      }

      const templateId = recipient.variant === 'B' && broadcast.variantBTemplateId
        ? broadcast.variantBTemplateId
        : broadcast.variantATemplateId;
      const template = await prisma.whatsAppTemplate.findUnique({ where: { id: templateId } });
      if (!template) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorCode: 'template_missing',
            metaErrorMessage: 'Template no longer exists.',
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { failedCount: { increment: 1 } },
        });
        return;
      }

      // Media-header templates (IMAGE/VIDEO/DOCUMENT): upload the header sample
      // to WhatsApp and include it as a header component. If that fails, fail
      // the recipient with a CLEAR reason (not Meta's cryptic 132012).
      const headerMedia = await resolveTemplateHeaderMedia(template, channel);
      if (headerMedia && 'error' in headerMedia) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorCode: 'header_media',
            metaErrorMessage: headerMedia.error,
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { failedCount: { increment: 1 } },
        });
        return;
      }

      await prisma.broadcastRecipient.update({
        where: { id: recipientId },
        data: { attemptCount: { increment: 1 } },
      });

      const variables =
        (recipient.variables as Record<string, string> | null) ?? {};
      const out = await callMeta({
        token: channel.accessToken,
        phoneNumberId: channel.phoneNumberId,
        to: recipient.phoneE164,
        templateName: template.name,
        language: template.language,
        variables,
        headerMedia: headerMedia ?? undefined,
        components: Array.isArray(template.components)
          ? (template.components as Record<string, unknown>[])
          : undefined,
      });

      if (out.ok) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'sent',
            sentAt: new Date(),
            metaMessageId: out.metaMessageId,
            metaErrorCode: null,
            metaErrorMessage: null,
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { sentCount: { increment: 1 } },
        });
        // Metered billing: charge this delivered message. Idempotent per
        // recipient (billed_at). We charge AFTER a confirmed send so failed
        // sends are never billed; the pre-send `canAfford` gate keeps this
        // from ever pushing the balance negative.
        if (meteredPriceMicros != null) {
          await chargeAtSend({
            orgId: organizationId,
            unitPriceMicros: Number(meteredPriceMicros),
            metaCostMicros: broadcast.billingMetaCostMicros != null ? Number(broadcast.billingMetaCostMicros) : undefined,
            broadcastId,
            recipientId,
          });
        }
        // Record an outbound WhatsAppMessage row LINKED to the customer's
        // inbox thread so it actually shows in the inbox (was an orphaned,
        // thread-less row that never appeared in any conversation).
        const rendered = renderTemplatePreview(
          Array.isArray(template.components)
            ? (template.components as Record<string, unknown>[])
            : [],
          variables,
          template.name,
          template.language,
        );
        await recordOutboundTemplate({
          organizationId,
          toNumber: recipient.phoneE164,
          metaMessageId: out.metaMessageId,
          templateName: template.name,
          whatsAppChannelId: sendChannelId,
          renderedBody: rendered.body,
          quickReplies: rendered.quickReplies,
          headerImageUrl: rendered.headerImageUrl,
        });
        await clearFailureBurst(broadcastId);
        return;
      }

      // Permanent failure — don't retry.
      if (out.permanent) {
        await prisma.broadcastRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorCode: out.metaErrorCode,
            metaErrorMessage: out.metaErrorMessage,
          },
        });
        await prisma.broadcast.update({
          where: { id: broadcastId },
          data: { failedCount: { increment: 1 } },
        });
        await emitWebhookEvent({
          organizationId,
          eventKind: 'broadcast_recipient_failed',
          payload: {
            broadcastId,
            recipientId,
            phoneE164: recipient.phoneE164,
            metaErrorCode: out.metaErrorCode,
            metaErrorMessage: out.metaErrorMessage,
          },
        });
        const burst = await bumpFailureBurst(organizationId, broadcastId);
        if (burst >= RECIPIENT_FAIL_BURST) {
          await prisma.broadcast.update({
            where: { id: broadcastId },
            data: { status: 'paused' },
          });
          await prisma.broadcastEvent.create({
            data: {
              organizationId,
              broadcastId,
              kind: 'recipient_failed_burst',
              detail: { count: burst },
            },
          });
          await clearFailureBurst(broadcastId);
        }
        return;
      }

      // Transient — let BullMQ retry. We bumped attemptCount above; if attempts
      // are exhausted the queue will surface it as a 'failed' job and the
      // recipient is left in `queued` (operator can manual-retry).
      throw new Error(
        `meta send failed (status=${out.status}, code=${out.metaErrorCode}): ${out.metaErrorMessage}`,
      );
    },
    {
      connection: getConnection(),
      concurrency: SEND_CONCURRENCY,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    // After max attempts BullMQ marks the job failed; capture that as a
    // permanent recipient failure so the campaign-level state is consistent.
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const data = job.data;
      await prisma.broadcastRecipient
        .update({
          where: { id: data.recipientId },
          data: {
            status: 'failed',
            failedAt: new Date(),
            metaErrorMessage: err.message?.slice(0, 500) ?? 'send failed after retries',
          },
        })
        .catch(() => undefined);
      await prisma.broadcast
        .update({
          where: { id: data.broadcastId },
          data: { failedCount: { increment: 1 } },
        })
        .catch(() => undefined);
    }
  });

  // After every send, if all recipients are terminal, mark the broadcast
  // completed. Done lazily after a short debounce.
  worker.on('completed', async (job) => {
    const data = job.data;
    const remaining = await prisma.broadcastRecipient.count({
      where: { broadcastId: data.broadcastId, status: { in: ['pending', 'queued'] } },
    });
    if (remaining > 0) return;
    const b = await prisma.broadcast.findUnique({ where: { id: data.broadcastId } });
    if (!b) return;
    if (b.status === 'sending') {
      // Phase 5.3 — A/B winner determination, post-hoc.
      let abWinnerVariant: 'A' | 'B' | null = null;
      if (b.abTest && b.abWinnerStrategy && b.abWinnerStrategy !== 'manual') {
        const grouped = await prisma.broadcastRecipient.groupBy({
          by: ['variant'],
          where: { broadcastId: b.id },
          _count: { _all: true },
          _sum: undefined,
        });
        // Compute per-variant counters via a follow-up query (cheap).
        const counters = await Promise.all(
          ['A', 'B'].map(async (v) => {
            const total = await prisma.broadcastRecipient.count({
              where: { broadcastId: b.id, variant: v as 'A' | 'B' },
            });
            const reads = await prisma.broadcastRecipient.count({
              where: { broadcastId: b.id, variant: v as 'A' | 'B', status: 'read' },
            });
            return { v, total, reads };
          }),
        );
        const a = counters.find((c) => c.v === 'A')!;
        const bVar = counters.find((c) => c.v === 'B')!;
        if (a.total > 0 && bVar.total > 0) {
          const aRate = a.reads / a.total;
          const bRate = bVar.reads / bVar.total;
          abWinnerVariant = aRate >= bRate ? 'A' : 'B';
        }
        void grouped;
      }
      await prisma.broadcast.update({
        where: { id: b.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          ...(abWinnerVariant
            ? { abWinnerVariant, abWinnerDecidedAt: new Date() }
            : {}),
        },
      });
      await prisma.broadcastEvent.create({
        data: {
          organizationId: data.organizationId,
          broadcastId: b.id,
          kind: 'completed',
          detail: abWinnerVariant ? { abWinnerVariant } : undefined,
        },
      });
      await emitWebhookEvent({
        organizationId: data.organizationId,
        eventKind: 'broadcast_completed',
        payload: {
          broadcastId: b.id,
          name: b.name,
          totalRecipients: b.totalRecipients,
          sentCount: b.sentCount,
          deliveredCount: b.deliveredCount,
          readCount: b.readCount,
          failedCount: b.failedCount,
          abWinnerVariant,
        },
      });
    }
  });

  return worker;
}
