// WhatsApp Cloud API channel routes — Phase 1.5.
//
// Two distinct surfaces in this file:
//
// 1) Tenant-authenticated config endpoints (require an authenticated org
//    member): GET / PUT / DELETE the channel config, run a verify probe
//    against Meta, send a test template message, list inbound messages.
//
// 2) Public webhook endpoints used by Meta itself:
//    - GET  /whatsapp/webhook/:orgId  → handshake (returns hub.challenge
//      when hub.verify_token matches the per-org webhookVerifyToken)
//    - POST /whatsapp/webhook/:orgId  → inbound message events. Verifies
//      the X-Hub-Signature-256 header against the org's appSecret before
//      persisting the payload.
//
// Webhook routes deliberately use `withRlsBypass` (no JWT, no app.tenant)
// because Meta cannot authenticate as a tenant. Tenant scoping is enforced
// by (a) reading the channel by orgId param + (b) requiring a valid HMAC
// signature using THAT channel's appSecret.

import {
  ApiErrorCode,
  COEXISTENCE_CONSENT_TEXT,
  COEXISTENCE_CONSENT_VERSION,
  SALES_SCAN_DEFAULT_WINDOW_DAYS,
  itemEnvelopeSchema,
  listEnvelopeSchema,
  successSchema,
  upsertWhatsappChannelBodySchema,
  uuidSchema,
  whatsappChannelSchema,
  whatsappEmbeddedSignupBodySchema,
  whatsappEmbeddedSignupConfigSchema,
  whatsappMessageSchema,
  whatsappTestSendBodySchema,
  whatsappSubscribeResultSchema,
  whatsappTestSendResultSchema,
  whatsappSendTextBodySchema,
  whatsappSendMediaBodySchema,
  whatsappVerifyResultSchema,
} from '@platform/shared';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { canSendAiMessage, recordAiMessages } from '../../lib/ai-messages.js';
import { recordAudit, recordCredentialAudit } from '../../lib/audit.js';
import { shouldRequestHistory } from '../../lib/coexistence-capture.js';
import { consumeMessageEchoes } from '../../lib/handset-echo.js';
import { createCoexistenceGrant, isSalesScanEnabled } from '../../lib/sales-scan.js';
import { attributeBroadcastResponse } from '../../lib/broadcast-response.js';
import { generateOpaqueToken } from '../../lib/crypto.js';
import { withRlsBypass, withTenant, type Tx } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { upsertWaThread } from '../../lib/wa-thread.js';
import { collapseVariantSiblings } from '../../lib/variant-image-collapse.js';
import { badRequest, notFound, paymentRequired } from '../../lib/errors.js';
import * as wallet from '../../lib/wallet.js';
import { getRedis } from '../../lib/redis.js';

// Outbound token-bucket rate limiter — 80 messages per second by default
// (Meta's default is 80 mps for tier 1 numbers; clients tier up over time).
// Keyed PER NUMBER (phone_number_id) because Meta's throughput limit is
// per-number — with multi-number sending, each number gets its own bucket.
// Falls back to the org id when no phone number id is available. Backed by
// Redis INCR + EXPIRE so it survives restarts.
async function consumeSendToken(bucketKey: string): Promise<{ ok: boolean; retryAfterMs: number }> {
  const redis = getRedis();
  const key = `wasend:${bucketKey}:${Math.floor(Date.now() / 1000)}`;
  const limit = 80;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 2);
  }
  if (count > limit) {
    return { ok: false, retryAfterMs: 1000 };
  }
  return { ok: true, retryAfterMs: 0 };
}

// ---- helpers --------------------------------------------------------------

// Sniff the actual container of an uploaded media file by its magic
// bytes. Returns a canonical MIME (without codec parameters) when
// recognised, or null when we can't tell. Used to override the
// browser-supplied content-type before forwarding to Meta — Chrome
// reports audio/ogg but actually writes WebM, etc.
function sniffMediaContainer(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // OGG container — "OggS" magic at offset 0.
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return 'audio/ogg';
  }
  // WebM / Matroska — EBML header 1A 45 DF A3 at offset 0.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'audio/webm';
  }
  // ISO BMFF (MP4 / M4A) — "ftyp" at offset 4..7.
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return 'audio/mp4';
  }
  // ID3 tag (MP3) — "ID3" at offset 0.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return 'audio/mpeg';
  }
  // MPEG frame sync — 0xFFFx at offset 0. Covers raw MP3 streams.
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  // AMR — "#!AMR\n" at offset 0.
  if (
    buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x41 &&
    buf[3] === 0x4d && buf[4] === 0x52 && buf[5] === 0x0a
  ) {
    return 'audio/amr';
  }
  // Common image / pdf containers — let send-media keep working for
  // those without changing what the caller declared.
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }
  return null;
}

// Whisper-transcribe an inbound voice/audio message. Two-step download
// from Meta (/{media-id} → url → bytes), then transcription via OpenAI.
// On success the persisted whatsapp_messages row's body is patched so
// the inbox shows the transcript instead of the "[audio]" placeholder.
// All errors are swallowed + logged so a transcription failure never
// blocks the bot's normal flow.
// WhatsApp voice notes are OGG/Opus, which Safari (macOS + iOS) cannot play —
// the inbox <audio> play button silently does nothing there. Transcode to MP3
// (universally playable) on ingest. Uses the bundled ffmpeg-static binary, so no
// system ffmpeg needed. Returns bytes:null on any failure → caller stores the original.
//
// Also reports the clip's DURATION, because Meta does not. Neither the inbound
// webhook `audio` object ({mime_type, sha256, id, url, voice}) nor the media
// metadata endpoint GET /{media-id} ({messaging_product, url, mime_type,
// sha256, file_size, id}) carries a length, so the only honest source is the
// bytes themselves. ffmpeg already decodes the whole file here, so we read the
// duration off its own progress output (the last `time=HH:MM:SS.ss` it prints)
// — a real measurement, not an estimate, and zero extra work. Best-effort: any
// parse/exit failure yields null rather than a guessed number.
type TranscodedAudio = { bytes: Buffer | null; durationSeconds: number | null };

