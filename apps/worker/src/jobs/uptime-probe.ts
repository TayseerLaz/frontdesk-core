// Self-hosted uptime probe. Runs every 60 s on the worker process,
// hits http://api:4000/health (in-VM, but separate process), records the
// result in a Redis ZSET. Surfaced in the admin panel as a 24-hour /
// 7-day uptime chart.
//
// IMPORTANT: this is *process* uptime, not *site* uptime. If the whole
// VM is down, both api and worker are down and nothing gets recorded.
// External monitoring (UptimeRobot etc.) is still strictly better. This
// closes the gap when the VM is up but the API process has crashed,
// which is the case our admin dashboard cares about most.
import { request as undiciRequest } from 'undici';

import { getConnection } from '../lib/redis.js';

const KEY = 'uptime:api';
const PROBE_INTERVAL_MS = 60_000;
const RETENTION_SECONDS = 7 * 24 * 60 * 60; // 7 days

let probeTimer: NodeJS.Timeout | null = null;

export function startUptimeProbe(): void {
  // Best-effort. Test once on boot, then periodic.
  probeOnce().catch(() => undefined);
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = setInterval(() => {
    probeOnce().catch(() => undefined);
  }, PROBE_INTERVAL_MS);
}

export function stopUptimeProbe(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

async function probeOnce(): Promise<void> {
  const target = process.env.UPTIME_PROBE_URL ?? 'http://127.0.0.1:4000/health';
  const t0 = Date.now();
  let status = 0;
  let ok = false;
  try {
    const res = await undiciRequest(target, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    status = res.statusCode;
    ok = status >= 200 && status < 400;
    // drain body to free the connection
    await res.body.text();
  } catch {
    /* network error — ok stays false */
  }
  const latency = Date.now() - t0;

  const conn = getConnection();
  const member = `${t0}:${ok ? 1 : 0}:${status}:${latency}`;
  try {
    await conn.zadd(KEY, t0, member);
    // Trim to last 7 days.
    const cutoff = t0 - RETENTION_SECONDS * 1000;
    await conn.zremrangebyscore(KEY, 0, cutoff);
  } catch {
    /* noop — Redis hiccup; probe data is best-effort */
  }
}
