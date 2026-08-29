// Voice-call reaper (S6).
//
// The voicebot posts a /voice/calls/:uuid/end event when a call finishes, but
// that fire-and-forget POST can be lost (OpenAI WS died mid-call, the bridge
// crashed, a network blip on the last hop). A lost end event leaves the
// VoiceCall row stuck at outcome='in_progress' with endedAt=null forever, so it
// shows as "live" in the dashboard and the /voice-calls list indefinitely.
//
// This hourly sweep flips any call still in_progress well past any real call
// length (default 24h) to 'dropped' so hung calls don't linger. updateMany is
// idempotent across worker replicas (no lock needed) — exactly like the
// draft-cart sweeper.

import { prisma } from '@platform/db';

const STUCK_HOURS = Number(process.env.VOICE_CALL_REAP_HOURS ?? 24);
const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly

let stopped = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function tick(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_HOURS * 60 * 60 * 1000);
  const result = await prisma.voiceCall.updateMany({
    where: { outcome: 'in_progress', endedAt: null, startedAt: { lt: cutoff } },
    data: {
      outcome: 'dropped',
      handoffReason: 'no end event received (auto-reaped)',
      endedAt: new Date(),
    },
  });
  if (result.count > 0) {
    console.log(
      `[voice-call-reaper] marked ${result.count} stuck call(s) dropped (in_progress > ${STUCK_HOURS}h)`,
    );
  }
}

export function startVoiceCallReaperTick(): { name: string; close: () => Promise<void> } {
  const run = async () => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      console.error('[voice-call-reaper] tick error', err);
    }
    if (!stopped) timer = setTimeout(run, TICK_INTERVAL_MS);
  };
  // Initial run 5 minutes after boot — gives other workers room to settle.
  timer = setTimeout(run, 5 * 60 * 1000);
  return {
    name: 'voice-call-reaper',
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
