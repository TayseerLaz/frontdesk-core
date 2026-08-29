// Phase 3 §5.1.4 — public-facing status page data. Unauthenticated read of
// the same self-probe ZSET the admin /hq/self-uptime endpoint
// consumes, but stripped down to the bits we're willing to publish: a
// rolled-up status string + 24h / 7d uptime + p95 latency. No tenant data,
// no queue depth, no internal counts.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { getRedis } from '../../lib/redis.js';

interface Sample {
  ts: number;
  ok: boolean;
  latency: number;
}

function readSamples(raw: string[]): Sample[] {
  return raw
    .map((m) => {
      const [tsStr, okStr, , latencyStr] = m.split(':');
      return {
        ts: Number(tsStr),
        ok: okStr === '1',
        latency: Number(latencyStr),
      };
    })
    .filter((s) => Number.isFinite(s.ts));
}

function uptimePct(samples: Sample[], since: number): number | null {
  const slice = samples.filter((s) => s.ts >= since);
  if (slice.length === 0) return null;
  const ok = slice.filter((s) => s.ok).length;
  return Number(((ok / slice.length) * 100).toFixed(3));
}

function p95(samples: Sample[], since: number): number | null {
  const slice = samples.filter((s) => s.ts >= since && Number.isFinite(s.latency));
  if (slice.length === 0) return null;
  const sorted = [...slice].sort((a, b) => a.latency - b.latency);
  return sorted[Math.floor(sorted.length * 0.95)]?.latency ?? null;
}

export default async function statusRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/status',
    {
      schema: {
        tags: ['status'],
        summary: 'Public service status — uptime + latency rolled up from the worker self-probe.',
      },
      // Public. Don't add an auth preHandler. Lighter rate-limit than the
      // global so a flood of refreshes from a status page doesn't cause
      // 429s; the data is cheap to compute.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async () => {
      const redis = getRedis();
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const cutoff7d = now - 7 * day;
      const cutoff24h = now - day;

      let raw: string[] = [];
      try {
        raw = await redis.zrangebyscore('uptime:api', cutoff7d, now);
      } catch {
        // Redis unavailable — best to surface unknown rather than fake "operational".
        return {
          data: {
            status: 'unknown' as const,
            updatedAt: new Date().toISOString(),
            uptime: { window24hPct: null, window7dPct: null },
            latency: { p95Ms24h: null },
            sampleCount: 0,
            note: 'Probe data unavailable.',
          },
        };
      }

      const samples = readSamples(raw);
      const recent = samples.filter((s) => s.ts >= now - 5 * 60 * 1000);
      const recentOkRate =
        recent.length > 0 ? recent.filter((s) => s.ok).length / recent.length : null;

      // Status is rolled up from the most recent 5 min of probes:
      //   operational: 100% ok last 5 min
      //   degraded:    >=80% ok
      //   down:        <80% ok
      //   unknown:     no probe data yet
      const status =
        recentOkRate === null
          ? ('unknown' as const)
          : recentOkRate >= 1
            ? ('operational' as const)
            : recentOkRate >= 0.8
              ? ('degraded' as const)
              : ('down' as const);

      return {
        data: {
          status,
          updatedAt: new Date().toISOString(),
          uptime: {
            window24hPct: uptimePct(samples, cutoff24h),
            window7dPct: uptimePct(samples, cutoff7d),
          },
          latency: { p95Ms24h: p95(samples, cutoff24h) },
          sampleCount: samples.length,
        },
      };
    },
  );
}
