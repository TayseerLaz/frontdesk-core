// Google Cloud Text-to-Speech client (REST + API key).
//
// We hit the REST endpoint directly instead of the @google-cloud/text-to-speech
// SDK because:
//   - the SDK insists on Application Default Credentials (service-account
//     JSON), which the user's Workspace org blocks via "Secure by Default"
//   - an API key is the supported workaround for TTS and the REST flow is
//     trivial — a single POST returning base64-encoded audio
//
// Returns OGG/Opus audio. WhatsApp accepts that container directly for
// voice notes (16 kHz mono ideal); the existing audio-transcode helper
// downsamples + remixes to mono before media upload so the play bubble
// renders correctly.
import { env } from './env.js';
import { normalizeCurrencyForTts } from './tts-text-normalizer.js';

const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

export interface SynthesizeArgs {
  /** Plain text to speak. Max ~5000 chars per request (Google limit). */
  text: string;
  /** Voice name, e.g. "en-US-Neural2-J", "ar-XA-Wavenet-B". */
  voiceName: string;
  /** BCP-47 language code derived from the voice name's prefix. */
  languageCode?: string;
  /** 0.25–4.0; 1 = normal. */
  speakingRate?: number;
  /** -20.0 to 20.0; 0 = normal. */
  pitch?: number;
}

export type SynthesizeResult =
  | { ok: true; bytes: Buffer; mime: 'audio/ogg' }
  | { ok: false; error: string; status?: number };

/**
 * Derive language code from voice name. Google voice names follow
 * "<langCode>-<region>-<style>-<letter>" so the first two segments give us
 * the BCP-47 language tag.
 */
function langCodeForVoice(voiceName: string): string {
  const parts = voiceName.split('-');
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return 'en-US';
}

export function isGoogleTtsConfigured(): boolean {
  return Boolean(env.GOOGLE_TTS_API_KEY && env.GOOGLE_TTS_API_KEY.length > 10);
}

/**
 * Synthesize speech via Google Cloud TTS. Returns OGG/Opus bytes on success.
 * Never throws — all failures are returned as `{ ok: false, error }` so the
 * caller can fall back to a text reply cleanly.
 */
export async function synthesizeSpeech(args: SynthesizeArgs): Promise<SynthesizeResult> {
  if (!isGoogleTtsConfigured()) {
    return { ok: false, error: 'GOOGLE_TTS_API_KEY not configured' };
  }
  // Phase 12.1 — expand currency codes to full words so TTS reads
  // "0.150 KWD" → "zero point one five zero Kuwaiti dinar" instead of
  // its built-in colloquial conversion to "150 fils". Matches the
  // ElevenLabs path.
  const text = normalizeCurrencyForTts(args.text.trim());
  if (!text) return { ok: false, error: 'empty text' };
  if (text.length > 4900) {
    return { ok: false, error: `text too long (${text.length} chars; max 4900)` };
  }

  const body = {
    input: { text },
    voice: {
      name: args.voiceName,
      languageCode: args.languageCode ?? langCodeForVoice(args.voiceName),
    },
    audioConfig: {
      audioEncoding: 'OGG_OPUS',
      // Request 16 kHz directly so our ffmpeg transcode only needs to
      // remix to mono — no resample. Google supports this rate natively
      // for Opus output.
      sampleRateHertz: 16000,
      speakingRate: args.speakingRate ?? 1.0,
      pitch: args.pitch ?? 0,
    },
  };

  let res: Response;
  try {
    res = await fetch(`${TTS_ENDPOINT}?key=${encodeURIComponent(env.GOOGLE_TTS_API_KEY!)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // TTS responses are normally <1s; 10s cap so a stalled call doesn't
      // park the bot reply path.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'fetch failed',
    };
  }

  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, error: raw.slice(0, 500), status: res.status };
  }

  let parsed: { audioContent?: string };
  try {
    parsed = JSON.parse(raw) as { audioContent?: string };
  } catch {
    return { ok: false, error: 'unparseable response', status: res.status };
  }
  if (!parsed.audioContent) {
    return { ok: false, error: 'no audioContent in response', status: res.status };
  }

  const bytes = Buffer.from(parsed.audioContent, 'base64');
  if (bytes.length === 0) {
    return { ok: false, error: 'empty audio buffer', status: res.status };
  }
  return { ok: true, bytes, mime: 'audio/ogg' };
}
