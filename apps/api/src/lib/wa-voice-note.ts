// Send a voice note that lives in object storage as a WhatsApp audio message.
//
// Streams the object from Wasabi → uploads to Meta /media → sends type:'audio'.
// Used by the bot reply path to play a tenant's greeting voice note on the
// opening reply (the LLM reply path doesn't send voice natively). Fully
// self-contained + fail-soft: returns {ok:false} (logged) on any problem, never
// throws, so a voice-send failure can't break the text reply. On success it
// returns the Meta message id so the caller can persist an inbox message row.
import type { Readable } from 'node:stream';

const GRAPH = 'https://graph.facebook.com/v25.0';

type Logger = {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
};

export interface SendVoiceResult {
  ok: boolean;
  metaMessageId: string | null;
}

const FAIL: SendVoiceResult = { ok: false, metaMessageId: null };

function mimeForExt(ext: string): string {
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'webm':
      return 'audio/webm';
    case 'aac':
      return 'audio/aac';
    case 'wav':
      return 'audio/wav';
    case 'amr':
      return 'audio/amr';
    default:
      return 'audio/ogg';
  }
}

export async function sendStoredVoiceNote(args: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  storageKey: string;
  log: Logger;
}): Promise<SendVoiceResult> {
  const { getObjectStream, isStorageConfigured } = await import('./storage.js');
  if (!isStorageConfigured()) {
    args.log.warn({ storageKey: args.storageKey }, '[wa-voice] storage not configured — voice skipped');
    return FAIL;
  }

  // 1) Pull the bytes from storage.
  let buf: Buffer;
  try {
    const stream = (await getObjectStream(args.storageKey)) as Readable;
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    buf = Buffer.concat(chunks);
  } catch (err) {
    args.log.warn({ err, storageKey: args.storageKey }, '[wa-voice] fetch from storage failed');
    return FAIL;
  }

  const ext = (args.storageKey.split('.').pop() ?? '').toLowerCase();
  const mime = mimeForExt(ext);

  // 2) Upload to Meta /media → media_id.
  let mediaId: string | undefined;
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), `voice.${ext || 'ogg'}`);
    const up = await fetch(`${GRAPH}/${encodeURIComponent(args.phoneNumberId)}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const body = await up.text();
    if (!up.ok) {
      args.log.warn({ status: up.status, body: body.slice(0, 300), mime, ext }, '[wa-voice] media upload failed');
      return FAIL;
    }
    mediaId = (JSON.parse(body) as { id?: string }).id;
  } catch (err) {
    args.log.warn({ err }, '[wa-voice] media upload threw');
    return FAIL;
  }
  if (!mediaId) {
    args.log.warn('[wa-voice] media upload returned no id');
    return FAIL;
  }

  // 3) Send the audio message.
  try {
    const sent = await fetch(`${GRAPH}/${encodeURIComponent(args.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: args.to,
        type: 'audio',
        audio: { id: mediaId },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const sentBody = await sent.text();
    if (!sent.ok) {
      args.log.warn({ status: sent.status, body: sentBody.slice(0, 300) }, '[wa-voice] audio send failed');
      return FAIL;
    }
    const metaMessageId =
      (JSON.parse(sentBody) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
    return { ok: true, metaMessageId };
  } catch (err) {
    args.log.warn({ err }, '[wa-voice] audio send threw');
    return FAIL;
  }
}
