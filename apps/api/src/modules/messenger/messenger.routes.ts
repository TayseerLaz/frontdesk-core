// Facebook Messenger channel — config + inbound webhook + AI reply.
//
// Reuses the channel-agnostic bot engine (gatherBotData + buildBotResponse);
// only the transport (Meta Send API) and identity (PSID) are Messenger-
// specific. WhatsApp is untouched. Inert until a tenant configures a Page +
// token, so deploying this is zero-risk. Instagram DMs (Phase C) ride the same
// Send API and slot in here later.
//
// v1 scope: text replies (markers stripped). Product images, cart/booking
// markers, and the per-PSID blocked-contact gate are follow-ups.
import crypto from 'node:crypto';

import { decryptSecret, encryptSecret } from '@platform/db';
import {
  ApiErrorCode,
  itemEnvelopeSchema,
  messengerChannelSchema,
  successSchema,
  uuidSchema,
  upsertMessengerChannelBodySchema,
} from '@platform/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { canSendAiMessage, recordAiMessages } from '../../lib/ai-messages.js';
import { recordAudit, recordCredentialAudit } from '../../lib/audit.js';
import { withRlsBypass, type Tx } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { BookingAvailability } from '../../lib/booking-slots.js';
import type { BookingFormLite, CatalogProductLite, ShopFormLite } from '../../lib/cart-flow.js';
import { env } from '../../lib/env.js';
import { generateOpaqueToken } from '../../lib/crypto.js';
import { publishInboxEvent } from '../../lib/inbox-events.js';
import { normalizeMarkdownForChannel } from '../../lib/markdown-normalize.js';

