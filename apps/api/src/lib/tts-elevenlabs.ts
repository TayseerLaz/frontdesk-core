// ElevenLabs Text-to-Speech client (REST + API key).
//
// Wire-compatible with tts-google.ts so the bot reply pipeline can swap
// providers based on BotConfig.ttsProvider without branching its own
// transcode + Meta-upload code. Returns OGG/Opus bytes (16 kHz mono),
// which the existing audio-transcode helper passes through to WhatsApp.
import { env } from './env.js';
import { normalizeCurrencyForTts } from './tts-text-normalizer.js';

const TTS_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

export interface SynthesizeArgs {
  /** Plain text to speak. Max 5000 chars per request (ElevenLabs limit). */
  text: string;
  /** ElevenLabs voice ID (20-char string) or `null` to use the env default. */
  voiceId?: string | null;
  /** Model override; defaults to env ELEVENLABS_MODEL (eleven_multilingual_v2). */
  modelId?: string;
}

export type SynthesizeResult =
  | { ok: true; bytes: Buffer; mime: 'audio/ogg' }
  | { ok: false; error: string; status?: number };

export function isElevenLabsConfigured(): boolean {
  return Boolean(
    env.ELEVENLABS_API_KEY &&
      env.ELEVENLABS_API_KEY.length > 10 &&
      env.ELEVENLABS_VOICE_ID &&
      env.ELEVENLABS_VOICE_ID.length > 0,
  );
}

export async function synthesizeSpeech(args: SynthesizeArgs): Promise<SynthesizeResult> {
  if (!env.ELEVENLABS_API_KEY) {
    return { ok: false, error: 'ELEVENLABS_API_KEY not configured' };
  }
  const voiceId = (args.voiceId ?? env.ELEVENLABS_VOICE_ID ?? '').trim();
  if (!voiceId) {
    return { ok: false, error: 'ELEVENLABS_VOICE_ID not configured and no per-tenant override' };
  }
  // Phase 12.1 — expand currency codes to full words BEFORE TTS so the
  // engine reads "0.150 KWD" → "zero point one five zero Kuwaiti dinar"
  // instead of colloquially-converting to "150 fils". Combined with
  // apply_text_normalization='off' below this gives us deterministic
  // control over what the customer hears.
  const text = normalizeCurrencyForTts(args.text.trim());
  if (!text) return { ok: false, error: 'empty text' };
  if (text.length > 4900) {
    return { ok: false, error: `text too long (${text.length} chars; max 4900)` };
  }

  const body = {
    text,
    model_id: args.modelId ?? env.ELEVENLABS_MODEL,
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      use_speaker_boost: true,
    },
    // Disable ElevenLabs' built-in "smart" number/currency normalization.
    // We already pre-expanded currency codes above; without this flag
    // the engine would still convert "0.150 Kuwaiti dinar" → "150 fils"
    // on its own initiative.
    apply_text_normalization: 'off',
  };

  // output_format=opus_48000_64 keeps the payload small (~6 KB/sec) and
  // gives us native Opus we can drop into the existing OGG-Opus pipeline
  // after a quick ffmpeg remux/resample to 16 kHz mono in
  // audio-transcode.ts.
  const url = `${TTS_ENDPOINT}/${encodeURIComponent(voiceId)}?output_format=opus_48000_64`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/ogg',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'fetch failed',
    };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, error: errText.slice(0, 500), status: res.status };
  }

  const ab = await res.arrayBuffer();
  const bytes = Buffer.from(ab);
  if (bytes.length === 0) {
    return { ok: false, error: 'empty audio buffer', status: res.status };
  }
  return { ok: true, bytes, mime: 'audio/ogg' };
}
