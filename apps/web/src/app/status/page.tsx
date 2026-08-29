// Phase 3 §5.1.4 — public status page. Unauthenticated. Served at /status
// on whichever domain the portal is hosted under (and via Caddy on tenant
// CNAMEs too, but that's incidental).
//
// Reads from the public `GET /api/v1/status` endpoint. Server-rendered so
// it works without JS — important when something is on fire.

import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface StatusResponse {
  data: {
    status: 'operational' | 'degraded' | 'down' | 'unknown';
    updatedAt: string;
    uptime: { window24hPct: number | null; window7dPct: number | null };
    latency: { p95Ms24h: number | null };
    sampleCount: number;
    note?: string;
  };
}

const STATUS_LABELS: Record<StatusResponse['data']['status'], string> = {
  operational: 'All systems operational',
  degraded: 'Degraded performance',
  down: 'Major outage',
  unknown: 'Status unknown',
};

const STATUS_COLORS: Record<StatusResponse['data']['status'], string> = {
  operational: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-red-500',
  unknown: 'bg-zinc-400',
};

async function fetchStatus(): Promise<StatusResponse['data'] | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  try {
    // Prevent Next.js fetch caching — status data must be fresh.
    const res = await fetch(`${apiUrl}/api/v1/status`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as StatusResponse;
    return json.data;
  } catch {
    return null;
  }
}

export default async function StatusPage() {
  // Touch headers so Next treats this as a dynamic render even on misconfigured deploys.
  await headers();
  const data = await fetchStatus();

  const status = data?.status ?? 'unknown';
  const updatedAt = data?.updatedAt;

  return (
    <main className="min-h-screen bg-white px-6 py-12 font-sans text-zinc-900">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold">Hader status</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Live availability of the API and the portal. Updated every minute.
        </p>

        <div className="mt-6 flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-4">
          <span
            className={`inline-block size-3 rounded-full ${STATUS_COLORS[status]}`}
            aria-hidden
          />
          <span className="text-base font-medium">{STATUS_LABELS[status]}</span>
          {updatedAt ? (
            <span className="ml-auto text-xs text-zinc-500">
              checked {new Date(updatedAt).toLocaleString()}
            </span>
          ) : null}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile
            label="Uptime — last 24h"
            value={data?.uptime.window24hPct != null ? `${data.uptime.window24hPct}%` : '—'}
          />
          <Tile
            label="Uptime — last 7d"
            value={data?.uptime.window7dPct != null ? `${data.uptime.window7dPct}%` : '—'}
          />
          <Tile
            label="p95 latency (24h)"
            value={data?.latency.p95Ms24h != null ? `${data.latency.p95Ms24h} ms` : '—'}
          />
        </div>

        {data?.note ? <p className="mt-4 text-sm text-amber-700">{data.note}</p> : null}

        <p className="mt-10 text-xs text-zinc-400">
          Numbers are computed from a worker process that probes /health every 60 seconds.
          External validation (UptimeRobot, Pingdom) provides additional confirmation when
          configured.
        </p>
      </div>
    </main>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
