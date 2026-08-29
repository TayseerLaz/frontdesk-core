// Transcodes browser-recorded audio (audio/mp4, audio/webm, etc.) to
// audio/ogg with the Opus codec so Meta accepts it as a real WhatsApp
// voice note (play-in-place bubble with waveform). Without this Meta
// 200-OKs both /media and /messages but then drops the message with
// error 131053 because its delivery validator opens the file and
// rejects the container.
//
// Prefers the system ffmpeg (apk-installed in the runtime Dockerfile)
// because the bundled ffmpeg-static glibc binary fails silently on
// alpine's musl libc — bot voice replies fell back to text in prod.
// Falls back to ffmpeg-static when system ffmpeg isn't on PATH so
// local-dev macs without `brew install ffmpeg` still work.
import { spawn } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';

export type TranscodeResult =
  | { ok: true; bytes: Buffer; mime: 'audio/ogg' }
  | { ok: false; error: string };

const FFMPEG_ARGS = [
  '-loglevel', 'error',
  '-i', 'pipe:0',
  '-vn',
  '-c:a', 'libopus',
  '-b:a', '24k',
  '-ac', '1',
  '-ar', '16000',
  '-f', 'ogg',
  'pipe:1',
];

function runFfmpeg(binary: string, input: Buffer): Promise<TranscodeResult & { missing?: true }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: TranscodeResult & { missing?: true }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let proc;
    try {
      proc = spawn(binary, FFMPEG_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return settle({
        ok: false,
        error: err instanceof Error ? err.message : 'spawn failed',
        ...(code === 'ENOENT' ? { missing: true } : {}),
      });
    }

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => outChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));

    proc.on('error', (err: NodeJS.ErrnoException) =>
      settle({
        ok: false,
        error: err.message,
        ...(err.code === 'ENOENT' ? { missing: true } : {}),
      }),
    );
    proc.on('close', (exitCode) => {
      if (exitCode === 0 && outChunks.length > 0) {
        settle({ ok: true, bytes: Buffer.concat(outChunks), mime: 'audio/ogg' });
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 500);
        settle({ ok: false, error: `ffmpeg exited ${exitCode}: ${stderr || '(no stderr)'}` });
      }
    });

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      settle({ ok: false, error: 'ffmpeg timeout (15s)' });
    }, 15_000);
    proc.on('close', () => clearTimeout(killTimer));

    proc.stdin.on('error', (err) =>
      settle({ ok: false, error: err instanceof Error ? err.message : 'stdin error' }),
    );
    proc.stdin.end(input);
  });
}

export async function transcodeToOggOpus(input: Buffer): Promise<TranscodeResult> {
  const primary = process.env.FFMPEG_PATH || 'ffmpeg';
  const first = await runFfmpeg(primary, input);
  if (first.ok) return { ok: true, bytes: first.bytes, mime: first.mime };

  // System ffmpeg missing (typically macOS dev without `brew install
  // ffmpeg`). Last-ditch fallback to the npm-bundled static binary.
  if (first.missing && ffmpegPath && ffmpegPath !== primary) {
    const second = await runFfmpeg(ffmpegPath as string, input);
    return second.ok
      ? { ok: true, bytes: second.bytes, mime: second.mime }
      : { ok: false, error: second.error };
  }
  return { ok: false, error: first.error };
}
