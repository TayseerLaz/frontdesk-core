'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  Building2,
  CheckCircle2,
  Database,
  Inbox,
  Rocket,
  Trash2,
  Users,
  Webhook,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface SystemHealth {
  orgs: { active: number; suspended: number; deleted: number };
  users: { total: number; pending: number; disabled: number };
  queues: {
    import: { waiting: number; active: number; failed: number };
    sync: { waiting: number; active: number; failed: number };
    webhook: { waiting: number; active: number; failed: number };
  };
  redis: { connected: boolean; opsPerSec: number | null };
}

interface UptimeSnapshot {
  configured: boolean;
  monitors: {
    id: number;
    name: string;
    url: string;
    status: 'up' | 'seems_down' | 'down' | 'paused' | 'unknown' | string;
    uptimeRatio: number | null;
  }[];
}

interface TrafficSnapshot {
  totalRequests: number;
  byStatusClass: {
    '2xx': number;
    '3xx': number;
    '4xx': number;
    '5xx': number;
    other: number;
  };
  errorRate: number;
  uptimeSeconds: number;
  processStartTime: string | null;
  topRoutes: { route: string; method: string; count: number }[];
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'default' | 'good' | 'warn';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : 'text-foreground';
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
              {label}
            </p>
            <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
            {sub ? (
              <p className="mt-0.5 text-xs text-foreground-muted">{sub}</p>
            ) : null}
          </div>
          <Icon className="size-5 text-foreground-subtle" />
        </div>
      </CardContent>
    </Card>
  );
}

function QueueRow({
  name,
  icon: Icon,
  w,
  a,
  f,
}: {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  w: number;
  a: number;
  f: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-foreground-subtle" />
        <span className="text-sm font-medium">{name}</span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span>
          <span className="text-foreground-subtle">Waiting</span>{' '}
          <span className="font-mono">{w}</span>
        </span>
        <span>
          <span className="text-foreground-subtle">Active</span>{' '}
          <span className="font-mono">{a}</span>
        </span>
        <span>
          <span className="text-foreground-subtle">Failed</span>{' '}
          <span className={`font-mono ${f > 0 ? 'text-red-600' : ''}`}>{f}</span>
        </span>
      </div>
    </div>
  );
}