// ffmpeg emits progress lines like `size=  12kB time=00:00:14.02 bitrate=…` to
// stderr. The LAST one is the full decoded length of the stream.
function parseFfmpegDurationSeconds(stderr: string): number | null {
  const matches = stderr.matchAll(/time=(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/g);
  let last: number | null = null;
  for (const m of matches) {
    const seconds =
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] ?? '0'}`);
    if (Number.isFinite(seconds)) last = seconds;
  }
  if (last === null) return null;
  const rounded = Math.round(last);
  // A WhatsApp voice note maxes out around 16 min; anything outside a sane
  // range means we mis-parsed, so report nothing rather than something wrong.
  if (rounded <= 0 || rounded > 24 * 3600) return null;
  return rounded;
}

async function transcodeAudioToMp3(input: Buffer): Promise<TranscodedAudio> {
  try {
    // Prefer the bundled ffmpeg-static binary, but it's frequently MISSING in
    // production: pnpm doesn't run postinstall scripts by default, so the
    // platform binary never downloads even though the package is listed. Fall
    // back to a system ffmpeg on PATH (present on our servers). Without a working
    // ffmpeg the OGG/Opus voice note is stored as-is → Safari can't play it.
    const { existsSync } = await import('node:fs');
    let ffmpegPath = 'ffmpeg';
    try {
      const mod = (await import('ffmpeg-static')) as { default?: string };
      if (mod.default && existsSync(mod.default)) ffmpegPath = mod.default;
    } catch {
      /* ffmpeg-static unavailable → use system ffmpeg */
    }
    const { spawn } = await import('node:child_process');
    return await new Promise<TranscodedAudio>((resolve) => {
      const ff = spawn(
        ffmpegPath,
        ['-i', 'pipe:0', '-vn', '-acodec', 'libmp3lame', '-q:a', '5', '-f', 'mp3', 'pipe:1'],
        // stderr was 'ignore'; it is now piped ONLY to read the duration off
        // ffmpeg's progress output. It must be consumed (see the 'data'
        // handler) or a full pipe buffer would stall the transcode.
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const chunks: Buffer[] = [];
      let stderr = '';
      let settled = false;
      const done = (v: TranscodedAudio) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        ff.kill('SIGKILL');
        done({ bytes: null, durationSeconds: null });
      }, 20_000);
      ff.stdout.on('data', (d: Buffer) => chunks.push(d));
      // Keep only the tail: progress is repetitive and the last line is the
      // one we want, so this is bounded regardless of clip length.
      ff.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString('utf8')).slice(-4096);
      });
      ff.on('error', () => {
        clearTimeout(timer);
        done({ bytes: null, durationSeconds: null });
      });
      ff.on('close', (code) => {
        clearTimeout(timer);
        const ok = code === 0 && chunks.length > 0;
        done({
          bytes: ok ? Buffer.concat(chunks) : null,
          // Only trust the measurement on a clean exit — a crashed ffmpeg may
          // have printed progress for a partially decoded stream.
          durationSeconds: code === 0 ? parseFfmpegDurationSeconds(stderr) : null,
        });
      });
      ff.stdin.on('error', () => undefined); // ignore EPIPE if ffmpeg exits early
      ff.stdin.write(input);
      ff.stdin.end();
    });
  } catch {
    return { bytes: null, durationSeconds: null };
  }
}

export async function transcribeInboundVoice(args: {
  organizationId: string;
  mediaId: string;
  mediaMime: string | null;
  wamid: string | null;
  // Customer's E.164 phone — used to look up the last outbound bot reply
  // in this thread so we can route English voice notes to Groq Whisper
  // (~250-400 ms) and Arabic to OpenAI gpt-4o-transcribe (~2.5 s but
  // materially better on Gulf/Levant dialects). First-message-in-thread
  // (no prior outbound) defaults to OpenAI — safer for an Arabic-leaning
  // customer base.
  customerPhone: string;
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}): Promise<string | null> {
  try {
    const { withRlsBypass } = await import('../../lib/db.js');
    // Idempotent: this runs from BOTH the universal inbound-audio store and the
    // bot-reply path. If the message already has a stored audio asset + a
    // transcript, skip the re-download/transcribe and return the cached text.
    if (args.wamid) {
      const done = await withRlsBypass((tx) =>
        tx.whatsAppMessage.findFirst({
          where: { organizationId: args.organizationId, metaMessageId: args.wamid! },
          select: { body: true, mediaAssetId: true },
        }),
      );
      if (done?.mediaAssetId && done.body && done.body.startsWith('🎙')) {
        return done.body.replace(/^🎙\s*/, '').trim();
      }
    }
    // Run lookups in parallel — channel (for media token), last-bot-language
    // (for transcribe provider) + the org's feature flags (transcription gate).
    const [channel, prevBotMessage, org] = await Promise.all([
      withRlsBypass((tx) =>
        tx.whatsAppChannel.findFirst({
          where: { organizationId: args.organizationId, isPrimary: true },
        }),
      ),
      withRlsBypass((tx) =>
        tx.whatsAppMessage.findFirst({
          where: {
            organizationId: args.organizationId,
            direction: 'outbound',
            body: { not: null },
            thread: { customerPhone: args.customerPhone },
          },
          orderBy: { receivedAt: 'desc' },
          select: { body: true },
        }),
      ),
      withRlsBypass((tx) =>
        tx.organization.findUnique({
          where: { id: args.organizationId },
          select: { disabledFeatures: true, botConfig: { select: { languages: true } } },
        }),
      ),
    ]);
    if (!channel?.accessToken) return null;
    // Per-tenant toggle: when voice transcription is OFF we still download +
    // store the audio (so it's playable) but skip the paid Whisper call.
    const transcriptionEnabled = !(org?.disabledFeatures ?? []).includes('voice_transcription');

    // Transcription provider routing. gpt-4o-transcribe (OpenAI) is materially
    // stronger on Gulf/Levant Arabic; Groq Whisper is faster but English-biased
    // (its prompt lists English/French/Spanish) and mangles Arabic. The old
    // heuristic — "last bot reply had no Arabic → Groq" — got Arabic-speaking
    // customers STUCK in English: one English reply routed their next Arabic
    // voice note to Groq, which mis-transcribed it toward English, so the bot
    // replied English again, and so on. Fix: if the tenant declares Arabic in
    // its bot languages, ALWAYS use OpenAI (it's fine on English too). Only fall
    // back to Groq for tenants with no Arabic AND a clearly-English last reply.
    const tenantSupportsArabic = /\bar\b/i.test(org?.botConfig?.languages ?? 'en');
    const transcribeProvider: 'openai' | 'groq' =
      tenantSupportsArabic || !prevBotMessage?.body || /[؀-ۿ]/.test(prevBotMessage.body)
        ? 'openai'
        : 'groq';

    // Step 1: Meta returns a download URL for the media id.
    const metaUrl = `https://graph.facebook.com/v25.0/${encodeURIComponent(args.mediaId)}`;
    const urlRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${channel.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!urlRes.ok) {
      args.log.warn(
        { status: urlRes.status, mediaId: args.mediaId },
        '[whatsapp] inbound media lookup failed',
      );
      return null;
    }
    const urlJson = (await urlRes.json()) as { url?: string; mime_type?: string };
    if (!urlJson.url) return null;

    // Step 2: GET the actual bytes from the signed URL.
    const fileRes = await fetch(urlJson.url, {
      headers: { Authorization: `Bearer ${channel.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!fileRes.ok) {
      args.log.warn(
        { status: fileRes.status, mediaId: args.mediaId },
        '[whatsapp] inbound media download failed',
      );
      return null;
    }
    const buf = Buffer.from(await fileRes.arrayBuffer());

    // Step 3: Whisper transcribe — only when the tenant has the feature ON.
    const mime = (args.mediaMime ?? urlJson.mime_type ?? 'audio/ogg').split(';')[0]!.trim();
    const ext = mime === 'audio/ogg' ? 'ogg' : mime === 'audio/mp4' ? 'm4a' : 'webm';
    let text = '';
    if (transcriptionEnabled) {
      const { transcribeAudio } = await import('../../lib/openai.js');
      const transcribeStart = Date.now();
      const res = await transcribeAudio({
        organizationId: args.organizationId,
        bytes: buf,
        filename: `inbound-${args.mediaId}.${ext}`,
        mimeType: mime,
        provider: transcribeProvider,
      });
      text = res.text;
      args.log.info(
        {
          mediaId: args.mediaId,
          language: res.language,
          chars: res.text.length,
          preview: res.text.slice(0, 200),
          provider: res.provider,
          transcribeMs: Date.now() - transcribeStart,
        },
        '[whatsapp] Whisper transcript',
      );
    } else {
      args.log.info({ mediaId: args.mediaId }, '[whatsapp] voice transcription disabled for org — storing audio only');
    }
    // Step 4: ALWAYS store the audio file — even when transcription came back
    // empty (silent clip, unsupported language, provider hiccup) — so the
    // operator can still LISTEN to the voice note. The transcript, when present,
    // goes behind the "Transcribe" button. Gating storage on a successful
    // transcript previously left ~70% of voice notes unplayable.
    if (args.wamid) {
      let audioAssetId: string | null = null;
      // Measured off the decoded audio (see transcodeAudioToMp3) — Meta sends
      // no duration. Stays null when storage is unconfigured or ffmpeg fails;
      // the inbox simply omits the "0:14" hint rather than showing a guess.
      let durationSeconds: number | null = null;
      try {
        const { isStorageConfigured, buildStorageKey, putObject } = await import('../../lib/storage.js');
        if (isStorageConfigured() && buf.length > 0 && buf.length <= 25 * 1024 * 1024) {
          // Transcode OGG/Opus → MP3 so it plays in every browser (Safari can't
          // decode Opus). Fall back to the original bytes if transcode fails.
          const transcoded = await transcodeAudioToMp3(buf);
          const mp3 = transcoded.bytes;
          durationSeconds = transcoded.durationSeconds;
          const storeBytes = mp3 ?? buf;
          const storeMime = mp3 ? 'audio/mpeg' : mime;
          const storeExt = mp3 ? 'mp3' : ext;
          const aId = crypto.randomUUID();
          const storageKey = buildStorageKey({
            organizationId: args.organizationId,
            kind: 'inbound-audio',
            assetId: aId,
            filename: `voice.${storeExt}`,
          });
          await putObject({ storageKey, body: storeBytes, contentType: storeMime });
          await withRlsBypass((tx) =>
            tx.asset.create({
              data: {
                id: aId,
                organizationId: args.organizationId,
                kind: 'document',
                storageKey,
                contentType: storeMime,
                byteSize: storeBytes.length,
              },
            }),
          );
          audioAssetId = aId;
        }
      } catch (e) {
        args.log.warn({ e, mediaId: args.mediaId }, '[whatsapp] inbound voice store failed');
      }
      await withRlsBypass(async (tx) => {
        await tx.whatsAppMessage.updateMany({
          where: {
            organizationId: args.organizationId,
            metaMessageId: args.wamid!,
          },
          data: {
            body: text ? `🎙 ${text}` : '🎙 Voice note',
            ...(audioAssetId ? { mediaAssetId: audioAssetId } : {}),
            ...(durationSeconds !== null ? { durationSeconds } : {}),
          },
        });
      });
    }

    args.log.info(
      { mediaId: args.mediaId, chars: text.length },
      '[whatsapp] transcribed inbound voice note',
    );
    return text;
  } catch (err) {
    args.log.warn({ err, mediaId: args.mediaId }, '[whatsapp] voice transcription threw');
    return null;
  }
}

// Download an inbound WhatsApp IMAGE from Meta and persist it to object
// storage, then point the message row at the new Asset (mediaAssetId) so the
// inbox renders the actual photo instead of an "[image]" placeholder. The
// pattern mirrors transcribeInboundVoice (media-id → download URL → bytes),
// but instead of transcribing we store the bytes. Best-effort: every failure
// is swallowed + logged; nothing here ever blocks the customer reply path.
export async function storeInboundImage(args: {
  organizationId: string;
  mediaId: string;
  mediaMime: string | null;
  wamid: string | null;
  /** 'image' (default) | 'video' | 'document' — drives size cap + extension. */
  kind?: 'image' | 'video' | 'document';
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}): Promise<void> {
  const kind = args.kind ?? 'image';
  try {
    if (!args.wamid) return; // need the wamid to link the stored asset back
    const { withRlsBypass } = await import('../../lib/db.js');
    const { isStorageConfigured, buildStorageKey, putObject } = await import('../../lib/storage.js');
    if (!isStorageConfigured()) return;

    const channel = await withRlsBypass((tx) =>
      tx.whatsAppChannel.findFirst({
        where: { organizationId: args.organizationId, isPrimary: true },
        select: { accessToken: true },
      }),
    );
    if (!channel?.accessToken) return;

    // Step 1: media id → short-lived download URL.
    const metaUrl = `https://graph.facebook.com/v25.0/${encodeURIComponent(args.mediaId)}`;
    const urlRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${channel.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!urlRes.ok) {
      args.log.warn({ status: urlRes.status, mediaId: args.mediaId }, '[whatsapp] inbound image lookup failed');
      return;
    }
    const urlJson = (await urlRes.json()) as { url?: string; mime_type?: string };
    if (!urlJson.url) return;

    // Step 2: download the bytes (authenticated with the channel token).
    const fileRes = await fetch(urlJson.url, {
      headers: { Authorization: `Bearer ${channel.accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!fileRes.ok) {
      args.log.warn({ status: fileRes.status, mediaId: args.mediaId }, '[whatsapp] inbound image download failed');
      return;
    }
    const buf = Buffer.from(await fileRes.arrayBuffer());
    // Sanity bounds. Meta caps video at 16 MB and documents at 100 MB; photos
    // stay on the original tight bound.
    const maxBytes =
      kind === 'video' ? 20 * 1024 * 1024 : kind === 'document' ? 25 * 1024 * 1024 : 10 * 1024 * 1024;
    if (buf.length === 0 || buf.length > maxBytes) return;

    const fallbackMime =
      kind === 'video' ? 'video/mp4' : kind === 'document' ? 'application/pdf' : 'image/jpeg';
    const mime = (args.mediaMime ?? urlJson.mime_type ?? fallbackMime).split(';')[0]!.trim();
    const ext =
      kind === 'video'
        ? mime.includes('3gpp')
          ? '3gp'
          : mime.includes('quicktime')
            ? 'mov'
            : 'mp4'
        : kind === 'document'
          ? (mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'
          : mime === 'image/png'
            ? 'png'
            : mime === 'image/webp'
              ? 'webp'
              : 'jpg';

    // Step 3: store first (so a failed PUT never leaves an orphan Asset row),
    // then create the Asset, then link the message. The assetId is generated
    // app-side so the storageKey is known before the row exists.
    const assetId = crypto.randomUUID();
    const storageKey = buildStorageKey({
      organizationId: args.organizationId,
      kind: `inbound-${kind}`,
      assetId,
      filename: `${kind === 'video' ? 'vid' : kind === 'document' ? 'doc' : 'img'}.${ext}`,
    });
    await putObject({ storageKey, body: buf, contentType: mime });
    await withRlsBypass(async (tx) => {
      await tx.asset.create({
        data: {
          id: assetId,
          organizationId: args.organizationId,
          // AssetKind has no `video` member; 'other' is the correct bucket and
          // contentType (video/mp4…) is what actually drives rendering.
          kind: kind === 'video' ? 'other' : kind,
          storageKey,
          contentType: mime,
          byteSize: buf.length,
        },
      });
      await tx.whatsAppMessage.updateMany({
        where: { organizationId: args.organizationId, metaMessageId: args.wamid! },
        data: { mediaAssetId: assetId },
      });
    });
    args.log.info({ mediaId: args.mediaId, kind, bytes: buf.length }, '[whatsapp] stored inbound media');
  } catch (err) {
    args.log.warn({ err, mediaId: args.mediaId }, '[whatsapp] inbound media store threw');
  }
}

function maskSecret(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function webhookCallbackUrl(orgId: string): string {
  // Meta posts here; the URL must be public + HTTPS in prod.
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/whatsapp/webhook/${orgId}`;
}

// Register THIS org's per-org callback as the WABA-level override so Meta
// actually delivers inbound here. Without it a number can be fully verified +
// send outbound yet receive NOTHING (the "empty inbox" trap). Best-effort:
// returns a status the caller can record/surface. Shared by POST /subscribe
// and the auto-subscribe baked into POST /verify so connecting a number can't
// silently skip inbound.
async function ensureWabaSubscribed(channel: {
  organizationId: string;
  wabaId: string | null;
  accessToken: string | null;
  webhookVerifyToken: string;
}): Promise<{ ok: boolean; status: string; message: string | null }> {
  if (!channel.accessToken || !channel.wabaId) {
    return { ok: false, status: 'missing_credentials', message: 'Access token and WABA ID required.' };
  }
  const callbackUrl = webhookCallbackUrl(channel.organizationId);
  const url = `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.wabaId)}/subscribed_apps`;
  const authHeaders = { Authorization: `Bearer ${channel.accessToken}` };

  // POST the override callback. Returns { success, code } where code is Meta's
  // error code (or null on success / parse failure).
  const postOverride = async (): Promise<{ success: boolean; code: number | null; msg: string }> => {
    const params = new URLSearchParams({
      override_callback_uri: callbackUrl,
      verify_token: channel.webhookVerifyToken!,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    if (res.ok && parsed?.success === true) return { success: true, code: null, msg: '' };
    const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
    const code = typeof errObj.code === 'number' ? errObj.code : null;
    const msg = typeof errObj.message === 'string' ? errObj.message : `HTTP ${res.status}`;
    return { success: false, code, msg };
  };

  try {
    let r = await postOverride();
    // Code 100 "must be subscribed to receive messages" → the app isn't
    // subscribed to this WABA yet. Do a plain subscribe (no override) first,
    // then retry the override. Some WABAs accept the override directly (which
    // is why we try that first), others require this two-step.
    if (!r.success && r.code === 100) {
      await fetch(url, { method: 'POST', headers: authHeaders, signal: AbortSignal.timeout(15_000) });
      r = await postOverride();
    }
    if (r.success) return { ok: true, status: 'subscribed', message: null };
    return {
      ok: false,
      status: r.code === 190 ? 'token_invalid' : 'subscribe_failed',
      message: r.msg,
    };
  } catch (err) {
    return { ok: false, status: 'network_error', message: err instanceof Error ? err.message : 'fetch failed' };
  }
}

function serializeChannel(c: {
  id: string;
  label: string | null;
  isPrimary: boolean;
  botEnabled: boolean;
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  appId: string | null;
  accessToken: string | null;
  appSecret: string | null;
  webhookVerifyToken: string;
  greetingMessage: string | null;
  businessName: string | null;
  businessAbout: string | null;
  businessAddress: string | null;
  businessEmail: string | null;
  isActive: boolean;
  lastVerifiedAt: Date | null;
  lastVerifyStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  organizationId: string;
}) {
  return {
    id: c.id,
    label: c.label,
    isPrimary: c.isPrimary,
    botEnabled: c.botEnabled,
    wabaId: c.wabaId,
    phoneNumberId: c.phoneNumberId,
    displayPhoneNumber: c.displayPhoneNumber,
    appId: c.appId,
    hasAccessToken: !!c.accessToken,
    hasAppSecret: !!c.appSecret,
    accessTokenMasked: maskSecret(c.accessToken),
    appSecretMasked: maskSecret(c.appSecret),
    webhookVerifyToken: c.webhookVerifyToken,
    webhookCallbackUrl: webhookCallbackUrl(c.organizationId),
    greetingMessage: c.greetingMessage,
    businessName: c.businessName,
    businessAbout: c.businessAbout,
    businessAddress: c.businessAddress,
    businessEmail: c.businessEmail,
    isActive: c.isActive,
    lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyStatus: c.lastVerifyStatus,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

// Defaults applied when an org touches /whatsapp for the first time.
function newDefaults(orgId: string) {
  return {
    organizationId: orgId,
    webhookVerifyToken: `vrf_${generateOpaqueToken(20)}`,
  };
}

/**
 * Guard against crossed Meta-app credentials at save time.
 *
 * Inbound webhook verification HMACs with the channel's app_secret, and Meta
 * signs with the secret of the app that's subscribed to the WABA. So the
 * access token, App ID, and App Secret MUST all belong to the SAME Meta app —
 * otherwise inbound silently fails the signature check and every customer
 * message is dropped (the 2026-06-15 Sandwich Wnos outage: token from
 * "Platform Campaigns", secret from a different app). We catch the mismatch the
 * moment it's entered instead of letting it go dark.
 *
 * Best-effort: only validates when a token + App ID are present, and never
 * blocks a save on a Meta network blip — only on a DEFINITIVE mismatch.
 */
async function assertMetaCredentialsConsistent(
  creds: { accessToken: string | null; appId: string | null; appSecret: string | null },
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  const { accessToken, appId, appSecret } = creds;
  if (!accessToken || !appId) return; // not enough to check anything meaningful

  // 1. Which app does the access token actually belong to?
  let tokenAppId: string | null = null;
  try {
    const res = await fetch(
      `https://graph.facebook.com/v25.0/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(accessToken)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const json = (await res.json()) as { data?: { app_id?: string } };
    tokenAppId = typeof json.data?.app_id === 'string' ? json.data.app_id : null;
  } catch (err) {
    log.warn({ err }, '[whatsapp] credential check: debug_token unreachable — skipping');
    return;
  }
  if (tokenAppId && tokenAppId !== appId) {
    // Keep the specific app ids in the server log for ops debugging — never in
    // the tenant-facing error (it would leak another app's id).
    log.warn(
      { tokenAppId, enteredAppId: appId },
      '[whatsapp] credential mismatch: token app id != entered app id',
    );
    throw badRequest(
      ApiErrorCode.VALIDATION_ERROR,
      "These WhatsApp credentials don't all belong to the same Meta app. Your access token, App ID, and App Secret must come from one and the same app — please re-copy all three from the same app in the Meta dashboard.",
    );
  }

  // 2. Does the App Secret belong to that App ID? (An app access token
  // app-id|app-secret is rejected with code 190 when the secret is wrong.)
  if (appSecret) {
    let secretMismatch = false;
    try {
      const res = await fetch(
        `https://graph.facebook.com/v25.0/${encodeURIComponent(appId)}/subscriptions?access_token=${encodeURIComponent(appId)}|${encodeURIComponent(appSecret)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const json = (await res.json()) as { error?: { code?: number } };
      if (json.error?.code === 190) secretMismatch = true;
    } catch (err) {
      log.warn({ err }, '[whatsapp] credential check: app-secret probe failed — skipping');
    }
    if (secretMismatch) {
      throw badRequest(
        ApiErrorCode.VALIDATION_ERROR,
        "The App Secret doesn't match your App ID. Please copy the App Secret from the same Meta app as your App ID and access token (Meta dashboard → App Settings → Basic).",
      );
    }
  }
}

// ---- routes ---------------------------------------------------------------

export default async function whatsappRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---------- GET /whatsapp ---------------------------------------------
  r.get(
    '/whatsapp',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Get the current org’s WhatsApp channel config (creates a stub on first call).',
        response: { 200: itemEnvelopeSchema(whatsappChannelSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        let row = await tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } });
        if (!row) {
          row = await tx.whatsAppChannel.create({ data: { ...newDefaults(orgId), isPrimary: true } });
        }
        return { data: serializeChannel(row) };
      });
    },
  );

  // ---------- PUT /whatsapp ---------------------------------------------
  r.put(
    '/whatsapp',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Upsert the WhatsApp channel config. Send empty string to clear a secret.',
        body: upsertWhatsappChannelBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappChannelSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const b = req.body;
      return app.tenant(req, async (tx) => {
        const existing =
          (await tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } })) ??
          (await tx.whatsAppChannel.create({ data: { ...newDefaults(orgId), isPrimary: true } }));

        // Helper: undefined = leave alone, '' = clear, else set.
        const update = <T>(v: T | undefined): T | null | undefined =>
          v === undefined ? undefined : v === '' ? null : v;

        // Guard crossed Meta-app credentials BEFORE persisting. Only when the
        // operator is actually touching a credential field; validate the
        // EFFECTIVE values (merge of existing + incoming). existing.* are
        // decrypted by the Prisma extension, so we compare real plaintext.
        if (b.accessToken !== undefined || b.appId !== undefined || b.appSecret !== undefined) {
          await assertMetaCredentialsConsistent(
            {
              accessToken:
                b.accessToken === undefined ? existing.accessToken : b.accessToken || null,
              appId: b.appId === undefined ? existing.appId : b.appId || null,
              appSecret: b.appSecret === undefined ? existing.appSecret : b.appSecret || null,
            },
            req.log,
          );
        }

        const updated = await tx.whatsAppChannel.update({
          where: { id: existing.id },
          data: {
            label: update(b.label ?? undefined),
            botEnabled: b.botEnabled ?? undefined,
            wabaId: update(b.wabaId ?? undefined),
            phoneNumberId: update(b.phoneNumberId ?? undefined),
            displayPhoneNumber: update(b.displayPhoneNumber ?? undefined),
            appId: update(b.appId ?? undefined),
            accessToken: update(b.accessToken),
            appSecret: update(b.appSecret),
            greetingMessage: update(b.greetingMessage ?? undefined),
            businessName: update(b.businessName ?? undefined),
            businessAbout: update(b.businessAbout ?? undefined),
            businessAddress: update(b.businessAddress ?? undefined),
            businessEmail: update(b.businessEmail ?? undefined),
            isActive: b.isActive ?? undefined,
          },
        });

        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_channel',
          entityId: updated.id,
          metadata: {
            event: 'whatsapp_channel_updated',
            isActive: updated.isActive,
            // Don't echo any secret values into the audit log.
            fieldsTouched: Object.keys(b).filter((k) => b[k as keyof typeof b] !== undefined),
          },
        });

        // the platform-HQ-only credential trail (encrypted at rest, hidden from the tenant).
        await recordCredentialAudit({
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          integration: 'whatsapp',
          credentials: {
            appId: b.appId,
            appSecret: b.appSecret,
            accessToken: b.accessToken,
            wabaId: b.wabaId,
            phoneNumberId: b.phoneNumberId,
            displayPhoneNumber: b.displayPhoneNumber,
          },
          status: updated.lastVerifyStatus ?? 'saved',
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });

        return { data: serializeChannel(updated) };
      });
    },
  );

  // ---------- DELETE /whatsapp ------------------------------------------
  r.delete(
    '/whatsapp',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Disconnect the WhatsApp channel (clears credentials, marks inactive).',
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        await tx.whatsAppChannel.updateMany({
          where: { organizationId: orgId },
          data: {
            accessToken: null,
            appSecret: null,
            wabaId: null,
            phoneNumberId: null,
            appId: null,
            isActive: false,
            lastVerifyStatus: null,
            lastVerifiedAt: null,
          },
        });
        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_channel',
          metadata: { event: 'whatsapp_channel_disconnected' },
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- POST /whatsapp/verify -------------------------------------
  // Round-trips with Meta's Graph API to confirm the access token + phone
  // number ID are valid. Doesn't store secrets in the response. Persists
  // the verification status so the page can show "last verified at X".
  r.post(
    '/whatsapp/verify',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Probe Meta to confirm the configured token + phone number id work.',
        // Multi-number: target a specific number; omitted ⇒ the primary.
        body: z.object({ channelId: uuidSchema.optional() }).optional(),
        response: { 200: itemEnvelopeSchema(whatsappVerifyResultSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channelId = req.body?.channelId;
      const channel = await app.tenant(req, (tx) =>
        channelId
          ? tx.whatsAppChannel.findFirst({ where: { id: channelId, organizationId: orgId } })
          : tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
      );
      if (!channel) throw notFound('WhatsApp channel not configured.');
      if (!channel.accessToken || !channel.phoneNumberId) {
        return {
          data: {
            ok: false,
            status: 'missing_credentials',
            verifiedDisplayPhoneNumber: null,
            verifiedQualityRating: null,
            verifiedNameStatus: null,
            errorMessage: 'Set the access token and phone number ID first.',
            rawSample: null,
          },
        };
      }

      const url = `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,name_status`;
      let body = '';
      let httpStatus = 0;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${channel.accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        httpStatus = res.status;
        body = await res.text();
      } catch (err) {
        const status = 'network_error';
        await app.tenant(req, (tx) =>
          tx.whatsAppChannel.update({
            where: { id: channel.id },
            data: { lastVerifyStatus: status, lastVerifiedAt: new Date() },
          }),
        );
        return {
          data: {
            ok: false,
            status,
            verifiedDisplayPhoneNumber: null,
            verifiedQualityRating: null,
            verifiedNameStatus: null,
            errorMessage: err instanceof Error ? err.message : 'fetch failed',
            rawSample: null,
          },
        };
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (httpStatus < 200 || httpStatus >= 300 || !parsed) {
        // Meta returns { error: { code, message, type, fbtrace_id } }.
        const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
        const code = typeof errObj.code === 'number' ? errObj.code : null;
        const status =
          code === 190 ? 'token_invalid' : httpStatus === 404 ? 'phone_not_found' : `http_${httpStatus}`;
        await app.tenant(req, (tx) =>
          tx.whatsAppChannel.update({
            where: { id: channel.id },
            data: { lastVerifyStatus: status, lastVerifiedAt: new Date() },
          }),
        );
        return {
          data: {
            ok: false,
            status,
            verifiedDisplayPhoneNumber: null,
            verifiedQualityRating: null,
            verifiedNameStatus: null,
            errorMessage: typeof errObj.message === 'string' ? errObj.message : `HTTP ${httpStatus}`,
            rawSample: body.slice(0, 500),
          },
        };
      }

      const display = typeof parsed.display_phone_number === 'string' ? parsed.display_phone_number : null;
      const quality = typeof parsed.quality_rating === 'string' ? parsed.quality_rating : null;
      const nameStatus = typeof parsed.name_status === 'string' ? parsed.name_status : null;

      // Credentials are valid. Now ALSO register the WABA-level override
      // callback so inbound actually flows here — otherwise a number can verify
      // green yet receive nothing (the empty-inbox trap that hit Full Volume).
      // Best-effort: verify still returns success; we fold the inbound state
      // into lastVerifyStatus so the page can warn when inbound isn't wired.
      const sub = await ensureWabaSubscribed({
        organizationId: orgId,
        wabaId: channel.wabaId,
        accessToken: channel.accessToken,
        webhookVerifyToken: channel.webhookVerifyToken,
      });
      // Inbound is only truly live when subscribed AND the app secret is present
      // (the webhook HMAC-verifies every delivery against it).
      const inboundLive = sub.ok && !!channel.appSecret;
      const status = inboundLive
        ? 'success'
        : sub.ok
          ? 'success_no_appsecret'
          : 'verified_inbound_failed';
      if (!sub.ok) {
        req.log.warn(
          { orgId, channelId: channel.id, subStatus: sub.status, subMsg: sub.message },
          '[whatsapp] verify ok but WABA auto-subscribe failed',
        );
      }

      await app.tenant(req, (tx) =>
        tx.whatsAppChannel.update({
          where: { id: channel.id },
          data: {
            lastVerifyStatus: status,
            lastVerifiedAt: new Date(),
            displayPhoneNumber: display ?? channel.displayPhoneNumber,
          },
        }),
      );

      return {
        data: {
          ok: true,
          status: 'success',
          verifiedDisplayPhoneNumber: display,
          verifiedQualityRating: quality,
          verifiedNameStatus: nameStatus,
          errorMessage: inboundLive
            ? null
            : sub.ok
              ? 'Verified and inbound subscribed, but the app secret is missing — add it so inbound messages can be received.'
              : `Verified, but inbound delivery could not be set up automatically (${sub.message ?? sub.status}). Click Connect/Subscribe or check the WABA + token.`,
          rawSample: null,
        },
      };
    },
  );

  // ---------- POST /whatsapp/subscribe ----------------------------------
  // One-click connect. Tells Meta to deliver THIS number's inbound webhooks
  // to THIS org's callback URL by registering an override callback on the
  // WABA's subscribed-apps entry, using the channel's own verify token.
  //
  // Why this exists: a WABA-level override callback supersedes the app-level
  // webhook config, and Meta delivers inbound only to whatever URL is set
  // there. Without this call an operator can paste valid credentials and the
  // channel still receives NOTHING (the symptom: messages never reach the
  // inbox, the bot never replies) — either because no callback was ever set,
  // or because the number was migrated from another system that left a stale
  // override pointing elsewhere. This overwrites it with our per-org URL.
  //
  // Meta GET-verifies the URL (hub.verify_token must match) before accepting,
  // which our GET /whatsapp/webhook/:orgId handler already satisfies. On
  // success we flip the channel active so the bot can reply immediately.
  r.post(
    '/whatsapp/subscribe',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Register this org’s webhook callback on the WABA + activate the channel.',
        response: { 200: itemEnvelopeSchema(whatsappSubscribeResultSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channel = await app.tenant(req, (tx) =>
        tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
      );
      if (!channel) throw notFound('WhatsApp channel not configured.');

      const callbackUrl = webhookCallbackUrl(orgId);
      // Need an access token (to call Graph) and a WABA id (the subscription
      // target). The app secret is also required for the actual inbound HMAC
      // later, but it's not needed to register the callback — we surface a
      // clear status instead of a half-working connect.
      if (!channel.accessToken || !channel.wabaId) {
        return {
          data: {
            ok: false,
            status: 'missing_credentials',
            callbackUrl,
            activated: false,
            errorMessage: 'Set the access token and WhatsApp Business Account (WABA) ID first.',
            rawSample: null,
          },
        };
      }

      const url = `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.wabaId)}/subscribed_apps`;
      const params = new URLSearchParams({
        override_callback_uri: callbackUrl,
        verify_token: channel.webhookVerifyToken,
      });
      let body = '';
      let httpStatus = 0;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${channel.accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params,
          signal: AbortSignal.timeout(15_000),
        });
        httpStatus = res.status;
        body = await res.text();
      } catch (err) {
        const status = 'network_error';
        await app.tenant(req, (tx) =>
          tx.whatsAppChannel.update({
            where: { id: channel.id },
            data: { lastVerifyStatus: status, lastVerifiedAt: new Date() },
          }),
        );
        return {
          data: {
            ok: false,
            status,
            callbackUrl,
            activated: false,
            errorMessage: err instanceof Error ? err.message : 'fetch failed',
            rawSample: null,
          },
        };
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      const success =
        httpStatus >= 200 && httpStatus < 300 && parsed?.success === true;

      if (!success) {
        // Meta returns { error: { code, message, type, fbtrace_id } }. The
        // most common failures: code 190 (token invalid/expired), or a
        // callback-verification failure when our GET endpoint didn't echo the
        // challenge (rare — our endpoint is public + verified, but the URL
        // must be reachable from Meta and the token must match).
        const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
        const code = typeof errObj.code === 'number' ? errObj.code : null;
        const msg = typeof errObj.message === 'string' ? errObj.message : `HTTP ${httpStatus}`;
        const status =
          code === 190
            ? 'token_invalid'
            : /callback|verify|url/i.test(msg)
              ? 'verify_failed'
              : `http_${httpStatus}`;
        await app.tenant(req, (tx) =>
          tx.whatsAppChannel.update({
            where: { id: channel.id },
            data: { lastVerifyStatus: `subscribe_${status}`, lastVerifiedAt: new Date() },
          }),
        );
        return {
          data: {
            ok: false,
            status,
            callbackUrl,
            activated: false,
            errorMessage: msg,
            rawSample: body.slice(0, 500),
          },
        };
      }

      // Subscribed. Flip the channel active so the bot can send replies, and
      // record the success. We only auto-activate when an app secret is also
      // present (inbound HMAC verification needs it); otherwise inbound would
      // still be rejected at the webhook with a 403, so we leave it inactive
      // and tell the operator to add the app secret.
      const canActivate = !!channel.appSecret;
      await app.tenant(req, (tx) =>
        tx.whatsAppChannel.update({
          where: { id: channel.id },
          data: {
            lastVerifyStatus: 'subscribed',
            lastVerifiedAt: new Date(),
            ...(canActivate ? { isActive: true } : {}),
          },
        }),
      );
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'whatsapp_channel',
        entityId: channel.id,
        metadata: { event: 'whatsapp_channel_subscribed', callbackUrl, activated: canActivate },
      });

      return {
        data: {
          ok: true,
          status: 'subscribed',
          callbackUrl,
          activated: canActivate,
          errorMessage: canActivate
            ? null
            : 'Subscribed, but the channel was left inactive because the app secret is missing — add it so inbound messages can be verified, then this will activate.',
          rawSample: null,
        },
      };
    },
  );

  // ---------- GET /whatsapp/embedded-signup/config ----------------------
  // Public, non-secret values the portal needs to open Meta's FB.login popup.
  // `configured: false` is how the portal decides not to render the button,
  // rather than rendering one that dead-ends.
  r.get(
    '/whatsapp/embedded-signup/config',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Non-secret Embedded Signup parameters for the browser.',
        response: { 200: itemEnvelopeSchema(whatsappEmbeddedSignupConfigSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => ({
      data: {
        // The app secret is deliberately NOT part of this shape.
        configured: Boolean(env.META_ES_APP_ID && env.META_ES_APP_SECRET && env.META_ES_CONFIG_ID),
        appId: env.META_ES_APP_ID ?? null,
        configId: env.META_ES_CONFIG_ID ?? null,
        graphVersion: env.META_GRAPH_VERSION,
        // Served from the server so the browser cannot render a different version
        // than the exchange handler will accept. The page echoes this version back
        // and a mismatch is refused, so a tab left open across a copy change
        // cannot consent someone to text they never saw.
        historyConsent: {
          version: COEXISTENCE_CONSENT_VERSION,
          text: COEXISTENCE_CONSENT_TEXT,
          available: await app.tenant(req, (tx) =>
            isSalesScanEnabled(tx, req.auth!.organizationId),
          ),
        },
      },
    }),
  );

  // ---------- POST /whatsapp/embedded-signup/exchange -------------------
  // Turns the code from Meta's Embedded Signup popup into a working channel.
  //
  // THE ORDERING IS THE SAFETY PROPERTY. Read it before changing anything:
  //
  //  1. Refuse early if unconfigured — no DB work on a request that cannot finish.
  //  2. Exchange the code FIRST. It has a 30-SECOND time-to-live and cannot be
  //     retried, so nothing slower may happen before it.
  //  3. Prove the browser-supplied phoneNumberId really belongs to that WABA.
  //     Both ids arrive from client-side JS and are untrusted until now.
  //  4. Cross-check the credentials against each other, because a mismatched
  //     app secret becomes a permanent 403 on every future inbound message.
  //  5. WRITE THE CHANNEL BEFORE SUBSCRIBING. Meta may deliver `history` the
  //     instant it is subscribed, and the webhook resolves ownership by
  //     phone_number_id — so the row has to exist first or the very first
  //     delivery is attributed to whichever org's URL Meta happened to use.
  //  6. Subscribe, then independently confirm Meta stored the override. Our own
  //     return value is not evidence.
  //  7. Ask Meta to send contacts + history. NOTHING in this repo did this
  //     before: history is partner-TRIGGERED, not pushed. Without it the tenant
  //     is connected for new messages only, the 24-hour window burns, and
  //     recovery means a full offboard and redo on their handset.
  //  8. Only now activate.
  //
  // Requires `admin`, matching every other credential-mutating WhatsApp route.
  // Not requireSuperAdmin: the tenant's own admin is the person clicking.
  r.post(
    '/whatsapp/embedded-signup/exchange',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Exchange an Embedded Signup code for a provisioned WhatsApp channel.',
        body: whatsappEmbeddedSignupBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappChannelSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const { code, wabaId } = req.body;
      // What the BROWSER claimed, which for coexistence is nothing at all.
      const claimedPhoneNumberId = req.body.phoneNumberId ?? null;
      // Resolved from Meta in step 3. EVERY step after that reads this, never
      // req.body.phoneNumberId - an undefined there is silently dropped by
      // Prisma (matching an arbitrary channel row) and interpolates as the
      // literal string "undefined" into the smb_app_data URL.
      let phoneNumberId = '';
      const label = req.body.label?.trim() || null;

      // --- 1. configured? ---------------------------------------------------
      const appId = env.META_ES_APP_ID;
      const appSecret = env.META_ES_APP_SECRET;
      if (!appId || !appSecret) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Embedded Signup is not configured on this server. Set META_ES_APP_ID and META_ES_APP_SECRET.',
        );
      }
      const gv = env.META_GRAPH_VERSION;

      // --- 2. exchange the code (30s TTL — do this first) -------------------
      const tokenUrl =
        `https://graph.facebook.com/${gv}/oauth/access_token` +
        `?client_id=${encodeURIComponent(appId)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&code=${encodeURIComponent(code)}`;
      // No redirect_uri: the Embedded Signup popup flow does not use one.
      let accessToken: string;
      try {
        const res = await fetch(tokenUrl, { signal: AbortSignal.timeout(10_000) });
        const body = (await res.json()) as {
          access_token?: string;
          error?: { message?: string; code?: number; fbtrace_id?: string };
        };
        if (!res.ok || !body.access_token) {
          // fbtrace_id is what Meta support asks for. Log it; never log the code.
          req.log.warn(
            { orgId, status: res.status, metaError: body.error?.message, fbtrace: body.error?.fbtrace_id },
            '[whatsapp] embedded signup: code exchange failed',
          );
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            body.error?.message ??
              'Meta rejected the signup code. It expires 30 seconds after the popup closes — please try connecting again.',
          );
        }
        accessToken = body.access_token;
      } catch (err) {
        if (err && typeof err === 'object' && 'statusCode' in err) throw err;
        req.log.warn({ orgId, err }, '[whatsapp] embedded signup: code exchange network error');
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Could not reach Meta to complete the connection. Please try again.');
      }

      // --- 3. prove the phone number belongs to the WABA --------------------
      // Both ids came from the browser. Until this check they are a claim.
      let displayPhoneNumber: string | null = null;
      try {
        const res = await fetch(
          `https://graph.facebook.com/${gv}/${encodeURIComponent(wabaId)}/phone_numbers` +
            `?fields=id,display_phone_number,verified_name`,
          { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) },
        );
        const body = (await res.json()) as {
          data?: { id?: string; display_phone_number?: string }[];
          error?: { message?: string };
        };
        if (!res.ok) throw badRequest(ApiErrorCode.VALIDATION_ERROR, body.error?.message ?? 'Could not list the numbers on that WhatsApp account.');
        const numbers = (body.data ?? []).filter(
          (p): p is { id: string; display_phone_number?: string } => Boolean(p.id),
        );
        let match: { id: string; display_phone_number?: string } | undefined;
        if (claimedPhoneNumberId) {
          // Standard flow: the browser named an id. Prove it.
          match = numbers.find((p) => p.id === claimedPhoneNumberId);
          if (!match) {
            req.log.warn(
              { orgId, wabaId, claimedPhoneNumberId, sawIds: numbers.map((p) => p.id) },
              '[whatsapp] embedded signup: phone number is not on that WABA — refusing',
            );
            throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'That phone number does not belong to the connected WhatsApp account.');
          }
        } else {
          // Coexistence flow: Meta returned only waba_id, so Meta's own list is
          // the sole source. REFUSE when it is not exactly one — binding the
          // wrong number would point this tenant's inbound traffic at someone
          // else's conversation, and the webhook resolves ownership by
          // phone_number_id.
          if (numbers.length !== 1) {
            req.log.warn(
              { orgId, wabaId, count: numbers.length, sawIds: numbers.map((p) => p.id) },
              '[whatsapp] embedded signup: cannot resolve a single phone number on that WABA — refusing',
            );
            throw badRequest(
              ApiErrorCode.VALIDATION_ERROR,
              numbers.length === 0
                ? 'Meta reports no phone number on that WhatsApp account yet. Your WhatsApp Business app may still be finishing — wait a minute, then contact support rather than repeating the connect flow.'
                : 'That WhatsApp account has more than one number, so we cannot tell which one you connected. Contact support — do not repeat the connect flow.',
            );
          }
          match = numbers[0]!;
        }
        phoneNumberId = match.id;
        displayPhoneNumber = match.display_phone_number ?? null;
      } catch (err) {
        if (err && typeof err === 'object' && 'statusCode' in err) throw err;
        throw badRequest(ApiErrorCode.VALIDATION_ERROR, 'Could not verify the phone number with Meta. Please try again.');
      }

      // Absence is never a valid state: every path above either assigns this or
      // throws, so an empty value here means someone added a fourth path.
      if (!phoneNumberId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Could not determine which phone number was connected. Please contact support.',
        );
      }

      // --- 4. credentials must all belong to the same Meta app --------------
      // Skips itself on a network error, so a Meta blip can never block signup.
      await assertMetaCredentialsConsistent({ accessToken, appId, appSecret }, req.log);

      // --- 5. write the channel BEFORE subscribing --------------------------
      // Must be a top-level whatsAppChannel create/update inside app.tenant:
      // withSecretCrypto is registered on that model and walks only top-level
      // data/create/update. A nested write, raw SQL, or a renamed column stores
      // the token and secret as PLAINTEXT with no error.
      const channel = await app.tenant(req, async (tx) => {
        const existingSame = await tx.whatsAppChannel.findFirst({ where: { phoneNumberId } });
        // An org's first visit to GET /whatsapp mints an empty placeholder row
        // (no phone id, no secret). Adopt it rather than leaving it orphaned
        // beside the real channel.
        const stub = existingSame
          ? null
          : await tx.whatsAppChannel.findFirst({
              where: { organizationId: orgId, phoneNumberId: null, accessToken: null },
              orderBy: { createdAt: 'asc' },
            });
        const target = existingSame ?? stub;
        const anyPrimary = await tx.whatsAppChannel.findFirst({
          where: { organizationId: orgId, isPrimary: true },
          select: { id: true },
        });
        const data = {
          wabaId,
          phoneNumberId,
          displayPhoneNumber,
          appId,
          accessToken,
          // Required: the inbound webhook HMACs with this and 403s every
          // message without it.
          appSecret,
          label,
          // Activated at step 8, once inbound is actually wired.
          isActive: false,
          botEnabled: false,
          lastVerifyStatus: 'embedded_signup',
          lastVerifiedAt: new Date(),
        };
        if (target) {
          return tx.whatsAppChannel.update({ where: { id: target.id }, data });
        }
        return tx.whatsAppChannel.create({
          data: {
            ...newDefaults(orgId),
            ...data,
            // EXPLICIT. The schema default is `true`, so an omitted value here
            // trips whatsapp_channels_one_primary_per_org on any org that
            // already has a primary.
            isPrimary: !anyPrimary,
          },
        });
      });

      // --- 6. subscribe, then verify Meta agrees ----------------------------
      const sub = await ensureWabaSubscribed(channel);
      if (!sub.ok) {
        await app.tenant(req, (tx) =>
          tx.whatsAppChannel.update({
            where: { id: channel.id },
            data: { lastVerifyStatus: `subscribe_failed:${sub.status}`, isActive: false },
          }),
        );
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          sub.message ??
            'Connected, but Meta would not register the webhook for this account, so messages would not reach you. The number is saved and inactive — retry from the WhatsApp page.',
        );
      }
      // Independent confirmation. ensureWabaSubscribed returning ok is our own
      // claim; this is Meta's. A silently-missing override leaves the WABA
      // delivering to the app-level URL indefinitely.
      const expectedCallback = webhookCallbackUrl(orgId);
      try {
        const res = await fetch(
          `https://graph.facebook.com/${gv}/${encodeURIComponent(wabaId)}/subscribed_apps`,
          { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) },
        );
        const body = (await res.json()) as {
          data?: { override_callback_uri?: string; whatsapp_business_api_data?: { id?: string } }[];
        };
        const overrides = (body.data ?? []).map((d) => d.override_callback_uri).filter(Boolean);
        if (!overrides.includes(expectedCallback)) {
          req.log.warn(
            { orgId, wabaId, expectedCallback, overrides },
            '[whatsapp] embedded signup: override callback NOT confirmed by Meta — deliveries may land on the app-level URL',
          );
        }
      } catch (err) {
        req.log.warn({ orgId, wabaId, err }, '[whatsapp] embedded signup: could not read back subscribed_apps');
      }

      // --- 7. ASK Meta for contacts, and for history ONLY WITH CONSENT ------
      //
      // Both syncs are partner-TRIGGERED, not pushed. Skipping one leaves the
      // tenant connected for new messages only and burns the 24-hour window —
      // and there is no second chance without a full offboard and redo.
      // Non-fatal individually: the channel is already usable for live traffic,
      // and a failure here is loud rather than silent.
      //
      // THE TWO SYNCS ARE NOT THE SAME ACT, which is why they are no longer
      // requested in one unconditional loop.
      //
      //  - `smb_app_state_sync` returns the tenant's OWN address book. They are
      //    handing us their own contacts by connecting their own number, the
      //    same as every other contact-import path in the product. Always run.
      //
      //  - `history` returns up to 180 DAYS OF THEIR CUSTOMERS' CONVERSATIONS —
      //    third-party message content, most of it exchanged long before this
      //    request, belonging to people who have agreed nothing with us. It ran
      //    unconditionally until 2026-08-24: no consent text, no grant, no
      //    retention clock, and it landed in a table nothing purged. Nobody had
      //    connected yet, so nothing leaked; this is the gate that closed it.
      //
      // The grant is created BEFORE the request, never after. If grant creation
      // throws we do not ask — a corpus that exists with no record of what was
      // agreed is the exact state this is here to prevent, and the ordering is
      // the only thing that guarantees it (history can begin arriving the
      // instant Meta accepts the request).
      const historyDecision = shouldRequestHistory(req.body.historyConsent);
      const syncTypes: ('smb_app_state_sync' | 'history')[] = ['smb_app_state_sync'];
      // The `sales_scan` feature is the second half of the gate, and it is a
      // gate on COLLECTION, not just on the UI. Holding 180 days of a tenant's
      // customers' conversations is only defensible when there is a product
      // that uses them; for a tenant HQ has not activated there is no summary
      // page, no voice profile, nothing — so the honest answer is not to take
      // the data at all. Fails closed: the key is defaultDisabled, so a tenant
      // gets asked only after someone deliberately switched it on.
      if (!historyDecision.request) {
        req.log.info(
          { orgId, phoneNumberId, reason: historyDecision.reason },
          '[whatsapp] embedded signup: no history consent — contacts only, conversation history NOT requested',
        );
      } else if (!(await app.tenant(req, (tx) => isSalesScanEnabled(tx, orgId)))) {
        req.log.info(
          { orgId, phoneNumberId, consentVersion: historyDecision.consentVersion },
          '[whatsapp] embedded signup: history consent given but sales_scan is off for this org — NOT requesting history',
        );
      } else {
        try {
          const grant = await app.tenant(req, (tx) =>
            createCoexistenceGrant(tx, {
              organizationId: orgId,
              // The echo stream's window. Deliberately NOT what bounds the
              // history burst — 180 days arrives regardless of this number.
              windowDays: SALES_SCAN_DEFAULT_WINDOW_DAYS,
              grantedByUserId: req.auth!.userId,
              phoneE164: displayPhoneNumber ? displayPhoneNumber.replace(/[^\d]/g, '') : null,
            }),
          );
          syncTypes.push('history');
          req.log.info(
            { orgId, phoneNumberId, grantId: grant.id, consentVersion: grant.consentVersion },
            '[whatsapp] embedded signup: history consent recorded — requesting conversation history',
          );
        } catch (err) {
          // Provisioning still succeeds. We simply do not ask for history,
          // which is the safe direction: the tenant keeps a working channel and
          // loses only an enrichment they can never be silently given instead.
          req.log.error(
            { orgId, phoneNumberId, err },
            '[whatsapp] embedded signup: could not record the history consent grant — NOT requesting history',
          );
        }
      }
      for (const syncType of syncTypes) {
        try {
          const res = await fetch(
            `https://graph.facebook.com/${gv}/${encodeURIComponent(phoneNumberId)}/smb_app_data`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ messaging_product: 'whatsapp', sync_type: syncType }),
              signal: AbortSignal.timeout(15_000),
            },
          );
          const body = (await res.json()) as { success?: boolean; error?: { message?: string; code?: number } };
          if (!res.ok || body.error) {
            req.log.error(
              { orgId, phoneNumberId, syncType, status: res.status, metaError: body.error?.message, code: body.error?.code },
              '[whatsapp] embedded signup: smb_app_data sync request REJECTED — history/contacts will not arrive',
            );
          } else {
            req.log.info({ orgId, phoneNumberId, syncType }, '[whatsapp] embedded signup: sync requested');
          }
        } catch (err) {
          req.log.error(
            { orgId, phoneNumberId, syncType, err },
            '[whatsapp] embedded signup: smb_app_data request failed — history/contacts will not arrive',
          );
        }
      }

      // --- 8. activate + audit ---------------------------------------------
      const active = await app.tenant(req, (tx) =>
        tx.whatsAppChannel.update({
          where: { id: channel.id },
          data: { isActive: true, lastVerifyStatus: 'subscribed' },
        }),
      );
      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'whatsapp_channel',
        entityId: active.id,
        metadata: {
          event: 'whatsapp_channel_updated',
          via: 'embedded_signup',
          coexistence: true,
          wabaId,
          phoneNumberId,
        },
      });
      await recordCredentialAudit({
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        integration: 'whatsapp',
        // Only non-empty values are recorded, and never the raw secret itself.
        credentials: { appId, wabaId, phoneNumberId },
        status: 'embedded_signup',
      });

      return { data: serializeChannel(active) };
    },
  );

  // ---------- POST /whatsapp/test-send ----------------------------------
  // Sends the `hello_world` template — the only message Meta lets us send
  // outside an active 24-hour customer window. Useful for proving the
  // token works end-to-end. Recipient must be a tester registered in Meta.
  r.post(
    '/whatsapp/test-send',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Send the hello_world template to a recipient (must be a Meta tester).',
        body: whatsappTestSendBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappTestSendResultSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const channelId = req.body.channelId;
      const channel = await app.tenant(req, (tx) =>
        channelId
          ? tx.whatsAppChannel.findFirst({ where: { id: channelId, organizationId: orgId } })
          : tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
      );
      if (!channel) throw notFound('WhatsApp channel not configured.');
      if (!channel.accessToken || !channel.phoneNumberId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Set the access token and phone number ID before sending.',
        );
      }
      const to = req.body.to.replace(/[^\d+]/g, '').replace(/^\+/, '');

      // Metered billing (docs/wallet-billing-plan.md): a test send is a real
      // WhatsApp message, so gate + charge it too. Reject if the metered
      // tenant can't afford one; charge on success below.
      const billingWallet = await wallet.getWallet(orgId);
      if (billingWallet?.meteringEnabled && billingWallet.availableMicros < billingWallet.pricePerMessageMicros) {
        throw paymentRequired(
          `Insufficient WhatsApp balance to send a test. Top up your wallet (balance $${(billingWallet.availableMicros / 1_000_000).toFixed(2)}).`,
        );
      }

      // Template name + language come from the request body (or fall back
      // to the well-known Meta sandbox 'hello_world / en_US'). Most accounts
      // don't actually have hello_world in their library, so we let callers
      // pass any template they've already approved.
      const templateName = req.body.templateName?.trim() || 'hello_world';
      const templateLanguage = req.body.templateLanguage?.trim() || 'en_US';
      const parameters = (req.body.parameters ?? []).map((v) => v.trim());

      // Fetch the template's components from Meta so we can build a payload
      // that satisfies every part Meta expects:
      //   - HEADER with TEXT  → if it has {{1}}, take the first body param
      //                          (rare; templates usually have header text
      //                          static). Skipped for now.
      //   - HEADER with IMAGE/VIDEO/DOCUMENT → use the `example.header_handle`
      //                          URL Meta itself provided when the template
      //                          was created. This is what allows test-send
      //                          on media-header templates without uploading.
      //   - BODY              → bind operator-supplied parameters[] to the
      //                          {{1}}, {{2}}, … placeholders.
      //   - FOOTER + BUTTONS  → no parameters required for static / quick-
      //                          reply buttons. URL buttons with {{1}} would
      //                          need handling, deferred.
      // Without this lookup, media-header templates fail with Meta error
      // 132012 ("Parameter format does not match format in the created
      // template") even when the body has no placeholders.
      type MetaComp = {
        type?: string;
        format?: string;
        text?: string;
        example?: { header_handle?: string[] };
      };
      let metaComponents: MetaComp[] = [];
      try {
        const tplRes = await fetch(
          `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.wabaId!)}/message_templates` +
            `?name=${encodeURIComponent(templateName)}&fields=id,name,language,components&limit=10`,
          {
            headers: { Authorization: `Bearer ${channel.accessToken}` },
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (tplRes.ok) {
          const body = (await tplRes.json()) as {
            data?: { name?: string; language?: string; components?: MetaComp[] }[];
          };
          const match = (body.data ?? []).find(
            (t) => t.name === templateName && t.language === templateLanguage,
          ) ?? (body.data ?? [])[0];
          metaComponents = match?.components ?? [];
        }
      } catch {
        // Non-fatal — fall through with no components and let Meta tell us
        // what's wrong on the actual send call.
      }

      // Operator-supplied per-variable values for header + button URL
      // placeholders. `parameters[]` already covers the body.
      const headerTextParam = req.body.headerTextParam?.trim() ?? null;
      const buttonUrlParams = (req.body.buttonUrlParams ?? []).map((v) => v.trim());

      const sendComponents: Record<string, unknown>[] = [];
      let urlButtonCursor = 0;

      for (const rawC of metaComponents) {
        const c = rawC as MetaComp & {
          buttons?: { type?: string; url?: string }[];
        };
        const t = (c.type ?? '').toUpperCase();
        const fmt = (c.format ?? '').toUpperCase();
        if (t === 'HEADER') {
          if (fmt === 'TEXT') {
            // Header with {{1}} (Meta only supports one var in headers).
            const hasVar = /{{\s*1\s*}}/.test(c.text ?? '');
            if (hasVar && headerTextParam) {
              sendComponents.push({
                type: 'header',
                parameters: [{ type: 'text', text: headerTextParam }],
              });
            }
          } else if (fmt && fmt !== 'TEXT') {
            const handle = c.example?.header_handle?.[0];
            if (handle) {
              const kind = fmt.toLowerCase(); // image | video | document
              sendComponents.push({
                type: 'header',
                parameters: [{ type: kind, [kind]: { link: handle } }],
              });
            }
          }
        }
        if (t === 'BODY' && parameters.length > 0) {
          sendComponents.push({
            type: 'body',
            parameters: parameters.map((text) => ({ type: 'text', text })),
          });
        }
        if (t === 'BUTTONS') {
          // For each URL button with {{1}}, pull the next value from
          // buttonUrlParams[] and emit a per-button-index entry. Non-URL
          // buttons and URL buttons without placeholders are skipped
          // (Meta doesn't need a runtime parameter for them).
          const buttons = c.buttons ?? [];
          buttons.forEach((b, i) => {
            const btype = (b.type ?? '').toUpperCase();
            if (btype !== 'URL') return;
            const hasVar = /{{\s*1\s*}}/.test(b.url ?? '');
            if (!hasVar) return;
            const value = buttonUrlParams[urlButtonCursor] ?? '';
            urlButtonCursor += 1;
            if (!value) return;
            sendComponents.push({
              type: 'button',
              sub_type: 'url',
              index: String(i),
              parameters: [{ type: 'text', text: value }],
            });
          });
        }
      }

      const templateBlock: Record<string, unknown> = {
        name: templateName,
        language: { code: templateLanguage },
      };
      if (sendComponents.length > 0) {
        templateBlock.components = sendComponents;
      }

      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: templateBlock,
      };

      let resBody = '';
      let resStatus = 0;
      try {
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        resStatus = res.status;
        resBody = await res.text();
      } catch (err) {
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'fetch failed',
          },
        };
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(resBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (resStatus < 200 || resStatus >= 300 || !parsed) {
        const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage:
              typeof errObj.message === 'string'
                ? errObj.message
                : `HTTP ${resStatus} — ${resBody.slice(0, 200)}`,
          },
        };
      }

      const messages = (parsed.messages ?? []) as { id?: string }[];
      const metaMessageId = messages[0]?.id ?? null;

      // Persist outbound to the inbox: upsert a thread keyed by the
      // recipient phone, attach the whatsAppMessage to it, and bump
      // the preview/counts so the conversation surfaces immediately
      // in /inbox.
      //
      // For the message body we render the FULL template text the
      // recipient will actually see — pulled from the BODY component
      // we just fetched from Meta — with {{1}}, {{2}}, … interpolated
      // from the operator's parameters. This way the inbox shows the
      // real customer-facing copy instead of a "[template] name"
      // placeholder, and there's no "see more" truncation: operators
      // can read the whole thing without scrolling on a phone.
      // Render the FULL customer-facing template — header (text) + body +
      // footer, each with {{n}} interpolated — and capture the button labels so
      // the inbox bubble shows exactly what the recipient sees, buttons and all,
      // rather than a "[template] name" placeholder.
      const interpolate = (tpl: string, vals: string[]) =>
        tpl.replace(/{{\s*(\d+)\s*}}/g, (_m, idx: string) => vals[Number(idx) - 1] ?? `{{${idx}}}`);
      const compByType = (want: string) =>
        metaComponents.find((c) => (c.type ?? '').toUpperCase() === want) as
          | (MetaComp & { buttons?: { type?: string; text?: string; url?: string }[] })
          | undefined;

      const headerComp = compByType('HEADER');
      const headerText =
        headerComp && (headerComp.format ?? '').toUpperCase() === 'TEXT' && headerComp.text
          ? interpolate(headerComp.text, headerTextParam ? [headerTextParam] : [])
          : '';
      const bodyComponent = compByType('BODY');
      const renderedBody = bodyComponent?.text ? interpolate(bodyComponent.text, parameters) : '';
      const footerText = compByType('FOOTER')?.text ?? '';
      // Button labels (all kinds — quick-reply, URL, phone). Shown as pills.
      const buttonLabels = (compByType('BUTTONS')?.buttons ?? [])
        .map((b) => (b.text ?? '').trim())
        .filter(Boolean);

      // Compose: [template tag line] + header + body + footer. The leading tag
      // makes it obvious this was a template send. Fall back to a plain marker
      // when the Meta-side components fetch failed.
      const tagLine = `📨 Template · ${templateName}${templateLanguage !== 'en_US' ? ` (${templateLanguage})` : ''}`;
      const renderedFull = [headerText, renderedBody, footerText].filter(Boolean).join('\n\n');
      const previewBody = renderedFull
        ? `${tagLine}\n\n${renderedFull}`
        : parameters.length > 0
        ? `${tagLine} · ${parameters.join(' / ')}`
        : tagLine;
      await withRlsBypass(async (tx) => {
        const thread = await upsertWaThread(tx, {
          organizationId: orgId,
          customerPhone: to,
          whatsAppChannelId: channel.id,
          create: {
            status: 'open',
            lastMessageAt: new Date(),
            lastMessagePreview: previewBody.slice(0, 200),
            inboundCount: 0,
            outboundCount: 1,
            searchText: previewBody,
          },
          update: {
            lastMessageAt: new Date(),
            lastMessagePreview: previewBody.slice(0, 200),
            outboundCount: { increment: 1 },
            status: 'open',
          },
        });
        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: orgId,
            direction: 'outbound',
            metaMessageId,
            fromNumber: channel.displayPhoneNumber ?? null,
            toNumber: to,
            messageType: 'template',
            body: previewBody,
            // Stamp the button labels so the inbox renders them as pills under
            // the bubble (it reads rawPayload.quickReplies).
            rawPayload: { ...(payload as Record<string, unknown>), quickReplies: buttonLabels } as never,
          },
        });
      }).catch((err) => req.log.error({ err }, '[whatsapp] test-send persist failed'));

      // Charge the delivered test message against the metered wallet.
      if (billingWallet?.meteringEnabled) {
        await wallet
          .chargeAtSend({
            orgId,
            unitPriceMicros: billingWallet.pricePerMessageMicros,
            metaCostMicros: billingWallet.metaCostMicros,
          })
          .catch((err) => req.log.error({ err }, '[whatsapp] test-send billing failed'));
      }

      return { data: { ok: true, metaMessageId, errorMessage: null } };
    },
  );

  // ---------- POST /whatsapp/send ---------------------------------------
  // Send a free-form text reply to a customer. Meta only accepts non-template
  // messages within a 24-hour session window after the customer's last
  // inbound message. We don't enforce that here — Meta will return an error
  // and we surface it. Persists outbound to the audit log.
  r.post(
    '/whatsapp/send',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Send a free-form text reply (must be inside the 24h customer-session window).',
        body: whatsappSendTextBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappTestSendResultSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      // Multi-number: reply FROM the number the thread belongs to. The inbox
      // passes threadId; we resolve its whatsAppChannelId. Falls back to the
      // primary number when there's no thread or the thread isn't number-bound.
      const channel = await app.tenant(req, async (tx) => {
        if (req.body.threadId) {
          const t = await tx.whatsAppThread.findFirst({
            where: { id: req.body.threadId, organizationId: orgId },
            select: { whatsAppChannelId: true },
          });
          if (t?.whatsAppChannelId) {
            const bound = await tx.whatsAppChannel.findFirst({
              where: { id: t.whatsAppChannelId, organizationId: orgId },
            });
            if (bound) return bound;
          }
        }
        return tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } });
      });
      if (!channel) throw notFound('WhatsApp channel not configured.');
      if (!channel.accessToken || !channel.phoneNumberId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Set the access token and phone number ID before sending.',
        );
      }
      if (!channel.isActive) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Channel is not active — flip the Live toggle first.',
        );
      }
      // Phase 3 cap check — block sends when the monthly message cap is hit.
      const { capCheck } = await import('../../lib/billing.js');
      await app.tenant(req, (tx) => capCheck(tx as never, orgId, 'monthly_message', { actorIsSuperAdmin: req.auth!.isSuperAdmin }));

      const bucket = await consumeSendToken(channel.phoneNumberId ?? orgId);
      if (!bucket.ok) {
        throw badRequest(
          ApiErrorCode.RATE_LIMITED,
          `Outbound rate limit hit — retry in ${bucket.retryAfterMs}ms.`,
        );
      }
      const to = req.body.to.replace(/[^\d+]/g, '').replace(/^\+/, '');

      // Operator block — never message a contact the operator has blocked.
      // Mirrors the bot gate in maybeReplyAsBot so "blocked" means no outbound
      // at all (bot OR human). Matches the contact by either phone form.
      const blockedContact = await app.tenant(req, (tx) =>
        tx.contact.findFirst({
          where: {
            organizationId: orgId,
            deletedAt: null,
            blockedAt: { not: null },
            phoneE164: { in: [to, `+${to}`] },
          },
          select: { id: true },
        }),
      );
      if (blockedContact) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'This contact is blocked — unblock them to send messages again.',
        );
      }

      // §5.1.2 24-hour session window. Meta only allows free-form text
      // when the customer messaged in the last 24h; otherwise the agent
      // must use an approved template. Enforce client-side so the user
      // gets a clear error before we burn a Meta API call (and to surface
      // the requirement in the UI rather than buried in a raw Meta error).
      const lastInbound = await app.tenant(req, (tx) =>
        tx.whatsAppMessage.findFirst({
          where: { direction: 'inbound', fromNumber: to },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        }),
      );
      const ageMs = lastInbound ? Date.now() - lastInbound.receivedAt.getTime() : Infinity;
      if (ageMs > 24 * 60 * 60 * 1000) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Outside the 24-hour session window. Send an approved template message instead — free-form replies require an inbound message from this customer in the last 24 hours.',
        );
      }
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: true, body: req.body.body },
      };

      let resBody = '';
      let resStatus = 0;
      try {
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        resStatus = res.status;
        resBody = await res.text();
      } catch (err) {
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'fetch failed',
          },
        };
      }

      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(resBody) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      if (resStatus < 200 || resStatus >= 300 || !parsed) {
        const errObj = (parsed?.error ?? {}) as Record<string, unknown>;
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage:
              typeof errObj.message === 'string'
                ? errObj.message
                : `HTTP ${resStatus} — ${resBody.slice(0, 200)}`,
          },
        };
      }

      const messages = (parsed.messages ?? []) as { id?: string }[];
      const metaMessageId = messages[0]?.id ?? null;

      await withRlsBypass(async (tx) => {
        const thread = await upsertWaThread(tx, {
          organizationId: orgId,
          customerPhone: to,
          whatsAppChannelId: channel.id,
          create: {
            status: 'open',
            lastMessageAt: new Date(),
            lastMessagePreview: req.body.body.slice(0, 200),
            inboundCount: 0,
            outboundCount: 1,
            searchText: req.body.body,
          },
          update: {
            lastMessageAt: new Date(),
            lastMessagePreview: req.body.body.slice(0, 200),
            outboundCount: { increment: 1 },
          },
        });
        // Operator replied → if the bot had escalated this chat to a
        // human, clear the flag so the sidebar badge decrements and
        // the red row tint goes away. Don't touch other statuses
        // (resolved / pending / open) since the operator might be
        // intentionally re-opening a closed chat.
        if (thread.status === 'escalated' || thread.assignedToUserId === null) {
          await tx.whatsAppThread.update({
            where: { id: thread.id },
            data: {
              ...(thread.status === 'escalated' ? { status: 'open' as never } : {}),
              ...(thread.assignedToUserId === null
                ? { assignedToUserId: req.auth!.userId }
                : {}),
            },
          });
        }
        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: orgId,
            direction: 'outbound',
            metaMessageId,
            toNumber: to,
            messageType: 'text',
            body: req.body.body,
            rawPayload: payload as never,
          },
        });
      }).catch(() => undefined);

      // Phase 3 — count this send against the monthly message cap.
      const { bumpUsage } = await import('../../lib/billing.js');
      const { prisma } = await import('../../lib/db.js');
      void bumpUsage(prisma as never, orgId, 'message_outbound');

      await recordAudit({
        action: 'business_info_updated',
        organizationId: orgId,
        actorUserId: req.auth!.userId,
        entityType: 'whatsapp_message',
        entityId: metaMessageId ?? undefined,
        metadata: { event: 'whatsapp_send_text', to },
      });

      return { data: { ok: true, metaMessageId, errorMessage: null } };
    },
  );

  // Thread routes moved to apps/api/src/modules/whatsapp-inbox/inbox.routes.ts
  // (Session 4 — Phase 3 §5.1.1). The new endpoints are id-keyed and
  // support status, tags, assignment, internal notes, and search.

  // ---------- GET /whatsapp/messages ------------------------------------
  // Audit log of inbound + test-outbound messages.
  r.get(
    '/whatsapp/messages',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Recent WhatsApp messages (inbound + test-outbound).',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: listEnvelopeSchema(whatsappMessageSchema) },
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppMessage.findMany({
          orderBy: { receivedAt: 'desc' },
          take: req.query.limit,
        });
        return {
          data: rows.map((m) => ({
            id: m.id,
            direction: m.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const),
            metaMessageId: m.metaMessageId,
            fromNumber: m.fromNumber,
            toNumber: m.toNumber,
            messageType: m.messageType,
            body: m.body,
            receivedAt: m.receivedAt.toISOString(),
          })),
          nextCursor: null,
        };
      }),
  );

  // ---------- POST /whatsapp/send-media -------------------------------
  // Two-step send: download the asset bytes from Wasabi → POST to Meta's
  // /media endpoint to obtain a media_id → POST /messages with that id.
  // Persists the outbound message in the audit log + thread.
  r.post(
    '/whatsapp/send-media',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Send a media message (image/document) using an uploaded Asset id.',
        body: whatsappSendMediaBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappTestSendResultSchema) },
      },
      preHandler: [app.requireRole('editor')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      // Tag every step of the voice/media send with a distinctive
      // prefix so we can grep the journalctl output cleanly. Drop
      // these once the path is confirmed healthy in prod.
      req.log.info(
        {
          assetId: req.body.assetId,
          mediaType: req.body.mediaType,
          to: req.body.to,
          hasCaption: !!req.body.caption,
        },
        '[AL-VOICE-DEBUG] send-media route start',
      );
      const channel = await app.tenant(req, (tx) =>
        tx.whatsAppChannel.findFirst({ where: { organizationId: orgId, isPrimary: true } }),
      );
      if (!channel) throw notFound('WhatsApp channel not configured.');
      if (!channel.accessToken || !channel.phoneNumberId) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Set the access token and phone number ID before sending.',
        );
      }
      if (!channel.isActive) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Channel is not active — flip the Live toggle first.',
        );
      }

      // Look up the asset (RLS will enforce tenant isolation).
      const asset = await app.tenant(req, (tx) =>
        tx.asset.findUnique({ where: { id: req.body.assetId } }),
      );
      if (!asset) throw notFound('Asset not found.');

      // Rate limit + cap.
      const { capCheck, bumpUsage } = await import('../../lib/billing.js');
      const { prisma } = await import('../../lib/db.js');
      await app.tenant(req, (tx) => capCheck(tx as never, orgId, 'monthly_message', { actorIsSuperAdmin: req.auth!.isSuperAdmin }));
      const bucket = await consumeSendToken(channel.phoneNumberId ?? orgId);
      if (!bucket.ok) {
        throw badRequest(
          ApiErrorCode.RATE_LIMITED,
          `Outbound rate limit hit — retry in ${bucket.retryAfterMs}ms.`,
        );
      }

      // Step 1: fetch the asset bytes from object storage.
      const { presignGetUrl, publicUrlFor } = await import('../../lib/storage.js');
      const fileUrl = publicUrlFor(asset.storageKey) ?? (await presignGetUrl(asset.storageKey));
      let fileBytes: Buffer;
      try {
        const r = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`asset fetch ${r.status}`);
        const ab = await r.arrayBuffer();
        fileBytes = Buffer.from(ab);
      } catch (err) {
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'asset fetch failed',
          },
        };
      }

      // Step 2: upload to Meta as multipart/form-data → media_id.
      // Meta's /media rejects MIME types that include codec parameters
      // (e.g. "audio/ogg;codecs=opus") — strip everything after ';'.
      // Then if we're sending audio, also coerce to one of the MIME
      // types Meta accepts (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media):
      //   audio/aac, audio/mp4, audio/mpeg, audio/amr, audio/ogg.
      //
      // IMPORTANT: Browsers lie about what MediaRecorder is going to
      // produce. Chrome on desktop reports isTypeSupported('audio/ogg')
      // as true but actually writes a WebM/EBML container internally.
      // Meta validates the bytes, not the headers, and silently rejects
      // unsupported audio containers — the upload "succeeds" (200) but
      // the customer never sees the message. So we sniff the magic bytes
      // here, override the MIME to the truth, and degrade audio → document
      // when the container isn't actually one Meta plays back.
      const rawContentType = asset.contentType ?? 'application/octet-stream';
      let baseContentType = rawContentType.split(';')[0]!.trim();
      const sniffed = sniffMediaContainer(fileBytes);
      if (sniffed) baseContentType = sniffed;
      // Browser MediaRecorder doesn't produce Meta-compatible audio.
      // Safari emits fragmented MP4 (no moov atom), Chrome emits
      // WebM/Opus, Firefox ogg/opus — none of which survive Meta's
      // async delivery validator. Meta accepts /media + /messages
      // with 200, then drops the message with code 131053 ("uploaded
      // as audio/mp4 but on processing it is application/octet-stream").
      //
      // Fix: transcode server-side via ffmpeg to canonical audio/ogg +
      // libopus, 16kHz mono — exactly what WhatsApp uses for native
      // voice notes. After transcode we set audio.voice=true so the
      // bubble renders with the waveform UI, not as a file attachment.
      // If ffmpeg fails for any reason we fall back to the document
      // delivery path so the audio still reaches the customer.
      let effectiveMediaType = req.body.mediaType;
      let voiceNoteFlag = false;
      if (effectiveMediaType === 'audio') {
        const { transcodeToOggOpus } = await import('../../lib/audio-transcode.js');
        const t0 = Date.now();
        const srcLen = fileBytes.length;
        const result = await transcodeToOggOpus(fileBytes);
        if (result.ok) {
          fileBytes = result.bytes;
          baseContentType = result.mime;
          voiceNoteFlag = true;
          req.log.info(
            {
              srcBytes: srcLen,
              outBytes: result.bytes.length,
              durationMs: Date.now() - t0,
            },
            '[AL-VOICE-DEBUG] transcoded to audio/ogg+opus',
          );
        } else {
          req.log.warn(
            { error: result.error },
            '[whatsapp] audio transcode failed — degrading to document so the file at least delivers',
          );
          effectiveMediaType = 'document';
        }
      }
      req.log.info(
        {
          assetContentType: rawContentType,
          sniffed,
          baseContentType,
          requestedMediaType: req.body.mediaType,
          effectiveMediaType,
          fileBytesLen: fileBytes.length,
        },
        '[AL-VOICE-DEBUG] after sniff',
      );
      // Filename + extension matter to Meta — it uses the extension to
      // dispatch the file to the right downstream pipeline. Sending
      // "upload.bin" makes Meta accept the upload, but WhatsApp can't
      // play it back. Derive a sensible extension from the content
      // type so audio actually reaches the customer's phone.
      const EXT_BY_MIME: Record<string, string> = {
        'audio/ogg': 'ogg',
        'audio/mpeg': 'mp3',
        'audio/mp4': 'm4a',
        'audio/aac': 'aac',
        'audio/amr': 'amr',
        'audio/webm': 'webm',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'application/pdf': 'pdf',
      };
      const ext = EXT_BY_MIME[baseContentType] ?? baseContentType.split('/')[1] ?? 'bin';
      const storedFilename =
        (asset.metadata as { filename?: string } | null)?.filename ?? `media-${asset.id}.${ext}`;
      // Always force the extension to match the MIME so a filename
      // mis-saved as "voice.webm" with content-type "audio/ogg" still
      // arrives at Meta as voice.ogg.
      const filenameWithExt = storedFilename.replace(/\.[^.]+$/, '') + `.${ext}`;
      let metaMediaId: string | null = null;
      try {
        const fd = new FormData();
        const blob = new Blob([fileBytes], { type: baseContentType });
        fd.set('file', blob, filenameWithExt);
        fd.set('messaging_product', 'whatsapp');
        fd.set('type', baseContentType);
        const upRes = await fetch(
          `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId)}/media`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${channel.accessToken}` },
            body: fd,
            signal: AbortSignal.timeout(20_000),
          },
        );
        const upText = await upRes.text();
        req.log.info(
          { status: upRes.status, bodySnippet: upText.slice(0, 400) },
          '[AL-VOICE-DEBUG] Meta /media response',
        );
        if (!upRes.ok) {
          return {
            data: { ok: false, metaMessageId: null, errorMessage: `Meta media upload ${upRes.status}: ${upText.slice(0, 200)}` },
          };
        }
        const upJson = JSON.parse(upText) as { id?: string };
        metaMediaId = upJson.id ?? null;
      } catch (err) {
        req.log.warn({ err }, '[AL-VOICE-DEBUG] Meta /media threw');
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'Meta upload failed',
          },
        };
      }
      if (!metaMediaId) {
        req.log.warn({}, '[AL-VOICE-DEBUG] Meta returned no media id');
        return { data: { ok: false, metaMessageId: null, errorMessage: 'Meta returned no media id' } };
      }

      // Step 3: send the message.
      const to = req.body.to.replace(/[^\d+]/g, '').replace(/^\+/, '');

      // Operator block — never message a blocked contact (mirrors /whatsapp/send
      // and the bot gate). The media upload above is harmless (Meta-side only);
      // the customer receives nothing.
      const blockedMediaContact = await app.tenant(req, (tx) =>
        tx.contact.findFirst({
          where: {
            organizationId: req.auth!.organizationId,
            deletedAt: null,
            blockedAt: { not: null },
            phoneE164: { in: [to, `+${to}`] },
          },
          select: { id: true },
        }),
      );
      if (blockedMediaContact) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'This contact is blocked — unblock them to send messages again.',
        );
      }

      // §5.1.2 24-hour session window — same rule as /whatsapp/send. Media
      // messages also count as free-form for Meta's purposes; outside the
      // window an agent has to use a template.
      const lastInboundMedia = await app.tenant(req, (tx) =>
        tx.whatsAppMessage.findFirst({
          where: { direction: 'inbound', fromNumber: to },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        }),
      );
      const ageMsMedia = lastInboundMedia
        ? Date.now() - lastInboundMedia.receivedAt.getTime()
        : Infinity;
      if (ageMsMedia > 24 * 60 * 60 * 1000) {
        throw badRequest(
          ApiErrorCode.VALIDATION_ERROR,
          'Outside the 24-hour session window. Send an approved template message instead — media replies require an inbound message from this customer in the last 24 hours.',
        );
      }

      // Audio messages don't accept a caption field at Meta's API —
      // sending one yields error (#100). Drop the caption silently
      // for audio; image / video / document keep it.
      const mediaType = effectiveMediaType;
      const allowsCaption = (mediaType as string) !== 'audio';
      // When we degraded an audio note to a document, include the
      // filename so the WhatsApp bubble shows "voice-note.webm" instead
      // of a generic "file" label. Documents need it anyway.
      const isDegradedVoice =
        req.body.mediaType === 'audio' && effectiveMediaType === 'document';
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: mediaType,
        [mediaType]: {
          id: metaMediaId,
          ...(allowsCaption && req.body.caption ? { caption: req.body.caption } : {}),
          ...(mediaType === 'document'
            ? { filename: isDegradedVoice ? `voice-note.${ext}` : filenameWithExt }
            : {}),
          // Render as a play-in-place WhatsApp voice note (waveform UI)
          // rather than a generic audio attachment. Only legal on
          // type=audio with audio/ogg + opus, which is exactly what
          // our transcoder produces.
          ...(mediaType === 'audio' && voiceNoteFlag ? { voice: true } : {}),
        },
      };
      let sendBody = '';
      let sendStatus = 0;
      req.log.info(
        { payloadSnippet: JSON.stringify(payload).slice(0, 400) },
        '[AL-VOICE-DEBUG] sending Meta /messages',
      );
      try {
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        sendStatus = res.status;
        sendBody = await res.text();
      } catch (err) {
        req.log.warn({ err }, '[AL-VOICE-DEBUG] Meta /messages threw');
        return {
          data: {
            ok: false,
            metaMessageId: null,
            errorMessage: err instanceof Error ? err.message : 'send failed',
          },
        };
      }
      req.log.info(
        { status: sendStatus, bodySnippet: sendBody.slice(0, 400) },
        '[AL-VOICE-DEBUG] Meta /messages response',
      );

      let parsedSend: Record<string, unknown> | null = null;
      try {
        parsedSend = JSON.parse(sendBody) as Record<string, unknown>;
      } catch {
        parsedSend = null;
      }
      if (sendStatus < 200 || sendStatus >= 300 || !parsedSend) {
        const err = (parsedSend?.error ?? {}) as { message?: string };
        return {
          data: { ok: false, metaMessageId: null, errorMessage: err.message ?? `HTTP ${sendStatus}` },
        };
      }
      const messages = (parsedSend.messages ?? []) as { id?: string }[];
      const metaMessageId = messages[0]?.id ?? null;

      await withRlsBypass(async (tx) => {
        const thread = await upsertWaThread(tx, {
          organizationId: orgId,
          customerPhone: to,
          whatsAppChannelId: channel.id,
          create: {
            status: 'open',
            lastMessageAt: new Date(),
            lastMessagePreview: `[${req.body.mediaType}] ${req.body.caption ?? ''}`.slice(0, 200),
            inboundCount: 0,
            outboundCount: 1,
          },
          update: {
            lastMessageAt: new Date(),
            lastMessagePreview: `[${req.body.mediaType}] ${req.body.caption ?? ''}`.slice(0, 200),
            outboundCount: { increment: 1 },
          },
        });
        await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: orgId,
            direction: 'outbound',
            metaMessageId,
            toNumber: to,
            messageType: req.body.mediaType,
            body: req.body.caption ?? null,
            mediaAssetId: asset.id,
            rawPayload: payload as never,
          },
        });
      }).catch(() => undefined);

      void bumpUsage(prisma as never, orgId, 'message_outbound');

      return { data: { ok: true, metaMessageId, errorMessage: null } };
    },
  );

  // ---------- GET /whatsapp/numbers ------------------------------------
  // Lists every channel for the org. Used by the "Numbers" section of the
  // /whatsapp page when a client has more than one Meta phone number.
  r.get(
    '/whatsapp/numbers',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'List every WhatsApp channel (number) configured for the org.',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) =>
      app.tenant(req, async (tx) => {
        const rows = await tx.whatsAppChannel.findMany({
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        });
        return { data: rows.map((c) => serializeChannel(c)) };
      }),
  );

  // ---------- GET /whatsapp/coexistence/status --------------------------
  // Post-connect visibility for a coexistence tenant: is a history grant
  // live, and how far along is WhatsApp's one-shot history delivery.
  //
  // The history rows CANNOT be read under app.tenant: during Embedded Signup a
  // new tenant's deliveries land on the APP-LEVEL callback — another org's URL
  // — so `organization_id` is the receiving org while `resolved_organization_id`
  // is the true owner. RLS on the receiving org would hide exactly those rows.
  // Bypass is used with an explicit owner filter on BOTH columns (the F-02
  // rule: bypass only with the org pinned in the WHERE), and this is read-only.
  r.get(
    '/whatsapp/coexistence/status',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Coexistence history-import status for the current org.',
      },
      preHandler: [app.requireRole('viewer')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;

      const grant = await app.tenant(req, (tx) =>
        tx.salesScanGrant.findFirst({
          where: { status: 'active' },
          orderBy: { grantedAt: 'desc' },
          select: { linkedAt: true, captureEndsAt: true, grantExpiresAt: true },
        }),
      );

      const rows = await withRlsBypass((tx) =>
        tx.metaWebhookEvent.findMany({
          where: {
            field: 'history',
            // Owner column first; the receiving-org clause matches ONLY rows
            // whose owner is still unresolved (number not in the DB yet at
            // delivery time). A plain OR on organizationId would also match
            // rows RESOLVED to another tenant — and the app-level callback
            // parks new tenants' deliveries on demo-b2b's org, which would
            // show that tenant's import on demo-b2b's page.
            OR: [
              { resolvedOrganizationId: orgId },
              { resolvedOrganizationId: null, organizationId: orgId },
            ],
          },
          orderBy: { receivedAt: 'desc' },
          select: { payload: true, receivedAt: true, processedAt: true },
          // History arrives in bounded chunks (one delivery per phase chunk);
          // 500 comfortably covers a 180-day import while bounding the read.
          take: 500,
        }),
      );

      // Meta's shape: payload.value.history[].metadata.{phase, progress}.
      // Parsed defensively — an unexpected shape degrades to nulls, never a 500.
      let phase: number | null = null;
      let progress: number | null = null;
      for (const row of rows) {
        const chunks = (
          row.payload as { value?: { history?: Array<{ metadata?: Record<string, unknown> }> } }
        )?.value?.history;
        if (!Array.isArray(chunks)) continue;
        for (const chunk of chunks) {
          const p = chunk?.metadata?.phase;
          const pr = chunk?.metadata?.progress;
          if (typeof p === 'number' && (phase === null || p > phase)) {
            phase = p;
            progress = typeof pr === 'number' ? pr : null;
          } else if (typeof p === 'number' && p === phase && typeof pr === 'number') {
            progress = Math.max(progress ?? 0, pr);
          }
        }
      }

      return {
        data: {
          historyOptIn: !!grant,
          linkedAt: grant?.linkedAt?.toISOString() ?? null,
          captureEndsAt: (grant?.captureEndsAt ?? grant?.grantExpiresAt)?.toISOString() ?? null,
          history:
            rows.length > 0
              ? {
                  received: rows.length,
                  processed: rows.filter((row) => row.processedAt !== null).length,
                  lastReceivedAt: rows[0]!.receivedAt.toISOString(),
                  phase,
                  progress,
                  // Meta's own completion condition for the 180-day import.
                  complete: phase === 2 && progress === 100,
                }
              : null,
        },
      };
    },
  );

  // ---------- POST /whatsapp/numbers -----------------------------------
  // Create a *secondary* number. The first channel an org gets is created
  // implicitly via GET /whatsapp; this endpoint is for additional ones.
  r.post(
    '/whatsapp/numbers',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Add an additional (non-primary) WhatsApp number to the org.',
        body: z.object({ label: z.string().trim().min(1).max(80).optional() }),
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        // Ensure a primary already exists; if not, the first call should be
        // GET /whatsapp not this one.
        const primary = await tx.whatsAppChannel.findFirst({
          where: { organizationId: orgId, isPrimary: true },
        });
        if (!primary) {
          throw badRequest(
            ApiErrorCode.VALIDATION_ERROR,
            'Configure the primary number first by visiting /whatsapp.',
          );
        }
        const created = await tx.whatsAppChannel.create({
          data: {
            ...newDefaults(orgId),
            isPrimary: false,
            label: req.body.label ?? null,
          },
        });
        return { data: serializeChannel(created) };
      });
    },
  );

  // ---------- PUT /whatsapp/numbers/:id --------------------------------
  // Edit a specific number's config (label, credentials, bot switch, live
  // toggle). Same body semantics as PUT /whatsapp but targets one channel by
  // id — the multi-number editor.
  r.put(
    '/whatsapp/numbers/:id',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Update a specific WhatsApp number. Send empty string to clear a secret.',
        params: z.object({ id: uuidSchema }),
        body: upsertWhatsappChannelBodySchema,
        response: { 200: itemEnvelopeSchema(whatsappChannelSchema) },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      const b = req.body;
      return app.tenant(req, async (tx) => {
        const existing = await tx.whatsAppChannel.findFirst({
          where: { id: req.params.id, organizationId: orgId },
        });
        if (!existing) throw notFound('Channel not found.');

        const update = <T>(v: T | undefined): T | null | undefined =>
          v === undefined ? undefined : v === '' ? null : v;

        if (b.accessToken !== undefined || b.appId !== undefined || b.appSecret !== undefined) {
          await assertMetaCredentialsConsistent(
            {
              accessToken:
                b.accessToken === undefined ? existing.accessToken : b.accessToken || null,
              appId: b.appId === undefined ? existing.appId : b.appId || null,
              appSecret: b.appSecret === undefined ? existing.appSecret : b.appSecret || null,
            },
            req.log,
          );
        }

        const updated = await tx.whatsAppChannel.update({
          where: { id: existing.id },
          data: {
            label: update(b.label ?? undefined),
            botEnabled: b.botEnabled ?? undefined,
            wabaId: update(b.wabaId ?? undefined),
            phoneNumberId: update(b.phoneNumberId ?? undefined),
            displayPhoneNumber: update(b.displayPhoneNumber ?? undefined),
            appId: update(b.appId ?? undefined),
            accessToken: update(b.accessToken),
            appSecret: update(b.appSecret),
            greetingMessage: update(b.greetingMessage ?? undefined),
            businessName: update(b.businessName ?? undefined),
            businessAbout: update(b.businessAbout ?? undefined),
            businessAddress: update(b.businessAddress ?? undefined),
            businessEmail: update(b.businessEmail ?? undefined),
            isActive: b.isActive ?? undefined,
          },
        });

        await recordAudit({
          action: 'business_info_updated',
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          entityType: 'whatsapp_channel',
          entityId: updated.id,
          metadata: {
            event: 'whatsapp_channel_updated',
            isActive: updated.isActive,
            botEnabled: updated.botEnabled,
            fieldsTouched: Object.keys(b).filter((k) => b[k as keyof typeof b] !== undefined),
          },
        });
        // the platform-HQ-only credential trail (encrypted; hidden from the tenant).
        await recordCredentialAudit({
          organizationId: orgId,
          actorUserId: req.auth!.userId,
          integration: 'whatsapp',
          credentials: {
            appId: b.appId,
            appSecret: b.appSecret,
            accessToken: b.accessToken,
            wabaId: b.wabaId,
            phoneNumberId: b.phoneNumberId,
            displayPhoneNumber: b.displayPhoneNumber,
          },
          status: updated.lastVerifyStatus ?? 'saved',
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        });

        return { data: serializeChannel(updated) };
      });
    },
  );

  // ---------- POST /whatsapp/numbers/:id/promote ------------------------
  // Switch which channel is the org's primary. Wrapped in a transaction so
  // the partial unique index never sees two primaries momentarily.
  r.post(
    '/whatsapp/numbers/:id/promote',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Mark a channel as the org\'s primary number.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const target = await tx.whatsAppChannel.findFirst({
          where: { id: req.params.id, organizationId: orgId },
        });
        if (!target) throw notFound('Channel not found.');
        if (target.isPrimary) return { ok: true as const };
        // Demote the existing primary first.
        await tx.whatsAppChannel.updateMany({
          where: { organizationId: orgId, isPrimary: true },
          data: { isPrimary: false },
        });
        await tx.whatsAppChannel.update({
          where: { id: target.id },
          data: { isPrimary: true },
        });
        return { ok: true as const };
      });
    },
  );

  // ---------- DELETE /whatsapp/numbers/:id -----------------------------
  // Remove a non-primary channel. Removing the primary is refused — promote
  // another number first.
  r.delete(
    '/whatsapp/numbers/:id',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Remove a non-primary WhatsApp channel.',
        params: z.object({ id: uuidSchema }),
        response: { 200: successSchema },
      },
      preHandler: [app.requireRole('admin')],
    },
    async (req) => {
      const orgId = req.auth!.organizationId;
      return app.tenant(req, async (tx) => {
        const target = await tx.whatsAppChannel.findFirst({
          where: { id: req.params.id, organizationId: orgId },
        });
        if (!target) throw notFound('Channel not found.');
        if (target.isPrimary) {
          throw badRequest(
            ApiErrorCode.CONFLICT,
            'Cannot remove the primary channel — promote another number first.',
          );
        }
        await tx.whatsAppChannel.delete({ where: { id: target.id } });
        return { ok: true as const };
      });
    },
  );

  // -----------------------------------------------------------------
  // Public webhook surfaces — no JWT, signature-verified.
  // -----------------------------------------------------------------

  // ---------- GET /whatsapp/webhook/:orgId  (Meta verification) ---------
  // Meta sends GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
  // We echo the challenge if (a) the org has a channel and (b) the verify
  // token matches what we stored.
  r.get(
    '/whatsapp/webhook/:orgId',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Meta webhook verification handshake.',
        params: z.object({ orgId: uuidSchema }),
        querystring: z.object({
          'hub.mode': z.string().optional(),
          'hub.verify_token': z.string().optional(),
          'hub.challenge': z.string().optional(),
        }),
      },
      // Public endpoint — no preHandler.
      logLevel: 'warn', // these are noisy in dev
    },
    async (req, reply) => {
      // Accept ANY of the org's channels' verify tokens, not just the primary's.
      //
      // This used to read the primary only, on the reasoning that Meta verifies
      // a URL once per WABA. But `newDefaults` mints an INDEPENDENT token per
      // channel row, and `ensureWabaSubscribed` registers the override using the
      // RESOLVED channel's token — so a non-primary channel's override could
      // never complete Meta's handshake, and there is no error that explains it.
      //
      // That is exactly the Embedded Signup case: a scratch or test org that
      // already has a primary gets its new coexistence number as a secondary.
      const channels = await withRlsBypass((tx) =>
        tx.whatsAppChannel.findMany({
          where: { organizationId: req.params.orgId },
          select: { webhookVerifyToken: true },
        }),
      );
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      // Per-candidate constant-time compare, padded to a fixed width so
      // timingSafeEqual never throws on a length mismatch (its own requirement).
      const tokenMatches =
        !!token &&
        channels.some((c) =>
          crypto.timingSafeEqual(
            Buffer.from(token.padEnd(64).slice(0, 64)),
            Buffer.from(c.webhookVerifyToken.padEnd(64).slice(0, 64)),
          ),
        );
      if (channels.length === 0 || mode !== 'subscribe' || !tokenMatches) {
        reply.code(403);
        return 'forbidden';
      }
      reply.code(200).header('content-type', 'text/plain');
      return challenge ?? '';
    },
  );

  // ---------- POST /whatsapp/webhook/:orgId  (inbound events) -----------
  // Meta posts message events here. We:
  //   1. Read the raw body (so HMAC matches byte-for-byte).
  //   2. Verify X-Hub-Signature-256 against the org's appSecret.
  //   3. Persist every message in `whatsapp_messages` for the audit log.
  //   4. Always reply 200 fast (Meta retries on non-2xx + 5s timeout).
  // We do NOT auto-respond to messages — that's the bot's job, not the
  // platform's. Phase 2 wires this to a flow runtime.
  r.post(
    '/whatsapp/webhook/:orgId',
    {
      schema: {
        tags: ['whatsapp'],
        summary: 'Meta webhook delivery (signature-verified).',
        params: z.object({ orgId: uuidSchema }),
      },
      // Public endpoint — no preHandler.
      // Capture raw body so signature verification works.
      // Fastify exposes request.rawBody when this option is set on the schema.
      //
      // Per-route body limit. The server default is 5 MB (server.ts), which is
      // right for tenant endpoints and too small here: a Coexistence `history`
      // chunk carries up to 180 days of one business's conversations and is
      // delivered ONCE, so a 413 is permanent, unrecoverable loss. Raised only
      // on this route — raising the global would relax every authenticated
      // endpoint too. 25 MB is a guess pending Meta's documented chunk ceiling;
      // over-provisioning costs memory, under-provisioning costs the corpus.
      bodyLimit: 25 * 1024 * 1024,
    },
    async (req, reply) => {
      // For multi-number orgs we resolve the channel by the inbound
      // payload's `metadata.phone_number_id`, falling back to the primary.
      // The HMAC must validate against THAT channel's appSecret because
      // Meta uses the app-level secret (which is the same across all
      // numbers under one app, but we keep it per-channel for flexibility).
      const inferredPhoneId = ((req.body ?? {}) as {
        entry?: { changes?: { value?: { metadata?: { phone_number_id?: string } } }[] }[];
      }).entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

      const channel = await withRlsBypass(async (tx) => {
        if (inferredPhoneId) {
          const byPhone = await tx.whatsAppChannel.findFirst({
            where: { organizationId: req.params.orgId, phoneNumberId: inferredPhoneId },
          });
          if (byPhone) return byPhone;
        }
        return tx.whatsAppChannel.findFirst({
          where: { organizationId: req.params.orgId, isPrimary: true },
        });
      });
      if (!channel || !channel.appSecret) {
        // Without an app secret we can't authenticate the request — refuse
        // rather than persist a potentially-spoofed message.
        req.log.warn(
          { orgId: req.params.orgId, inferredPhoneId, hasChannel: !!channel, hasSecret: !!channel?.appSecret },
          '[whatsapp] webhook rejected — channel or app secret missing',
        );
        reply.code(403);
        return 'forbidden';
      }

      const sig = req.headers['x-hub-signature-256'];
      const sigStr = Array.isArray(sig) ? sig[0] : sig;
      // HMAC must be computed over Meta's ORIGINAL request bytes — not a
      // re-stringification of the parsed body. server.ts's custom
      // application/json parser stashes the raw UTF-8 body at req.rawBody for
      // exactly this. L-10 — if it's missing (unexpected/absent Content-Type)
      // we REJECT rather than fall back to JSON.stringify, which could reorder
      // keys and either false-accept or false-reject a signature.
      const rawBody = (req as unknown as { rawBody?: string }).rawBody;
      if (rawBody === undefined) {
        req.log.warn(
          { orgId: req.params.orgId, inferredPhoneId },
          '[whatsapp] webhook missing raw body — rejected',
        );
        reply.code(401);
        return 'invalid signature';
      }
      const expected =
        'sha256=' +
        crypto.createHmac('sha256', channel.appSecret).update(rawBody).digest('hex');
      const ok =
        typeof sigStr === 'string' &&
        sigStr.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigStr), Buffer.from(expected));
      if (!ok) {
        // Log enough to debug app-secret mismatches without leaking the
        // secret itself: show the first/last chars of received sig vs the
        // expected one so an operator can eyeball the diff.
        const previewSig = (s: string | undefined): string =>
          !s ? '<missing>' : s.length < 16 ? s : `${s.slice(0, 12)}…${s.slice(-4)} (len=${s.length})`;
        req.log.warn(
          {
            orgId: req.params.orgId,
            inferredPhoneId,
            received: previewSig(sigStr),
            expected: previewSig(expected),
            bodyLen: rawBody.length,
          },
          '[whatsapp] webhook signature mismatch — check app secret in /whatsapp',
        );
        reply.code(401);
        return 'invalid signature';
      }
      req.log.info(
        { orgId: req.params.orgId, inferredPhoneId, bodyLen: rawBody.length },
        '[whatsapp] webhook signature ok',
      );

      // Walk Meta's payload structure: entry[].changes[].value.messages[]
      // for inbound, entry[].changes[].value.statuses[] for delivery /
      // read receipts on outbound messages we previously sent.
      const body = (req.body ?? {}) as {
        entry?: {
          changes?: {
            value?: {
              messaging_product?: string;
              metadata?: { display_phone_number?: string; phone_number_id?: string };
              // Parallel array with the sender's WhatsApp profile name +
              // wa_id. Use to populate Contact.whatsappName etc.
              contacts?: {
                wa_id?: string;
                profile?: { name?: string };
              }[];
              messages?: {
                id?: string;
                from?: string;
                type?: string;
                text?: { body?: string };
                timestamp?: string;
                // Inbound media payloads: only the `id` is needed to
                // pull the bytes back from Meta's /media/{id} endpoint.
                // We only care about audio + voice here so the bot can
                // transcribe customer voice notes.
                audio?: { id?: string; mime_type?: string; voice?: boolean };
                voice?: { id?: string; mime_type?: string };
                // Inbound photo: `id` pulls the bytes from Meta so we can
                // store + render it in the inbox; `caption` (if any) is the
                // operator-visible body.
                image?: { id?: string; mime_type?: string; caption?: string };
              }[];
              statuses?: {
                id?: string; // wamid of the outbound message
                status?: 'sent' | 'delivered' | 'read' | 'failed';
                timestamp?: string;
                recipient_id?: string;
                // On status=failed, Meta attaches at least one error
                // object describing why the message wasn't delivered.
                // Log it so voice / media debugging isn't a black box.
                errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
              }[];
            };
          }[];
        }[];
      };

      // ATTRIBUTION IS FLEET-WIDE; THE HMAC KEY IS NOT.
      //
      // `channel` above is resolved WITHIN the URL's org, falling back to that
      // org's primary. It must stay that way: Meta signs with the app secret of
      // the app subscribed to the WABA, and the platform's channels span four Meta
      // apps, so swapping it here would break signature verification and Meta
      // would retry for seven days.
      //
      // But that resolution is the wrong answer to "whose payload is this?".
      // The app secret is shared across every number on an app, so the HMAC no
      // longer distinguishes tenants, and the app-level Callback URL is one
      // specific org's URL. A number delivering there resolves to THAT org's
      // primary, verifies, and — before this block existed — its `messages`
      // became that org's inbox rows: another business's live customer
      // conversations, in the wrong inbox, 200'd so Meta never retried.
      //
      // So ownership is looked up GLOBALLY by phone_number_id, which the
      // accompanying migration makes unique fleet-wide. Resolved per CHANGE,
      // not per request: the resolution above reads only entry[0].changes[0]
      // while every loop below walks all of them.
      const phoneIdsInBatch = [
        ...new Set(
          (body.entry ?? [])
            .flatMap((e) => e.changes ?? [])
            .map((c) => c.value?.metadata?.phone_number_id)
            .filter((p): p is string => !!p),
        ),
      ];
      const ownerOrgByPhoneId = new Map<string, string>();
      // The owning CHANNEL too, not just the org. A coexistence tenant's handset
      // replies have to be threaded against the number they were sent from, and
      // whatsapp_threads is deduped per (org, phone, channel) — resolving only
      // the org would put echoes on the wrong thread for any multi-number org.
      const ownerChannelByPhoneId = new Map<string, string>();
      if (phoneIdsInBatch.length > 0) {
        const owners = await withRlsBypass((tx) =>
          tx.whatsAppChannel.findMany({
            where: { phoneNumberId: { in: phoneIdsInBatch } },
            select: { id: true, organizationId: true, phoneNumberId: true },
          }),
        );
        for (const o of owners) {
          if (o.phoneNumberId) {
            ownerOrgByPhoneId.set(o.phoneNumberId, o.organizationId);
            ownerChannelByPhoneId.set(o.phoneNumberId, o.id);
          }
        }
      }
      /** Owning org for a change's number, or null when we don't know it yet. */
      const ownerOrgOf = (phoneId: string | undefined): string | null =>
        (phoneId ? ownerOrgByPhoneId.get(phoneId) : undefined) ?? null;
      /**
       * True when this change belongs to a DIFFERENT org than the URL it arrived
       * at. Deliberately false when the owner is unknown (a number not yet in
       * our DB — the expected first state for a self-onboarding tenant): an
       * unknown owner is not evidence of misattribution, and treating it as such
       * would silently divert a legitimate new tenant's traffic.
       */
      const isMisattributed = (phoneId: string | undefined): boolean => {
        const owner = ownerOrgOf(phoneId);
        return owner !== null && owner !== req.params.orgId;
      };

      // Capture-everything safety net. The two loops below read ONLY
      // `value.messages` and `value.statuses`, which is the `messages` field.
      // Every other subscribed field falls straight through them, gets a 200,
      // and is lost — and Meta never retries a 200.
      //
      // That is fine for repeatable streams and fatal for Coexistence
      // `history`, which Meta sends ONCE inside a 24-hour window after a
      // business onboards and will not send again without full offboarding.
      // All three Coexistence fields are already subscribed on the app, so we
      // park anything unrecognised verbatim and interpret it later.
      //
      // AWAITED, NOT fire-and-forget. An earlier version of this block ran as
      // `void (async () => …)()`, which returned 200 to Meta before the row was
      // durable — so a pool blip during a `history` delivery would lose exactly
      // the payload this table exists to protect. Meta never retries a 200.
      //
      // On a park failure we now return 5xx so Meta REDELIVERS. That is the
      // whole point: a retry is recoverable, a 200 is not.
      //
      // The live hot path is untouched — `field === 'messages'` short-circuits
      // before any work, so ordinary inbound traffic for every number on the
      // app never touches this block.
      for (const entry of body.entry ?? []) {
        for (const change of (entry as { changes?: { field?: string }[] }).changes ?? []) {
          const field = change.field;
          const v = (change as { value?: { metadata?: { phone_number_id?: string } } }).value;
          const phoneId = v?.metadata?.phone_number_id;
          // `messages` is fully handled below — UNLESS it arrived at the wrong
          // org's URL, in which case the loops below deliberately skip it and
          // this is the only thing standing between the payload and the bin.
          // Anything else, including a payload with no field at all, is parked.
          if (field === 'messages' && !isMisattributed(phoneId)) continue;
          try {
            const parked = await withRlsBypass((tx) =>
              tx.metaWebhookEvent.create({
                data: {
                  organizationId: channel.organizationId,
                  // Always stamped, misattributed or not, so a replay never has
                  // to re-derive ownership from the blob.
                  resolvedOrganizationId: ownerOrgOf(phoneId),
                  field: field ?? 'unknown',
                  phoneNumberId: phoneId ?? null,
                  wabaId: (entry as { id?: string }).id ?? null,
                  payload: change as never,
                },
                select: { id: true },
              }),
            );
            req.log.info(
              { orgId: req.params.orgId, field, wabaId: (entry as { id?: string }).id },
              '[whatsapp] parked unhandled webhook field',
            );

            // COEXISTENCE HANDSET REPLIES. Consumed AFTER the park, never
            // instead of it: the row is the recoverable copy if this throws, and
            // capture-first is the whole reason that table exists. `processed_at`
            // is stamped only on success, so a failure leaves a replayable row
            // and the retention sweep's "never processed" alarm can see it.
            //
            // Owner resolved GLOBALLY by phone_number_id, not from the URL's org:
            // during Embedded Signup a new tenant's first deliveries arrive at
            // the app-level callback, which is another org's URL entirely.
            const echoOrgId = ownerOrgOf(phoneId);
            const echoes = (change as { value?: { message_echoes?: unknown[] } }).value
              ?.message_echoes;
            if (field === 'smb_message_echoes' && echoOrgId && Array.isArray(echoes)) {
              try {
                const res = await consumeMessageEchoes({
                  organizationId: echoOrgId,
                  whatsAppChannelId: phoneId ? ownerChannelByPhoneId.get(phoneId) ?? null : null,
                  echoes: echoes as Parameters<typeof consumeMessageEchoes>[0]['echoes'],
                  log: req.log,
                });
                await withRlsBypass((tx) =>
                  tx.metaWebhookEvent.update({
                    where: { id: parked.id },
                    data: { processedAt: new Date() },
                  }),
                );
                req.log.info(
                  { orgId: echoOrgId, phoneId, ...res },
                  '[whatsapp] handset replies stored from smb_message_echoes',
                );
              } catch (err) {
                // Deliberately NOT a 5xx. The payload is already parked, so this
                // is recoverable without asking Meta to resend the whole batch —
                // and a 5xx here would make Meta redeliver every OTHER change in
                // the same request too, including a one-shot `history`.
                req.log.error(
                  { orgId: echoOrgId, phoneId, err },
                  '[whatsapp] handset echo consumption FAILED — payload parked, processed_at left null',
                );
              }
            }
          } catch (err) {
            req.log.error(
              { err, orgId: req.params.orgId, field },
              '[whatsapp] FAILED to park unhandled webhook field — asking Meta to redeliver',
            );
            // 503, not 200. Meta's retry is the only second chance a one-shot
            // `history` delivery gets.
            reply.code(503);
            return 'park failed';
          }
        }
      }

      // Read-receipt path — process status events first so the inbound
      // path's transaction work doesn't block them.
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          // Another org's number delivering at this URL. Its payload is already
          // parked above with `resolvedOrganizationId` set; touching this org's
          // rows with it would corrupt delivery state on a message it never sent.
          if (isMisattributed(change.value?.metadata?.phone_number_id)) continue;
          for (const s of change.value?.statuses ?? []) {
            if (!s.id || !s.status) continue;
            const ts = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
            if (s.status === 'failed') {
              // Surface the exact Meta error so voice / media failures
              // stop being silent. We see the wamid, recipient, and
              // the errors[].{code,title,message,error_data.details}.
              req.log.warn(
                {
                  wamid: s.id,
                  recipient: s.recipient_id,
                  errors: s.errors,
                },
                '[AL-VOICE-DEBUG] Meta marked outbound as FAILED',
              );
            }
            // Captured inside the tx, used AFTER commit to refund a failed-but-
            // billed metered send (see below).
            let failedBilledRecipientId: string | null = null;
            await withRlsBypass(async (tx) => {
              await tx.whatsAppMessage.updateMany({
                where: {
                  organizationId: channel.organizationId,
                  metaMessageId: s.id!,
                },
                data: {
                  metaStatus: s.status!,
                  metaStatusAt: ts,
                },
              });

              // Phase 4 — also propagate to BroadcastRecipient (lookup by wamid).
              const recipient = await tx.broadcastRecipient.findFirst({
                where: {
                  organizationId: channel.organizationId,
                  metaMessageId: s.id!,
                },
              });
              if (!recipient) return;
              const updates: Record<string, unknown> = {};
              const counterDelta: Record<string, number> = {};
              if (s.status === 'delivered' && recipient.status !== 'read') {
                updates.status = 'delivered';
                updates.deliveredAt = ts;
                counterDelta.deliveredCount = 1;
              } else if (s.status === 'read') {
                updates.status = 'read';
                updates.readAt = ts;
                if (!recipient.deliveredAt) {
                  updates.deliveredAt = ts;
                  counterDelta.deliveredCount = 1;
                }
                counterDelta.readCount = 1;
              } else if (s.status === 'failed' && recipient.status !== 'failed') {
                updates.status = 'failed';
                updates.failedAt = ts;
                counterDelta.failedCount = 1;
                // Meta bills on delivery, not the send attempt — a failed
                // delivery costs $0. chargeAtSend already debited the tenant, so
                // the charge must be refunded (done after commit, idempotently).
                // Guard on never-delivered: a message that was delivered/read was
                // billed correctly and must NOT be refunded even on an odd late
                // 'failed'.
                if (recipient.billedAt && !recipient.deliveredAt && !recipient.readAt) {
                  failedBilledRecipientId = recipient.id;
                }
                // Persist Meta's reason so the recipient row shows WHY it failed
                // (previously only logged → every delivery-failure was blank).
                // Most common: the number isn't a WhatsApp user / undeliverable.
                const err0 = s.errors?.[0];
                if (err0) {
                  updates.metaErrorCode = err0.code != null ? String(err0.code) : null;
                  updates.metaErrorMessage =
                    err0.error_data?.details || err0.message || err0.title || 'Delivery failed';
                }
              }
              if (Object.keys(updates).length > 0) {
                await tx.broadcastRecipient.update({
                  where: { id: recipient.id },
                  data: updates,
                });
              }
              if (Object.keys(counterDelta).length > 0) {
                await tx.broadcast.update({
                  where: { id: recipient.broadcastId },
                  data: Object.fromEntries(
                    Object.entries(counterDelta).map(([k, v]) => [k, { increment: v }]),
                  ),
                });
              }
            }).catch((err) => req.log.error({ err }, '[whatsapp] status update failed'));

            // Refund the charge-at-send debit for a metered message that FAILED
            // delivery (Meta bills on delivery, not the attempt). Idempotent
            // (atomic refunded_at claim) + fire-and-forget so the webhook ack
            // stays fast; a duplicate 'failed' webhook can't double-refund.
            if (failedBilledRecipientId) {
              void wallet
                .refundFailedSend(channel.organizationId, failedBilledRecipientId)
                .then((r) => {
                  if (r.refunded && r.micros > 0) {
                    req.log.info(
                      { recipientId: failedBilledRecipientId, micros: r.micros },
                      '[wallet] refunded a failed-delivery charge',
                    );
                  }
                })
                .catch((err) =>
                  req.log.error(
                    { err, recipientId: failedBilledRecipientId },
                    '[wallet] refund on failed delivery threw',
                  ),
                );
            }
          }
        }
      }

      // Extract the operator-visible body text from any Meta inbound
      // payload shape. WhatsApp delivers replies in different fields
      // depending on the source:
      //   - type=text                → text.body
      //   - type=button              → button.text (template Quick Reply)
      //   - type=interactive         → interactive.button_reply.title  OR
      //                                interactive.list_reply.title
      //   - type=image/video/audio/  → caption (if any) or "[image]" etc.
      //     document/sticker
      //   - everything else          → "[<type>]" placeholder so the
      //                                inbox never shows a bare empty cell.
      function extractInboundBody(m: Record<string, unknown>): string {
        const type = (m.type as string | undefined) ?? '';
        if (type === 'text') {
          return (m as { text?: { body?: string } }).text?.body ?? '';
        }
        if (type === 'button') {
          return (m as { button?: { text?: string; payload?: string } }).button?.text
            ?? (m as { button?: { payload?: string } }).button?.payload
            ?? '[button]';
        }
        if (type === 'interactive') {
          const i = (m as { interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } } }).interactive;
          return i?.button_reply?.title ?? i?.list_reply?.title ?? '[interactive]';
        }
        // Shared contact card(s): render the real name + phone number(s) so the
        // operator actually sees who was shared, not a bare "[contacts]".
        if (type === 'contacts') {
          const contacts =
            (m as {
              contacts?: Array<{
                name?: { formatted_name?: string };
                phones?: Array<{ phone?: string }>;
              }>;
            }).contacts ?? [];
          const parts = contacts
            .map((c) => {
              const name = c.name?.formatted_name?.trim() || 'Contact';
              const phones = (c.phones ?? [])
                .map((p) => p.phone?.trim())
                .filter((p): p is string => !!p)
                .join(', ');
              return phones ? `${name} · ${phones}` : name;
            })
            .filter(Boolean);
          return parts.length ? `📇 Shared contact: ${parts.join(' | ')}` : '[contacts]';
        }
        // A shared location: place name / address plus a maps link built from
        // the coordinates, so the bubble is openable — bare "33.89, 35.50" text
        // (or worse, "[location]") gave the operator nothing to tap.
        if (type === 'location') {
          const loc = (m as { location?: { name?: string; address?: string; latitude?: number; longitude?: number } }).location;
          const label = loc?.name?.trim() || loc?.address?.trim() || '';
          const pin =
            loc?.latitude != null && loc?.longitude != null
              ? `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`
              : '';
          if (label && pin) return `📍 ${label}\n${pin}`;
          if (pin) return `📍 Location: ${pin}`;
          return label ? `📍 Location: ${label}` : '[location]';
        }
        // Media types: prefer the caption if the customer attached one,
        // otherwise placeholder so the thread preview is meaningful.
        const caption = (m as { [k: string]: { caption?: string } | undefined })[type]?.caption;
        if (caption) return caption;
        if (['image', 'video', 'audio', 'document', 'sticker', 'voice'].includes(type)) {
          return `[${type}]`;
        }
        return type ? `[${type}]` : '';
      }

      // Inbound queue passed to the bot reply path. mediaId is the
      // Meta /media id for inbound audio/voice messages — used by the
      // bot to download + Whisper-transcribe customer voice notes so
      // they go through the same reply pipeline as text.
      const persisted: {
        from: string;
        type: string;
        bodyText: string | null;
        metaId: string | null;
        mediaId: string | null;
        mediaMime: string | null;
        // Meta's own send time (epoch seconds). received_at can't be used for
        // staleness: a webhook Meta redelivers days after an outage is
        // processed "now" — only this field reveals the message's true age.
        timestampEpoch: number | null;
      }[] = [];
      // Whether the tenant's AI bot is deployed. Gates ONLY the fuzzy free-text
      // opt-out phrase rule (keywords + Unsubscribe button always apply).
      // null = not resolved yet; looked up once per webhook batch.
      let aiPhraseOptOutEnabled: boolean | null = null;
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value;
          if (!value || !value.messages) continue;
          // THE CROSS-TENANT GUARD. Without this, a number owned by org A that
          // delivers at org B's callback URL has its customers' messages written
          // as B's threads and shown to B's operators — and the bot answers them
          // as B. The payload is not lost: the parking block above stored it with
          // resolvedOrganizationId = A, for replay against the right tenant.
          if (isMisattributed(value.metadata?.phone_number_id)) {
            req.log.warn(
              {
                urlOrgId: req.params.orgId,
                ownerOrgId: ownerOrgOf(value.metadata?.phone_number_id),
                phoneNumberId: value.metadata?.phone_number_id,
              },
              '[whatsapp] inbound skipped — number belongs to another org; parked for replay',
            );
            continue;
          }
          for (const m of value.messages) {
            // Idempotency guard. Meta RETRIES webhook deliveries on timeout or
            // any non-2xx — without this a retry re-persists the inbound
            // message AND re-fires the bot, double-replying to the customer
            // (and could double-capture a cart). Skip if this metaMessageId is
            // already stored for the org. Backed by the
            // (organization_id, meta_message_id) index, so it's a cheap lookup.
            if (m.id) {
              const already = await withRlsBypass((tx) =>
                tx.whatsAppMessage.findFirst({
                  where: {
                    organizationId: channel.organizationId,
                    metaMessageId: m.id,
                    direction: 'inbound',
                  },
                  select: { id: true },
                }),
              );
              if (already) {
                req.log.info(
                  { orgId: channel.organizationId, metaMessageId: m.id },
                  '[whatsapp] inbound dedup — already processed, skipping retry',
                );
                continue;
              }
            }
            const bodyText = extractInboundBody(m as unknown as Record<string, unknown>);
            // Pull the Meta media id for audio/voice so the bot can
            // download + transcribe later. Both `audio` and `voice`
            // shapes can appear depending on whether the customer
            // recorded a voice note or shared an audio file.
            const sticker = (m as { sticker?: { id?: string; mime_type?: string } }).sticker;
            // video/document were missing from this chain, so the "store videos
            // + documents" branch downstream could never fire (p.mediaId null).
            const video = (m as { video?: { id?: string; mime_type?: string } }).video;
            const doc = (m as { document?: { id?: string; mime_type?: string } }).document;
            const mediaId =
              m.type === 'audio'
                ? m.audio?.id ?? null
                : m.type === 'voice'
                  ? m.voice?.id ?? null
                  : m.type === 'image'
                    ? m.image?.id ?? null
                    : m.type === 'sticker'
                      ? sticker?.id ?? null
                      : m.type === 'video'
                        ? video?.id ?? null
                        : m.type === 'document'
                          ? doc?.id ?? null
                          : null;
            const mediaMime =
              m.type === 'audio'
                ? m.audio?.mime_type ?? null
                : m.type === 'voice'
                  ? m.voice?.mime_type ?? null
                  : m.type === 'image'
                    ? m.image?.mime_type ?? null
                    : m.type === 'sticker'
                      ? sticker?.mime_type ?? null
                      : m.type === 'video'
                        ? video?.mime_type ?? null
                        : m.type === 'document'
                          ? doc?.mime_type ?? null
                          : null;
            const tsRaw = (m as { timestamp?: string | number }).timestamp;
            persisted.push({
              from: m.from ?? '',
              type: m.type ?? 'unknown',
              bodyText: bodyText || null,
              metaId: m.id ?? null,
              mediaId,
              mediaMime,
              timestampEpoch:
                tsRaw != null && Number.isFinite(Number(tsRaw)) && Number(tsRaw) > 0
                  ? Number(tsRaw)
                  : null,
            });

            // Every inbound creates a Contact row if we don't already
            // have one for this phone. Keeps /contacts in sync with
            // the inbox automatically so the operator never has to
            // copy/paste numbers. The contact's `profile.name` from
            // Meta (if present in the contacts[] block) is used as the
            // initial display name.
            const STOP_RE = /^\s*(stop|unsubscribe|quit|cancel|end|opt\s*out|alto|para|arr[eê]ter|stopper|اوقف|إيقاف)\s*\.?\s*$/i;
            // Is the AI bot live for this tenant? Gates the fuzzy phrase rule
            // only (see below). Resolved lazily and cached per webhook batch.
            if (aiPhraseOptOutEnabled === null) {
              const cfg = await withRlsBypass((tx) =>
                tx.botConfig.findFirst({
                  where: { organizationId: channel.organizationId },
                  select: { deployedAt: true },
                }),
              );
              aiPhraseOptOutEnabled = !!cfg?.deployedAt;
            }
            // Explicit free-text opt-out PHRASES. STOP_RE only matches a bare
            // keyword ("stop"), so "pls stop sharing broadcasts" was ignored and
            // the customer kept receiving campaigns. Deliberately narrow: each
            // pattern pairs a stop/remove verb with a messaging noun, so
            // "stop by the shop tomorrow" is NOT an opt-out.
            //
            // Phrase matching is the only FUZZY rule here, so it runs only for
            // tenants with the AI bot deployed. Bare STOP keywords and the
            // template Unsubscribe button are NEVER gated — honouring those is
            // required of every tenant regardless of AI, and gating them is
            // what let unsubscribed customers keep receiving broadcasts.
            const STOP_PHRASE_RE =
              /\b(stop|no more|don'?t|do not|cancel|remove me|unsubscribe)\b[^.!?]{0,30}\b(broadcast|promo|promotion|offer|marketing|advertis|messag|sending|send|share|sharing|list)/i;
            if (m.from) {
              const phoneE164 = `+${m.from}`;
              // Opt-out is either a typed STOP keyword, OR a tap on a marketing
              // template's opt-out button (button/interactive reply whose label
              // contains stop / unsubscribe / "stop promotions").
              const isButtonReply = m.type === 'button' || m.type === 'interactive';
              // NOTE: no trailing \b after `unsubscrib` — "Unsubscribe" ends in
              // a word character, so a closing boundary never matched and EVERY
              // opt-out BUTTON TAP was silently ignored in production. Keep this
              // as a substring test.
              const isStop =
                STOP_RE.test(bodyText) ||
                (aiPhraseOptOutEnabled && STOP_PHRASE_RE.test(bodyText)) ||
                (isButtonReply &&
                  /(stop|unsubscrib|opt[\s-]?out|desinscri|désinscri|إلغاء|الغاء|ايقاف|إيقاف)/i.test(
                    bodyText,
                  ));
              // Meta inbound payloads include a parallel contacts[] array
              // with profile.name and wa_id matching the message's from.
              const inboundContact = (value.contacts ?? []).find(
                (c) => c.wa_id === m.from,
              );
              const profileName = inboundContact?.profile?.name ?? null;
              req.log.info(
                {
                  from: m.from,
                  hasContactsBlock: Array.isArray(value.contacts),
                  contactsCount: (value.contacts ?? []).length,
                  matchedWaId: !!inboundContact,
                  profileName,
                },
                '[whatsapp] inbound profile extraction',
              );
              await withRlsBypass(async (tx) => {
                // Read prior opt-out state so we only tag + audit a NEW opt-out.
                const prior = await tx.contact.findUnique({
                  where: {
                    organizationId_phoneE164: { organizationId: channel.organizationId, phoneE164 },
                  },
                  select: { optedOutAt: true },
                });
                const wasNewlyOptedOut = isStop && !prior?.optedOutAt;
                const contact = await tx.contact.upsert({
                  where: {
                    organizationId_phoneE164: {
                      organizationId: channel.organizationId,
                      phoneE164,
                    },
                  },
                  create: {
                    organizationId: channel.organizationId,
                    phoneE164,
                    // On first sight, seed displayName from the Meta
                    // profile too so operators see SOMETHING immediately
                    // rather than just a phone number. They can rename
                    // later; subsequent inbounds only refresh
                    // whatsappName.
                    displayName: profileName,
                    whatsappName: profileName,
                    optedOutAt: isStop ? new Date() : null,
                    lastInboundAt: new Date(),
                    source: 'inbox_auto',
                  },
                  update: {
                    // Always keep Meta's profile name fresh.
                    ...(profileName ? { whatsappName: profileName } : {}),
                    lastInboundAt: new Date(),
                    ...(isStop ? { optedOutAt: new Date() } : {}),
                  },
                });
                if (isStop) {
                  const { recordContactOptOut } = await import('../../lib/opt-out.js');
                  await recordContactOptOut(tx, {
                    organizationId: channel.organizationId,
                    contactId: contact.id,
                    phoneE164,
                    channel: 'whatsapp',
                    wasNewlyOptedOut,
                  });
                }
              }).catch((err) =>
                req.log.error({ err }, '[whatsapp] contact upsert failed'),
              );
            }
            // Upsert the thread + persist the message + bump the
            // thread's preview/counts in one transaction. RLS bypassed
            // because the public webhook can't carry tenant context —
            // we write into channel.organizationId derived from the URL.
            await withRlsBypass(async (tx) => {
              const phone = m.from ?? null;
              if (!phone) {
                await tx.whatsAppMessage.create({
                  data: {
                    organizationId: channel.organizationId,
                    direction: 'inbound',
                    metaMessageId: m.id ?? null,
                    fromNumber: null,
                    toNumber: value.metadata?.display_phone_number ?? null,
                    messageType: m.type ?? null,
                    body: bodyText || null,
                    rawPayload: m as never,
                  },
                });
                return;
              }
              // Meta's inbound webhook includes a parallel contacts[]
              // block with the sender's profile.name + wa_id. Keep our
              // local mirror fresh so the inbox shows the WhatsApp
              // display name alongside the operator's rename.
              const inboundContact = (value.contacts ?? []).find(
                (c) => c.wa_id === m.from,
              );
              const waProfileName = inboundContact?.profile?.name ?? null;
              const preview = (bodyText || `[${m.type ?? 'media'}]`).slice(0, 200);
              const thread = await upsertWaThread(tx, {
                organizationId: channel.organizationId,
                customerPhone: phone,
                whatsAppChannelId: channel.id,
                create: {
                  customerWhatsappName: waProfileName,
                  status: 'open',
                  lastMessageAt: new Date(),
                  lastMessagePreview: preview,
                  lastInboundAt: new Date(),
                  inboundCount: 1,
                  outboundCount: 0,
                  searchText: bodyText || '',
                },
                update: {
                  lastMessageAt: new Date(),
                  lastMessagePreview: preview,
                  lastInboundAt: new Date(),
                  inboundCount: { increment: 1 },
                  // Reopen if previously resolved.
                  status: 'open',
                  // Always refresh the WhatsApp profile name from Meta —
                  // never overwrite customer_name (operator's rename).
                  ...(waProfileName ? { customerWhatsappName: waProfileName } : {}),
                  // Append to the rolling search blob, capped at ~16 KB.
                  searchText: { set: '' }, // see post-update below
                },
              });
              // Two-step search-text update so we keep the existing blob
              // bounded without a stored procedure. The `$2::uuid` cast is
              // required because Prisma's $executeRawUnsafe passes JS
              // strings as `text` and Postgres won't compare `uuid = text`
              // implicitly (error 42883). The id column on
              // whatsapp_threads is uuid.
              if (bodyText) {
                await tx.$executeRawUnsafe(
                  `UPDATE whatsapp_threads
                     SET search_text = LEFT(COALESCE(search_text,'') || ' ' || $1, 16000)
                     WHERE id = $2::uuid`,
                  bodyText,
                  thread.id,
                );
              }
              await tx.whatsAppMessage.create({
                data: {
                  threadId: thread.id,
                  organizationId: channel.organizationId,
                  direction: 'inbound',
                  metaMessageId: m.id ?? null,
                  fromNumber: phone,
                  toNumber: value.metadata?.display_phone_number ?? null,
                  messageType: m.type ?? null,
                  body: bodyText || null,
                  rawPayload: m as never,
                },
              });
              // Notify on first inbound from this customer (thread.inboundCount
              // == 1 means this insert just created it). Cheap to over-notify;
              // bell collapses dups by entityId.
              if (thread.inboundCount === 0) {
                await tx.notification.create({
                  data: {
                    organizationId: channel.organizationId,
                    kind: 'generic',
                    severity: 'info',
                    title: 'New conversation',
                    body: `New WhatsApp message from ${phone}`,
                    link: '/inbox',
                    entityType: 'whatsapp_thread',
                    entityId: thread.id,
                  },
                });
              }
            }).catch((err) => req.log.error({ err }, '[whatsapp] persist failed'));

            // Credit this reply to the most recent campaign that reached the
            // sender within the attribution window (per-campaign "responded").
            if (m.from) void attributeBroadcastResponse(channel.organizationId, m.from, new Date());
          }
        }
      }

      // Inbound photos — download each one from Meta + store it so the inbox
      // can render the actual image (not just an "[image]" tag). Fire-and-
      // forget and fully independent of the bot reply below.
      for (const p of persisted) {
        if ((p.type === 'image' || p.type === 'sticker') && p.mediaId) {
          void storeInboundImage({
            organizationId: channel.organizationId,
            mediaId: p.mediaId,
            mediaMime: p.mediaMime,
            wamid: p.metaId,
            log: req.log,
          });
        }
        // Same treatment for videos + documents so the inbox can PLAY the clip
        // / offer the file instead of a dead "[video]" tag.
        if ((p.type === 'video' || p.type === 'document') && p.mediaId) {
          void storeInboundImage({
            organizationId: channel.organizationId,
            mediaId: p.mediaId,
            mediaMime: p.mediaMime,
            wamid: p.metaId,
            kind: p.type,
            log: req.log,
          });
        }
        // Inbound voice notes — download + transcode + transcribe + store so the
        // inbox can PLAY them, regardless of whether the AI bot replies (the bot
        // path also calls this but it's idempotent). Fixes voice notes staying
        // as a dead "[audio]" bubble for manual/AI-off tenants.
        if ((p.type === 'audio' || p.type === 'voice') && p.mediaId && p.from) {
          void transcribeInboundVoice({
            organizationId: channel.organizationId,
            mediaId: p.mediaId,
            mediaMime: p.mediaMime,
            wamid: p.metaId,
            customerPhone: p.from,
            log: req.log,
          });
        }
      }

      // Bot runtime — fire-and-forget. Conditions: bot is deployed, the
      // org has an OpenAI key, the thread isn't already assigned to a
      // human, and the message has body text. Reply latency is paid by
      // Meta's reply window so we don't block the webhook 200 on this.
      void (async () => {
        try {
          await maybeReplyAsBot({
            organizationId: channel.organizationId,
            channelId: channel.id,
            messages: persisted,
            log: req.log,
          });
        } catch (err) {
          req.log.error({ err }, '[whatsapp] bot reply failed');
        }
      })();

      reply.code(200);
      return { received: persisted.length };
    },
  );
}

// "Noise" inbound = a message that's just punctuation / a single emoji /
// whitespace. We never want to send a fallback "sorry, rephrase?" reply
// for a "." or a thumbs-up — that would spam. Treats anything with fewer
// than 2 substantive characters (letters/digits) as noise.
function isNoisyInbound(s: string | null | undefined): boolean {
  if (!s) return true;
  // Keep only letters + digits across scripts (Arabic, Latin, etc.). If
  // <2 remain, the message was essentially empty.
  const substantive = s.replace(/[^\p{L}\p{N}]/gu, '');
  return substantive.length < 2;
}

// Localised fallback when the LLM returns empty or the validators strip
// the reply to nothing. Without this, the customer sees only a "..."
// typing indicator and never gets an actual reply. We send this so the
// bot stays responsive even when the LLM has nothing useful to say.
function emptyReplyFallback(userMessage: string | null | undefined): string {
  const isArabic = !!userMessage && /[؀-ۿ]/.test(userMessage);
  return isArabic
    ? 'عذراً، لم أفهم تماماً. هل يمكنك إعادة صياغة سؤالك؟'
    : "Sorry, I didn't quite catch that. Could you rephrase?";
}

// Phase 2 — auto-reply hook called from the inbound webhook. Looks up the
// bot config + thread, asks the LLM via bot-engine, sends through the
// existing /whatsapp/send token-bucket. No-ops cleanly when:
//   - OPENAI_API_KEY is not configured
//   - BotConfig.deployedAt is null
//   - the thread has been assigned to a human (operator owns it now)
//   - the inbound message has no text (image/template/system event)
async function maybeReplyAsBot(args: {
  organizationId: string;
  // The WhatsApp number this inbound arrived on. The bot replies from this
  // number and only when this number has bot_enabled (multi-number routing).
  channelId?: string | null;
  messages: {
    from: string;
    type: string;
    bodyText: string | null;
    metaId: string | null;
    mediaId: string | null;
    mediaMime: string | null;
    timestampEpoch: number | null;
  }[];
  log: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}): Promise<void> {
  const { isOpenAIConfigured } = await import('../../lib/openai.js');
  if (!isOpenAIConfigured()) return;

  // F-02: the whole bot hot path runs under the tenant role so Postgres RLS is
  // a real backstop, not just the explicit org filters in each WHERE clause.
  // We bind the local name `withRlsBypass` to a tenant-scoped wrapper so every
  // call site below is unchanged while now running RLS-ON (org is always known
  // here as args.organizationId). A forgotten org filter can no longer leak
  // cross-tenant — the tenant_isolation policy blocks it at the database.
  const withRlsBypass = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withTenant(args.organizationId, fn);
  const { buildBotResponse, gatherBotData } = await import('../../lib/bot-engine.js');

  // Phase 13 — pipeline stopwatch (one per inbound message). Threaded
  // through every station so we can show the operator exactly where
  // time goes on each reply.
  const { PipelineStopwatch } = await import('../../lib/pipeline-timer.js');

  // Coalesce rapid-fire messages so the bot sends ONE reply per burst instead
  // of greeting/answering each message separately. Meta delivers each message
  // as its own webhook (separate maybeReplyAsBot calls), and a customer often
  // sends "Hi" then "I want to order" within a second or two. Two layers:
  //   (a) within THIS webhook batch, only the LAST message per sender replies;
  //   (b) across webhooks, a short Redis debounce — set a token, wait, and if
  //       a newer message has arrived (token changed) skip this reply and let
  //       the newer invocation handle it (the earlier messages are already in
  //       the thread history the LLM sees).
  const COALESCE_MS = Number(process.env.BOT_COALESCE_MS ?? 2000);
  const lastIdxByFrom = new Map<string, number>();
  args.messages.forEach((mm, i) => {
    if (mm.from) lastIdxByFrom.set(mm.from, i);
  });

  for (let mi = 0; mi < args.messages.length; mi++) {
    const m = args.messages[mi]!;
    // STALE-REDELIVERY GATE. When the webhook endpoint has been down, Meta
    // queues every inbound and redelivers each on its own backoff schedule
    // for up to 7 days. Those pass the wamid dedup (they were never stored)
    // and used to get a fresh bot reply days later at a random hour — the
    // customer experienced the AI "messaging them on its own" (2026-08-05→08
    // outage: replies to 4-day-old greetings at 2 AM). The message is already
    // persisted + visible in the inbox for a human; only the AUTO-REPLY is
    // suppressed. Age comes from Meta's own timestamp — received_at is the
    // processing time and is always "now" for a redelivery.
    {
      const maxAgeMin = Number(process.env.BOT_MAX_INBOUND_AGE_MINUTES ?? 15);
      const { isStaleInbound } = await import('../../lib/inbound-burst.js');
      if (
        maxAgeMin > 0 &&
        isStaleInbound(m.timestampEpoch, Date.now() / 1000, maxAgeMin * 60)
      ) {
        args.log.info(
          {
            orgId: args.organizationId,
            from: m.from,
            metaId: m.metaId,
            sentEpoch: m.timestampEpoch,
            lagMinutes: Math.round((Date.now() / 1000 - (m.timestampEpoch ?? 0)) / 60),
          },
          '[whatsapp] bot skip: stale inbound (late Meta redelivery) — left for human',
        );
        continue;
      }
    }
    // (a) In-batch: skip earlier messages from the same sender in this batch.
    if (m.from && lastIdxByFrom.get(m.from) !== mi) {
      args.log.info({ from: m.from }, '[whatsapp] coalesce: superseded within batch — skipping');
      continue;
    }
    // (b) Cross-webhook debounce. The token doubles as the supersede marker
    // re-checked AFTER generation (see below), so its TTL must outlive a slow
    // generation (18s observed on large-catalog tenants), not just the wait.
    let coalesceToken: string | null = null;
    if (m.from && COALESCE_MS > 0) {
      try {
        const { getRedis } = await import('../../lib/redis.js');
        const redis = getRedis();
        const ckey = `botcoalesce:${args.organizationId}:${m.from}`;
        const ctoken = `${Date.now()}.${m.metaId ?? Math.random().toString(36).slice(2)}`;
        await redis.set(ckey, ctoken, 'PX', COALESCE_MS + 180_000);
        coalesceToken = ctoken;
        await new Promise((r) => setTimeout(r, COALESCE_MS));
        const latest = await redis.get(ckey);
        if (latest && latest !== ctoken) {
          args.log.info(
            { from: m.from },
            '[whatsapp] coalesce: superseded by a newer message — skipping reply',
          );
          continue;
        }
      } catch {
        /* Redis unavailable — proceed without coalescing rather than drop the reply. */
      }
    }
    // (c) Per-phone flood throttle — cost-DoS protection. A single sender
    // spamming the number could otherwise drive unbounded LLM calls + Meta
    // sends. Cap auto-replies per phone per minute (generous: real customers
    // never approach it). Over the cap we suppress only the AUTO-REPLY — the
    // inbound is still stored + visible in the inbox for a human. Tunable via
    // BOT_REPLY_PER_PHONE_PER_MINUTE (0 disables).
    if (m.from) {
      try {
        const { getRedis } = await import('../../lib/redis.js');
        const redis = getRedis();
        const limit = Number(process.env.BOT_REPLY_PER_PHONE_PER_MINUTE ?? 20);
        if (Number.isFinite(limit) && limit > 0) {
          const minuteBucket = Math.floor(Date.now() / 60_000);
          const fkey = `botflood:${args.organizationId}:${m.from}:${minuteBucket}`;
          const n = await redis.incr(fkey);
          if (n === 1) await redis.expire(fkey, 120);
          if (n > limit) {
            args.log.warn(
              { orgId: args.organizationId, from: m.from, count: n, limit },
              '[whatsapp] bot reply throttled — per-phone flood cap hit',
            );
            continue;
          }
        }
      } catch {
        /* Redis down — never block a legitimate reply on the throttle. */
      }
    }
    const stopwatch = new PipelineStopwatch();
    // Voice-note path: customer sent an audio/voice message. Download
    // the bytes from Meta, run Whisper, then feed the transcript into
    // the same bot reply pipeline as a text message. We also patch the
    // already-persisted whatsapp_messages row so the inbox shows the
    // transcript instead of the "[audio]" placeholder.
    //
    // bodyText for inbound audio defaults to "[audio]" (truthy), so we
    // can't gate on `!m.bodyText` — we gate on the type + mediaId. If
    // Whisper succeeds, we overwrite the placeholder with the transcript.
    //
    // Phase 11.1 — transcribe runs in PARALLEL with the prompt-data
    // gather. They share no data deps; both take ~1-2s end-to-end on
    // cold path. Promise.all means the LLM call starts the moment the
    // SLOWER of the two finishes, not the sum. Saves ~200-400 ms per
    // voice reply on hot path; up to 1.5 s on cold-cache cases where
    // gatherBotData is the slower side.
    const isVoice = !!(m.from && (m.type === 'audio' || m.type === 'voice') && m.mediaId);
    const transcribePromise: Promise<string | null> = isVoice
      ? transcribeInboundVoice({
          organizationId: args.organizationId,
          mediaId: m.mediaId!,
          mediaMime: m.mediaMime,
          wamid: m.metaId,
          customerPhone: m.from,
          log: args.log,
        })
      : Promise.resolve(null);

    // tx1: read everything we need to decide whether to reply + the prompt
    // data. No LLM call inside.
    const ctxPromise = withRlsBypass(async (tx) => {
      const config = await tx.botConfig.findUnique({
        where: { organizationId: args.organizationId },
      });
      if (!config?.deployedAt) {
        args.log.info({ orgId: args.organizationId, from: m.from }, '[whatsapp] bot skip: not deployed');
        return null;
      }

      const thread = await tx.whatsAppThread.findFirst({
        where: { organizationId: args.organizationId, customerPhone: m.from },
      });
      if (!thread) {
        args.log.info({ orgId: args.organizationId, from: m.from }, '[whatsapp] bot skip: thread not found');
        return null;
      }
      // Don't reply if a human owns it.
      if (thread.assignedToUserId) {
        args.log.info(
          { orgId: args.organizationId, threadId: thread.id, assignedToUserId: thread.assignedToUserId },
          '[whatsapp] bot skip: thread assigned to human',
        );
        return null;
      }
      // Don't reply if the business already answered THIS message from their own
      // handset (Coexistence). `assignedToUserId` above cannot catch this: a
      // handset reply produces no HTTP request to the platform, so nothing assigns the
      // thread, and without this gate the customer gets a second, different
      // answer from the same number.
      //
      // Compared against the INBOUND message's own timestamp, not now(). "The
      // owner already answered this" is the question — a customer who writes
      // again after that reply must still get an answer, so a thread is never
      // permanently silenced by one handset reply.
      if (
        thread.handsetRepliedAt &&
        m.timestampEpoch != null &&
        thread.handsetRepliedAt.getTime() >= m.timestampEpoch * 1000
      ) {
        args.log.info(
          {
            orgId: args.organizationId,
            threadId: thread.id,
            from: m.from,
            handsetRepliedAt: thread.handsetRepliedAt.toISOString(),
            inboundEpoch: m.timestampEpoch,
          },
          '[whatsapp] bot skip: the business already answered this from their handset',
        );
        return null;
      }
      // Don't reply once the bot has escalated to a human — the thread
      // is waiting for an operator to step in. They'll un-escalate by
      // resolving or re-opening the chat from the inbox.
      if (thread.status === 'escalated') {
        args.log.info(
          { orgId: args.organizationId, threadId: thread.id },
          '[whatsapp] bot skip: thread escalated',
        );
        return null;
      }
      // super-admin per-tenant access control: when 'ai' is disabled this
      // tenant is a manual social-media handler — store the inbound (visible in
      // the inbox) but never auto-reply.
      const orgFeatures = await tx.organization.findUnique({
        where: { id: args.organizationId },
        select: { disabledFeatures: true },
      });
      if (orgFeatures?.disabledFeatures?.includes('ai')) {
        args.log.info(
          { orgId: args.organizationId, threadId: thread.id },
          '[whatsapp] bot skip: AI disabled for tenant',
        );
        return null;
      }

      // Blocked or opted-out contact: never auto-reply. We still stored the
      // inbound message (visible in the inbox) — we just leave it for a human.
      //   - blockedAt: the operator muted the bot for this person.
      //   - optedOutAt: the customer sent STOP/UNSUBSCRIBE. Auto-replying after
      //     an opt-out is a marketing-compliance violation. Messenger already
      //     gates this (messenger.routes maybeReplyOnMessenger); WhatsApp must
      //     too. Match both phone formats (+E.164 and bare) since contacts can
      //     be stored either way.
      if (m.from) {
        const phoneVariants = Array.from(
          new Set([m.from, m.from.startsWith('+') ? m.from.slice(1) : `+${m.from}`]),
        );
        const contactState = await tx.contact.findFirst({
          where: {
            organizationId: args.organizationId,
            phoneE164: { in: phoneVariants },
            OR: [{ blockedAt: { not: null } }, { optedOutAt: { not: null } }],
          },
          select: { id: true, blockedAt: true, optedOutAt: true },
        });
        if (contactState?.blockedAt) {
          args.log.info(
            { orgId: args.organizationId, threadId: thread.id },
            '[whatsapp] bot skip: contact blocked',
          );
          return null;
        }
        if (contactState?.optedOutAt) {
          args.log.info(
            { orgId: args.organizationId, threadId: thread.id },
            '[whatsapp] bot skip: contact opted out (STOP)',
          );
          return null;
        }
      }

      // Multi-number: reply from the EXACT number this inbound arrived on
      // (args.channelId, resolved by the webhook from metadata.phone_number_id).
      // Fall back to the primary number for legacy callers that don't pass it.
      const ch = args.channelId
        ? await tx.whatsAppChannel.findFirst({
            where: { id: args.channelId, organizationId: args.organizationId },
          })
        : await tx.whatsAppChannel.findFirst({
            where: { organizationId: args.organizationId, isPrimary: true },
          });
      // The per-number AI bot switch: the bot only auto-replies on numbers the
      // tenant has deployed it on (bot_enabled), and the number must be active
      // with valid credentials.
      if (!ch || !ch.accessToken || !ch.phoneNumberId || !ch.isActive || !ch.botEnabled) {
        args.log.info(
          {
            orgId: args.organizationId,
            threadId: thread.id,
            channelId: args.channelId ?? null,
            channelExists: Boolean(ch),
            isActive: ch?.isActive,
            botEnabled: ch?.botEnabled,
          },
          '[whatsapp] bot skip: channel missing, inactive, or bot disabled on this number',
        );
        return null;
      }

      // Pull recent thread history. Phase 2 Step 4 cut this from 10 to 8
      // messages and applied a hard per-message body cap (400 chars) so a
      // single noisy turn (paste, long voice transcript) doesn't blow up
      // the input-token budget. 8 messages = ~4 customer/bot turn pairs,
      // which covers the short-term-memory window that actually drives
      // reply quality in practice.
      const RAW_HISTORY_LIMIT = 8;
      const PER_MESSAGE_BODY_CAP = 400;
      const rawHistory = await tx.whatsAppMessage.findMany({
        where: { threadId: thread.id, body: { not: null } },
        orderBy: { receivedAt: 'desc' },
        take: RAW_HISTORY_LIMIT,
      });
      const history = rawHistory.map((m) => ({
        ...m,
        body: m.body && m.body.length > PER_MESSAGE_BODY_CAP
          ? m.body.slice(0, PER_MESSAGE_BODY_CAP - 1) + '…'
          : m.body,
      }));
      const data = await gatherBotData(tx as never, args.organizationId);

      // Phase 2 Step 5 — fast-path inputs. Locations + contacts aren't
      // currently fed to the LLM prompt (we kept the static prompt lean),
      // but the fast-path templater needs them to answer hours / location
      // / contact questions deterministically. Both tables are tiny
      // (1-5 rows per org) so the cost is negligible.
      const [locations, contacts] = await Promise.all([
        tx.location.findMany({
          where: { organizationId: args.organizationId },
          orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
          select: { name: true, addressLine1: true, city: true, region: true, country: true, isPrimary: true },
        }),
        tx.contactChannel.findMany({
          where: { organizationId: args.organizationId },
          orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
          select: { kind: true, label: true, value: true, isPrimary: true },
        }),
      ]);

      // Phase 6 — per-thread override beats org-wide default. NULL on
      // the thread means "inherit BotConfig.replyMode".
      const threadOverride =
        ((thread as { botReplyMode?: string | null }).botReplyMode ?? null) || null;
      const effectiveReplyMode =
        threadOverride && ['text', 'voice', 'match_customer'].includes(threadOverride)
          ? threadOverride
          : (config.replyMode as string | undefined) ?? 'text';
      return {
        history: history.reverse(),
        data,
        locations,
        contacts,
        channel: ch,
        threadId: thread.id,
        // Deterministic scripted-flow inputs (null/disabled ⇒ normal LLM bot).
        scriptedFlow: (config as { scriptedFlow?: unknown }).scriptedFlow ?? null,
        threadFlowState: (thread as { flowState?: unknown }).flowState ?? null,
        greetingVoiceKey:
          (config as { greetingVoiceStorageKey?: string | null }).greetingVoiceStorageKey ?? null,
        threadOutboundCount: thread.outboundCount ?? 0,
        replyMode: effectiveReplyMode,
        ttsProvider:
          ((config as { ttsProvider?: string | null }).ttsProvider as string | null) ?? 'google',
        ttsVoiceName: (config.ttsVoiceName as string | null | undefined) ?? null,
        // Customer's WhatsApp profile name (Meta-provided). Falls back
        // to the operator-set nickname if Meta didn't send one. Empty
        // string when neither is available — bot-engine treats that
        // the same as null + silently skips the by-name greeting.
        customerName:
          thread.customerWhatsappName ?? thread.customerName ?? null,
      };
    });

    // Phase 11.1 — await both transcribe + ctx in parallel here.
    // Whichever is slower sets the wall-clock; the other is "free".
    const [transcript, ctx] = await Promise.all([transcribePromise, ctxPromise]);
    stopwatch.lap(isVoice ? 'transcribe+gather (parallel)' : 'gather_bot_data');
    if (isVoice) {
      if (!transcript) {
        // Transcription failed — skip this message entirely so the LLM
        // doesn't see "[audio]" and reply with a generic "can't listen"
        // fallback. The audio bubble still shows in the inbox.
        continue;
      }
      m.bodyText = transcript;
    }
    if (!m.bodyText || !m.from) continue;
    if (!ctx) continue;

    // Fold the whole unanswered trailing run of this customer's messages into
    // ONE user turn ("hi" + "I want to order" → one turn, one combined reply).
    // The folded rows are cut from the history passed to the LLM so nothing
    // appears twice. Voice: m.bodyText already holds the transcript here; the
    // row is matched by wamid so the "[audio]" placeholder is replaced.
    const { aggregateUnansweredTail, sentEpochFromRaw } = await import(
      '../../lib/inbound-burst.js'
    );
    const burst = aggregateUnansweredTail({
      history: ctx.history.map((h) => ({
        direction: h.direction,
        body: h.body,
        metaMessageId: h.metaMessageId,
        sentEpochSeconds: sentEpochFromRaw(h.rawPayload),
      })),
      currentMetaId: m.metaId,
      currentText: m.bodyText,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    });
    const historyForLlm = ctx.history.slice(0, burst.historyBeforeBurst);

    // ---- Deterministic scripted flow ----------------------------------------
    // If this tenant has an ENABLED scripted flow, it fully owns the
    // conversation: it replies with the operator's EXACT text + tap-buttons and
    // advances node-by-node on each tap/answer. The LLM path below never runs
    // for these tenants. Any error falls through to the normal bot.
    if (ctx.scriptedFlow) {
      try {
        const { runScriptedFlow } = await import('../../lib/scripted-flow.js');
        const handled = await runScriptedFlow({
          organizationId: args.organizationId,
          channel: {
            id: ctx.channel.id,
            phoneNumberId: ctx.channel.phoneNumberId,
            accessToken: ctx.channel.accessToken,
          },
          thread: { id: ctx.threadId, flowState: ctx.threadFlowState },
          scriptedFlow: ctx.scriptedFlow,
          greetingVoiceKey: ctx.greetingVoiceKey,
          message: { from: m.from, type: m.type, bodyText: m.bodyText, mediaId: m.mediaId },
          log: args.log,
        });
        if (handled) continue;
      } catch (err) {
        args.log.error({ err }, '[whatsapp] scripted flow failed — falling through to LLM');
      }
    }

    // Show typing indicator the moment we know a reply is coming. Meta's
    // /messages endpoint accepts a combined read-receipt + typing marker
    // that the customer sees as "..." in WhatsApp. It expires automatically
    // when our real reply lands (or 25s, whichever comes first), so it
    // requires no explicit teardown. Fire-and-forget — a typing-indicator
    // failure must NEVER block the actual bot reply.
    if (m.metaId) {
      void fetch(
        `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId!)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ctx.channel.accessToken!}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: m.metaId,
            typing_indicator: { type: 'text' },
          }),
        },
      ).catch((err) =>
        args.log.warn({ err: err instanceof Error ? err.message : err }, '[whatsapp] typing indicator failed'),
      );
    }

    // Escalation short-circuit: if the bot's most recent reply asked
    // whether the customer wants to talk to a human, and this inbound
    // is an affirmative answer, skip the LLM call entirely. Send a
    // confirmation, flag the thread as 'pending' (escalated state),
    // post an internal "Bot escalated" note so the analytics signal
    // fires, and leave the rest to the operator.
    const lastBotReply =
      [...ctx.history].reverse().find((h) => h.direction === 'outbound')?.body ?? '';
    // The bot offers the handoff in the CUSTOMER's language, so detecting that
    // offer must be multilingual. An English-only regex silently failed for
    // Arabic / Arabizi / French offers (e.g. Lebanese "2etwasal ma3 7ada mn el
    // team") — so the customer's "yes" was never recognised as a handoff
    // confirmation and the thread never escalated / flagged support.
    const HANDOFF_OFFER_RES: RegExp[] = [
      // English: connect/transfer/speak/talk/put-you-in-touch … human/agent/team
      /(connect|transfer|escalat|hand[\s-]?off|speak|talk|put you (?:in touch|through)|get you).{0,40}(human|specialist|agent|representative|teammate|operator|colleague|team|staff|support)/i,
      // Levantine / Gulf Arabizi: (2/n)etwasal / wassel / ne7ki … (7ada / el) team / fari2
      /(twasal|etwasal|netwasal|wasse?l|wassl|ne7ki|n7ki|7ki).{0,40}(team|fari[2q]|7ada)/i,
      // Arabic script: connect/talk + team/someone/staff/support
      /(أوصلك|نوصلك|نوصّلك|تواصل|نتواصل|أتواصل|نحكي|تحكي|نحكيك).{0,40}(الفريق|فريق|حدا|أحد|موظف|الدعم|زميل|الزملاء)/,
      /(فريق|الدعم|موظف).{0,30}(يساعدك|للمساعدة|يتواصل|يرد)/,
      // French: contacter / mettre en contact / parler / transférer … agent/équipe/humain
      /(contacter|mettre en (?:contact|relation)|parler|transf[ée]rer|joindre|passer).{0,40}(agent|conseiller|[ée]quipe|collaborateur|humain|membre|support)/i,
    ];
    const isHandoffOffer = HANDOFF_OFFER_RES.some((re) => re.test(lastBotReply));
    // Affirmative = a SHORT reply (≤4 words) containing a yes-word in any
    // supported language/dialect. The previous whole-string anchor rejected
    // multi-word affirmatives like "eh akid" / "aywa akid" / "oui bien sûr".
    const AFFIRMATIVE_WORD_RE =
      /(^|\s)(yes|yep|yeah|yup|sure|please|ok(ay)?|oui|si|sí|d'accord|na'?am|aywa|ay?wa|akid|2akid|ee+|eh|tab|tayyeb|mashi|tmam|tamam|نعم|إيه|ايه|اي|ايوة|أيوة|أكيد|اكيد|طيب|تمام|ماشي|اوكي|أوكي)(\s|$)/i;
    const userMsgTrim = (m.bodyText ?? '').trim();
    const isAffirmative =
      userMsgTrim.length > 0 &&
      userMsgTrim.split(/\s+/).length <= 4 &&
      AFFIRMATIVE_WORD_RE.test(userMsgTrim);
    const isHandoffConfirm = isHandoffOffer && isAffirmative;

    if (isHandoffConfirm) {
      // Prefer the org's configured escalation fallback so it carries
      // their tone of voice; default to a polite generic line.
      const escalation = (ctx.data.config?.escalationRules ?? {}) as { fallback?: unknown };
      const confirmText =
        typeof escalation.fallback === 'string' && escalation.fallback.trim().length > 0
          ? escalation.fallback.trim()
          : "Thanks — we'll connect you with a human teammate shortly.";
      try {
        const payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: m.from,
          type: 'text',
          text: { preview_url: false, body: confirmText },
        };
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId!)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${ctx.channel.accessToken!}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const text = await res.text();
        let metaMessageId: string | null = null;
        try {
          metaMessageId = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
        } catch {
          /* ignore */
        }
        await withRlsBypass(async (tx) => {
          await tx.whatsAppMessage.create({
            data: {
              threadId: ctx.threadId,
              organizationId: args.organizationId,
              direction: 'outbound',
              metaMessageId,
              toNumber: m.from,
              messageType: 'text',
              body: confirmText,
              rawPayload: { sentBy: 'bot', reason: 'handoff_confirm' } as never,
            },
          });
          await tx.whatsAppThread.update({
            where: { id: ctx.threadId },
            data: {
              // 'escalated' (not 'pending') so the bot-skip guard below
              // actually stops auto-replying and the inbox surfaces it as
              // needing a human — matches the [HANDOFF] marker path.
              status: 'escalated',
              lastMessageAt: new Date(),
              lastMessagePreview: confirmText.slice(0, 200),
              outboundCount: { increment: 1 },
            },
          });
          await tx.whatsAppNote.create({
            data: {
              threadId: ctx.threadId,
              organizationId: args.organizationId,
              authorUserId: null,
              body: '🤖 → 👤 Bot escalated to human (customer confirmed handoff).',
            },
          });
        });
        // Flag support to the team in the notifications bell too, so a
        // handoff isn't silently buried in the thread.
        void (await import('../../lib/notifications.js')).createNotification({
          organizationId: args.organizationId,
          kind: 'cart_received',
          severity: 'warning',
          title: 'Customer needs a human',
          body: `${(ctx as { customerName?: string | null }).customerName ?? m.from} confirmed a handoff — reply in the inbox.`,
          link: `/inbox?thread=${ctx.threadId}`,
          entityType: 'whatsapp_thread',
          entityId: ctx.threadId,
        });
      } catch (err) {
        args.log.warn({ err }, '[whatsapp] handoff-confirm send failed');
      }
      continue;
    }

    // F2 — post-conversation rating intercept (roadmap 2026-08-26). When the
    // resolve-time ask is pending on this thread, the next inbound is checked
    // for a 1-5 reply BEFORE any bot logic. A rating records + thanks the
    // customer (deterministic, no LLM); anything else clears the stamp and
    // flows to the bot normally — never trap the customer in a survey.
    {
      const stampRow = await withRlsBypass((tx) =>
        tx.whatsAppThread.findFirst({
          where: { id: ctx.threadId, organizationId: args.organizationId },
          select: { awaitingFeedbackAt: true },
        }),
      );
      if (stampRow?.awaitingFeedbackAt) {
        const { parseRating, feedbackThanksText, feedbackStampFresh, containsArabic } =
          await import('../../lib/feedback.js');
        const rating = feedbackStampFresh(stampRow.awaitingFeedbackAt, new Date())
          ? parseRating(m.bodyText)
          : null;
        if (rating) {
          const thanks = feedbackThanksText(containsArabic(m.bodyText) ? 'ar' : 'en', rating);
          try {
            const sendRes = await fetch(
              `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId!)}/messages`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${ctx.channel.accessToken!}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  recipient_type: 'individual',
                  to: m.from,
                  type: 'text',
                  text: { preview_url: false, body: thanks },
                }),
                signal: AbortSignal.timeout(10_000),
              },
            );
            const sendText = await sendRes.text();
            let metaMessageId: string | null = null;
            try {
              metaMessageId = (JSON.parse(sendText) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
            } catch { /* noop */ }
            await withRlsBypass(async (tx) => {
              await tx.conversationFeedback.updateMany({
                where: { threadId: ctx.threadId, organizationId: args.organizationId, rating: null },
                data: { rating, respondedAt: new Date() },
              });
              await tx.whatsAppNote.create({
                data: {
                  threadId: ctx.threadId,
                  organizationId: args.organizationId,
                  authorUserId: null,
                  body: `⭐ Customer rated this conversation ${rating}/5.`,
                },
              });
              await tx.whatsAppMessage.create({
                data: {
                  threadId: ctx.threadId,
                  organizationId: args.organizationId,
                  direction: 'outbound',
                  metaMessageId,
                  toNumber: m.from,
                  messageType: 'text',
                  body: thanks,
                  rawPayload: { sentBy: 'bot', reason: 'feedback_thanks' } as never,
                },
              });
              await tx.whatsAppThread.update({
                where: { id: ctx.threadId },
                data: {
                  awaitingFeedbackAt: null,
                  lastMessageAt: new Date(),
                  lastMessagePreview: thanks.slice(0, 200),
                  outboundCount: { increment: 1 },
                },
              });
            });
            args.log.info({ threadId: ctx.threadId, rating }, '[feedback] rating recorded');
            continue;
          } catch (err) {
            args.log.error({ err }, '[feedback] thanks send failed — rating flow abandoned');
            // fall through: the stamp clears below so the bot still answers
          }
        }
        // No parsable rating (or a stale ask): clear the stamp and let the
        // normal reply path handle the message.
        await withRlsBypass((tx) =>
          tx.whatsAppThread.updateMany({
            where: { id: ctx.threadId, organizationId: args.organizationId },
            data: { awaitingFeedbackAt: null },
          }),
        ).catch(() => undefined);
      }
    }

    // F5 — automatic back-in-stock interest capture (roadmap 2026-08-26).
    // Fire-and-forget: never blocks or delays the reply path; all guards
    // (feature gate, conservative name matching, opt-out) live inside.
    {
      const { captureStockInterest } = await import('../../lib/stock-interest.js');
      void captureStockInterest({
        organizationId: args.organizationId,
        threadId: ctx.threadId,
        customerPhone: m.from,
        inboundText: m.bodyText,
        log: args.log,
      });
    }

    // F11 — configured quick-button tap (roadmap 2026-08-26). A tap on an
    // operator-configured button (or the label typed verbatim) with a canned
    // replyText answers deterministically: no LLM call, no AI-message
    // allowance burn. Same send/persist mechanics as the intent fast-path
    // below. Single messages only — a burst is a real conversation.
    if (burst.burstSize <= 1) {
      const { parseCustomButtons, matchButtonReply } = await import('../../lib/quick-buttons.js');
      const configuredButtons = parseCustomButtons(ctx.data.config?.customButtons);
      const canned = matchButtonReply(m.bodyText, configuredButtons);
      if (canned) {
        try {
          const sendRes = await fetch(
            `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId!)}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${ctx.channel.accessToken!}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: m.from,
                type: 'text',
                text: { preview_url: false, body: canned },
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          const sendText = await sendRes.text();
          let metaMessageId: string | null = null;
          try {
            metaMessageId = (JSON.parse(sendText) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
          } catch { /* noop */ }
          await withRlsBypass(async (tx) => {
            await tx.whatsAppMessage.create({
              data: {
                threadId: ctx.threadId,
                organizationId: args.organizationId,
                direction: 'outbound',
                metaMessageId,
                toNumber: m.from,
                messageType: 'text',
                body: canned,
                rawPayload: { sentBy: 'bot', reason: 'quick_button' } as never,
              },
            });
            await tx.whatsAppThread.update({
              where: { id: ctx.threadId },
              data: {
                lastMessageAt: new Date(),
                lastMessagePreview: canned.slice(0, 200),
                outboundCount: { increment: 1 },
              },
            });
          });
          args.log.info(
            { threadId: ctx.threadId },
            '[whatsapp] bot reply via configured quick-button (no LLM)',
          );
          continue;
        } catch (err) {
          args.log.error({ err }, '[whatsapp] quick-button canned send failed');
          // fall through to the normal path — the customer still gets an answer
        }
      }
    }

    // Phase 2 Step 5 — deterministic intent fast-path. Catches the most
    // common WhatsApp customer-service intents (hours / location /
    // contact / "I want a human") with regex + the existing business-
    // info data, skipping the LLM entirely. Latency drops from 3-8s
    // (Groq) or 22s (legacy) to ~80 ms total. Conservative detection:
    // returns null and falls through to the LLM on any ambiguity.
    {
      const { detectFastPath } = await import('../../lib/bot-fastpath.js');
      const { formatOperatingHours } = await import('../../lib/bot-engine.js');
      // A multi-message burst never takes the fast-path — answering only the
      // latest message would silently drop the earlier unanswered inquiries.
      const fp = burst.burstSize > 1 ? null : detectFastPath({
        message: m.bodyText!,
        // "First message in thread" = no prior outbound. If the bot has
        // already replied, the customer's current message is likely
        // context-coupled and we should let the LLM read history.
        isFirstMessageInThread: ctx.threadOutboundCount === 0,
        businessInfo: ctx.data.biz
          ? { operatingHours: ctx.data.biz.operatingHours, timezone: ctx.data.biz.timezone ?? null }
          : null,
        locations: ctx.locations,
        contacts: ctx.contacts,
        formatOperatingHours,
      });

      if (fp) {
        stopwatch.lap('fast_path_match');
        try {
          const sendRes = await fetch(
            `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId!)}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${ctx.channel.accessToken!}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: m.from,
                type: 'text',
                text: { preview_url: false, body: fp.reply.replace(/\n\[HANDOFF\]\s*$/, '').trim() },
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          const sendText = await sendRes.text();
          let metaMessageId: string | null = null;
          try {
            metaMessageId = (JSON.parse(sendText) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
          } catch { /* noop */ }
          stopwatch.lap('meta_messages_send');

          await withRlsBypass(async (tx) => {
            await tx.whatsAppMessage.create({
              data: {
                threadId: ctx.threadId,
                organizationId: args.organizationId,
                direction: 'outbound',
                metaMessageId,
                toNumber: m.from,
                messageType: 'text',
                body: fp.reply,
                rawPayload: { sentBy: 'bot', reason: 'fast_path', intent: fp.intent } as never,
              },
            });
            await tx.whatsAppThread.update({
              where: { id: ctx.threadId },
              data: {
                status: fp.handoffMarker ? 'escalated' : undefined,
                lastMessageAt: new Date(),
                lastMessagePreview: fp.reply.slice(0, 200),
                outboundCount: { increment: 1 },
              },
            });
            if (fp.handoffMarker) {
              await tx.whatsAppNote.create({
                data: {
                  threadId: ctx.threadId,
                  organizationId: args.organizationId,
                  authorUserId: null,
                  body: '🤖 → 👤 Bot escalated to human (fast-path: explicit handoff request).',
                },
              });
            }
          });
          stopwatch.lap('persist');
          args.log.info(
            {
              intent: fp.intent,
              threadId: ctx.threadId,
              totalMs: stopwatch.snapshot().totalMs,
            },
            '[whatsapp] bot reply via fast-path (no LLM)',
          );
        } catch (err) {
          args.log.error({ err }, '[whatsapp] fast-path send failed');
        }
        continue;
      }
    }

    // Did the customer's CURRENT inbound arrive as a voice note? Affects
    // the LLM's delivery-mode banner (match_customer) and the eventual
    // wantsVoice decision below — compute once, reuse both places.
    const customerSpokeAudio = m.type === 'audio' || m.type === 'voice';

    // Stateful cart bookkeeping — runs BEFORE the LLM call so the bot's
    // reply can be informed by the latest draft state when needed.
    // Three things happen here:
    //   1. If the customer message clearly says "cancel" / "start over",
    //      delete the active draft cart (if any).
    //   2. If the previous outbound is older than the session-boundary
    //      window (4h), cancel any active draft — "new conversation =
    //      new draft" so a returning customer doesn't accidentally
    //      continue an order from days ago.
    //   3. Otherwise the existing draft just persists; the post-LLM
    //      parser will append / update items on it.
    const SESSION_GAP_MS = 4 * 60 * 60 * 1000;
    try {
      const { detectCancelIntent } = await import('../../lib/cart-parser.js');
      const wantsCancel = detectCancelIntent(m.bodyText ?? '');
      const lastOutbound = [...ctx.history]
        .reverse()
        .find((h) => h.direction === 'outbound');
      // WhatsAppMessage has `receivedAt` (DateTime) — outbound rows
      // record the moment the API sent the message, inbound rows record
      // when Meta delivered it. Use it as a single timeline clock.
      const lastOutboundAge = lastOutbound
        ? Date.now() - new Date(lastOutbound.receivedAt).getTime()
        : null;
      const sessionStale =
        lastOutboundAge !== null && lastOutboundAge > SESSION_GAP_MS;
      if (wantsCancel || sessionStale) {
        await withRlsBypass(async (tx) => {
          await tx.cart.updateMany({
            where: {
              organizationId: args.organizationId,
              threadId: ctx.threadId,
              status: 'draft',
            },
            data: { status: 'cancelled' },
          });
        });
        if (wantsCancel) {
          args.log.info(
            { orgId: args.organizationId, threadId: ctx.threadId },
            '[whatsapp] draft cart cancelled: customer requested',
          );
        } else if (sessionStale) {
          args.log.info(
            {
              orgId: args.organizationId,
              threadId: ctx.threadId,
              lastOutboundAgeMs: lastOutboundAge,
            },
            '[whatsapp] draft cart cancelled: session-boundary gap',
          );
        }
      }
    } catch (err) {
      args.log.warn({ err }, '[whatsapp] cart pre-LLM bookkeeping failed');
    }

    // Diagnostic log emitted on EVERY bot reply so we can audit voice
    // mode + greet-by-name decisions in one place. Cheap (one line per
    // reply) and removes guesswork when behaviour looks wrong.
    args.log.info(
      {
        orgId: args.organizationId,
        threadId: ctx.threadId,
        inboundType: m.type,
        customerSpokeAudio,
        replyMode: ctx.replyMode,
        ttsProvider: ctx.ttsProvider,
        ttsVoiceName: ctx.ttsVoiceName,
        greetByName:
          (ctx.data.config as { greetByName?: boolean | null } | null)?.greetByName === true,
        customerName: (ctx as { customerName?: string | null }).customerName ?? null,
        historyLen: ctx.history.length,
        isFirstReply: !ctx.history.some((h) => h.direction === 'outbound'),
      },
      '[whatsapp] bot reply: config resolution',
    );

    // Phase 9 — load the active draft cart for this thread so the LLM
    // has the deterministic running total ready to quote. Loaded before
    // the LLM call; passed in as `cartState`. If no draft exists, the
    // bot-engine silently skips the "running cart" prompt section.
    // Wrapped so a poisoned / oversized draft cart (e.g. a money value that
    // overflowed an Int column for a high-denomination currency like LBP)
    // degrades to "no running cart" for this turn instead of throwing and
    // bricking EVERY reply on the thread with the "rephrase?" fallback.
    const cartStateForLLM = await withRlsBypass(async (tx) => {
     try {
      const draft = await tx.cart.findFirst({
        where: {
          organizationId: args.organizationId,
          threadId: ctx.threadId,
          status: 'draft',
        },
        include: { items: true },
      });
      if (!draft || draft.items.length === 0) return null;
      const currency = (draft.currency ?? ctx.data.shopForm?.currency ?? 'USD').toUpperCase();
      const subtotalMinor = draft.items.reduce(
        (s, it) => s + Number(it.unitPriceMinor) * it.quantity,
        0,
      );

      // capturedFields: extracted shopForm answers we want the LLM to
      // see on every subsequent turn so it stops re-asking. Two
      // sources, in priority order:
      //   1) Persistent fields[] JSON on the draft Cart row (set by
      //      the form-collect path on confirm).
      //   2) Heuristic regex sweep of the bot's prior outbound text —
      //      catches the "Delivery address is Lusail Marina Twin
      //      Tower B" line the bot speaks before persisting anything.
      // (2) is the bandaid; (1) is the long-term home as we wire
      // per-field capture into the form-collection state.
      const capturedFields: Record<string, string> = {};
      const draftFields = (draft.fields as unknown) as Array<{ key?: string; value?: string }> | null;
      if (Array.isArray(draftFields)) {
        for (const f of draftFields) {
          if (f && typeof f.key === 'string' && typeof f.value === 'string' && f.value.trim()) {
            capturedFields[f.key] = f.value.trim();
          }
        }
      }
      // Regex sweep across the last 8 outbound messages. Looks for
      // address-shaped lines. Limited to outbound (the bot's own
      // speech) so the customer's inbound chatter doesn't pollute.
      const outboundRecent = ctx.history
        .filter((h) => h.direction === 'outbound')
        .slice(-8)
        .map((h) => h.body ?? '')
        .join('\n');
      const addressMatch = outboundRecent.match(
        /(?:delivery\s+address\s+is|delivery\s+address\s*:|address\s+is|address\s*:)\s+([^.\n]{6,120})/i,
      );
      if (addressMatch && !capturedFields['delivery_address']) {
        capturedFields['delivery_address'] = addressMatch[1]!.trim().replace(/[,;]+$/, '');
      }

      return {
        items: draft.items.map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unitPriceMinor: Number(it.unitPriceMinor),
          sku: it.sku,
        })),
        subtotalMinor,
        currency,
        capturedFields: Object.keys(capturedFields).length > 0 ? capturedFields : undefined,
      };
     } catch (err) {
       args.log.warn({ err }, '[whatsapp] cart-state load failed — replying without the running cart this turn');
       return null;
     }
    });

    // Returning-customer reminder: if the customer left this order unfinished
    // and has come back after a long silence (>1h since the previous message),
    // flag it so the bot OPENS by reminding them of the pending order and asks
    // continue-or-fresh (instead of silently resuming). The 4h session-boundary
    // above already cancels older drafts, so a non-null cartState here means the
    // order is still resumable. Gap is measured from the most recent prior
    // message of any direction (ctx.history excludes the current inbound).
    const RETURN_REMINDER_GAP_MS = 60 * 60 * 1000;
    let cartIdleReturn = false;
    if (cartStateForLLM) {
      const lastPriorMsg = ctx.history[ctx.history.length - 1];
      const idleGapMs = lastPriorMsg
        ? Date.now() - new Date(lastPriorMsg.receivedAt).getTime()
        : null;
      cartIdleReturn = idleGapMs != null && idleGapMs > RETURN_REMINDER_GAP_MS;
    }

    // Per-user memory ("user_info") — ALL plans. Loads this contact's
    // distilled persona + real recent orders so the bot personalises and uses
    // FEWER tokens (it reads saved facts instead of re-deriving them from the
    // full history every turn). Intent classification + link selection stay
    // Ultra-only (those drive the deterministic link backstop). All failures
    // are swallowed so the reply path is never blocked.
    let personaBlock: string | null = null;
    let isUltraPlan = false;
    let contactMemoryEnabled = true;
    let pinnedSkus: string[] = [];
    let intentPromise: Promise<{ intent: string; confidence: number; reason: string } | null> | null =
      null;
    try {
      const { getOrgAiPlan } = await import('../../lib/openai.js');
      isUltraPlan = (await getOrgAiPlan(args.organizationId)) === 'ultra';
      // Per-tenant "AI contact memory" feature gate. When OFF we neither
      // generate nor inject the per-contact persona. Real order history is NOT
      // AI-generated memory, so it still loads (re-order / "what did I order").
      const orgFeat = await withRlsBypass((tx) =>
        tx.organization.findUnique({
          where: { id: args.organizationId },
          select: { disabledFeatures: true },
        }),
      );
      contactMemoryEnabled = !(orgFeat?.disabledFeatures ?? []).includes('contact_memory');
      const {
        loadPersonaBlock,
        renderPersonaForPrompt,
        loadRecentOrders,
        renderOrdersForPrompt,
        pinnedSkusFromOrders,
        loadLastOrderProfile,
        renderLastOrderDefaultsForPrompt,
      } = await import('../../lib/contact-memory.js');
      const [pb, orders, lastProfile] = await Promise.all([
        contactMemoryEnabled
          ? loadPersonaBlock(args.organizationId, m.from)
          : Promise.resolve(null),
        loadRecentOrders(args.organizationId, m.from),
        // Last-order name/address/notes to offer as confirmable checkout defaults.
        // Gated on the same "AI contact memory" feature as the persona.
        contactMemoryEnabled
          ? loadLastOrderProfile(args.organizationId, m.from)
          : Promise.resolve(null),
      ]);
      personaBlock =
        [
          contactMemoryEnabled ? renderPersonaForPrompt(pb) : '',
          contactMemoryEnabled ? renderLastOrderDefaultsForPrompt(lastProfile) : '',
          renderOrdersForPrompt(orders),
        ]
          .filter(Boolean)
          .join('\n\n') || null;
      // Pin recent-order products so "yes add these" can re-add them even when
      // top-K wouldn't have surfaced them this turn.
      pinnedSkus = pinnedSkusFromOrders(orders);
      // Intent + link selection — Ultra only.
      if (isUltraPlan) {
        const ultraHistory = historyForLlm.map((h) => ({
          role: h.direction === 'outbound' ? ('assistant' as const) : ('user' as const),
          content: h.body ?? '',
        }));
        const { classifyIntent } = await import('../../lib/intent.js');
        intentPromise = classifyIntent({
          organizationId: args.organizationId,
          userMessage: burst.userTurn,
          history: ultraHistory,
          offers: {
            hasProducts: ctx.data.products.length > 0,
            hasServices: ctx.data.services.length > 0,
            hasBookingForm: !!ctx.data.bookingForm,
            hasShopForm: !!ctx.data.shopForm,
          },
        }).catch(() => null);
      }
    } catch (err) {
      args.log.warn({ err }, '[whatsapp] per-user memory setup failed (non-fatal)');
    }
    stopwatch.lap('persona');

    // Booking availability — open slots the bot may offer (capacity-filtered).
    const bookingAvail = ctx.data.bookingForm?.availability ?? null;
    let openSlots: string[] = [];
    if (bookingAvail?.enabled) {
      const { computeOpenSlots } = await import('../../lib/booking-slots.js');
      openSlots = (await computeOpenSlots(args.organizationId, bookingAvail, new Date(), 6)).map(
        (s) => s.label,
      );
    }

    // Monthly AI-message allowance — once the tenant is out of allowance for
    // the month, pause the bot (leave the chat for a human) instead of replying.
    if (!(await canSendAiMessage(args.organizationId))) {
      args.log.warn(
        { orgId: args.organizationId, threadId: ctx.threadId },
        '[whatsapp] monthly AI message allowance reached — skipping bot reply (left for human)',
      );
      continue;
    }

    // OpenAI call — outside the tx. Safe to be slow.
    let botError: unknown = null;
    const result = await buildBotResponse({
      organizationId: args.organizationId,
      // The aggregated burst turn — EVERY unanswered message from this
      // customer, not just the latest, so one reply covers all inquiries.
      userMessage: burst.userTurn,
      history: historyForLlm.map((h) => ({
        role: h.direction === 'outbound' ? ('assistant' as const) : ('user' as const),
        content: h.body ?? '',
      })),
      data: ctx.data,
      replyMode: ctx.replyMode as 'text' | 'voice' | 'match_customer',
      customerSpokeAudio,
      customerName: (ctx as { customerName?: string | null }).customerName ?? null,
      cartState: cartStateForLLM ? { ...cartStateForLLM, idleReturn: cartIdleReturn } : null,
      persona: personaBlock,
      pinnedSkus,
      channelLabel: 'WhatsApp',
      openSlots,
    }).catch((err) => {
      botError = err;
      args.log.warn({ err }, '[whatsapp] bot-engine failed');
      return null;
    });
    stopwatch.lap('llm');
    // SUPERSEDE RE-CHECK. The debounce above only covers the 2s wait — but
    // generation itself takes 8–20s on large-catalog tenants, and a message
    // arriving in THAT window used to produce a second parallel reply that
    // re-greeted the customer (observed live on aseer-time, 2026-08-09). If a
    // newer message replaced our token while we were generating, this draft
    // is stale: discard it WITHOUT sending. Nothing is lost — the newer
    // message's own invocation folds every unanswered message (including
    // ours) into its aggregated turn and sends ONE combined reply.
    if (m.from && coalesceToken) {
      try {
        const { getRedis } = await import('../../lib/redis.js');
        const latest = await getRedis().get(`botcoalesce:${args.organizationId}:${m.from}`);
        if (latest && latest !== coalesceToken) {
          args.log.info(
            { from: m.from, threadId: ctx.threadId },
            '[whatsapp] superseded during generation — discarding draft; newer invocation answers the full burst',
          );
          continue;
        }
      } catch {
        /* Redis down — better to send than to drop the reply. */
      }
    }
    let rawReply = result?.text ?? null;
    // Count one AI message against the monthly allowance for a real bot reply.
    if (rawReply) void recordAiMessages(args.organizationId, 1);
    const channel = ctx.channel;
    if (!rawReply) {
      // Don't go silent on the customer. We already fired the typing
      // indicator (Meta /messages with typing_indicator) at the top of
      // this iteration — bailing here leaves "..." on the customer's
      // screen until it expires ~25 s later, then nothing. For a real
      // inbound we send a localised rephrase prompt instead so the bot
      // stays responsive. For trivially noisy inbounds (".", "👍",
      // single character) we still skip — replying to a stray punct
      // would be worse than silence.
      args.log.warn(
        {
          orgId: args.organizationId,
          threadId: ctx.threadId,
          inboundLen: m.bodyText?.length ?? 0,
          inboundType: m.type,
        },
        '[whatsapp] bot reply: LLM returned no text — applying empty-reply fallback',
      );
      // Out of daily AI budget — do NOT tell the customer the bot is confused
      // ("rephrase?"). Leave the message unanswered so an operator picks it up;
      // the dashboard banner + notification already flag the org is capped.
      if ((botError as { code?: string } | null)?.code === 'TOKEN_BUDGET_EXCEEDED') {
        args.log.warn(
          { orgId: args.organizationId, threadId: ctx.threadId },
          '[whatsapp] daily AI token budget exceeded — skipping bot reply (left for human)',
        );
        continue;
      }
      if (isNoisyInbound(burst.userTurn)) continue;
      rawReply = emptyReplyFallback(burst.userTurn);
    }

    // Ultra plan — deterministically append the single most relevant link
    // for the classified intent, when it isn't already in the reply. The
    // LLM can't be trusted to remember to paste links (bot-engine lesson),
    // so this is the backstop. Skipped for voice replies (a URL in a TTS
    // voice note reads terribly). Gated on ultra + a confident intent.
    const willSpeak =
      ctx.replyMode === 'voice' || (ctx.replyMode === 'match_customer' && customerSpokeAudio);
    // Only surface a link on the FIRST bot reply in the thread, or when the
    // customer EXPLICITLY asks for one — never on every order-intent turn
    // (that spammed the menu link). And never resend a link already sent in
    // this thread. ("when asked" for the menu is also handled deterministically
    // inside bot-engine; appendRelevantLink dedupes against the current reply.)
    const isFirstBotReply = (ctx.threadOutboundCount ?? 0) === 0;
    const asksForLink =
      /\b(menu|link|catalog|catalogue|website|site|book|booking|reserve|reservation)\b/i.test(
        burst.userTurn,
      ) || /قائمة|منيو|رابط|الموقع|احجز|حجز|carte|lien|réserv/i.test(burst.userTurn);
    if (isUltraPlan && intentPromise && rawReply && !willSpeak && (isFirstBotReply || asksForLink)) {
      try {
        const intent = await intentPromise;
        if (intent && intent.confidence >= 0.5) {
          const { selectLinks, appendRelevantLink } = await import('../../lib/link-rules.js');
          const contactUrl =
            ctx.contacts.find((c) => /^https?:\/\//i.test(c.value))?.value ?? null;
          // Don't resend a link the bot already pasted earlier in this thread.
          const recentOutbound = ctx.history
            .filter((h) => h.direction === 'outbound')
            .map((h) => h.body ?? '')
            .join('\n');
          const candidates = selectLinks(
            intent.intent as 'order' | 'booking' | 'question' | 'support' | 'smalltalk' | 'other',
            {
              menuUrl: (ctx.data.shopForm as { menuUrl?: string | null } | null)?.menuUrl ?? null,
              websiteUrl:
                (ctx.data.biz as { websiteUrl?: string | null } | null)?.websiteUrl ?? null,
              contactUrl,
            },
          ).filter((c) => !recentOutbound.includes(c.url));
          rawReply = appendRelevantLink(rawReply, candidates);
        }
      } catch (err) {
        args.log.warn({ err }, '[whatsapp] ultra link-append failed (non-fatal)');
      }
    }

    // Fold this turn into the contact's "user_info" memory (ALL plans now).
    // Fire-and-forget: runs in the background, has its own try/catch + a
    // per-contact throttle (so it doesn't re-summarize on every single
    // message), and can never delay or fail the reply the customer is waiting
    // on.
    if (rawReply && contactMemoryEnabled) {
      const replyForMemory = rawReply;
      void import('../../lib/contact-memory.js').then(({ updateContactMemory }) =>
        updateContactMemory({
          organizationId: args.organizationId,
          phoneE164: m.from,
          customerName: (ctx as { customerName?: string | null }).customerName ?? null,
          history: ctx.history.map((h) => ({
            role: h.direction === 'outbound' ? ('assistant' as const) : ('user' as const),
            content: h.body ?? '',
          })),
          latestUserMessage: m.bodyText!,
          latestBotReply: replyForMemory,
        }),
      );
    }

    // Phase 9 — universal reply validators. Runs the pre-send pipeline:
    // image-marker SKU check, voice-apology strip, cart-total override,
    // booking-fidelity guard, handoff strictness, welcome dedup. Tenant-
    // agnostic — every tenant's bot replies pass through the same logic.
    //
    // Skipped entirely when `result` is null (LLM threw / fell through to
    // the empty-reply fallback above). Validators sanity-check LLM output;
    // a deterministic hardcoded "Sorry, rephrase?" string doesn't need to
    // run that gauntlet — and the validation context wants the LLM's
    // `inputs` blob, which doesn't exist on the fallback path.
    if (result) {
      const { validateReply } = await import('../../lib/reply-validators.js');
      const previousBotReply =
        [...ctx.history]
          .reverse()
          .find((h) => h.direction === 'outbound')?.body ?? null;
      const validation = validateReply({
        reply: rawReply,
        // The reply was generated from the aggregated burst turn — validators
        // (language mirror, welcome dedup) must compare against the same text.
        userMessage: burst.userTurn,
        inputs: result.inputs,
        kb: {
          products: ctx.data.products.map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            priceMinor: p.priceMinor,
            currency: p.currency,
          })),
          services: ctx.data.services.map((s) => ({
            id: s.id,
            name: s.name,
            basePriceMinor: s.basePriceMinor,
            currency: s.currency,
          })),
          faqs: ctx.data.faqs.map((f) => ({
            id: f.id,
            question: f.question,
            answer: f.answer,
          })),
          policies: ctx.data.policies.map((p) => ({
            kind: p.kind,
            title: p.title,
            content: p.content,
          })),
          biz: ctx.data.biz
            ? {
                legalName: ctx.data.biz.legalName,
                websiteUrl: ctx.data.biz.websiteUrl,
                operatingHours: ctx.data.biz.operatingHours,
                currency: ctx.data.biz.currency,
                menuUrl: ctx.data.shopForm?.menuUrl ?? null,
              }
            : null,
          config: ctx.data.config
            ? { greeting: ctx.data.config.greeting }
            : null,
          customer: {
            whatsappName:
              (ctx as { customerName?: string | null }).customerName ?? null,
            operatorNickname: null,
          },
        },
        cartDraft: cartStateForLLM
          ? {
              items: cartStateForLLM.items,
              totalMinor: cartStateForLLM.subtotalMinor,
              currency: cartStateForLLM.currency,
            }
          : null,
        bookingFormEnabled: !!ctx.data.bookingForm?.enabled,
        shopFormEnabled: !!ctx.data.shopForm?.enabled,
        voiceMode:
          ctx.replyMode === 'voice'
            ? 'voice'
            : ctx.replyMode === 'match_customer' && customerSpokeAudio
              ? 'voice'
              : 'text',
        previousBotReply,
        configuredGreeting: ctx.data.config?.greeting ?? null,
      });
      if (validation.warnings.length > 0) {
        args.log.warn(
          { warnings: validation.warnings, orgId: args.organizationId },
          '[whatsapp] reply validators fired',
        );
      }
      rawReply = validation.reply;
    }
    stopwatch.lap('validators');

    // Grounding gate — flag (shadow) or refuse (enforce) a reply that asserts a
    // product/price not in the catalog. Scan the customer-facing text (markers
    // stripped, as the send path will), against the same candidate KB provenance
    // uses. Shadow (default) only logs + records; enforce swaps in the safe
    // fallback so the downstream marker/cart/image steps find nothing and only
    // the fallback goes out. Never throws — a gate error can't block a reply.
    let groundingFlagged = false;
    let groundingReason: string | null = null;
    if (result && rawReply) {
      try {
        const { buildScanCandidates, groundingGate, gateMode, safeFallback } = await import(
          '../../lib/grounding-gate.js'
        );
        const strippedForScan = rawReply
          .replace(/\[IMAGE:[^\]]*\]/gi, '')
          .replace(/\[CART:[\s\S]*\}\s*\]/gi, '')
          .replace(/\[BUTTONS:[^\]]*\]/gi, '')
          .replace(/\[BOOKING:[\s\S]*\}\s*\]/gi, '')
          .replace(/\[HANDOFF\]/gi, '')
          .replace(/\[CLEAR_CART\]/gi, '')
          .replace(/\[PAYMENT_LINK\]/gi, '')
          .trim();
        const candidates = buildScanCandidates(
          ctx.data,
          (ctx as { customerName?: string | null }).customerName ?? null,
        );
        const gate = groundingGate(strippedForScan, candidates);
        if (gate.wouldBlock) {
          groundingFlagged = true;
          groundingReason = gate.reason;
          args.log.warn(
            { threadId: ctx.threadId, orgId: args.organizationId, mode: gateMode(), reason: gate.reason },
            '[whatsapp] grounding gate flagged reply',
          );
        }
        if (!gate.ok) {
          // enforce: replace with the safe fallback (no markers → downstream
          // cart/image/payment steps no-op → only the fallback is sent).
          rawReply = safeFallback();
        }
      } catch (err) {
        args.log.warn({ err }, '[whatsapp] grounding gate errored (non-fatal, reply unchanged)');
      }
    }

    // MyFatoorah payment-link swap. The LLM is trained to emit
    // "https://myfatoorah.com" as a placeholder when the customer
    // asks for a payment link — useless because it's the marketing
    // homepage, not a payable invoice. Detect any such mention AND
    // the explicit [PAYMENT_LINK] marker the prompt may emit, then
    // call MyFatoorah to mint a real per-order invoice and substitute
    // its URL. When the integration isn't configured OR creation
    // fails, we leave the original text alone (the customer still
    // sees a non-broken reply; the operator can intervene from the
    // inbox).
    if (
      rawReply &&
      cartStateForLLM &&
      cartStateForLLM.items.length > 0 &&
      (/\bhttps?:\/\/(?:[a-z0-9-]+\.)?myfatoorah\.com\S*/i.test(rawReply) ||
        /\[PAYMENT_LINK\]/i.test(rawReply))
    ) {
      try {
        const code = cartStateForLLM.currency.toUpperCase();
        const dec =
          code === 'KWD' || code === 'BHD' || code === 'OMR' || code === 'JOD' ? 3 : 2;
        const div = Math.pow(10, dec);
        const amountMinor = cartStateForLLM.subtotalMinor;
        const amountMajor = Number((amountMinor / div).toFixed(dec));
        const draftCart = await withRlsBypass((tx) =>
          tx.cart.findFirst({
            where: { organizationId: args.organizationId, threadId: ctx.threadId, status: 'draft' },
            select: { id: true, customerName: true },
          }),
        );
        if (draftCart) {
          const payCtx = {
            organizationId: args.organizationId,
            threadId: ctx.threadId,
            cartId: draftCart.id,
            customerName:
              draftCart.customerName ||
              (ctx as { customerName?: string | null }).customerName ||
              'Customer',
            customerPhone: m.from,
            amountMajor,
            amountMinor,
            currency: code,
            displayReference: draftCart.id.slice(0, 8),
          };
          // Per-tenant, multi-provider resolution: load the org's payment
          // config and dispatch to the matching adapter (cash/static-link/
          // bank-transfer/myfatoorah/stripe/paypal). Falls back to the
          // platform-global MyFatoorah env when no per-tenant config exists.
          let resolution:
            | { kind: 'url'; url: string; ref?: string | null }
            | { kind: 'text'; text: string }
            | null = null;
          let payProvider = 'none';
          const pcfg = await withRlsBypass((tx) =>
            tx.paymentConfig.findUnique({ where: { organizationId: args.organizationId } }),
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
              args.log,
            );
            if (resolution) payProvider = pcfg.provider;
          }
          if (!resolution) {
            const { createInvoice, isMyFatoorahConfigured } = await import('../../lib/myfatoorah.js');
            if (isMyFatoorahConfigured()) {
              const invoice = await createInvoice(payCtx, args.log);
              if (invoice) {
                resolution = { kind: 'url', url: invoice.invoiceUrl, ref: String(invoice.invoiceId) };
                payProvider = 'myfatoorah';
              }
            }
          }
          // F-04: record the gateway + external ref so the inbound payment
          // webhook can correlate this order back and mark it paid.
          if (resolution?.kind === 'url' && payProvider !== 'none') {
            const { recordPaymentIntent } = await import('../../lib/payments/confirm.js');
            await recordPaymentIntent({
              organizationId: args.organizationId,
              cartId: draftCart.id,
              provider: payProvider,
              ref: resolution.ref ?? null,
            });
          }
          if (resolution?.kind === 'url') {
            rawReply = rawReply
              .replace(/\bhttps?:\/\/(?:[a-z0-9-]+\.)?myfatoorah\.com\S*/gi, resolution.url)
              .replace(/\[PAYMENT_LINK\]/gi, resolution.url);
          } else if (resolution?.kind === 'text') {
            rawReply = rawReply.replace(/\[PAYMENT_LINK\]/gi, resolution.text);
          } else if (/\[PAYMENT_LINK\]/i.test(rawReply)) {
            rawReply = rawReply.replace(
              /\[PAYMENT_LINK\]/gi,
              'We will send you a secure payment link shortly.',
            );
          }
        }
      } catch (err) {
        args.log.warn({ err }, '[whatsapp] payment-link resolve failed');
      }
    }

    // Stateful cart — parse "added N× <product>" lines out of the bot's
    // reply and upsert each one into a draft Cart row for this thread.
    // The downstream [CART:] marker handler will read items from THIS
    // draft instead of trusting the LLM's marker payload (which often
    // drops items on long carts). Also injects [IMAGE: <sku>] markers
    // into the reply for any added item the LLM forgot to attach.
    if (ctx.data.shopForm?.enabled && rawReply) {
      try {
        const { parseAddedItems, augmentReplyWithImageMarkers } = await import(
          '../../lib/cart-parser.js'
        );
        // userMessage is forwarded so the parser can refuse adds the
        // customer didn't explicitly request (defeats the "Done send" →
        // hallucinated Mango Ice Cream class of failure). previousBotReply
        // also goes in so the payment-turn detector sees the prior
        // "send me a payment link" prompt and never matches a phonetic
        // catalog cousin (e.g. "Fawran" → "Farouhah Frappe").
        const previousBotReplyForParser =
          [...ctx.history]
            .reverse()
            .find((h) => h.direction === 'outbound')?.body ?? '';
        const parsed = parseAddedItems(
          rawReply,
          ctx.data.products.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
            priceMinor: p.priceMinor,
          })),
          { userMessage: burst.userTurn, previousBotReply: previousBotReplyForParser },
        );
        // Hallucination guard. Two passes:
        //   1. "added/removed N× X" lines (cart confirmations / removals)
        //   2. Any "<X> is <price> <currency>" mention in the reply
        // For each captured product fragment that doesn't substring-match a
        // catalog product name, log a warn. Cheap (regex over reply text),
        // diagnostic only — we don't block the send. Catches the bot
        // inventing items, sizes, or prices the operator never entered.
        try {
          const catalogNames = ctx.data.products.map((p) => p.name.toLowerCase());
          const matchesCatalog = (frag: string) => {
            const f = frag.toLowerCase().trim();
            if (f.length === 0) return true;
            return catalogNames.some((n) => n.length > 1 && (f.includes(n) || n.includes(f)));
          };
          const phantom: string[] = [];
          // Pass 1: explicit cart actions.
          for (const m of rawReply.matchAll(
            /(?:added|i(?:'ve)?\s+added|removed)\s+(?:one|two|three|four|five|\d+)\s*(?:×|x)?\s+([A-Z][^\n.;,]{2,60})/gi,
          )) {
            const frag = (m[1] ?? '').trim();
            if (frag && !matchesCatalog(frag)) phantom.push(frag);
          }
          // Pass 2: any "<Name>(?) is/at/for <price> <currency>" phrasing —
          // catches upsells that name a product that doesn't exist. The
          // currency is dynamic so we read it off the shopForm config.
          const cur = ctx.data.shopForm?.currency ?? null;
          if (cur) {
            const priceRe = new RegExp(
              String.raw`\b([A-Z][a-zA-Z0-9 '\-]{2,40})\b[^\n.;]{0,30}?(?:\bis\b|\bat\b|\bfor\b|\b\-\b|\b—\b)\s*\d+(?:[.,]\d+)?\s*` +
                cur,
              'g',
            );
            for (const m of rawReply.matchAll(priceRe)) {
              const frag = (m[1] ?? '').trim();
              if (frag && !matchesCatalog(frag)) phantom.push(frag);
            }
          }
          if (phantom.length > 0) {
            args.log.warn(
              {
                orgId: args.organizationId,
                threadId: ctx.threadId,
                phantom: Array.from(new Set(phantom)).slice(0, 5),
                catalogSize: ctx.data.products.length,
              },
              '[whatsapp] bot quoted product names not found in catalog (possible hallucination)',
            );
          }
        } catch {
          /* diagnostic only — never fail the reply on this */
        }
        if (parsed.length > 0) {
          // Inject missing [IMAGE: <sku>] markers BEFORE the downstream
          // regex picks them up. Doing it here means the existing
          // multi-image pipeline handles the actual send.
          rawReply = augmentReplyWithImageMarkers(rawReply, parsed);

          // Upsert items into the draft cart. One draft per thread; if
          // none exists, create it. Each parsed line REPLACES the item
          // qty for that SKU rather than accumulating, because the bot's
          // running-total semantics treat each "added N× X" as a fresh
          // statement of the line. Cart totals recompute server-side.
          await withRlsBypass(async (tx) => {
            const currency = ctx.data.shopForm?.currency ?? 'USD';
            let draft = await tx.cart.findFirst({
              where: {
                organizationId: args.organizationId,
                threadId: ctx.threadId,
                status: 'draft',
              },
              include: { items: true },
            });
            if (!draft) {
              const created = await tx.cart.create({
                data: {
                  organizationId: args.organizationId,
                  threadId: ctx.threadId,
                  customerPhone: m.from!,
                  customerName:
                    (ctx as { customerName?: string | null }).customerName ?? null,
                  status: 'draft',
                  currency,
                  fields: [] as never,
                },
                include: { items: true },
              });
              draft = created;
            }
            // Replace-or-append by SKU. Existing rows for a parsed SKU
            // get their quantity updated; new SKUs get a fresh row.
            for (const p of parsed) {
              const existing = draft.items.find((it) => it.sku === p.sku);
              if (existing) {
                await tx.cartItem.update({
                  where: { id: existing.id },
                  data: {
                    quantity: p.quantity,
                    unitPriceMinor: p.unitPriceMinor,
                    lineTotalMinor: p.quantity * p.unitPriceMinor,
                  },
                });
              } else {
                await tx.cartItem.create({
                  data: {
                    organizationId: args.organizationId,
                    cartId: draft.id,
                    productId: p.productId,
                    sku: p.sku,
                    name: p.name,
                    quantity: p.quantity,
                    unitPriceMinor: p.unitPriceMinor,
                    lineTotalMinor: p.quantity * p.unitPriceMinor,
                  },
                });
              }
            }
            // Recompute cart totals from the canonical items rows so
            // /cart UI reflects the latest state immediately.
            const refreshed = await tx.cartItem.findMany({
              where: { cartId: draft.id },
            });
            const subtotalMinor = refreshed.reduce(
              (s, it) => s + Number(it.lineTotalMinor),
              0,
            );
            const shopForm = ctx.data.shopForm!;
            const baseDelivery = shopForm.deliveryFeeMinor ?? 0;
            const deliveryMinor =
              shopForm.freeDeliveryAboveMinor != null &&
              subtotalMinor >= shopForm.freeDeliveryAboveMinor
                ? 0
                : baseDelivery;
            await tx.cart.update({
              where: { id: draft.id },
              data: {
                subtotalMinor,
                deliveryMinor,
                totalMinor: subtotalMinor + deliveryMinor,
                itemsCount: refreshed.reduce((s, it) => s + it.quantity, 0),
              },
            });
          });
          args.log.info(
            {
              orgId: args.organizationId,
              threadId: ctx.threadId,
              addedCount: parsed.length,
              skus: parsed.map((p) => p.sku),
            },
            '[whatsapp] draft cart updated from parsed reply',
          );
        }
      } catch (err) {
        args.log.warn({ err }, '[whatsapp] stateful cart parse failed');
      }
    }

    // Image protocol: the LLM emits [IMAGE: <SKU>] when the customer
    // asks for a product's images. The bot can emit MULTIPLE markers
    // in one reply (one per product). For each matched product we send
    // EVERY image attached to it as a separate WhatsApp media message,
    // so a customer's "do you have pictures?" gets back the full
    // gallery, not just the primary.
    const imageMarkerRe = /\[IMAGE:\s*([^\]\s]+)\s*\]/gi;
    const imageSkus = Array.from(rawReply.matchAll(imageMarkerRe)).map((m) => m[1]!.trim());

    // Handoff protocol: bare [HANDOFF] marker means the customer asked
    // for a human teammate. Strip it, flip the thread to "escalated"
    // (sidebar Inbox badge + colored row in the list), and post an
    // internal note so the operator can see why.
    const handoffMarkerRe = /\[HANDOFF\]/i;
    const wantsHandoff = handoffMarkerRe.test(rawReply);

    // Booking protocol: [BOOKING: { ... json ... }] terminates a
    // booking conversation. We parse the JSON, look up the operator's
    // configured form to label each field, persist a Booking row,
    // strip the marker from the visible reply.
    const bookingMarkerRe = /\[BOOKING:\s*(\{[\s\S]*?\})\s*\]/i;
    const bookingMatch = bookingMarkerRe.exec(rawReply);

    // Cart protocol: [CART: { items[...], fields{...} }] mirrors booking.
    // Uses the brace-balanced parser from bot-engine because the cart
    // marker's JSON payload contains nested objects + arrays that the
    // booking regex's non-greedy match would truncate.
    const { parseCartMarker, stripCartMarker, formatMoney } = await import('../../lib/bot-engine.js');
    let cartMarkerPayload = parseCartMarker(rawReply);

    // Deterministic order-confirmation fallback (mirrors the extractBooking
    // safety net). The reply model — especially Claude Sonnet on the ultra
    // plan — intermittently SKIPS the load-bearing [CART:] marker, which
    // leaves the order stuck as a 'draft' that never reaches the orders page
    // even though the bot told the customer "order confirmed". When there's
    // no marker but a shop form exists and the customer's last message looks
    // like a confirmation, run the deterministic extractor; if it reports the
    // order complete (item chosen + required fields captured + just
    // confirmed), synthesize a marker so the existing promote-draft-to-'new'
    // logic below finalizes the order. The finalizer's own 30-min dedupe
    // prevents any double-creation.
    if (!cartMarkerPayload && result && ctx.data.shopForm) {
      const looksLikeConfirm =
        /\b(confirm|confirmed|yes|yep|yeah|correct|go ahead|place (?:the )?order|that'?s all|that is all|done|ok(?:ay)?|sure|proceed)\b/i.test(
          m.bodyText ?? '',
        ) || /تمام|اكد|أكد|أكّد|نعم|ايوه|أيوه|اوكي|اوك|أوكي|تأكيد|أكمل|اكمل|خلص|ماشي|زبط/.test(m.bodyText ?? '');
      // Don't finalize while the bot is STILL asking the customer to confirm
      // (it just showed the summary + "Shall I confirm?"). The customer's "yes"
      // on that turn answers an EARLIER question (e.g. payment), not the final
      // confirmation — finalizing now captures a premature, possibly partial
      // cart. Wait for the customer's reply to the "shall I confirm?" question.
      const botStillAsking =
        /\b(shall i confirm|should i (?:place|confirm)|confirm (?:this|your) order|ready to confirm|do you want me to (?:place|confirm)|place (?:the|this|your) order\?|to confirm(?: this| your)?(?: order)?\?)\b/i.test(
          rawReply ?? '',
        ) || /هل (?:أؤكد|تريد|تؤكد)|أؤكد (?:الطلب|لك)|تأكيد الطلب\؟/.test(rawReply ?? '');
      if (looksLikeConfirm && !botStillAsking) {
        try {
          const { extractCart } = await import('../../lib/bot-engine.js');
          const ex = await extractCart({
            organizationId: args.organizationId,
            shopForm: ctx.data.shopForm,
            catalog: ctx.data.products.map((p) => ({
              sku: p.sku,
              name: p.name,
              priceMinor: p.priceMinor,
            })),
            history: ctx.history.map((h) => ({
              role: h.direction === 'outbound' ? ('assistant' as const) : ('user' as const),
              content: h.body ?? '',
            })),
            latestUserMessage: m.bodyText!,
          });
          if (ex.complete && ex.items.length > 0) {
            cartMarkerPayload = {
              items: ex.items.map((it) => ({
                sku: it.sku,
                name: it.name,
                quantity: it.quantity,
                unitPriceMinor: it.unitPriceMinor,
                notes: it.notes,
              })),
              fields: ex.values,
            };
            args.log.info(
              { orgId: args.organizationId, threadId: ctx.threadId, items: ex.items.length },
              '[whatsapp] cart fallback: no [CART:] marker but extractor reports complete — finalizing order',
            );
          }
        } catch (err) {
          args.log.warn({ err }, '[whatsapp] cart fallback extractCart failed (non-fatal)');
        }
      }
    }

    // Clear-cart marker — the customer declined to resume their leftover cart
    // (or chose to start over), so discard the draft. The token is stripped
    // from the visible reply below. Only runs the DB write when present.
    if (/\[CLEAR_CART\]/i.test(rawReply) && ctx.data.shopForm) {
      await withRlsBypass((tx) =>
        tx.cart.updateMany({
          where: { organizationId: args.organizationId, threadId: ctx.threadId, status: 'draft' },
          data: { status: 'cancelled' },
        }),
      ).catch((err) => args.log.warn({ err }, '[whatsapp] clear-cart cancel failed (non-fatal)'));
    }

    let reply = stripCartMarker(
      rawReply
        .replace(imageMarkerRe, '')
        .replace(handoffMarkerRe, '')
        .replace(bookingMarkerRe, '')
        .replace(/\[BUTTONS:[^\]]*\]/gi, '')
        .replace(/\[CLEAR_CART\]/gi, ''),
    ).trim();

    // Quick-reply buttons (WhatsApp interactive, max 3). Parse the model's
    // [BUTTONS: A | B | C] marker; if it emitted none and the feature is on,
    // fall back to a context-aware default set. Gated by the bot-builder toggle
    // and skipped on handoff turns.
    const quickRepliesOn = ctx.data.config?.quickRepliesEnabled !== false;
    let botButtons: string[] = [];
    if (quickRepliesOn) {
      const fromMarker = (/\[BUTTONS:\s*([^\]]+)\]/i.exec(rawReply)?.[1] ?? '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      const modelChoseButtons = fromMarker.length > 0;
      if (modelChoseButtons) {
        botButtons = fromMarker.slice(0, 3);
      } else if (!wantsHandoff) {
        const hasCatalog = ctx.data.products.length > 0 || ctx.data.services.length > 0;
        const dq: string[] = [];
        if (ctx.data.shopForm) dq.push('Order now');
        else if (hasCatalog) dq.push('View products');
        if (ctx.data.bookingForm?.enabled) dq.push('Book a meeting');
        dq.push('Talk to a human');
        botButtons = dq.slice(0, 3);
      }
      // F11 (owner amendment 2026-08-30): the MODEL decides the buttons when
      // it emitted a marker (configured buttons reach it as a prompt palette);
      // configured always-on buttons only fill when the model offered nothing.
      // Either way the button the customer JUST tapped never re-renders on
      // this reply. Skipped on handoff turns — a "we're getting a human"
      // message shouldn't sprout sales buttons.
      if (!wantsHandoff) {
        const { parseCustomButtons, mergeQuickButtons } = await import('../../lib/quick-buttons.js');
        botButtons = mergeQuickButtons(
          botButtons,
          parseCustomButtons(ctx.data.config?.customButtons),
          { cap: 3, modelChose: modelChoseButtons, justPressed: m.bodyText },
        );
      }
    }
    // Resolve every emitted SKU against the catalog. Dedupe by product
    // id so multiple markers for the same SKU collapse to one send.
    const explicitImageRequest =
      /\b(image|images|picture|pictures|photo|photos|pic|pics|show me|send.*pic|send.*image|send.*photo)\b/i.test(
        m.bodyText ?? '',
      ) || /صورة|صور|ابعتلي.*صور|ورّيني/.test(m.bodyText ?? '');
    const resolvedImageProducts: (typeof ctx.data.products)[number][] = [];
    const seenProductIds = new Set<string>();
    for (const sku of imageSkus) {
      const product = ctx.data.products.find(
        (p) => p.sku.toLowerCase() === sku.toLowerCase(),
      );
      if (!product || seenProductIds.has(product.id)) continue;
      seenProductIds.add(product.id);
      resolvedImageProducts.push(product);
    }
    // Size/count variants of the same item are separate catalog rows whose
    // photos are visually identical — send ONE per sibling group, unless
    // the customer explicitly asked to see pictures.
    const imageProducts = explicitImageRequest
      ? resolvedImageProducts
      : collapseVariantSiblings(resolvedImageProducts);
    const imageSends: { sku: string; name: string; storageKey: string; productImageId?: string; kind?: 'product' | 'greeting' }[] = [];
    for (const product of imageProducts) {
      for (const im of product.images ?? []) {
        if (im.storageKey && im.storageKey.length > 0) {
          imageSends.push({
            sku: product.sku,
            name: product.name,
            storageKey: im.storageKey,
            productImageId: im.productImageId,
          });
        }
      }
    }
    // Dedup: the LLM dutifully re-emits [IMAGE: SKU] every time it
    // mentions a product, including on "what's your name?" / "address?"
    // / "payment method?" turns mid-cart-flow. Customers don't want
    // the same photo three times in a row. Skip any SKU we already
    // sent an image for in this thread within the last hour, UNLESS:
    //   - this reply contains the final [CART:] marker (re-show the
    //     gallery as part of the confirmation), or
    //   - the customer explicitly asked for an image / picture / photo
    //     / صورة in their latest message.
    let dedupedImageSends = imageSends;
    if (imageSends.length > 0 && !cartMarkerPayload && !explicitImageRequest) {
      const recentlySent = await withRlsBypass(async (tx) => {
        const rows = await tx.whatsAppMessage.findMany({
          where: {
            threadId: ctx.threadId,
            organizationId: args.organizationId,
            direction: 'outbound',
            messageType: 'image',
            receivedAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
          },
          select: { rawPayload: true },
          take: 50,
        });
        return new Set(
          rows
            .map((r) => (r.rawPayload as { sku?: string } | null)?.sku)
            .filter((s): s is string => typeof s === 'string'),
        );
      });
      const skipped: string[] = [];
      dedupedImageSends = imageSends.filter((s) => {
        if (recentlySent.has(s.sku)) {
          skipped.push(s.sku);
          return false;
        }
        return true;
      });
      if (skipped.length > 0) {
        args.log.info(
          {
            threadId: ctx.threadId,
            skippedSkus: Array.from(new Set(skipped)),
            kept: dedupedImageSends.length,
          },
          '[whatsapp] image dedup: suppressed already-sent SKUs',
        );
      }
    }
    // Image-spam guard: never fire more than N images in one reply. The model
    // sometimes emits an [IMAGE:] per size/variant (e.g. 5 juice sizes at once),
    // which floods the customer. Cap to the first few — enough to show options.
    const MAX_IMAGES_PER_REPLY = 3;
    if (dedupedImageSends.length > MAX_IMAGES_PER_REPLY) {
      args.log.info(
        { threadId: ctx.threadId, total: dedupedImageSends.length, cap: MAX_IMAGES_PER_REPLY },
        '[whatsapp] image cap: trimmed image sends',
      );
      dedupedImageSends = dedupedImageSends.slice(0, MAX_IMAGES_PER_REPLY);
    }
    // Greeting image: if the operator configured one and this reply
    // opens with a greeting word, prepend it to the send queue so the
    // welcome graphic lands alongside the bot's "Hi there!". Dedup per
    // thread for 24h so a customer who pings the bot four times in an
    // hour doesn't get the banner each time.
    const greetingImageKey =
      (ctx.data.config as { greetingImageStorageKey?: string | null } | null)
        ?.greetingImageStorageKey ?? null;
    // Greeting VOICE note: the LLM reply path doesn't send voice natively, so a
    // tenant that uploaded a greeting voice (e.g. fatme's pure-LLM intake) gets
    // it played on the opening reply — same trigger + 1h dedup as the image.
    const greetingVoiceKey =
      (ctx.data.config as { greetingVoiceStorageKey?: string | null } | null)
        ?.greetingVoiceStorageKey ?? null;
    // /u flag is REQUIRED — the emoji char class contains surrogate-pair
    // characters (👋 etc.) and without Unicode mode they don't match,
    // so "👋 Welcome to ..." silently fell through and the greeting
    // image never sent.
    // The Arabic greeting stems match ANY trailing Arabic letters/diacritics
    // (ء-ٟ) so LEVANTINE openers like "أهلين", "أهلاً", "مرحباً" match
    // — the old `أهل[اًاً]?` only matched "أهلا"/"أهل" and silently skipped the
    // greeting voice/image for tenants (e.g. fatme) that open with "أهلين".
    const GREETING_REPLY_RE =
      /^(\s*[👋🙏✨🌟😊]?\s*)?(hi|hello|hey|welcome|good\s+(morning|afternoon|evening)|greetings|(?:أهل|اهل|مرحب|سلام|هلا)[ء-ٟ]*|bonjour|salut|hola|buen(os|as)\s+(d[ií]as|tardes|noches))(?:[\s,!.:؛،]|$)/iu;
    // Voice-note triggers: the bot's reply opens with a greeting, the CUSTOMER
    // greeted, OR the CUSTOMER asked for the voice note. (The old logic only
    // fired when the BOT's reply happened to be greeting-shaped, so fatme's voice
    // frequently never sent.) An explicit request always sends; fatme sends on
    // every greeting/request (no 1h dedup) per the owner's request.
    const replyIsGreeting = !!(reply && GREETING_REPLY_RE.test(reply.trim()));
    const inboundGreetingText = (m.bodyText ?? '').trim();
    const VOICE_REQUEST_RE =
      /\bvoice\b|voice\s*note|\brecording\b|\baudio\b|فويس|تسجيل|الصوت|صوتي|صوتيه|رسالة صوتية|3awtiy|sawtiy|tasjil/i;
    const customerGreeted = inboundGreetingText.length > 0 && GREETING_REPLY_RE.test(inboundGreetingText);
    const customerAskedForVoice =
      !!greetingVoiceKey && inboundGreetingText.length > 0 && VOICE_REQUEST_RE.test(inboundGreetingText);
    const FATME_ORG_ID = '6b2d1c79-582b-4dd2-86db-ffdc8240d535';
    const voiceBypassDedup = customerAskedForVoice || args.organizationId === FATME_ORG_ID;
    if (
      (greetingImageKey && replyIsGreeting) ||
      (greetingVoiceKey && (replyIsGreeting || customerGreeted || customerAskedForVoice))
    ) {
      // The welcome banner/voice is for the START of a visit — not every time the
      // bot opens a mid-conversation reply with "Hey <name>". Suppress it when
      // the bot has already replied in this thread within the last hour (an
      // active/continuing session). A genuinely returning customer (dormant >
      // 1h, or a brand-new thread) still gets a fresh welcome. Previously this
      // was a 2-minute dedup, so a voice note 3 min after an order re-sent the
      // banner mid-conversation.
      const recentlyChatting = voiceBypassDedup
        ? false
        : await withRlsBypass(async (tx) => {
            const row = await tx.whatsAppMessage.findFirst({
              where: {
                threadId: ctx.threadId,
                organizationId: args.organizationId,
                direction: 'outbound',
                receivedAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
              },
              select: { id: true },
            });
            return !!row;
          });
      if (!recentlyChatting) {
        if (greetingImageKey && replyIsGreeting) {
          // Prepend so the greeting image sends before any product images
          // in the same reply.
          dedupedImageSends.unshift({
            sku: '__greeting__',
            name: '',
            storageKey: greetingImageKey,
            kind: 'greeting',
          });
          args.log.info({ threadId: ctx.threadId }, '[whatsapp] greeting image queued');
        }
        if (greetingVoiceKey && ctx.channel.phoneNumberId && ctx.channel.accessToken && m.from) {
          // Fire-and-forget audio send — must never block or break the text reply.
          // On success, persist an outbound message row (mediaAssetId → the voice
          // object) so the note SHOWS + PLAYS in the inbox, mirroring the bot's
          // TTS voice reply. Without this the customer hears it but the operator
          // sees nothing in the conversation.
          const voiceKey = greetingVoiceKey;
          const voiceTo = m.from;
          const { sendStoredVoiceNote } = await import('../../lib/wa-voice-note.js');
          void sendStoredVoiceNote({
            phoneNumberId: ctx.channel.phoneNumberId,
            accessToken: ctx.channel.accessToken,
            to: voiceTo,
            storageKey: voiceKey,
            log: args.log,
          })
            .then(async (res) => {
              args.log.info({ threadId: ctx.threadId, ok: res.ok }, '[whatsapp] greeting voice note send');
              if (!res.ok) return;
              try {
                await withRlsBypass(async (tx) => {
                  // find-or-create an Asset for the voice object (storageKey is @unique).
                  let asset = await tx.asset.findFirst({
                    where: { organizationId: args.organizationId, storageKey: voiceKey },
                    select: { id: true },
                  });
                  if (!asset) {
                    const ext = (voiceKey.split('.').pop() ?? 'ogg').toLowerCase();
                    const ct =
                      ext === 'mp3' ? 'audio/mpeg'
                      : ext === 'm4a' ? 'audio/mp4'
                      : ext === 'wav' ? 'audio/wav'
                      : ext === 'webm' ? 'audio/webm'
                      : 'audio/ogg';
                    asset = await tx.asset.create({
                      data: {
                        organizationId: args.organizationId,
                        kind: 'document', // AssetKind has no 'audio'; TTS replies use 'document' too
                        storageKey: voiceKey,
                        contentType: ct,
                        byteSize: 0,
                      },
                      select: { id: true },
                    });
                  }
                  await tx.whatsAppMessage.create({
                    data: {
                      threadId: ctx.threadId,
                      organizationId: args.organizationId,
                      direction: 'outbound',
                      metaMessageId: res.metaMessageId,
                      toNumber: voiceTo,
                      messageType: 'audio',
                      body: '🎙 رسالة صوتية',
                      mediaAssetId: asset.id,
                      rawPayload: { sentBy: 'bot', kind: 'greeting' } as never,
                    },
                  });
                  await tx.whatsAppThread.update({
                    where: { id: ctx.threadId },
                    data: { lastMessageAt: new Date(), outboundCount: { increment: 1 } },
                  });
                });
              } catch (err) {
                args.log.warn(
                  { err, threadId: ctx.threadId },
                  '[whatsapp] greeting voice persist failed (sent but not shown in inbox)',
                );
              }
            })
            .catch((err) =>
              args.log.warn({ err, threadId: ctx.threadId }, '[whatsapp] greeting voice note threw'),
            );
        }
      } else {
        args.log.info(
          { threadId: ctx.threadId },
          '[whatsapp] greeting image/voice suppressed (mid-conversation — bot replied within last hour)',
        );
      }
    }

    // Back-compat shims for code paths further down that referenced the
    // old single-image variables. They now point at the first send (or
    // null) — the loop further down does the multi-send.
    const imageProduct = dedupedImageSends.length > 0
      ? ctx.data.products.find((p) => p.sku === dedupedImageSends[0]!.sku) ?? null
      : null;
    const imageStorageKey = dedupedImageSends[0]?.storageKey ?? null;
    // If the LLM emitted ONLY markers (no visible text), fall back to a
    // short acknowledgement so the customer sees something — and so the
    // handoff / booking side effects still run.
    if (!reply) {
      if (wantsHandoff) {
        reply = "Sure — connecting you with a teammate now. They'll pick up here shortly.";
      } else if (cartMarkerPayload) {
        // Substitute the operator-configured confirmation message. It may
        // contain {{cart_id_short}} / {{total}} placeholders — interpolate
        // them from the draft cart that is about to be promoted (same row →
        // same id + total the customer sees in /cart and the operator sees
        // in the inbox). If we can't resolve a real cart (no draft yet) we
        // fall back to the placeholder-free default rather than ship raw
        // "{{…}}" tokens to the customer.
        const DEFAULT_CONFIRMATION = "Got it! Your order is in 🙏 We'll be in touch shortly.";
        const tmpl = ctx.data.shopForm?.confirmationMessage?.trim();
        const hasPlaceholder = !!tmpl && /\{\{\s*(?:cart_id_short|total)\s*\}\}/.test(tmpl);
        if (!tmpl) {
          reply = DEFAULT_CONFIRMATION;
        } else if (!hasPlaceholder) {
          reply = tmpl;
        } else {
          const shopForm = ctx.data.shopForm;
          const resolved = await withRlsBypass(async (tx) => {
            const draft = await tx.cart.findFirst({
              where: {
                organizationId: args.organizationId,
                threadId: ctx.threadId,
                status: 'draft',
              },
              include: { items: true },
            });
            if (!draft || draft.items.length === 0) return null;
            const subtotalMinor = draft.items.reduce(
              (s, it) => s + Number(it.unitPriceMinor) * it.quantity,
              0,
            );
            // Same delivery rule as the cart-promotion block below — keep the
            // quoted total identical to the persisted total.
            const baseDelivery = shopForm?.deliveryFeeMinor ?? 0;
            const deliveryMinor =
              shopForm?.freeDeliveryAboveMinor != null &&
              subtotalMinor >= shopForm.freeDeliveryAboveMinor
                ? 0
                : baseDelivery;
            const totalMinor = subtotalMinor + deliveryMinor;
            const currency = draft.currency ?? shopForm?.currency ?? 'USD';
            return {
              cartIdShort: draft.id.slice(0, 8),
              total: formatMoney(totalMinor, currency),
            };
          });
          if (!resolved) {
            reply = DEFAULT_CONFIRMATION;
          } else {
            reply = tmpl
              .replace(/\{\{\s*cart_id_short\s*\}\}/g, resolved.cartIdShort)
              .replace(/\{\{\s*total\s*\}\}/g, resolved.total)
              // Strip any leftover/unknown tokens so nothing leaks raw.
              .replace(/\{\{\s*[\w.]+\s*\}\}/g, '')
              .replace(/[ \t]{2,}/g, ' ')
              .trim();
          }
        }
      } else if (bookingMatch) {
        reply = 'All set — your request has been captured. A teammate will follow up shortly.';
      }
    }

    // Whenever a cart is being finalized THIS turn, guarantee the customer
    // sees the REAL order number + total. The reply is sent before the cart is
    // promoted below, but the draft's id == the promoted order's id, so we
    // resolve it from the draft here and append (the LLM routinely omits the
    // total or invents a number). No-op if the reply already shows the id.
    if (cartMarkerPayload && reply) {
      const orderInfo = await withRlsBypass(async (tx) => {
        const draft = await tx.cart.findFirst({
          where: {
            organizationId: args.organizationId,
            threadId: ctx.threadId,
            status: 'draft',
          },
          include: { items: true },
        });
        if (!draft || draft.items.length === 0) return null;
        const subtotalMinor = draft.items.reduce(
          (s, it) => s + Number(it.unitPriceMinor) * it.quantity,
          0,
        );
        const sf = ctx.data.shopForm;
        const baseDelivery = sf?.deliveryFeeMinor ?? 0;
        const deliveryMinor =
          sf?.freeDeliveryAboveMinor != null && subtotalMinor >= sf.freeDeliveryAboveMinor
            ? 0
            : baseDelivery;
        return {
          idShort: draft.id.slice(0, 8),
          total: formatMoney(subtotalMinor + deliveryMinor, draft.currency ?? sf?.currency ?? 'USD'),
        };
      });
      if (orderInfo && !reply.includes(orderInfo.idShort)) {
        reply = `${reply.trimEnd()}\n\nOrder #${orderInfo.idShort} · Total ${orderInfo.total}`;
      }
    }

    // FINAL OUTPUT GUARD — a raw internal token must NEVER reach a customer.
    // The [PAYMENT_LINK] resolver upstream only runs when a *draft* cart with
    // items exists, so a marker emitted after the order was already captured
    // (draft→new) would otherwise leak verbatim (seen in prod). Likewise strip
    // any unresolved {{…}} template tokens. Belt-and-suspenders, all paths.
    if (reply) {
      reply = reply
        .replace(/\[PAYMENT_LINK\]/gi, 'We will send you a secure payment link shortly.')
        .replace(/\{\{\s*[\w.]+\s*\}\}/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trimEnd();
    }

    if (!reply && dedupedImageSends.length === 0) {
      // Same reasoning as the post-LLM bail above: the customer is
      // staring at a "..." typing indicator that's about to evaporate
      // with no reply. Send a rephrase prompt unless the inbound was
      // noise. Logs the cause so we can tell "LLM gave us markers only"
      // from "validators stripped everything" when we audit later.
      args.log.warn(
        {
          orgId: args.organizationId,
          threadId: ctx.threadId,
          rawReplyLen: rawReply?.length ?? 0,
          inboundLen: m.bodyText?.length ?? 0,
        },
        '[whatsapp] bot reply: empty after markers+validators — applying empty-reply fallback',
      );
      if (isNoisyInbound(burst.userTurn)) continue;
      reply = emptyReplyFallback(burst.userTurn);
    }

    // Phase 6 — decide text vs voice. `voice` always sends TTS. `match_customer`
    // only sends TTS when the customer's last inbound was itself a voice
    // note (so they don't get audio replies after typing a text question).
    // `text` keeps existing behaviour. `customerSpokeAudio` already computed
    // above so we could feed it into the LLM's delivery-mode banner.
    //
    // Order confirmations always come back as text — the customer needs to
    // see the order summary in writing so they can scroll back, screenshot,
    // or forward it. Spoken-only confirmations are too easy to miss the
    // details of (item name, quantity, total). Applies in voice +
    // match_customer modes alike. Bookings get the same treatment.
    //
    // Triggers: explicit [CART:] / [BOOKING:] markers OR any reply that
    // contains an order-summary keyword (total / subtotal / إجمالي /
    // المجموع). The keyword check catches the "running cart" replies
    // the bot sends while collecting required fields (name, etc.) —
    // those still describe the order and need to be readable.
    const ORDER_SUMMARY_RE = /\b(?:total|subtotal|order total|grand total)\b|إجمالي|المجموع/i;
    const isOrderConfirmation =
      !!cartMarkerPayload || !!bookingMatch || ORDER_SUMMARY_RE.test(reply);
    const baseWantsVoice =
      ctx.replyMode === 'voice' ||
      (ctx.replyMode === 'match_customer' && customerSpokeAudio);
    const wantsVoice = baseWantsVoice && !isOrderConfirmation;
    // Voice-mode visibility: log the decision explicitly so we can tell
    // why a voice reply did/didn't happen without grep-spelunking. The
    // generic "config resolution" line above shows the inputs; this
    // line shows the resulting decision + (later in the voice block)
    // each fallback reason.
    args.log.info(
      {
        orgId: args.organizationId,
        threadId: ctx.threadId,
        replyMode: ctx.replyMode,
        customerSpokeAudio,
        inboundType: m.type,
        baseWantsVoice,
        isOrderConfirmation,
        wantsVoice,
        ttsProvider: ctx.ttsProvider,
        hasTtsVoice: !!ctx.ttsVoiceName,
      },
      wantsVoice
        ? '[whatsapp] wantsVoice=true — attempting TTS reply'
        : isOrderConfirmation
          ? '[whatsapp] wantsVoice=false — order/booking confirmation always sends text'
          : '[whatsapp] wantsVoice=false — sending text reply',
    );

    let metaMessageId: string | null = null;
    let sendOk = false;
    // Wasabi asset id for the bot's spoken (TTS) reply, so the inbox can play
    // back the actual voice the customer heard. Set after a successful voice send.
    let voiceAssetId: string | null = null;

    // When this turn CONFIRMS an order (the LLM emitted a [CART:] marker and a
    // shop form is configured), the platform sends ONE deterministic order
    // receipt (order # + items + total) after the cart is captured. Suppress
    // the LLM's own free-text "order confirmed" reply so the customer isn't
    // double-texted with two confirmation messages. The LLM text is still
    // persisted for the operator inbox; a fallback below re-sends it if no
    // receipt ends up going out.
    const suppressReplySend = !!(cartMarkerPayload && ctx.data.shopForm);

    // Phase 2 follow-up — kick off image sends in PARALLEL with the
    // voice/text path. Pre-this change, images sent serially AFTER the
    // voice send completed, adding 1-2s per image (even with media-cache
    // hits!) to total latency. Image sends are independent — only the
    // caption-suppression flag was stateful, and we pre-compute it now
    // so the loop body can run via Promise.all.
    const seenSkusForCaption = new Set<string>();
    const dedupedSendsWithCaption = dedupedImageSends.map((send) => {
      const isFirstOfGroup = !seenSkusForCaption.has(send.sku);
      seenSkusForCaption.add(send.sku);
      return {
        ...send,
        shouldCaption: send.kind !== 'greeting' && isFirstOfGroup && send.name.length > 0,
      };
    });

    let imagesParallelStats: { cacheHits: number; cacheMisses: number; durationMs: number } | null = null;
    const imagesPromise = dedupedSendsWithCaption.length === 0
      ? Promise.resolve()
      : (async () => {
          const t0 = Date.now();
          let cacheHits = 0;
          let cacheMisses = 0;
          const { getOrUploadMetaMediaId } = await import('../../lib/meta-media-cache.js');
          const { presignGetUrl, publicUrlFor } = await import('../../lib/storage.js');
          await Promise.all(
            dedupedSendsWithCaption.map(async (send) => {
              try {
                let mediaId: string | null = null;
                if (send.productImageId) {
                  mediaId = await getOrUploadMetaMediaId({
                    productImageId: send.productImageId,
                    storageKey: send.storageKey,
                    channel: {
                      id: channel.id,
                      phoneNumberId: channel.phoneNumberId,
                      accessToken: channel.accessToken,
                    },
                    log: args.log,
                  });
                  if (mediaId) cacheHits += 1;
                }
                if (!mediaId) {
                  cacheMisses += 1;
                  const fileUrl = publicUrlFor(send.storageKey) ?? (await presignGetUrl(send.storageKey));
                  const fr = await fetch(fileUrl, { signal: AbortSignal.timeout(15_000) });
                  if (!fr.ok) {
                    args.log.warn(
                      { status: fr.status, key: send.storageKey },
                      '[whatsapp] bot image fetch from Wasabi failed (parallel)',
                    );
                    return;
                  }
                  const fileBytes = Buffer.from(await fr.arrayBuffer());
                  const fd = new FormData();
                  fd.append('messaging_product', 'whatsapp');
                  fd.append(
                    'file',
                    new Blob([new Uint8Array(fileBytes)], { type: 'image/jpeg' }),
                    `${send.sku}.jpg`,
                  );
                  const mediaRes = await fetch(
                    `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId!)}/media`,
                    {
                      method: 'POST',
                      headers: { Authorization: `Bearer ${channel.accessToken!}` },
                      body: fd,
                      signal: AbortSignal.timeout(20_000),
                    },
                  );
                  const mediaJson = (await mediaRes.json().catch(() => ({}))) as { id?: string };
                  if (!mediaRes.ok || !mediaJson.id) {
                    args.log.warn(
                      { status: mediaRes.status, mediaJson },
                      '[whatsapp] bot image upload to Meta failed (parallel)',
                    );
                    return;
                  }
                  mediaId = mediaJson.id;
                }
                const imgPayload = {
                  messaging_product: 'whatsapp',
                  recipient_type: 'individual',
                  to: m.from,
                  type: 'image',
                  image: {
                    id: mediaId!,
                    ...(send.shouldCaption ? { caption: send.name.slice(0, 1024) } : {}),
                  },
                };
                const imgRes = await fetch(
                  `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId!)}/messages`,
                  {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${channel.accessToken!}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(imgPayload),
                    signal: AbortSignal.timeout(10_000),
                  },
                );
                if (!imgRes.ok) {
                  args.log.warn(
                    { status: imgRes.status, sku: send.sku },
                    '[whatsapp] bot image send failed (parallel)',
                  );
                  return;
                }
                const imgJson = (await imgRes.json().catch(() => ({}))) as {
                  messages?: { id?: string }[];
                };
                const isGreeting = send.kind === 'greeting';
                const previewName = isGreeting ? 'Welcome' : send.name;
                await withRlsBypass(async (tx) => {
                  await tx.whatsAppMessage.create({
                    data: {
                      threadId: ctx.threadId,
                      organizationId: args.organizationId,
                      direction: 'outbound',
                      metaMessageId: imgJson.messages?.[0]?.id ?? null,
                      toNumber: m.from,
                      messageType: 'image',
                      body: `[image] ${previewName}`,
                      // `storageKey` lets the inbox resolve a signed Wasabi
                      // URL to actually render this image inline (not just an
                      // "[image]" placeholder). `sentBy`/`kind`/`sku` drive the
                      // sender label + provenance attribution.
                      rawPayload: isGreeting
                        ? ({ sentBy: 'bot', kind: 'greeting', storageKey: send.storageKey } as never)
                        : ({ sentBy: 'bot', sku: send.sku, storageKey: send.storageKey } as never),
                    },
                  });
                  await tx.whatsAppThread.update({
                    where: { id: ctx.threadId },
                    data: {
                      lastMessageAt: new Date(),
                      lastMessagePreview: `[image] ${previewName}`.slice(0, 200),
                      outboundCount: { increment: 1 },
                    },
                  });
                });
              } catch (err) {
                args.log.warn(
                  { err, sku: send.sku },
                  '[whatsapp] bot image attach failed (parallel)',
                );
              }
            }),
          );
          imagesParallelStats = { cacheHits, cacheMisses, durationMs: Date.now() - t0 };
        })();

    if (wantsVoice && reply && !suppressReplySend) {
      const { transcodeToOggOpus } = await import('../../lib/audio-transcode.js');
      // Dispatch based on org's chosen provider. ElevenLabs uses voice
      // IDs (20-char strings); Google uses named voices. ttsVoiceName
      // carries the right format for whichever provider is selected.
      const provider = ctx.ttsProvider === 'elevenlabs' ? 'elevenlabs' : 'google';
      let isConfigured: () => boolean;
      let synthesizeSpeech: (a: {
        text: string;
        voiceName?: string;
        voiceId?: string | null;
      }) => Promise<
        | { ok: true; bytes: Buffer; mime: 'audio/ogg' }
        | { ok: false; error: string; status?: number }
      >;
      if (provider === 'elevenlabs') {
        const mod = await import('../../lib/tts-elevenlabs.js');
        isConfigured = mod.isElevenLabsConfigured;
        synthesizeSpeech = (a) =>
          mod.synthesizeSpeech({ text: a.text, voiceId: a.voiceId ?? null });
      } else {
        const mod = await import('../../lib/tts-google.js');
        isConfigured = mod.isGoogleTtsConfigured;
        synthesizeSpeech = (a) =>
          mod.synthesizeSpeech({
            text: a.text,
            voiceName:
              a.voiceName ||
              (/[؀-ۿ]/.test(a.text)
                ? env.GOOGLE_TTS_DEFAULT_VOICE_AR
                : env.GOOGLE_TTS_DEFAULT_VOICE_EN),
          });
      }
      if (!isConfigured()) {
        args.log.warn(
          { orgId: args.organizationId, provider },
          '[whatsapp] voice reply requested but TTS provider not configured — falling back to text',
        );
      } else {
        // Rewrite prices to spoken form in the matching language so
        // TTS doesn't say "0.150 kay-double-yoo-dee". Only mutates the
        // string handed to TTS — the original `reply` is still what
        // gets saved + sent in the text-fallback branch below.
        const { rewriteForTts } = await import('../../lib/text-for-tts.js');
        const spokenText = rewriteForTts(reply);
        // For Google, ttsVoiceName is a voice NAME; for ElevenLabs, a
        // voice ID. We pass it through unchanged to whichever provider
        // dispatches below — both accept null to mean "use env default".
        const tts = await synthesizeSpeech({
          text: spokenText,
          voiceName: ctx.ttsVoiceName ?? '',
          voiceId: ctx.ttsVoiceName ?? null,
        });
        stopwatch.lap('tts_synthesize', { provider });
        if (!tts.ok) {
          args.log.warn(
            {
              err: tts.error,
              status: tts.status,
              orgId: args.organizationId,
              provider,
              voice: ctx.ttsVoiceName ?? null,
            },
            '[whatsapp] TTS failed — falling back to text',
          );
        } else {
          // Even though Google gives us OGG/Opus 16 kHz already, run
          // ffmpeg to force mono + the exact bitrate Meta's voice-note
          // validator likes. ~30 ms operation; cheap insurance.
          const transcoded = await transcodeToOggOpus(tts.bytes);
          stopwatch.lap('ffmpeg_transcode');
          if (!transcoded.ok) {
            args.log.warn(
              { err: transcoded.error },
              '[whatsapp] TTS transcode failed — falling back to text',
            );
          } else {
            // Upload bytes to Meta /media → get media_id → send audio.
            try {
              const fd = new FormData();
              fd.append('messaging_product', 'whatsapp');
              fd.append(
                'file',
                new Blob([new Uint8Array(transcoded.bytes)], { type: 'audio/ogg' }),
                'reply.ogg',
              );
              const mediaRes = await fetch(
                `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId!)}/media`,
                {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${channel.accessToken!}` },
                  body: fd,
                  signal: AbortSignal.timeout(20_000),
                },
              );
              const mediaJson = (await mediaRes.json().catch(() => ({}))) as { id?: string };
              stopwatch.lap('meta_media_upload_audio');
              if (!mediaRes.ok || !mediaJson.id) {
                args.log.warn(
                  { status: mediaRes.status, body: mediaJson },
                  '[whatsapp] TTS media upload failed — falling back to text',
                );
              } else {
                const audioPayload = {
                  messaging_product: 'whatsapp',
                  recipient_type: 'individual',
                  to: m.from,
                  type: 'audio',
                  audio: { id: mediaJson.id },
                };
                const audioRes = await fetch(
                  `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId!)}/messages`,
                  {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${channel.accessToken!}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(audioPayload),
                    signal: AbortSignal.timeout(10_000),
                  },
                );
                const audioBody = await audioRes.text();
                stopwatch.lap('meta_messages_send', { type: 'audio' });
                if (!audioRes.ok) {
                  args.log.warn(
                    { status: audioRes.status, body: audioBody.slice(0, 200) },
                    '[whatsapp] TTS audio send failed — falling back to text',
                  );
                } else {
                  try {
                    const parsed = JSON.parse(audioBody) as { messages?: { id?: string }[] };
                    metaMessageId = parsed.messages?.[0]?.id ?? null;
                  } catch {
                    /* ignore */
                  }
                  sendOk = true;
                  // Store the spoken reply as MP3 so the operator can play it
                  // back in the inbox (best-effort; never blocks the reply).
                  try {
                    const { isStorageConfigured, buildStorageKey, putObject } = await import(
                      '../../lib/storage.js'
                    );
                    if (isStorageConfigured()) {
                      const mp3 = (await transcodeAudioToMp3(Buffer.from(tts.bytes))).bytes;
                      if (mp3) {
                        const aId = crypto.randomUUID();
                        const storageKey = buildStorageKey({
                          organizationId: args.organizationId,
                          kind: 'outbound-audio',
                          assetId: aId,
                          filename: 'reply.mp3',
                        });
                        await putObject({ storageKey, body: mp3, contentType: 'audio/mpeg' });
                        await withRlsBypass((tx) =>
                          tx.asset.create({
                            data: {
                              id: aId,
                              organizationId: args.organizationId,
                              kind: 'document',
                              storageKey,
                              contentType: 'audio/mpeg',
                              byteSize: mp3.length,
                            },
                          }),
                        );
                        voiceAssetId = aId;
                      }
                    }
                  } catch (e) {
                    args.log.warn({ e }, '[whatsapp] bot voice store failed');
                  }
                }
              }
            } catch (err) {
              args.log.warn({ err }, '[whatsapp] TTS send threw — falling back to text');
            }
          }
        }
      }
    }

    // Fallback / default: plain text reply (also runs when voice failed).
    // Skipped for order-confirmation turns — the deterministic receipt is the
    // single customer-facing confirmation (see suppressReplySend).
    if (!sendOk && !suppressReplySend) {
      try {
        // Interactive reply buttons when the bot offered choices; else plain text.
        const payload =
          botButtons.length > 0
            ? {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: m.from,
                type: 'interactive',
                interactive: {
                  type: 'button',
                  body: { text: (reply || 'Please choose:').slice(0, 1024) },
                  action: {
                    buttons: botButtons.slice(0, 3).map((t, i) => ({
                      type: 'reply',
                      reply: { id: `qr_${i}`, title: [...t].slice(0, 20).join('') },
                    })),
                  },
                },
              }
            : {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: m.from,
                type: 'text',
                text: { preview_url: false, body: reply || 'Here:' },
              };
        const res = await fetch(
          `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.phoneNumberId!)}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${channel.accessToken!}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          },
        );
        const text = await res.text();
        stopwatch.lap('meta_messages_send', { type: 'text' });
        if (!res.ok) {
          args.log.warn(
            { status: res.status, text: text.slice(0, 200) },
            '[whatsapp] bot send failed',
          );
          continue;
        }
        try {
          const parsed = JSON.parse(text) as { messages?: { id?: string }[] };
          metaMessageId = parsed.messages?.[0]?.id ?? null;
        } catch {
          /* ignore */
        }
      } catch (err) {
        args.log.warn({ err }, '[whatsapp] bot send threw');
        continue;
      }
    }

    // The legacy code below this point expects `metaMessageId` to be set
    // and continues with image-followup, audit, etc. We keep that flow.
    try {

      // Phase 2 follow-up — images already kicked off in parallel with
      // the voice/text path. Just collect the result here. By the time
      // we reach this point, the voice path has already awaited its
      // upload+send; concurrent images have typically finished too
      // (cache hits are ~50ms each). Net win: ~1.5-2 s off the typical
      // voice-with-image reply.
      if (dedupedSendsWithCaption.length > 0) {
        await imagesPromise;
        const stats = imagesParallelStats ?? { cacheHits: 0, cacheMisses: 0, durationMs: 0 };
        stopwatch.lap('image_attach', {
          count: dedupedSendsWithCaption.length,
          cacheHits: stats.cacheHits,
          cacheMisses: stats.cacheMisses,
          totalMsThisStation: stats.durationMs,
        });
      }
      // Persist outbound + bump thread.
      // wantsHandoff flips the thread to 'escalated' so the inbox can
      // surface it (colored row + sidebar badge). booking marker, if
      // valid, persists a Booking row that operators see on /bookings.
      let parsedBooking: Record<string, string> | null = null;
      if (bookingMatch) {
        try {
          const obj = JSON.parse(bookingMatch[1]!) as Record<string, unknown>;
          parsedBooking = {};
          for (const [k, v] of Object.entries(obj)) {
            parsedBooking[k] = v == null ? '' : String(v);
          }
        } catch (err) {
          args.log.warn({ err, raw: bookingMatch[1]?.slice(0, 300) }, '[whatsapp] booking marker JSON invalid');
          parsedBooking = null;
        }
      }

      // Dedupe: don't create a second booking for this thread if one
      // was captured in the last 30 minutes. Both the LLM marker and
      // the fallback extractor can fire for the same conversation;
      // without this guard a follow-up "thanks" would create a
      // duplicate row from the extractor.
      const recentBooking = await withRlsBypass(async (tx) =>
        tx.booking.findFirst({
          where: {
            organizationId: args.organizationId,
            threadId: ctx.threadId,
            createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
          },
          select: { id: true },
        }),
      );

      // Fallback: GPT-4o-mini sometimes finishes the booking conversation
      // without ever emitting the [BOOKING:{...}] marker. Run a tiny
      // JSON-mode extraction call to recover. Gate on cheap signals so
      // we don't fire it for unrelated messages.
      if (
        !parsedBooking &&
        !recentBooking &&
        ctx.data.bookingForm?.enabled &&
        ctx.data.bookingForm.fields.length > 0
      ) {
        const recentAssistant = ctx.history
          .filter((h) => h.direction === 'outbound')
          .slice(-3)
          .map((h) => (h.body ?? '').toLowerCase())
          .join(' ');
        const ASSISTANT_BOOKING_SIGNAL = /(book|schedul|appointment|consult|reserv|confirm|set up|will (?:be|finalize)|set you up)/i;
        const USER_AFFIRMATIVE = /^\s*(yes|yep|yeah|yup|sure|please|ok(ay)?|y|confirm(ed)?|do it|go ahead|sounds good|let'?s do it|book it|that works|perfect)[\s.!,?]*\s*$/i;
        const looksLikeBookingFlow =
          ASSISTANT_BOOKING_SIGNAL.test(recentAssistant) ||
          ASSISTANT_BOOKING_SIGNAL.test(reply.toLowerCase()) ||
          USER_AFFIRMATIVE.test(m.bodyText!);

        if (looksLikeBookingFlow) {
          const { extractBooking } = await import('../../lib/bot-engine.js');
          const ex = await extractBooking({
            organizationId: args.organizationId,
            bookingForm: ctx.data.bookingForm,
            history: ctx.history.map((h) => ({
              role: h.direction === 'outbound' ? ('assistant' as const) : ('user' as const),
              content: h.body ?? '',
            })),
            latestUserMessage: m.bodyText!,
          }).catch((err) => {
            args.log.warn({ err }, '[whatsapp] booking extractor failed');
            return null;
          });
          if (ex?.complete && ex.values) {
            // Make sure every REQUIRED field has a non-empty value before
            // we persist — otherwise an over-eager extractor could
            // create half-filled bookings.
            const missing = ctx.data.bookingForm.fields.filter(
              (f) => f.required && !(ex.values[f.key] && String(ex.values[f.key]).trim()),
            );
            if (missing.length === 0) {
              parsedBooking = {};
              for (const f of ctx.data.bookingForm.fields) {
                parsedBooking[f.key] = (ex.values[f.key] ?? '').toString();
              }
              args.log.info(
                { fieldCount: ctx.data.bookingForm.fields.length },
                '[whatsapp] booking captured via fallback extractor',
              );
            } else {
              args.log.info(
                { missing: missing.map((f) => f.key) },
                '[whatsapp] booking extractor flagged complete but required fields missing',
              );
            }
          }
        }
      }

      // Captured from inside the tx, used AFTER commit for fire-and-forget
      // provenance write. Writing provenance from inside the tx would race
      // the message-row FK (provenance.message_id → whatsapp_messages.id).
      let botMessageId: string | null = null;
      // When an order is captured we send a deterministic confirmation
      // (order ref + line items + total) AFTER the tx commits — the LLM's
      // own "order placed" reply can't include the server-generated order
      // number or a guaranteed total, so we append a clean receipt.
      let orderConfirmation: { body: string } | null = null;
      // Set inside the tx, acted on AFTER it commits: confirming a booking
      // calls Google, and a network round-trip must never happen while a
      // Postgres transaction is open. Mirrors orderConfirmation below.
      type BookingToConfirm = {
        id: string;
        appointmentAt: Date | null;
        customerName: string | null;
        fields: { key: string; label: string; type: string; value: unknown }[];
      };
      let bookingToConfirm: BookingToConfirm | null = null;
      await withRlsBypass(async (tx) => {
        const thread = await tx.whatsAppThread.findFirst({
          where: { organizationId: args.organizationId, customerPhone: m.from },
        });
        if (!thread) return;
        // If the reply was successfully delivered as a TTS voice note,
        // record the message as `audio` so the inbox renders the 🎙
        // Voice-note bubble (matches the inbound voice-note treatment)
        // instead of a plain text bubble. `body` still holds the
        // transcript for search + LLM history.
        const sentAsVoice = wantsVoice && sendOk;
        const botMessage = await tx.whatsAppMessage.create({
          data: {
            threadId: thread.id,
            organizationId: args.organizationId,
            direction: 'outbound',
            metaMessageId,
            toNumber: m.from,
            messageType: sentAsVoice ? 'audio' : 'text',
            body: reply,
            ...(sentAsVoice && voiceAssetId ? { mediaAssetId: voiceAssetId } : {}),
            // Stamp the offered reply buttons so the inbox renders them as
            // pills under the bot bubble (it reads rawPayload.quickReplies) —
            // otherwise the customer's "Button tapped" reply has no visible
            // question. Voice sends never carry buttons.
            rawPayload: {
              sentBy: 'bot',
              tts: sentAsVoice,
              ...(!sentAsVoice && botButtons.length > 0
                ? { quickReplies: botButtons.slice(0, 3).map((t) => [...t].slice(0, 20).join('')) }
                : {}),
            } as never,
          },
          select: { id: true },
        });
        botMessageId = botMessage.id;
        await tx.whatsAppThread.update({
          where: { id: thread.id },
          data: {
            lastMessageAt: new Date(),
            lastMessagePreview: sentAsVoice
              ? '🎙 Voice note'
              : reply.slice(0, 200),
            outboundCount: { increment: 1 },
            ...(wantsHandoff ? { status: 'escalated' as never } : {}),
          },
        });

        if (wantsHandoff) {
          await tx.whatsAppNote.create({
            data: {
              threadId: thread.id,
              organizationId: args.organizationId,
              authorUserId: null,
              body: '🤖 → 👤 Bot flagged this chat for human support (customer asked for an agent).',
            },
          });
        }

        if (parsedBooking && ctx.data.bookingForm && !recentBooking) {
          const fields = ctx.data.bookingForm.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            value: parsedBooking![f.key] ?? null,
          }));
          // When weekly availability is on, resolve the chosen slot label →
          // exact appointment instant (pure match, no extra query).
          let bkAppointmentAt: Date | null = null;
          if (bookingAvail?.enabled) {
            const { resolveSlotFromText } = await import('../../lib/booking-slots.js');
            const dateField = ctx.data.bookingForm?.fields.find((f) => f.type === 'date');
            const cands = dateField
              ? [parsedBooking![dateField.key]]
              : Object.values(parsedBooking!);
            for (const v of cands) {
              const s = resolveSlotFromText(v ?? '', bookingAvail, new Date());
              if (s) {
                bkAppointmentAt = s;
                break;
              }
            }
          }
          const booking = await tx.booking.create({
            data: {
              organizationId: args.organizationId,
              threadId: thread.id,
              customerPhone: m.from,
              customerName: thread.customerName ?? thread.customerWhatsappName ?? null,
              fields: fields as never,
              status: 'new',
              appointmentAt: bkAppointmentAt,
            },
          });
          await tx.whatsAppNote.create({
            data: {
              threadId: thread.id,
              organizationId: args.organizationId,
              authorUserId: null,
              body: `📅 Booking captured (id ${booking.id.slice(0, 8)}…). See /bookings.`,
            },
          });
          // Flag for operator review unless an explicit handoff already set it.
          if (!wantsHandoff) {
            await tx.whatsAppThread.update({
              where: { id: thread.id },
              data: { status: 'pending' as never },
            });
          }
          // Hand to the post-commit step: calendar event, Meet link, and the
          // confirmation the customer receives.
          bookingToConfirm = {
            id: booking.id,
            appointmentAt: bkAppointmentAt,
            customerName: thread.customerName ?? thread.customerWhatsappName ?? null,
            fields,
          };
          // Webhook for downstream automations.
          void (await import('../../lib/webhooks.js')).emitWebhookEvent({
            organizationId: args.organizationId,
            eventKind: 'booking_created',
            payload: { id: booking.id, customerPhone: m.from, fields },
          });
        }

        // Cart marker → PROMOTE the existing draft cart to status='new'.
        // We deliberately IGNORE cartMarkerPayload.items because the LLM
        // routinely drops items from the marker on long carts. The draft
        // cart that was being upserted in real time as the bot said
        // "added N× X" is the source of truth. We only read marker.fields
        // (the form answers — name / address / payment).
        if (cartMarkerPayload && ctx.data.shopForm) {
          // Dedupe: skip if a non-draft cart already exists for this
          // thread in the last 30 minutes (mirrors booking dedupe).
          const recentCart = await tx.cart.findFirst({
            where: {
              organizationId: args.organizationId,
              threadId: thread.id,
              status: { not: 'draft' },
              createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
            },
            select: { id: true },
          });
          // Find the draft + its items. If none exists, fall back to the
          // marker payload (covers edge case where parser missed every
          // add — better to capture something than nothing).
          const draft = await tx.cart.findFirst({
            where: {
              organizationId: args.organizationId,
              threadId: thread.id,
              status: 'draft',
            },
            include: { items: true },
          });
          // Build lineItems from the draft if present, else from marker.
          const productsBySku = new Map(
            ctx.data.products.map((p) => [p.sku.toLowerCase(), p]),
          );
          const lineItems: {
            productId: string | null;
            sku: string | null;
            name: string;
            quantity: number;
            unitPriceMinor: number;
            notes: string | null;
          }[] = [];
          // True when we couldn't promote a parsed draft and had to trust
          // the LLM's [CART:] marker instead. The marker is known to drop
          // items, so this is a strong signal the captured cart may be
          // wrong — we surface it to operators (note + warning ping)
          // rather than letting it look like a clean confirmation.
          let usedMarkerFallback = false;
          if (draft && draft.items.length > 0) {
            for (const it of draft.items) {
              lineItems.push({
                productId: it.productId,
                sku: it.sku,
                name: it.name,
                quantity: it.quantity,
                unitPriceMinor: Number(it.unitPriceMinor),
                notes: it.notes ?? null,
              });
            }
            args.log.info(
              {
                orgId: args.organizationId,
                threadId: thread.id,
                draftId: draft.id,
                draftItemCount: draft.items.length,
                markerItemCount: (cartMarkerPayload.items ?? []).length,
              },
              '[whatsapp] cart marker: promoting draft, ignoring marker items',
            );
          } else {
            usedMarkerFallback = true;
            for (const it of cartMarkerPayload.items ?? []) {
              const sku = (it.sku ?? '').toString().trim();
              const matched = sku ? productsBySku.get(sku.toLowerCase()) : null;
              const name = (it.name ?? matched?.name ?? '').toString().trim();
              if (!name) continue;
              const qty = Math.max(1, Math.floor(Number(it.quantity ?? 1)));
              const unitPriceMinor = Math.max(
                0,
                Math.floor(Number(it.unitPriceMinor ?? matched?.priceMinor ?? 0)),
              );
              lineItems.push({
                productId: matched?.id ?? null,
                sku: matched?.sku ?? (sku || null),
                name,
                quantity: qty,
                unitPriceMinor,
                notes:
                  typeof it.notes === 'string' && it.notes.trim()
                    ? it.notes.trim().slice(0, 500)
                    : null,
              });
            }
            args.log.warn(
              {
                orgId: args.organizationId,
                threadId: thread.id,
                markerItemCount: lineItems.length,
              },
              '[whatsapp] cart marker: no draft, falling back to marker items',
            );
          }

          // A fresh draft with items is a NEW order in progress — promote it
          // even if the thread had a recent order. Customers legitimately
          // re-order within 30 min, and the old `!recentCart` 30-min dedupe
          // silently dropped EVERY repeat order on a thread to a stuck draft
          // (the bot still said "confirmed", so it looked successful). In-place
          // promotion (draft → 'new', same id) cannot double-create, so the
          // recentCart dedupe only needs to guard the no-draft marker-fallback
          // path below (where a re-fired marker could otherwise dup an order).
          const hasFreshDraft = !!(draft && draft.items.length > 0);
          if ((hasFreshDraft || !recentCart) && lineItems.length > 0) {
            const subtotalMinor = lineItems.reduce(
              (s, it) => s + it.quantity * it.unitPriceMinor,
              0,
            );
            const shopForm = ctx.data.shopForm;
            const baseDelivery = shopForm.deliveryFeeMinor ?? 0;
            const deliveryMinor =
              shopForm.freeDeliveryAboveMinor != null &&
              subtotalMinor >= shopForm.freeDeliveryAboveMinor
                ? 0
                : baseDelivery;
            const totalMinor = subtotalMinor + deliveryMinor;
            const itemsCount = lineItems.reduce((s, it) => s + it.quantity, 0);
            // Frozen snapshot of shopForm.fields[] with the customer's answers.
            const fieldRows = shopForm.fields.map((f) => ({
              key: f.key,
              label: f.label,
              type: f.type,
              required: f.required,
              value: (cartMarkerPayload.fields ?? {})[f.key] ?? null,
            }));

            // If a draft exists for this thread, promote it in place
            // instead of creating a new row — keeps the same cart id
            // through draft → new and avoids leaking abandoned draft
            // rows when the customer eventually confirms.
            let cart: { id: string };
            if (draft) {
              cart = await tx.cart.update({
                where: { id: draft.id },
                data: {
                  status: 'new',
                  customerName:
                    thread.customerName ?? thread.customerWhatsappName ?? null,
                  fields: fieldRows as never,
                  subtotalMinor,
                  deliveryMinor,
                  totalMinor,
                  itemsCount,
                  currency: shopForm.currency,
                },
                select: { id: true },
              });
              // Sanity: make sure CartItem rows match lineItems exactly
              // (the draft.items list should already match, since both
              // come from the same parser, but defensively re-sync).
              const existingItems = await tx.cartItem.findMany({
                where: { cartId: draft.id },
                select: { id: true, sku: true },
              });
              const targetSkus = new Set(
                lineItems.map((i) => i.sku).filter((s): s is string => !!s),
              );
              const toDelete = existingItems
                .filter((i) => i.sku && !targetSkus.has(i.sku))
                .map((i) => i.id);
              if (toDelete.length > 0) {
                await tx.cartItem.deleteMany({ where: { id: { in: toDelete } } });
              }
            } else {
              cart = await tx.cart.create({
                data: {
                  organizationId: args.organizationId,
                  threadId: thread.id,
                  customerPhone: m.from,
                  customerName:
                    thread.customerName ?? thread.customerWhatsappName ?? null,
                  fields: fieldRows as never,
                  subtotalMinor,
                  deliveryMinor,
                  totalMinor,
                  itemsCount,
                  currency: shopForm.currency,
                  status: 'new',
                  items: {
                    createMany: {
                      data: lineItems.map((it) => ({
                        organizationId: args.organizationId,
                        productId: it.productId,
                        sku: it.sku,
                        name: it.name,
                        quantity: it.quantity,
                        unitPriceMinor: it.unitPriceMinor,
                        lineTotalMinor: it.quantity * it.unitPriceMinor,
                        notes: it.notes,
                      })),
                    },
                  },
                },
                select: { id: true },
              });
            }
            await tx.whatsAppNote.create({
              data: {
                threadId: thread.id,
                organizationId: args.organizationId,
                authorUserId: null,
                body: usedMarkerFallback
                  ? `⚠️ Cart captured FROM LLM MARKER, not a parsed draft (id ${cart.id.slice(0, 8)}…, ${itemsCount} item${itemsCount === 1 ? '' : 's'}, ${totalMinor} ${shopForm.currency} minor). The item parser matched nothing, so this cart may be missing items the customer agreed to — VERIFY against the chat before fulfilling. See /cart.`
                  : `🛒 Cart captured (id ${cart.id.slice(0, 8)}…, ${itemsCount} item${itemsCount === 1 ? '' : 's'}, ${totalMinor} ${shopForm.currency} minor). See /cart.`,
              },
            });
            // Push the thread to 'pending' for operator review unless
            // an explicit handoff already set escalated. A marker-fallback
            // capture ALWAYS needs review (the cart may be incomplete), so
            // it overrides any non-handoff state too.
            if (!wantsHandoff) {
              await tx.whatsAppThread.update({
                where: { id: thread.id },
                data: { status: 'pending' as never },
              });
            }
            void (await import('../../lib/webhooks.js')).emitWebhookEvent({
              organizationId: args.organizationId,
              eventKind: 'cart_created',
              payload: {
                id: cart.id,
                customerPhone: m.from,
                itemsCount,
                totalMinor,
                currency: shopForm.currency,
              },
            });
            // In-app ping — admins see the new cart in the notifications
            // bell + can click straight through to /cart.
            void (await import('../../lib/notifications.js')).createNotification({
              organizationId: args.organizationId,
              kind: 'cart_received',
              severity: usedMarkerFallback ? 'warning' : 'info',
              title: usedMarkerFallback
                ? `⚠️ Cart needs review · ${itemsCount} item${itemsCount === 1 ? '' : 's'} (parser missed)`
                : `New cart · ${itemsCount} item${itemsCount === 1 ? '' : 's'}`,
              body: `${thread.customerName ?? thread.customerWhatsappName ?? m.from} · ${totalMinor / (shopForm.currency === 'KWD' || shopForm.currency === 'BHD' || shopForm.currency === 'OMR' || shopForm.currency === 'JOD' ? 1000 : 100)} ${shopForm.currency}${usedMarkerFallback ? ' · captured from LLM marker — may be missing items' : ''}`,
              link: `/cart`,
              entityType: 'cart',
              entityId: cart.id,
              metadata: { capturedVia: usedMarkerFallback ? 'marker_fallback' : 'parsed_draft' },
            });
            // Build the customer-facing order receipt (sent after commit).
            // Mostly numbers + a short order ref so it reads cleanly in any
            // language; the line items echo what they ordered.
            const itemLines = lineItems
              .map((it) => `• ${it.name}${it.quantity > 1 ? ` ×${it.quantity}` : ''}`)
              .join('\n');
            orderConfirmation = {
              body:
                `✅ Order #${cart.id.slice(0, 8)}\n` +
                `${itemLines}\n` +
                `Total: ${formatMoney(totalMinor, shopForm.currency)}`,
            };
          }
        }
      });
      stopwatch.lap('persist');

      // Booking confirmed → calendar event → meeting link. Runs after the tx
      // so the Google call isn't holding a database transaction open, and
      // fails soft: if Google is unreachable the booking still stands and the
      // two-minute tick places the event later (its backfill query picks up
      // any booking with no event yet). Only the instant link is lost.
      // Cast: TypeScript can't see the assignment inside the transaction
      // callback, so it narrows the outer binding to null.
      const bk = bookingToConfirm as BookingToConfirm | null;
      if (bk) {
        try {
          const { confirmBooking } = await import('../../lib/booking-confirm.js');
          const loc = ctx.locations?.[0];
          const address = loc
            ? [loc.addressLine1, loc.city, loc.region].filter(Boolean).join(', ')
            : null;
          const confirmed = await confirmBooking({
            orgId: args.organizationId,
            bookingId: bk.id,
            customerName: bk.customerName,
            customerPhone: m.from,
            fields: bk.fields,
            appointmentAt: bk.appointmentAt,
            slotMinutes: bookingAvail?.slotMinutes ?? 60,
            timezone: ctx.data.biz?.timezone ?? 'UTC',
            businessName: ctx.data.biz?.legalName ?? null,
            address,
            customerText: m.bodyText ?? null,
          });
          if (confirmed?.message && ctx.channel.phoneNumberId && ctx.channel.accessToken) {
            const body = confirmed.message;
            const res = await fetch(
              `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId)}/messages`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${ctx.channel.accessToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  recipient_type: 'individual',
                  to: m.from,
                  type: 'text',
                  // preview_url on: a Meet link renders as a tappable card.
                  text: { preview_url: !!confirmed.meetLink, body },
                }),
                signal: AbortSignal.timeout(10_000),
              },
            );
            const txt = await res.text();
            let metaId: string | null = null;
            try {
              metaId = (JSON.parse(txt) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
            } catch {
              /* ignore */
            }
            await withRlsBypass(async (tx) => {
              await tx.whatsAppMessage.create({
                data: {
                  threadId: ctx.threadId,
                  organizationId: args.organizationId,
                  direction: 'outbound',
                  metaMessageId: metaId,
                  toNumber: m.from,
                  messageType: 'text',
                  body,
                  rawPayload: { sentBy: 'bot', reason: 'booking_confirmation' } as never,
                },
              });
            });
          }
        } catch (err) {
          args.log.warn({ err }, '[whatsapp] booking confirmation failed (non-fatal)');
        }
      }

      // Send the deterministic order receipt (order ref + items + total) once
      // the cart row is committed. Separate from the LLM reply on purpose:
      // the model already said "order placed" but can't know the order number
      // or guarantee the total. Persist it so it shows in the inbox too.
      if (orderConfirmation && ctx.channel.phoneNumberId && ctx.channel.accessToken) {
        const confBody = (orderConfirmation as { body: string }).body;
        try {
          const res = await fetch(
            `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId)}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${ctx.channel.accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: m.from,
                type: 'text',
                text: { preview_url: false, body: confBody },
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          const txt = await res.text();
          let confMetaId: string | null = null;
          try {
            confMetaId = (JSON.parse(txt) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
          } catch {
            /* ignore */
          }
          await withRlsBypass(async (tx) => {
            await tx.whatsAppMessage.create({
              data: {
                threadId: ctx.threadId,
                organizationId: args.organizationId,
                direction: 'outbound',
                metaMessageId: confMetaId,
                toNumber: m.from,
                messageType: 'text',
                body: confBody,
                rawPayload: { sentBy: 'bot', reason: 'order_confirmation' } as never,
              },
            });
          });
        } catch (err) {
          args.log.warn({ err }, '[whatsapp] order-confirmation send failed');
        }
      } else if (
        suppressReplySend &&
        reply &&
        ctx.channel.phoneNumberId &&
        ctx.channel.accessToken
      ) {
        // Safety net: we suppressed the LLM reply expecting a receipt, but none
        // was produced (e.g. the marker resolved to no items). Send the LLM's
        // text so the customer is never left without a reply.
        try {
          await fetch(
            `https://graph.facebook.com/v25.0/${encodeURIComponent(ctx.channel.phoneNumberId)}/messages`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${ctx.channel.accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: m.from,
                type: 'text',
                text: { preview_url: false, body: reply },
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
        } catch (err) {
          args.log.warn({ err }, '[whatsapp] suppressed-reply fallback send failed');
        }
      }

      // Phase 8 — provenance write, AFTER the tx commits so the bot
      // message row is visible to the FK check. Fire-and-forget: any
      // error logs at WARN and is swallowed by recordProvenance itself.
      // The scanner uses ctx.data (the in-memory KB we packed into the
      // prompt) to compute citations + hallucinations against the final
      // `reply` text the customer sees.
      // Only log when the gate FAILS — successful writes are the boring
      // happy path and would just flood the log. If we ever stop seeing
      // provenance rows in /hq/provenance for fresh replies,
      // these warns will tell us which side of the gate is collapsing.
      if (!(botMessageId && result?.inputs)) {
        args.log.warn(
          {
            gateBotMessageId: !!botMessageId,
            gateHasInputs: !!result?.inputs,
            gateHasCtx: !!ctx?.data,
          },
          '[whatsapp] provenance gate FAILED — no provenance row will be written',
        );
      }
      if (botMessageId && result?.inputs) {
        try {
          const { recordProvenance } = await import('../../lib/provenance.js');
          // Synchronous await so any throw lands in the surrounding catch
          // and writes the [whatsapp] bot send threw log line. The
          // additional latency is bounded (≈ 50 ms scanner + 2 DB writes).
          await recordProvenance({
          organizationId: args.organizationId,
          messageId: botMessageId,
          inputs: result.inputs,
          reply,
          kb: {
            products: ctx.data.products.map((p) => ({
              id: p.id,
              name: p.name,
              sku: p.sku,
              priceMinor: p.priceMinor,
              currency: p.currency,
            })),
            services: ctx.data.services.map((s) => ({
              id: s.id,
              name: s.name,
              basePriceMinor: s.basePriceMinor,
              currency: s.currency,
            })),
            faqs: ctx.data.faqs.map((f) => ({
              id: f.id,
              question: f.question,
              answer: f.answer,
            })),
            policies: ctx.data.policies.map((p) => ({
              kind: p.kind,
              title: p.title,
              content: p.content,
            })),
            biz: ctx.data.biz
              ? {
                  legalName: ctx.data.biz.legalName,
                  websiteUrl: ctx.data.biz.websiteUrl,
                  operatingHours: ctx.data.biz.operatingHours,
                  currency: ctx.data.biz.currency,
                  // Phase 8 / 1.5 — menuUrl is on shopForm, not biz, in
                  // BotData. Surface it under biz for the scanner since
                  // it lives on the BusinessInfo row in the schema.
                  menuUrl: ctx.data.shopForm?.menuUrl ?? null,
                }
              : null,
            config: ctx.data.config
              ? { greeting: ctx.data.config.greeting }
              : null,
            // Phase 8 / 1.6 — pass the customer's WhatsApp display name +
            // any operator-set thread nickname so the scanner can cite
            // them when the greet-by-name path injects them into the reply.
            customer: {
              whatsappName:
                (ctx as { customerName?: string | null }).customerName ?? null,
              // We don't currently surface the operator nickname distinct
              // from customerName; they get merged in gatherBotData.
              operatorNickname: null,
            },
          },
          // Phase 13 — per-station pipeline trace from the stopwatch
          // we've been lapping through the whole bot reply path.
          pipelineTimings: stopwatch.snapshot(),
          // WS2 grounding gate — record whether the gate flagged this reply
          // (blocked=true) and why, so the shadow-mode block rate is queryable
          // for tuning before enforce.
          blocked: groundingFlagged,
          blockReason: groundingReason,
          log: args.log,
        });
        } catch (err) {
          // Inner catch — provenance is never load-bearing. We log loudly
          // (both pino + console.error so it lands in /var/log even when
          // the pino sink is flushed slowly) and continue.
          args.log.warn({ err, botMessageId }, '[whatsapp] provenance recordProvenance threw');
          // eslint-disable-next-line no-console
          console.error('[whatsapp] provenance recordProvenance threw', err);
        }
      }
    } catch (err) {
      args.log.warn({ err }, '[whatsapp] bot send threw');
    }
  }
}