function webhookCallbackUrl(orgId: string): string {
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/messenger/webhook/${orgId}`;
}

// Strip the bot engine's internal markers from a reply before sending — the
// Messenger transport doesn't (yet) act on them; the customer must never see
// the literal tokens.
function stripMarkers(text: string): string {
  return text
    .replace(/\[IMAGE:[^\]]*\]/gi, '')
    .replace(/\[CART:[\s\S]*?\]/gi, '')
    .replace(/\[BOOKING:[\s\S]*?\]/gi, '')
    .replace(/\[BUTTONS:[^\]]*\]/gi, '')
    .replace(/\[(HANDOFF|PAYMENT_LINK|CLEAR_CART)\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function serialize(row: {
  pageId: string | null;
  pageName: string | null;
  igAccountId: string | null;
  pageAccessToken: string | null;
  appSecret: string | null;
  isActive: boolean;
  webhookVerifyToken: string;
  lastVerifyStatus: string | null;
  updatedAt: Date;
  organizationId: string;
}) {
  const hasToken = !!row.pageAccessToken;
  const hasSecret = !!row.appSecret;
  return {
    pageId: row.pageId,
    pageName: row.pageName,
    igAccountId: row.igAccountId,
    hasPageAccessToken: hasToken,
    hasAppSecret: hasSecret,
    isActive: row.isActive,
    webhookVerifyToken: row.webhookVerifyToken,
    webhookCallbackUrl: webhookCallbackUrl(row.organizationId),
    ready: !!(row.pageId && hasToken && hasSecret),
    lastVerifyStatus: row.lastVerifyStatus,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

// The shape returned for an org that has never configured Messenger, when the
// caller is only reading status. Mirrors `serialize` for an empty row but
// mints nothing: `webhookVerifyToken` is '' precisely because no token exists
// yet. The callback URL is derived from the org id alone (not a secret), so it
// is safe to show. Callers that need a real token must ask to provision.
function unprovisioned(orgId: string) {
  return {
    pageId: null,
    pageName: null,
    igAccountId: null,
    hasPageAccessToken: false,
    hasAppSecret: false,
    isActive: false,
    webhookVerifyToken: '',
    webhookCallbackUrl: webhookCallbackUrl(orgId),
    ready: false,
    lastVerifyStatus: null,
    updatedAt: null,
  };
}

export default async function messengerRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /messenger ----------------------------------------------
  r.get(
    '/messenger',
    {
      schema: {
        tags: ['messenger'],
        summary: 'Get the org Messenger/Instagram channel config (secrets masked).',
        querystring: z.object({
          // Opt-in row creation. This GET used to create a MessengerChannel
          // unconditionally whenever the org had none — minting a verify token
          // and stamping updatedAt — which made a read a write. Harmless at the
          // web portal's call rate (one page visit), but the mobile Settings
          // screen polls this endpoint, so every poll on an unconfigured org
          // was a pointless INSERT attempt. A GET must not mutate.
          //
          // Provisioning is still needed by the portal's /settings/messenger
          // page, which has to SHOW the verify token + callback URL so the
          // tenant can paste them into Meta BEFORE any credentials are saved.
          // That page passes provision=true, so its behaviour is unchanged. Every
          // other caller now gets a pure read. Note the row is also created by
          // PUT /messenger (upsert), so nothing depends on this side effect.
          provision: z.enum(['true', 'false']).optional(),
        }),
        response: { 200: itemEnvelopeSchema(messengerChannelSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const row = await tx.messengerChannel.findUnique({ where: { organizationId: orgId } });
        if (row) return { data: serialize(row) };
        if (req.query.provision !== 'true') return { data: unprovisioned(orgId) };
        const created = await tx.messengerChannel.create({
          data: { organizationId: orgId, webhookVerifyToken: `vrf_${generateOpaqueToken(20)}` },
        });
        return { data: serialize(created) };
      });
    },
  );

  // ---------- PUT /messenger ----------------------------------------------
  r.put(
    '/messenger',
    {
      schema: {
        tags: ['messenger'],
        summary: 'Upsert the Messenger channel config. Credentials are write-only.',
        body: upsertMessengerChannelBodySchema,
        response: { 200: itemEnvelopeSchema(messengerChannelSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const b = req.body;
      return app.tenant(req, async (tx) => {
        const existing = await tx.messengerChannel.findUnique({ where: { organizationId: orgId } });
        // undefined = leave, '' = clear, else encrypt + set.
        const encField = (v: string | undefined, current: string | null | undefined) =>
          v === undefined ? (current ?? null) : v === '' ? null : (encryptSecret(v) ?? null);
        const data = {
          pageId: b.pageId === undefined ? existing?.pageId ?? null : b.pageId || null,
          pageName: b.pageName === undefined ? existing?.pageName ?? null : b.pageName || null,
          igAccountId: b.igAccountId === undefined ? existing?.igAccountId ?? null : b.igAccountId || null,
          pageAccessToken: encField(b.pageAccessToken, existing?.pageAccessToken),
          appSecret: encField(b.appSecret, existing?.appSecret),
          isActive: b.isActive ?? existing?.isActive ?? false,
        };
        const row = await tx.messengerChannel.upsert({
          where: { organizationId: orgId },
          create: { organizationId: orgId, webhookVerifyToken: `vrf_${generateOpaqueToken(20)}`, ...data },
          update: data,
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'messenger_channel',
          entityId: row.id,
          metadata: { event: 'messenger_channel_updated', isActive: row.isActive },
        });
        // the platform-HQ-only credential trail (encrypted; hidden from the tenant).
        // Covers Facebook Messenger AND Instagram (same channel/creds).
        await recordCredentialAudit({
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          integration: b.igAccountId ? 'messenger_instagram' : 'messenger',
          credentials: {
            pageId: b.pageId,
            pageName: b.pageName,
            igAccountId: b.igAccountId,
            pageAccessToken: b.pageAccessToken,
            appSecret: b.appSecret,
          },
          status: row.lastVerifyStatus ?? 'saved',
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });
        return { data: serialize(row) };
      });
    },
  );

  // ---------- POST /messenger/subscribe -----------------------------------
  // One-click connect: validate the Page token, capture the page name, subscribe
  // the Page to this app's `messages` webhook field so Meta delivers DMs here,
  // and activate the channel. Mirrors the WhatsApp subscribe flow.
  r.post(
    '/messenger/subscribe',
    {
      schema: {
        tags: ['messenger'],
        summary: 'Validate + subscribe the Page to the app webhook, then activate.',
        response: { 200: itemEnvelopeSchema(messengerChannelSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channel = await app.tenant(req, (tx) =>
        tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
      );
      if (!channel) throw notFound('Messenger channel not configured.');
      if (!channel.pageAccessToken) {
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Add the Page access token first.');
      }
      const pageToken = decryptSecret(channel.pageAccessToken) ?? '';
      const GRAPH = 'https://graph.facebook.com/v25.0';

      // 1. Validate token + read the page id/name.
      let pageId = channel.pageId;
      let pageName = channel.pageName;
      let status = 'subscribed';
      try {
        const meRes = await fetch(
          `${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(pageToken)}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        const me = (await meRes.json()) as { id?: string; name?: string; error?: { message?: string } };
        if (!meRes.ok || !me.id) {
          return {
            data: serialize({ ...channel, lastVerifyStatus: 'token_invalid', isActive: false }),
          };
        }
        pageId = me.id;
        pageName = me.name ?? pageName;

        // 2. Subscribe the Page to the messaging webhook fields.
        const subRes = await fetch(
          `${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              subscribed_fields: 'messages,messaging_postbacks,message_reads',
              access_token: pageToken,
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const sub = (await subRes.json()) as { success?: boolean; error?: { message?: string } };
        if (!subRes.ok || sub.success !== true) {
          status = 'subscribe_failed';
        }
      } catch (err) {
        req.log.warn({ err }, '[messenger] subscribe failed');
        status = 'network_error';
      }

      const activate = status === 'subscribed' && !!channel.appSecret;
      const row = await app.tenant(req, (tx) =>
        tx.messengerChannel.update({
          where: { id: channel.id },
          data: {
            pageId,
            pageName,
            isActive: activate,
            lastVerifyStatus: status,
            lastVerifiedAt: new Date(),
          },
        }),
      );
      return { data: serialize(row) };
    },
  );

  // ---------- DELETE /messenger -------------------------------------------
  // Disconnect + delete the channel. Best-effort: unsubscribe the Page from the
  // app webhook so Meta stops delivering DMs, then drop the row (encrypted creds
  // included). Existing conversation history is untouched — threads/messages key
  // off orgId + a channel string, not an FK to this row. After this, inbound
  // Messenger/Instagram webhooks for the org are rejected until reconfigured.
  r.delete(
    '/messenger',
    {
      schema: {
        tags: ['messenger'],
        summary: 'Disconnect and delete the Messenger/Instagram channel.',
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channel = await app.tenant(req, (tx) =>
        tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
      );
      if (!channel) throw notFound('Messenger channel not configured.');

      // Best-effort unsubscribe from Meta (never blocks the local delete).
      if (channel.pageId && channel.pageAccessToken) {
        try {
          const pageToken = decryptSecret(channel.pageAccessToken) ?? '';
          if (pageToken) {
            await fetch(
              `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.pageId)}/subscribed_apps?access_token=${encodeURIComponent(
                pageToken,
              )}`,
              { method: 'DELETE', signal: AbortSignal.timeout(10_000) },
            );
          }
        } catch (err) {
          req.log.warn({ err }, '[messenger] unsubscribe on delete failed (continuing)');
        }
      }

      await app.tenant(req, (tx) => tx.messengerChannel.delete({ where: { id: channel.id } }));
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'messenger_channel',
        entityId: channel.id,
        metadata: { event: 'messenger_channel_deleted', pageId: channel.pageId },
      });
      return { ok: true as const };
    },
  );

  // ---------- GET /messenger/webhook/:orgId  (Meta verify handshake) ------
  r.get(
    '/messenger/webhook/:orgId',
    { schema: { tags: ['messenger'], params: z.object({ orgId: uuidSchema }) } },
    async (req, reply) => {
      const q = req.query as Record<string, string>;
      const mode = q['hub.mode'];
      const token = q['hub.verify_token'];
      const challenge = q['hub.challenge'];
      const channel = await withRlsBypass((tx) =>
        tx.messengerChannel.findUnique({ where: { organizationId: req.params.orgId } }),
      );
      // Constant-time compare, length-guarded via pad-to-64 (mirrors the
      // WhatsApp handshake) so timingSafeEqual never throws on a length mismatch
      // and the comparison doesn't leak the token through timing. (L-11)
      if (
        mode === 'subscribe' &&
        channel &&
        token &&
        crypto.timingSafeEqual(
          Buffer.from(token.padEnd(64).slice(0, 64)),
          Buffer.from(channel.webhookVerifyToken.padEnd(64).slice(0, 64)),
        )
      ) {
        reply.header('content-type', 'text/plain');
        return challenge ?? '';
      }
      reply.code(403);
      return 'forbidden';
    },
  );

  // ---------- POST /messenger/webhook/:orgId  (inbound) -------------------
  r.post(
    '/messenger/webhook/:orgId',
    { schema: { tags: ['messenger'], params: z.object({ orgId: uuidSchema }) } },
    async (req, reply) => {
      const orgId = req.params.orgId;
      const channel = await withRlsBypass((tx) =>
        tx.messengerChannel.findUnique({ where: { organizationId: orgId } }),
      );
      if (!channel || !channel.appSecret) {
        reply.code(403);
        return 'forbidden';
      }
      // Verify X-Hub-Signature-256 over the raw body with the app secret.
      const appSecret = decryptSecret(channel.appSecret) ?? '';
      const sig = req.headers['x-hub-signature-256'];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      // Require the original bytes: a JSON.stringify(req.body) fallback reorders
      // keys and would make the HMAC mismatch legitimate senders — reject when
      // the raw body is absent instead of re-serializing. (L-10)
      const rawBody = (req as unknown as { rawBody?: string }).rawBody;
      if (rawBody === undefined) {
        req.log.warn({ orgId }, '[messenger] webhook missing raw body');
        reply.code(401);
        return 'invalid signature';
      }
      const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
      const ok =
        typeof sigStr === 'string' &&
        sigStr.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigStr), Buffer.from(expected));
      if (!ok) {
        req.log.warn({ orgId }, '[messenger] webhook signature mismatch');
        reply.code(401);
        return 'invalid signature';
      }

      // Always 200 fast; process replies fire-and-forget (Meta retries on non-2xx).
      const body = req.body as {
        object?: string;
        entry?: { messaging?: MessengerEvent[] }[];
      };
      // Instagram + Messenger both arrive here (same Send API); the top-level
      // `object` distinguishes them so threads carry the right channel.
      const channelKind = body.object === 'instagram' ? 'instagram' : 'messenger';
      const events: MessengerEvent[] = (body.entry ?? []).flatMap((e) => e.messaging ?? []);
      void handleMessengerEvents(orgId, channel.id, channelKind, events, req.log).catch((err) =>
        req.log.error({ err }, '[messenger] event handling failed'),
      );
      reply.code(200);
      return 'ok';
    },
  );
}

interface MessengerEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: { type?: string; payload?: { url?: string } }[];
  };
}

// Download an inbound Messenger/IG attachment from its CDN URL and persist it
// to object storage, then point the message row at the new Asset so the inbox
// renders the photo inline (mirrors the WhatsApp storeInboundImage, but the
// Messenger payload gives a direct, unauthenticated URL — no media-id lookup).
// Best-effort: every failure is swallowed + logged.
async function storeInboundMessengerImage(args: {
  orgId: string;
  messageId: string;
  url: string;
  log: Logger;
}): Promise<void> {
  try {
    const { isStorageConfigured, buildStorageKey, putObject } = await import('../../lib/storage.js');
    if (!isStorageConfigured()) return;
    const fileRes = await fetch(args.url, { signal: AbortSignal.timeout(20_000) });
    if (!fileRes.ok) {
      args.log.warn({ status: fileRes.status }, '[messenger] inbound image download failed');
      return;
    }
    const buf = Buffer.from(await fileRes.arrayBuffer());
    if (buf.length === 0 || buf.length > 10 * 1024 * 1024) return;
    const mime = (fileRes.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const assetId = crypto.randomUUID();
    const storageKey = buildStorageKey({
      organizationId: args.orgId,
      kind: 'inbound-image',
      assetId,
      filename: `img.${ext}`,
    });
    await putObject({ storageKey, body: buf, contentType: mime });
    await withRlsBypass(async (tx) => {
      await tx.asset.create({
        data: {
          id: assetId,
          organizationId: args.orgId,
          kind: 'image',
          storageKey,
          contentType: mime,
          byteSize: buf.length,
        },
      });
      await tx.whatsAppMessage.update({
        where: { id: args.messageId },
        data: { mediaAssetId: assetId },
      });
    });
    args.log.info({ bytes: buf.length }, '[messenger] stored inbound image');
  } catch (err) {
    args.log.warn({ err }, '[messenger] inbound image store threw');
  }
}

type Logger = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

// Multi-locale opt-out keywords (mirrors the WhatsApp STOP_RE). A lone STOP /
// UNSUBSCRIBE / إيقاف etc. flips the contact's optedOutAt and suppresses the bot.
const STOP_RE = /^\s*(stop|unsubscribe|quit|cancel|end|opt\s*out|alto|para|arr[eê]ter|stopper|اوقف|إيقاف)\s*\.?\s*$/i;

async function handleMessengerEvents(
  orgId: string,
  channelId: string,
  channelKind: 'messenger' | 'instagram',
  events: MessengerEvent[],
  log: Logger,
): Promise<void> {
  for (const ev of events) {
    const psid = ev.sender?.id;
    // Skip echoes (our own outbound). Accept text AND/OR image attachments —
    // a photo-only message (no text) is still ingested so the operator sees it.
    if (!psid || ev.message?.is_echo) continue;
    const text = ev.message?.text ?? '';
    const imageAttachments = (ev.message?.attachments ?? []).filter(
      (a) => a.type === 'image' && a.payload?.url,
    );
    const hasImage = imageAttachments.length > 0;
    if (!text && !hasImage) continue; // nothing we can store
    const mid = ev.message?.mid ?? null;

    // Idempotency: skip a mid we already stored (Meta retries).
    if (mid) {
      const dup = await withRlsBypass((tx) =>
        tx.whatsAppMessage.findFirst({
          where: { organizationId: orgId, metaMessageId: mid, direction: 'inbound' },
          select: { id: true },
        }),
      );
      if (dup) continue;
    }

    const messageType = text ? 'text' : 'image';
    const body = text || '[image]';
    const preview = body.slice(0, 200);

    // Upsert the thread (keyed by PSID in channelUserId). On FIRST contact,
    // fetch the customer's profile name from Graph so the inbox + /contacts
    // show a real name instead of a raw PSID (best-effort; null on failure).
    const existing = await withRlsBypass((tx) =>
      tx.whatsAppThread.findFirst({
        where: { organizationId: orgId, channel: channelKind, channelUserId: psid },
        select: { id: true, searchText: true, customerName: true },
      }),
    );
    // Fetch the display name on first contact AND when an existing thread still
    // has no real name (null or a bare numeric id) — this backfills IG/Messenger
    // threads created before the name lookup worked.
    let profileName: string | null = existing?.customerName ?? null;
    // Refetch when there's no name, it's a bare numeric id, or (Instagram) it
    // doesn't yet include the @handle — so older threads upgrade to "Name (@user)".
    const needsName =
      !profileName ||
      /^\d+$/.test(profileName) ||
      (channelKind === 'instagram' && !profileName.includes('@'));
    if (needsName) {
      const { fetchMessengerProfileName } = await import('../../lib/messenger-send.js');
      profileName = (await fetchMessengerProfileName(orgId, psid, channelKind, log)) ?? profileName;
    }

    const thread = await withRlsBypass(async (tx) => {
      if (existing) {
        return tx.whatsAppThread.update({
          where: { id: existing.id },
          data: {
            status: 'open',
            lastMessageAt: new Date(),
            lastMessagePreview: preview,
            lastInboundAt: new Date(),
            inboundCount: { increment: 1 },
            searchText: `${existing.searchText} ${body}`.slice(0, 16000),
            // Backfill the name once we resolve it.
            ...(needsName && profileName ? { customerName: profileName } : {}),
          },
        });
      }
      return tx.whatsAppThread.create({
        data: {
          organizationId: orgId,
          channel: channelKind,
          channelUserId: psid,
          customerPhone: psid, // generic id slot for non-WhatsApp channels
          customerName: profileName,
          status: 'open',
          lastMessageAt: new Date(),
          lastMessagePreview: preview,
          lastInboundAt: new Date(),
          inboundCount: 1,
          searchText: body,
        },
      });
    });

    const message = await withRlsBypass((tx) =>
      tx.whatsAppMessage.create({
        data: {
          threadId: thread.id,
          organizationId: orgId,
          channel: channelKind,
          direction: 'inbound',
          metaMessageId: mid,
          fromNumber: psid,
          messageType,
          body,
          rawPayload: ev as never,
        },
        select: { id: true },
      }),
    );

    // Pull down the photo (first image attachment) so the inbox renders it
    // inline rather than an "[image]" placeholder.
    if (hasImage) {
      await storeInboundMessengerImage({
        orgId,
        messageId: message.id,
        url: imageAttachments[0]!.payload!.url!,
        log,
      });
    }

    // Auto-upsert a Contact (mirrors the WhatsApp inbound flow) so the
    // operator's block button + /contacts work for Messenger/Instagram too,
    // and so STOP opt-outs are honoured. The PSID lives in phoneE164 — it's a
    // long numeric string with no leading '+', so it can't collide with a real
    // WhatsApp +E.164 number. STOP keywords (multi-locale) set optedOutAt.
    const isStop = !!text && STOP_RE.test(text);
    await withRlsBypass(async (tx) => {
      const prior = await tx.contact.findUnique({
        where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: psid } },
        select: { optedOutAt: true },
      });
      const wasNewlyOptedOut = isStop && !prior?.optedOutAt;
      const contact = await tx.contact.upsert({
        where: { organizationId_phoneE164: { organizationId: orgId, phoneE164: psid } },
        create: {
          organizationId: orgId,
          phoneE164: psid,
          channel: channelKind, // 'instagram' | 'messenger' — not a phone number
          displayName: profileName,
          optedOutAt: isStop ? new Date() : null,
          lastInboundAt: new Date(),
          source: 'inbox_auto',
        },
        update: {
          channel: channelKind,
          lastInboundAt: new Date(),
          ...(profileName ? { displayName: profileName } : {}),
          ...(isStop ? { optedOutAt: new Date() } : {}),
        },
      });
      if (isStop) {
        const { recordContactOptOut } = await import('../../lib/opt-out.js');
        await recordContactOptOut(tx, {
          organizationId: orgId,
          contactId: contact.id,
          phoneE164: psid,
          channel: channelKind,
          wasNewlyOptedOut,
        });
      }
    }).catch((err) => log.error({ err }, '[messenger] contact upsert failed'));

    publishInboxEvent(orgId); // show the inbound in the inbox instantly

    // Only run the bot when there's actual text to answer. A photo-only
    // inbound is stored for the operator but doesn't trigger an AI reply.
    if (text) {
      await maybeReplyOnMessenger(orgId, channelId, channelKind, thread.id, psid, text, log);
    }
  }
}

async function maybeReplyOnMessenger(
  orgId: string,
  channelId: string,
  channelKind: 'messenger' | 'instagram',
  threadId: string,
  psid: string,
  userMessage: string,
  log: Logger,
): Promise<void> {
  const { gatherBotData, buildBotResponse } = await import('../../lib/bot-engine.js');

  // F-02: run the Messenger bot path under the tenant role so RLS is a real
  // backstop. Bind the local name `withRlsBypass` to a tenant-scoped wrapper so
  // every call below runs RLS-ON (orgId is always known here) without touching
  // call sites; explicit org filters stay as defence-in-depth.
  const { withTenant } = await import('../../lib/db.js');
  const withRlsBypass = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withTenant(orgId, fn);

  // Gate: bot must be deployed + the thread not human-owned / escalated.
  const thread = await withRlsBypass((tx) =>
    tx.whatsAppThread.findUnique({
      where: { id: threadId },
      select: { status: true, assignedToUserId: true },
    }),
  );
  if (!thread || thread.assignedToUserId || thread.status === 'escalated') return;

  // Compliance gate: never auto-reply to a contact the operator blocked or who
  // opted out (STOP). The inbound is still stored + visible in the inbox; we
  // just stay silent. Keyed by PSID-in-phoneE164 (see the contact upsert above).
  const contact = await withRlsBypass((tx) =>
    tx.contact.findFirst({
      where: { organizationId: orgId, phoneE164: psid },
      select: { blockedAt: true, optedOutAt: true },
    }),
  );
  if (contact?.blockedAt || contact?.optedOutAt) {
    log.info({ orgId, threadId }, '[messenger] bot skip: contact blocked or opted out');
    return;
  }

  // super-admin per-tenant access control: 'ai' disabled → manual replies
  // only (the DM is stored + shown in the inbox; the bot stays silent).
  const orgFeatures = await withRlsBypass((tx) =>
    tx.organization.findUnique({ where: { id: orgId }, select: { disabledFeatures: true } }),
  );
  if (orgFeatures?.disabledFeatures?.includes('ai')) {
    log.info({ orgId, threadId }, '[messenger] bot skip: AI disabled for tenant');
    return;
  }

  // Per-channel access control: super-admin can turn Messenger and Instagram
  // on/off independently. When the inbound channel is disabled the DM is still
  // stored + shown in the inbox; the bot just stays silent on that channel.
  if (channelKind === 'messenger' && orgFeatures?.disabledFeatures?.includes('messenger')) {
    log.info({ orgId, threadId }, '[messenger] bot skip: Messenger channel disabled for tenant');
    return;
  }
  if (channelKind === 'instagram' && orgFeatures?.disabledFeatures?.includes('instagram')) {
    log.info({ orgId, threadId }, '[instagram] bot skip: Instagram channel disabled for tenant');
    return;
  }

  const channel = await withRlsBypass((tx) =>
    tx.messengerChannel.findUnique({ where: { id: channelId } }),
  );
  if (!channel || !channel.isActive || !channel.pageAccessToken) return;

  // Gather tenant data + run the channel-agnostic engine (org-scoped tx).
  const data = await withTenant(orgId, (tx) => gatherBotData(tx, orgId));
  const config = (data as { config?: { deployedAt?: Date | null } }).config;
  if (!config?.deployedAt) return; // bot not deployed

  // Last 8 turns for context. Also capture the previous message's timestamp so
  // we can detect a returning customer (>1h silence) below.
  let lastPriorReceivedAt: Date | null = null;
  const history = await withRlsBypass(async (tx) => {
    const rows = await tx.whatsAppMessage.findMany({
      where: { threadId },
      orderBy: { receivedAt: 'desc' },
      take: 9,
      select: { direction: true, body: true, receivedAt: true },
    });
    // rows[0] is the current inbound (already stored); rows[1] is the prior msg.
    lastPriorReceivedAt = rows[1]?.receivedAt ?? null;
    return rows
      .reverse()
      .slice(0, -1) // drop the current inbound (it's passed as userMessage)
      .filter((m) => m.body)
      .map((m) => ({
        role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: (m.body ?? '').slice(0, 400),
      }));
  });

  // Commerce: load the draft cart so the bot quotes a correct running total.
  const shopForm = (data as { shopForm?: ShopFormLite | null }).shopForm ?? null;
  const products =
    (data as { products?: (CatalogProductLite & { images?: { storageKey: string }[] })[] })
      .products ?? [];
  const { loadDraftCartState, syncDraftFromReply, captureCart } = await import('../../lib/cart-flow.js');
  const cartState = shopForm ? await loadDraftCartState(orgId, threadId) : null;

  // Returning-customer reminder: customer left this order unfinished and came
  // back after a long silence (>1h since the previous message). Flag it so the
  // bot opens by reminding them of the pending order and asks continue-or-fresh.
  const RETURN_REMINDER_GAP_MS = 60 * 60 * 1000;
  const cartIdleReturn =
    !!cartState &&
    lastPriorReceivedAt != null &&
    Date.now() - new Date(lastPriorReceivedAt).getTime() > RETURN_REMINDER_GAP_MS;

  // Booking availability — compute the open slots the bot may offer.
  const bookingAvail =
    (data as { bookingForm?: { availability?: BookingAvailability | null } | null }).bookingForm
      ?.availability ?? null;
  let openSlots: string[] = [];
  if (bookingAvail?.enabled) {
    const { computeOpenSlots } = await import('../../lib/booking-slots.js');
    openSlots = (await computeOpenSlots(orgId, bookingAvail, new Date(), 6)).map((s) => s.label);
  }

  // Monthly AI-message allowance — once the tenant is out of allowance for the
  // month, pause the bot (leave the chat for a human) instead of replying.
  if (!(await canSendAiMessage(orgId))) {
    log.warn({ orgId }, '[messenger] monthly AI message allowance reached — skipping bot reply (left for human)');
    return;
  }

  let rawText: string;
  let botInputs: import('../../lib/bot-engine.js').BotResponseInputs | null = null;
  try {
    const result = await buildBotResponse({
      organizationId: orgId,
      userMessage,
      history,
      data,
      replyMode: 'text',
      cartState: cartState ? { ...cartState, idleReturn: cartIdleReturn } : undefined,
      channelLabel: channelKind === 'instagram' ? 'Instagram' : 'Facebook Messenger',
      openSlots,
    });
    rawText = result.text;
    botInputs = result.inputs;
  } catch (err) {
    log.warn({ err }, '[messenger] buildBotResponse failed');
    return;
  }

  // WS4a — run the same validator pipeline WhatsApp uses (Messenger/IG
  // previously only stripped markdown), plus the grounding gate. Both read the
  // same candidate KB the reply was built from. Never throws.
  let mgroundingFlagged = false;
  let mgroundingReason: string | null = null;
  try {
    const { buildScanCandidates, groundingGate, gateMode, safeFallback } = await import(
      '../../lib/grounding-gate.js'
    );
    const { validateReply } = await import('../../lib/reply-validators.js');
    const candidates = buildScanCandidates(
      data as never,
      (thread as { customerWhatsappName?: string | null } | null)?.customerWhatsappName ?? null,
    );
    if (botInputs) {
      const validation = validateReply({
        reply: rawText,
        userMessage,
        inputs: botInputs,
        kb: candidates,
        cartDraft: null,
        bookingFormEnabled: Boolean(
          (data as { bookingForm?: { enabled?: boolean } }).bookingForm?.enabled,
        ),
        shopFormEnabled: Boolean((data as { shopForm?: unknown }).shopForm),
        voiceMode: 'text',
        previousBotReply: null,
        configuredGreeting: (data as { config?: { greeting?: string | null } }).config?.greeting ?? null,
      });
      rawText = validation.reply;
    }
    const stripped = rawText
      .replace(/\[IMAGE:[^\]]*\]/gi, '')
      .replace(/\[CART:[\s\S]*\}\s*\]/gi, '')
      .replace(/\[BUTTONS:[^\]]*\]/gi, '')
      .replace(/\[BOOKING:[\s\S]*\}\s*\]/gi, '')
      .replace(/\[HANDOFF\]/gi, '')
      .replace(/\[CLEAR_CART\]/gi, '')
      .replace(/\[PAYMENT_LINK\]/gi, '')
      .trim();
    const gate = groundingGate(stripped, candidates);
    if (gate.wouldBlock) {
      mgroundingFlagged = true;
      mgroundingReason = gate.reason;
      log.warn({ orgId, threadId, mode: gateMode(), reason: gate.reason }, '[messenger] grounding gate flagged reply');
    }
    if (!gate.ok) rawText = safeFallback();
  } catch (err) {
    log.warn({ err }, '[messenger] validators/grounding gate errored (non-fatal)');
  }
  // Count one AI message against the monthly allowance for this bot reply.
  void recordAiMessages(orgId, 1);

  // Human handoff — supersedes everything. Trips on the [HANDOFF] marker OR an
  // explicit "talk to a human / agent / support" request (covers the tappable
  // "Talk to a human" quick reply, whose text arrives verbatim). Escalates the
  // thread so the bot goes silent, posts an internal note, and pings the team.
  const HANDOFF_INTENT_RE =
    /\b(talk|speak|connect|chat)\b.{0,20}\b(human|agent|person|someone|representative|rep|operator|staff|team|support)\b|\b(human|real person|live agent|customer support|customer service)\b|تحدث.*انسان|موظف|خدمة العملاء/i;
  const wantsHandoff = /\[HANDOFF\]/i.test(rawText) || HANDOFF_INTENT_RE.test(userMessage);
  if (wantsHandoff) {
    const escalation = (data as { config?: { escalationRules?: { fallback?: unknown } } }).config
      ?.escalationRules;
    const fallback =
      typeof escalation?.fallback === 'string' && escalation.fallback.trim()
        ? escalation.fallback.trim()
        : "Sure — I'm connecting you with a member of our team. They'll reply right here shortly. 🙌";
    const { sendMessengerText: sendHandoff } = await import('../../lib/messenger-send.js');
    const mid = await sendHandoff(orgId, psid, fallback, log);
    await withRlsBypass(async (tx) => {
      if (mid) {
        await tx.whatsAppMessage.create({
          data: {
            threadId,
            organizationId: orgId,
            channel: channelKind,
            direction: 'outbound',
            metaMessageId: mid,
            toNumber: psid,
            messageType: 'text',
            body: fallback,
            rawPayload: { sentBy: 'bot', reason: 'handoff' } as never,
          },
        });
      }
      await tx.whatsAppThread.update({
        where: { id: threadId },
        data: {
          status: 'escalated',
          lastMessageAt: new Date(),
          lastMessagePreview: fallback.slice(0, 200),
          ...(mid ? { outboundCount: { increment: 1 } } : {}),
        },
      });
      await tx.whatsAppNote.create({
        data: {
          threadId,
          organizationId: orgId,
          authorUserId: null,
          body: '🤖 → 👤 Bot flagged this chat for human support (customer asked for an agent).',
        },
      });
    });
    void (await import('../../lib/notifications.js'))
      .createNotification({
        organizationId: orgId,
        kind: 'cart_received',
        severity: 'warning',
        title: 'Customer needs a human',
        body: `A ${channelKind} customer asked to talk to a human — reply in the inbox.`,
        link: `/inbox?thread=${threadId}`,
        entityType: 'whatsapp_thread',
        entityId: threadId,
      })
      .catch(() => undefined);
    publishInboxEvent(orgId); // push the handoff message + escalation instantly
    return; // escalated — do not run cart/booking/quick-reply logic
  }

  // Build the draft cart from "added" lines + capture an order on the [CART:]
  // marker (reuses the shared cart-flow + the WhatsApp cart-parser). When an
  // order is captured, a deterministic receipt becomes the SINGLE confirmation
  // (the LLM's own "order confirmed" text is suppressed — mirrors WhatsApp).
  let orderReceiptBody: string | null = null;
  if (shopForm) {
    const { parseCartMarker, formatMoney } = await import('../../lib/bot-engine.js');
    const prevBotReply = [...history].reverse().find((h) => h.role === 'assistant')?.content ?? '';
    try {
      await syncDraftFromReply({
        orgId,
        threadId,
        customerId: psid,
        reply: rawText,
        userMessage,
        previousBotReply: prevBotReply,
        products,
        shopForm,
      });
    } catch (err) {
      log.warn({ err }, '[messenger] draft cart sync failed');
    }
    const cartMarker = parseCartMarker(rawText);
    if (cartMarker) {
      try {
        const customerName = await withRlsBypass((tx) =>
          tx.whatsAppThread
            .findUnique({ where: { id: threadId }, select: { customerName: true } })
            .then((t) => t?.customerName ?? null),
        );
        const captured = await captureCart({
          orgId,
          threadId,
          customerId: psid,
          customerName,
          cartMarkerPayload: cartMarker,
          shopForm,
          products,
        });
        if (captured) {
          orderReceiptBody = `✅ Order #${captured.id.slice(0, 8)}\nTotal: ${formatMoney(
            captured.totalMinor,
            captured.currency,
          )}`;
          await withRlsBypass((tx) =>
            tx.whatsAppThread.update({ where: { id: threadId }, data: { status: 'pending' } }),
          );
        }
      } catch (err) {
        log.warn({ err }, '[messenger] cart capture failed');
      }
    }

    // [PAYMENT_LINK] → mint/resolve a real payable link via the tenant's
    // payment provider (mirrors WhatsApp). Leaves the text intact on any
    // failure so the customer never sees a broken reply.
    if (/\[PAYMENT_LINK\]/i.test(rawText) && cartState && cartState.items.length > 0) {
      try {
        const code = cartState.currency.toUpperCase();
        const dec = ['KWD', 'BHD', 'OMR', 'JOD'].includes(code) ? 3 : 2;
        const amountMinor = cartState.subtotalMinor;
        const amountMajor = Number((amountMinor / Math.pow(10, dec)).toFixed(dec));
        const draftCart = await withRlsBypass((tx) =>
          tx.cart.findFirst({
            where: { organizationId: orgId, threadId, status: 'draft' },
            select: { id: true, customerName: true },
          }),
        );
        let resolution:
          | { kind: 'url'; url: string; ref?: string | null }
          | { kind: 'text'; text: string }
          | null = null;
        let payProvider = 'none';
        if (draftCart) {
          const payCtx = {
            organizationId: orgId,
            threadId,
            cartId: draftCart.id,
            customerName: draftCart.customerName || 'Customer',
            customerPhone: psid,
            amountMajor,
            amountMinor,
            currency: code,
            displayReference: draftCart.id.slice(0, 8),
          };
          const pcfg = await withRlsBypass((tx) =>
            tx.paymentConfig.findUnique({ where: { organizationId: orgId } }),
          );
          if (pcfg && pcfg.provider !== 'none') {
            const { resolvePaymentLink } = await import('../../lib/payments/index.js');
            const { decryptSecret } = await import('@platform/db');
            let creds: Record<string, string> = {};
            try {
              const j = decryptSecret(pcfg.credentials);
              creds = j ? (JSON.parse(j) as Record<string, string>) : {};
            } catch {
              creds = {};
            }
            resolution = await resolvePaymentLink(
              {
                provider: pcfg.provider,
                staticLinkUrl: pcfg.staticLinkUrl,
                bankDetails: pcfg.bankDetails,
                testMode: pcfg.testMode,
                credentials: creds,
              },
              payCtx,
              log,
            );
            if (resolution) payProvider = pcfg.provider;
          }
          if (!resolution) {
            const { createInvoice, isMyFatoorahConfigured } = await import(
              '../../lib/myfatoorah.js'
            );
            if (isMyFatoorahConfigured()) {
              const invoice = await createInvoice(payCtx, log);
              if (invoice) {
                resolution = { kind: 'url', url: invoice.invoiceUrl, ref: String(invoice.invoiceId) };
                payProvider = 'myfatoorah';
              }
            }
          }
          // F-04: record which gateway + external ref this order is awaiting,
          // so the inbound payment webhook can correlate it back and mark paid.
          if (resolution?.kind === 'url' && payProvider !== 'none') {
            const { recordPaymentIntent } = await import('../../lib/payments/confirm.js');
            await recordPaymentIntent({
              organizationId: orgId,
              cartId: draftCart.id,
              provider: payProvider,
              ref: resolution.ref ?? null,
            });
          }
        }
        if (resolution?.kind === 'url') {
          rawText = rawText.replace(/\[PAYMENT_LINK\]/gi, resolution.url);
        } else if (resolution?.kind === 'text') {
          rawText = rawText.replace(/\[PAYMENT_LINK\]/gi, resolution.text);
        } else {
          rawText = rawText.replace(
            /\[PAYMENT_LINK\]/gi,
            'We will send you a secure payment link shortly.',
          );
        }
      } catch (err) {
        log.warn({ err }, '[messenger] payment-link resolve failed');
      }
    }
  }

  // Booking: capture an appointment from the bot's [BOOKING: {json}] marker
  // (mirrors WhatsApp). Independent of the shop flow — an org may have either.
  let bookingCaptured = false;
  // Deterministic booking confirmation (time + Meet link or address), sent as
  // its own message after the reply so a paraphrasing model can never mangle
  // the link. Null when no calendar is connected.
  let bookingConfirmationBody: string | null = null;
  const bookingForm = (data as { bookingForm?: BookingFormLite | null }).bookingForm ?? null;
  if (bookingForm?.enabled) {
    const bookingMatch = /\[BOOKING:\s*(\{[\s\S]*?\})\s*\]/i.exec(rawText);
    if (bookingMatch) {
      try {
        const { captureBooking } = await import('../../lib/cart-flow.js');
        const customerName = await withRlsBypass((tx) =>
          tx.whatsAppThread
            .findUnique({ where: { id: threadId }, select: { customerName: true } })
            .then((t) => t?.customerName ?? null),
        );
        const biz = (data as { biz?: { legalName?: string | null; timezone?: string | null } }).biz;
        const loc = (
          data as { locations?: { addressLine1?: string | null; addressLine2?: string | null; city?: string | null }[] }
        ).locations?.[0];
        const booking = await captureBooking({
          orgId,
          threadId,
          customerId: psid,
          customerName,
          bookingMarkerJson: bookingMatch[1]!,
          bookingForm,
          availability: bookingAvail,
          calendar: {
            timezone: biz?.timezone ?? 'UTC',
            businessName: biz?.legalName ?? null,
            address: loc
              ? [loc.addressLine1, loc.addressLine2, loc.city].filter(Boolean).join(', ')
              : null,
            customerText: userMessage ?? null,
          },
        });
        bookingCaptured = !!booking;
        bookingConfirmationBody = booking?.confirmationMessage ?? null;
      } catch (err) {
        log.warn({ err }, '[messenger] booking capture failed');
      }
    }
  }

  const replyText = stripMarkers(rawText);
  // The order receipt (if any) is the single confirmation; else the bot text.
  // If a booking was captured but the marker was the whole reply (nothing left
  // after stripping), fall back to a friendly confirmation.
  const customerText = normalizeMarkdownForChannel(
    orderReceiptBody ??
      (replyText ||
        (bookingCaptured
          ? 'All set — your request has been captured. A teammate will follow up shortly.'
          : '')),
    // Messenger / Instagram render no markup — strip all emphasis to plain.
    'plain',
  );
  if (!customerText) return;

  const { sendMessengerText, sendMessengerImage } = await import('../../lib/messenger-send.js');

  // Send product images for [IMAGE: <sku>] markers (skip on an order-confirm
  // turn — the receipt stands alone).
  if (!orderReceiptBody) {
    const imageSkus = Array.from(rawText.matchAll(/\[IMAGE:\s*([^\]\s]+)\s*\]/gi)).map((m) =>
      m[1]!.trim(),
    );
    if (imageSkus.length > 0) {
      const { presignGetUrl } = await import('../../lib/storage.js');
      const { collapseVariantSiblings } = await import('../../lib/variant-image-collapse.js');
      const seenIds = new Set<string>();
      const resolved: typeof products = [];
      for (const sku of imageSkus) {
        const p = products.find((x) => x.sku.toLowerCase() === sku.toLowerCase());
        if (!p || seenIds.has(p.id)) continue;
        seenIds.add(p.id);
        resolved.push(p);
      }
      // Size/count variants of the same item share a visually identical
      // photo — send ONE per sibling group, then cap at 3 per reply.
      for (const p of collapseVariantSiblings(resolved).slice(0, 3)) {
        const key = p.images?.[0]?.storageKey;
        if (!key) continue;
        try {
          const url = await presignGetUrl(key, 3600);
          await sendMessengerImage(orgId, psid, url, log);
        } catch (err) {
          log.warn({ err, sku: p.sku }, '[messenger] product image send failed');
        }
      }
    }
  }

  // Quick-reply pills. Prefer the buttons the model emitted via [BUTTONS: …];
  // if it emitted none, fall back to a deterministic, context-aware default set
  // derived from what the business offers — so customers reliably get tappable
  // options even when gpt-4o-mini forgets the marker. Suppressed only on an
  // order-receipt turn (a confirmation shouldn't sprout choices).
  const quickRepliesOn =
    (data as { config?: { quickRepliesEnabled?: boolean | null } }).config?.quickRepliesEnabled !==
    false;
  let quickReplies: string[] = [];
  if (!orderReceiptBody && quickRepliesOn) {
    const fromMarker = (/\[BUTTONS:\s*([^\]]+)\]/i.exec(rawText)?.[1] ?? '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromMarker.length > 0) {
      quickReplies = fromMarker.slice(0, 11);
    } else {
      const hasCatalog =
        products.length > 0 ||
        (((data as { services?: unknown[] }).services?.length ?? 0) > 0);
      const dq: string[] = [];
      // shopForm is non-null only when the shop flow is enabled.
      if (shopForm) dq.push('Order now');
      else if (hasCatalog) dq.push('View products');
      if (bookingForm?.enabled) dq.push('Book a meeting');
      dq.push('Talk to a human');
      quickReplies = dq.slice(0, 3);
    }
    // F11 (owner amendment 2026-08-30): the model's marker decides the
    // buttons; configured always-on buttons only fill when it offered nothing,
    // and the button the customer just tapped never re-renders. Messenger
    // pills allow more than WhatsApp's 3, so cap at the marker path's 11.
    const { parseCustomButtons, mergeQuickButtons } = await import('../../lib/quick-buttons.js');
    quickReplies = mergeQuickButtons(
      quickReplies,
      parseCustomButtons((data as { config?: { customButtons?: unknown } }).config?.customButtons),
      { cap: 11, modelChose: fromMarker.length > 0, justPressed: userMessage },
    );
  }

  const metaMessageId = await sendMessengerText(orgId, psid, customerText, log, quickReplies);
  if (metaMessageId === null) return; // send failed — don't persist a phantom outbound

  // Booking confirmation (time + Meet link or address) as its own message,
  // after the reply. Deterministic rather than model-written: a paraphrased
  // meeting link is a broken meeting link.
  if (bookingConfirmationBody) {
    try {
      const confId = await sendMessengerText(orgId, psid, bookingConfirmationBody, log, []);
      if (confId) {
        await withRlsBypass((tx) =>
          tx.whatsAppMessage.create({
            data: {
              threadId,
              organizationId: orgId,
              channel: channelKind,
              direction: 'outbound',
              metaMessageId: confId,
              toNumber: psid,
              messageType: 'text',
              body: bookingConfirmationBody!,
              rawPayload: { sentBy: 'bot', reason: 'booking_confirmation' } as never,
            },
          }),
        );
      }
    } catch (err) {
      log.warn({ err }, '[messenger] booking confirmation send failed (non-fatal)');
    }
  }

  const botMessage = await withRlsBypass((tx) =>
    tx.whatsAppMessage.create({
      data: {
        threadId,
        organizationId: orgId,
        channel: channelKind,
        direction: 'outbound',
        metaMessageId,
        toNumber: psid,
        messageType: 'text',
        body: customerText,
        rawPayload: {
          sentBy: 'bot',
          ...(quickReplies.length ? { quickReplies } : {}),
        } as never,
      },
      select: { id: true },
    }),
  );
  await withRlsBypass((tx) =>
    tx.whatsAppThread.update({
      where: { id: threadId },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: customerText.slice(0, 200),
        outboundCount: { increment: 1 },
      },
    }),
  );
  publishInboxEvent(orgId); // push the bot reply to the inbox instantly

  // WS4a — provenance for Messenger/IG (previously WhatsApp-only). Same audit
  // trail: prompt snapshot, citations, hallucinations, grounding-gate flag.
  // Never load-bearing — swallowed on error.
  if (botInputs && botMessage?.id) {
    try {
      const { recordProvenance } = await import('../../lib/provenance.js');
      const { buildScanCandidates } = await import('../../lib/grounding-gate.js');
      await recordProvenance({
        organizationId: orgId,
        messageId: botMessage.id,
        inputs: botInputs,
        reply: customerText,
        kb: buildScanCandidates(
          data as never,
          (thread as { customerWhatsappName?: string | null } | null)?.customerWhatsappName ?? null,
        ),
        blocked: mgroundingFlagged,
        blockReason: mgroundingReason,
        log,
      });
    } catch (err) {
      log.warn({ err }, '[messenger] provenance recordProvenance threw (non-fatal)');
    }
  }
}