export default function PlatformAdminSystemPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const system = useQuery({
    queryKey: ['admin-system'],
    queryFn: () => api.get<{ data: SystemHealth }>('/api/v1/hq/system'),
    refetchInterval: 10_000,
  });

  const traffic = useQuery({
    queryKey: ['admin-traffic'],
    queryFn: () => api.get<{ data: TrafficSnapshot }>('/api/v1/hq/traffic'),
    refetchInterval: 15_000,
  });

  const uptime = useQuery({
    queryKey: ['admin-uptime'],
    queryFn: () => api.get<{ data: UptimeSnapshot }>('/api/v1/hq/uptime'),
    refetchInterval: 60_000,
  });

  const selfUptime = useQuery({
    queryKey: ['admin-self-uptime'],
    queryFn: () =>
      api.get<{
        data: {
          configured: boolean;
          window7dPct: number | null;
          window24hPct: number | null;
          p95Latency24h: number | null;
          totalSamples: number;
        };
      }>('/api/v1/hq/self-uptime'),
    refetchInterval: 60_000,
  });

  const drainFailed = useMutation({
    mutationFn: (queue: 'import' | 'sync' | 'webhook') =>
      api.post(`/api/v1/hq/queues/${queue}/drain-failed`),
    onSuccess: (_d, queue) => {
      queryClient.invalidateQueries({ queryKey: ['admin-system'] });
      toast.success(`Cleared failed jobs on ${queue} queue`);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Drain failed'),
  });

  if (!session?.user.isSuperAdmin) {
    return (
      <>
        <PageHeader backHref="/hq" backLabel="Tenants" title="System health" />
        <Card>
          <CardContent className="p-6 text-sm text-foreground-muted">
            Super-admin role required.
          </CardContent>
        </Card>
      </>
    );
  }

  const h = system.data?.data;
  const totalFailed =
    (h?.queues.import.failed ?? 0) +
    (h?.queues.sync.failed ?? 0) +
    (h?.queues.webhook.failed ?? 0);

  return (
    <>
      <PageHeader
        backHref="/hq"
        backLabel="Tenants"
        title="System health"
        description="Queue depth, Redis, and tenant counts across the platform."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Building2}
          label="Organisations"
          value={h ? h.orgs.active : '—'}
          sub={h ? `${h.orgs.suspended} suspended · ${h.orgs.deleted} deleted` : undefined}
        />
        <StatCard
          icon={Users}
          label="Users"
          value={h ? h.users.total : '—'}
          sub={h ? `${h.users.pending} pending · ${h.users.disabled} disabled` : undefined}
        />
        <StatCard
          icon={Database}
          label="Redis"
          value={h ? (h.redis.connected ? (h.redis.opsPerSec ?? 0) : 'down') : '—'}
          sub={h?.redis.connected ? 'ops/s · connected' : 'disconnected'}
          tone={h?.redis.connected ? 'good' : 'warn'}
        />
        <StatCard
          icon={totalFailed > 0 ? AlertCircle : CheckCircle2}
          label="Queue failures"
          value={totalFailed}
          sub={totalFailed === 0 ? 'all clear' : 'see breakdown below'}
          tone={totalFailed > 0 ? 'warn' : 'good'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" /> Queues
          </CardTitle>
          <CardDescription>
            Auto-refreshes every 10 s. High failure counts usually mean orphan
            repeatable jobs — clear them with the button on the right.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {!h ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (
            <>
              <QueueRow name="Imports" icon={Inbox} w={h.queues.import.waiting} a={h.queues.import.active} f={h.queues.import.failed} />
              <QueueRow name="API sync" icon={Rocket} w={h.queues.sync.waiting} a={h.queues.sync.active} f={h.queues.sync.failed} />
              <QueueRow name="Outbound webhooks" icon={Webhook} w={h.queues.webhook.waiting} a={h.queues.webhook.active} f={h.queues.webhook.failed} />

              {totalFailed > 0 ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  {(['import', 'sync', 'webhook'] as const).map((q) =>
                    h.queues[q].failed > 0 ? (
                      <Button
                        key={q}
                        size="sm"
                        variant="secondary"
                        loading={drainFailed.isPending && drainFailed.variables === q}
                        onClick={() => drainFailed.mutate(q)}
                      >
                        <Trash2 className="size-3.5" /> Drain {q} failed ({h.queues[q].failed})
                      </Button>
                    ) : null,
                  )}
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {selfUptime.data?.data.configured ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" /> Process uptime (self-probe)
            </CardTitle>
            <CardDescription>
              Worker pings the API /health every 60 s. Catches "API process crashed but VM is up"
              cases. <strong>Not a substitute for external monitoring</strong> — if the whole VM is
              down, neither side can record. Wire UptimeRobot for the truthful picture.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              icon={CheckCircle2}
              label="24-h uptime"
              value={
                selfUptime.data.data.window24hPct == null
                  ? '—'
                  : `${selfUptime.data.data.window24hPct.toFixed(2)}%`
              }
              tone={
                selfUptime.data.data.window24hPct == null
                  ? 'default'
                  : selfUptime.data.data.window24hPct >= 99.9
                    ? 'good'
                    : 'warn'
              }
            />
            <StatCard
              icon={Activity}
              label="7-day uptime"
              value={
                selfUptime.data.data.window7dPct == null
                  ? '—'
                  : `${selfUptime.data.data.window7dPct.toFixed(2)}%`
              }
              tone={
                selfUptime.data.data.window7dPct == null
                  ? 'default'
                  : selfUptime.data.data.window7dPct >= 99.9
                    ? 'good'
                    : 'warn'
              }
            />
            <StatCard
              icon={AlertCircle}
              label="p95 latency (24 h)"
              value={selfUptime.data.data.p95Latency24h == null ? '—' : `${selfUptime.data.data.p95Latency24h} ms`}
              sub={`${selfUptime.data.data.totalSamples} samples in 7 d`}
              tone={
                selfUptime.data.data.p95Latency24h == null
                  ? 'default'
                  : selfUptime.data.data.p95Latency24h < 200
                    ? 'good'
                    : 'warn'
              }
            />
          </CardContent>
        </Card>
      ) : null}

      {uptime.data?.data.configured ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-4" /> Uptime
            </CardTitle>
            <CardDescription>Proxied from UptimeRobot. 24-hour uptime ratio shown.</CardDescription>
          </CardHeader>
          <CardContent>
            {uptime.data.data.monitors.length === 0 ? (
              <p className="text-sm text-foreground-muted">No monitors configured.</p>
            ) : (
              <ul className="space-y-2">
                {uptime.data.data.monitors.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{m.name}</p>
                      <p className="truncate text-xs font-mono text-foreground-subtle">{m.url}</p>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span>
                        <span className="text-foreground-subtle">24h</span>{' '}
                        <span className="font-mono">{m.uptimeRatio != null ? `${m.uptimeRatio}%` : '—'}</span>
                      </span>
                      <Badge variant={m.status === 'up' ? 'success' : m.status === 'paused' ? 'muted' : 'danger'}>
                        {m.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" /> API traffic
          </CardTitle>
          <CardDescription>
            Live counters from the API process. For a real time-series, point a Prometheus scrape at <code>/metrics</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!traffic.data ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <StatCard
                  icon={Activity}
                  label="Total requests"
                  value={traffic.data.data.totalRequests.toLocaleString()}
                  sub={`since ${formatUptime(traffic.data.data.uptimeSeconds)} ago`}
                />
                <StatCard
                  icon={CheckCircle2}
                  label="Success"
                  value={traffic.data.data.byStatusClass['2xx'].toLocaleString()}
                  sub={pct(traffic.data.data.byStatusClass['2xx'], traffic.data.data.totalRequests)}
                  tone="good"
                />
                <StatCard
                  icon={AlertCircle}
                  label="Client errors (4xx)"
                  value={traffic.data.data.byStatusClass['4xx'].toLocaleString()}
                  sub={pct(traffic.data.data.byStatusClass['4xx'], traffic.data.data.totalRequests)}
                />
                <StatCard
                  icon={AlertCircle}
                  label="Server errors (5xx)"
                  value={traffic.data.data.byStatusClass['5xx'].toLocaleString()}
                  sub={`${(traffic.data.data.errorRate * 100).toFixed(3)}% error rate`}
                  tone={traffic.data.data.byStatusClass['5xx'] > 0 ? 'warn' : 'good'}
                />
              </div>
              <div className="rounded-md border border-border bg-surface-muted/40 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  Top routes
                </p>
                {traffic.data.data.topRoutes.length === 0 ? (
                  <p className="text-xs text-foreground-muted">No traffic yet.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {traffic.data.data.topRoutes.slice(0, 8).map((r) => (
                      <li key={`${r.method}-${r.route}`} className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <Badge variant="muted">{r.method}</Badge>
                          <span className="truncate font-mono text-xs">{r.route}</span>
                        </span>
                        <span className="font-mono text-xs tabular-nums">{r.count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function pct(n: number, total: number): string {
  if (total === 0) return '—';
  return `${((n / total) * 100).toFixed(1)}%`;
}
