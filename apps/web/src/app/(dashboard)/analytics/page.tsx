'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Bot,
  Clock,
  Inbox,
  Send,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { BotPerformanceWidget } from '@/components/dashboard/widgets/bot-performance';
import { InboxSnapshotWidget } from '@/components/dashboard/widgets/inbox-snapshot';
import { RecentActivityWidget } from '@/components/dashboard/widgets/recent-activity';
import { UsageLimitsWidget } from '@/components/dashboard/widgets/usage-limits';
import { WalletBalanceWidget } from '@/components/dashboard/widgets/wallet-balance';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

type Window = '24h' | '7d' | '30d' | '90d';

interface Analytics {
  window: Window;
  volume: { date: string; inbound: number; outbound: number }[];
  totals: { inbound: number; outbound: number; threads: number };
  botResolution: { resolutionRate: number; handoffs: number };
  avgResponseSeconds: number | null;
  topQueries: { word: string; count: number }[];
  topMessages: { message: string; count: number }[];
  topProducts: { id: string; name: string; sku: string; count: number }[];
  topServices: { id: string; name: string; count: number }[];
  // F9 — reporting v2 (older API builds may omit these; render nothing then).
  aiVsHuman?: { botReplies: number; humanReplies: number };
  containment?: { threadsWithReplies: number; aiOnlyThreads: number; rate: number | null };
  csat?: {
    asked: number;
    responded: number;
    avgRating: number | null;
    byMix: { mix: string; count: number; avgRating: number | null }[];
  };
  team?: {
    userId: string;
    name: string;
    assignedActive: number;
    resolvedInWindow: number;
    csatCount: number;
    csatAvg: number | null;
  }[];
  sales?: {
    orders: { channel: string; count: number; totalMinor: number }[];
    bookings: { channel: string; count: number }[];
  };
}

interface Broadcast {
  id: string;
  name: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------- helpers ---

function Reveal({ delay = 0, className, children }: { delay?: number; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn('animate-in fade-in-0 slide-in-from-bottom-3', className)}
      style={{ animationDuration: '520ms', animationDelay: `${delay}ms`, animationFillMode: 'both' }}
    >
      {children}
    </div>
  );
}

// F9 — client-side CSV export of the loaded report window.
function exportReportCsv(a: Analytics, win: string) {
  const rows: string[][] = [
    ['metric', 'value'],
    ['window', win],
    ['conversations', String(a.totals.threads)],
    ['messages_in', String(a.totals.inbound)],
    ['messages_out', String(a.totals.outbound)],
    ['ai_replies', String(a.aiVsHuman?.botReplies ?? '')],
    ['human_replies', String(a.aiVsHuman?.humanReplies ?? '')],
    ['ai_containment_rate', String(a.containment?.rate ?? '')],
    ['csat_avg', String(a.csat?.avgRating ?? '')],
    ['csat_responded', String(a.csat?.responded ?? '')],
    [],
    ['agent', 'open_chats', 'resolved', 'csat_avg', 'csat_count'],
    ...(a.team ?? []).map((t) => [
      t.name,
      String(t.assignedActive),
      String(t.resolvedInWindow),
      String(t.csatAvg ?? ''),
      String(t.csatCount),
    ]),
    [],
    ['orders_channel', 'count', 'total_minor'],
    ...(a.sales?.orders ?? []).map((o) => [o.channel, String(o.count), String(o.totalMinor)]),
  ];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hader-report-${win}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}
function fmtReply(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function fmtDay(date: string): string {
  return date.slice(5); // MM-DD
}
// Simple trend from the first vs last third of a series.
function trend(vals: number[]): { dir: 'up' | 'down' | 'flat'; text: string } {
  if (vals.length < 2) return { dir: 'flat', text: 'not enough data' };
  const k = Math.max(1, Math.floor(vals.length / 3));
  const first = vals.slice(0, k).reduce((s, v) => s + v, 0) / k;
  const last = vals.slice(-k).reduce((s, v) => s + v, 0) / k;
  if (last > first * 1.1) return { dir: 'up', text: 'trending up' };
  if (last < first * 0.9) return { dir: 'down', text: 'easing off' };
  return { dir: 'flat', text: 'holding steady' };
}

// ------------------------------------------------------------------ KPIs ----

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  highlight,
}: {
  icon: typeof Inbox;
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <Card
      className={cn(
        'rounded-lg p-5',
        highlight
          ? 'border-transparent bg-brand-500 text-on-brand'
          : '',
      )}
    >
      <div className="flex items-center justify-between">
        <p
          className={cn(
            'flex items-center gap-2 text-[0.8125rem] font-medium',
            highlight ? 'text-on-brand/80' : 'text-foreground-muted',
          )}
        >
          <Icon className={cn('size-[1.05rem] shrink-0', highlight ? 'text-on-brand/70' : 'text-foreground-subtle')} />
          {label}
        </p>
        <ArrowUpRight className={cn('size-4', highlight ? 'text-on-brand/60' : 'text-foreground-subtle')} />
      </div>
      <p className="mt-3 font-mono text-[1.9rem] font-semibold leading-none tracking-[-0.02em] tabular-nums">
        {value}
      </p>
      <p className={cn('mt-1.5 text-xs font-medium', highlight ? 'text-on-brand/70' : 'text-foreground-subtle')}>
        {sub ?? ' '}
      </p>
    </Card>
  );
}

// ------------------------------------------------------------ line chart ----

function LineChart({ values, gradId }: { values: number[]; gradId: string }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 90);
    return () => clearTimeout(t);
  }, []);
  const n = values.length;
  const max = Math.max(1, ...values);
  const x = (i: number) => (n <= 1 ? 50 : (i * 100) / (n - 1));
  const y = (v: number) => 38 - (v / max) * 34; // padded within 0..40
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const area = n > 0 ? `0,40 ${pts} 100,40` : '';
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full text-brand-500">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[10, 20, 30].map((gy) => (
        <line key={gy} x1="0" y1={gy} x2="100" y2={gy} style={{ stroke: 'var(--color-border)' }} strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
      ))}
      {n > 1 ? (
        <polygon points={area} fill={`url(#${gradId})`} style={{ opacity: drawn ? 1 : 0, transition: 'opacity .8s ease .3s' }} />
      ) : null}
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        pathLength={1}
        style={{ strokeDasharray: 1, strokeDashoffset: drawn ? 0 : 1, transition: 'stroke-dashoffset 1.1s ease' }}
      />
    </svg>
  );
}

function LineCard({
  title,
  total,
  values,
  dates,
  gradId,
}: {
  title: string;
  total: number;
  values: number[];
  dates: string[];
  gradId: string;
}) {
  const t = trend(values);
  const max = Math.max(1, ...values);
  const yLabels = [max, Math.round(max * 0.66), Math.round(max * 0.33), 0];
  return (
    <Card className="rounded-lg border-border p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <ArrowUpRight className="size-4 text-foreground-subtle" />
      </div>
      <p className="mt-2 font-mono text-[1.9rem] font-semibold leading-none tracking-[-0.02em] tabular-nums">
        {fmtNum(total)}
      </p>
      <p
        className={cn(
          'mt-1.5 flex items-center gap-1 text-xs font-medium',
          t.dir === 'up' ? 'text-emerald-700' : t.dir === 'down' ? 'text-red-600' : 'text-foreground-subtle',
        )}
      >
        {t.dir === 'up' ? <TrendingUp className="size-3.5" /> : t.dir === 'down' ? <TrendingDown className="size-3.5" /> : null}
        {t.text}
      </p>
      <div className="mt-4 flex gap-2">
        <div className="flex h-[96px] flex-col justify-between py-0.5 text-right font-mono text-[10px] text-foreground-subtle">
          {yLabels.map((l, i) => (
            <span key={i}>{fmtNum(l)}</span>
          ))}
        </div>
        <div className="h-[96px] flex-1">
          <LineChart values={values} gradId={gradId} />
        </div>
      </div>
      <div className="mt-1.5 flex justify-between pl-8 font-mono text-[10px] text-foreground-subtle">
        <span>{dates[0] ? fmtDay(dates[0]) : ''}</span>
        <span>{dates.length ? fmtDay(dates[dates.length - 1]!) : ''}</span>
      </div>
    </Card>
  );
}

// --------------------------------------------------------------- section ----

function Panel({ title, right, children, bodyClassName }: { title: string; right?: ReactNode; children: ReactNode; bodyClassName?: string }) {
  return (
    <Card className="h-full rounded-lg border-border">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {right ? <div className="ml-auto">{right}</div> : null}
      </div>
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

function ListCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { key: string; primary: string; secondary?: string; count: number }[];
  empty: string;
}) {
  return (
    <Panel title={title} bodyClassName="py-2">
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-foreground-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-foreground">{r.primary}</p>
                {r.secondary ? <p className="truncate font-mono text-[10px] text-foreground-subtle">{r.secondary}</p> : null}
              </div>
              <span className="shrink-0 rounded-full bg-surface-elevated px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-foreground-muted">
                {r.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function statusChip(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('complet') || s.includes('sent') || s.includes('done')) return 'bg-emerald-100 text-emerald-700';
  if (s.includes('send') || s.includes('progress')) return 'bg-brand-50 text-brand-600';
  if (s.includes('schedul') || s.includes('paus') || s.includes('draft')) return 'bg-amber-100 text-amber-800';
  if (s.includes('fail') || s.includes('cancel')) return 'bg-red-100 text-red-700';
  return 'bg-surface-elevated text-foreground-muted';
}

// ------------------------------------------------------------------ page ----

export default function AnalyticsPage() {
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const hasCatalog = !disabledFeatures.includes('products') || !disabledFeatures.includes('services');
  const hasBroadcasts = !disabledFeatures.includes('broadcasts');
  // Opt-in (owner directive 2026-08-29): the v2 section + 90d window stay
  // hidden until HQ enables analytics_v2 for this org.
  const v2On = !disabledFeatures.includes('analytics_v2');
  const [win, setWin] = useState<Window>('7d');
  useEffect(() => {
    if (!v2On && win === '90d') setWin('7d');
  }, [v2On, win]);

  const q = useQuery({
    queryKey: ['analytics', win],
    queryFn: () => api.get<{ data: Analytics }>(`/api/v1/analytics?window=${win}`),
    refetchInterval: 60_000,
  });
  const a = q.data?.data;

  const broadcastsQ = useQuery({
    queryKey: ['analytics-broadcasts'],
    queryFn: () => api.get<{ data: Broadcast[] }>('/api/v1/broadcasts?limit=50'),
    refetchInterval: 60_000,
    enabled: hasBroadcasts,
  });
  const broadcasts = broadcastsQ.data?.data ?? [];

  const dates = a?.volume.map((v) => v.date) ?? [];
  const inbound = a?.volume.map((v) => v.inbound) ?? [];
  const outbound = a?.volume.map((v) => v.outbound) ?? [];
  const totalSeries = a?.volume.map((v) => v.inbound + v.outbound) ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title="Performance"
        description="Message volume, AI resolution, response time, and what your customers ask about."
        actions={
          <Select value={win} onValueChange={(v) => setWin(v as Window)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">Last 24 h</SelectItem>
              <SelectItem value="7d">Last 7 d</SelectItem>
              <SelectItem value="30d">Last 30 d</SelectItem>
              {v2On ? <SelectItem value="90d">Last 90 d</SelectItem> : null}
            </SelectContent>
          </Select>
        }
      />

      {!a ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[116px] rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {/* KPI row — the first tile is the highlighted brand card. */}
          <Reveal className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              icon={Users}
              label="Conversations"
              value={fmtNum(a.totals.threads)}
              sub={`${fmtNum(a.totals.inbound + a.totals.outbound)} messages`}
              highlight
            />
            <Kpi icon={Inbox} label="Messages in" value={fmtNum(a.totals.inbound)} sub="from customers" />
            <Kpi icon={Send} label="Messages out" value={fmtNum(a.totals.outbound)} sub="replies sent" />
            <Kpi icon={Clock} label="Avg response" value={fmtReply(a.avgResponseSeconds)} sub="first reply time" />
          </Reveal>

          {/* Live snapshot — the same real-time widgets as the dashboard, so
              Insights answers "how are we doing right now?" alongside the
              period report below. Each widget self-fetches + self-hides when
              its feature is off. */}
          <div>
            <h2 className="mb-3 text-lg font-semibold tracking-[-0.01em] text-foreground">
              Live snapshot
            </h2>
            <Reveal delay={100} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <InboxSnapshotWidget />
              <BotPerformanceWidget />
              <WalletBalanceWidget />
              <RecentActivityWidget />
            </Reveal>
          </div>

          {/* Report review — animated line charts. */}
          <div>
            <h2 className="mb-3 text-lg font-semibold tracking-[-0.01em] text-foreground">Report review</h2>
            <Reveal delay={140} className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <LineCard title="Inbound messages" total={a.totals.inbound} values={inbound} dates={dates} gradId="lc-in" />
              <LineCard title="Outbound replies" total={a.totals.outbound} values={outbound} dates={dates} gradId="lc-out" />
              <LineCard
                title="Total volume"
                total={a.totals.inbound + a.totals.outbound}
                values={totalSeries}
                dates={dates}
                gradId="lc-tot"
              />
            </Reveal>
          </div>

          {/* Usage & limits — full width. */}
          <Reveal delay={140}>
            <UsageLimitsWidget />
          </Reveal>

          {/* F9 — AI vs team + customer satisfaction (opt-in: analytics_v2). */}
          {v2On ? (
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
                AI &amp; team performance
              </h2>
              <Button size="sm" variant="secondary" onClick={() => exportReportCsv(a, win)}>
                Export CSV
              </Button>
            </div>
            <Reveal delay={160} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi
                icon={Bot}
                label="AI containment"
                value={a.containment?.rate != null ? `${Math.round(a.containment.rate * 100)}%` : '—'}
                sub={`${fmtNum(a.containment?.aiOnlyThreads ?? 0)} of ${fmtNum(a.containment?.threadsWithReplies ?? 0)} chats AI-only`}
                highlight
              />
              <Kpi
                icon={Bot}
                label="AI replies"
                value={fmtNum(a.aiVsHuman?.botReplies ?? 0)}
                sub={`${fmtNum(a.aiVsHuman?.humanReplies ?? 0)} by your team`}
              />
              <Kpi
                icon={Users}
                label="CSAT"
                value={a.csat?.avgRating != null ? `${a.csat.avgRating}/5` : '—'}
                sub={`${fmtNum(a.csat?.responded ?? 0)} of ${fmtNum(a.csat?.asked ?? 0)} rated`}
              />
              <Kpi
                icon={Users}
                label="CSAT · AI-only chats"
                value={
                  a.csat?.byMix.find((m) => m.mix === 'ai')?.avgRating != null
                    ? `${a.csat.byMix.find((m) => m.mix === 'ai')!.avgRating}/5`
                    : '—'
                }
                sub={
                  a.csat?.byMix.find((m) => m.mix === 'human' || m.mix === 'mixed')
                    ? `human-touched: ${
                        (() => {
                          const rows = a.csat.byMix.filter((m) => m.mix !== 'ai' && m.avgRating != null);
                          if (rows.length === 0) return '—';
                          const avg = rows.reduce((sum, r) => sum + (r.avgRating ?? 0) * r.count, 0) /
                            rows.reduce((sum, r) => sum + r.count, 0);
                          return `${avg.toFixed(2)}/5`;
                        })()
                      }`
                    : 'no rated human chats yet'
                }
              />
            </Reveal>
            {(a.team?.length ?? 0) > 0 ? (
              <Reveal delay={200} className="mt-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Team</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                        <tr>
                          <th className="px-4 py-2.5">Agent</th>
                          <th className="px-4 py-2.5 text-right">Open chats</th>
                          <th className="px-4 py-2.5 text-right">Resolved ({win})</th>
                          <th className="px-4 py-2.5 text-right">CSAT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.team!.map((t) => (
                          <tr key={t.userId} className="border-b border-border last:border-0">
                            <td className="px-4 py-2.5">{t.name}</td>
                            <td className="px-4 py-2.5 text-right">{fmtNum(t.assignedActive)}</td>
                            <td className="px-4 py-2.5 text-right">{fmtNum(t.resolvedInWindow)}</td>
                            <td className="px-4 py-2.5 text-right">
                              {t.csatAvg != null ? `${t.csatAvg}/5 (${t.csatCount})` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              </Reveal>
            ) : null}
            {(a.sales?.orders.length ?? 0) > 0 || (a.sales?.bookings.length ?? 0) > 0 ? (
              <Reveal delay={230} className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Orders by channel ({win})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(a.sales?.orders ?? []).length === 0 ? (
                      <p className="text-sm text-foreground-muted">No orders in this window.</p>
                    ) : (
                      <ul className="space-y-1.5 text-sm">
                        {a.sales!.orders.map((o) => (
                          <li key={o.channel} className="flex items-center justify-between">
                            <span className="capitalize">{o.channel}</span>
                            <span>
                              {fmtNum(o.count)} · {(o.totalMinor / 100).toLocaleString()} total
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Bookings by channel ({win})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(a.sales?.bookings ?? []).length === 0 ? (
                      <p className="text-sm text-foreground-muted">No bookings in this window.</p>
                    ) : (
                      <ul className="space-y-1.5 text-sm">
                        {a.sales!.bookings.map((b) => (
                          <li key={b.channel} className="flex items-center justify-between">
                            <span className="capitalize">{b.channel}</span>
                            <span>{fmtNum(b.count)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </Reveal>
            ) : null}
          </div>
          ) : null}

          {/* What customers ask about. */}
          {hasCatalog ? (
            <Reveal delay={200} className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <ListCard
                title="Top products asked"
                empty="No product mentions yet."
                rows={a.topProducts.map((p) => ({ key: p.id, primary: p.name, secondary: p.sku, count: p.count }))}
              />
              <ListCard
                title="Top services asked"
                empty="No service mentions yet."
                rows={a.topServices.map((s) => ({ key: s.id, primary: s.name, count: s.count }))}
              />
              <ListCard
                title="Top sentences"
                empty="Not enough messages yet."
                rows={a.topMessages.map((m, i) => ({ key: String(i), primary: m.message, count: m.count }))}
              />
            </Reveal>
          ) : (
            <Reveal delay={200}>
              <ListCard
                title="Top sentences"
                empty="Not enough messages yet."
                rows={a.topMessages.map((m, i) => ({ key: String(i), primary: m.message, count: m.count }))}
              />
            </Reveal>
          )}

          {/* Broadcasts table. */}
          {hasBroadcasts ? (
            <Reveal delay={230}>
              <Panel
                title="Broadcasts"
                right={
                  <span className="text-xs text-foreground-subtle">
                    {fmtNum(broadcasts.reduce((s, b) => s + b.sentCount, 0))} sent ·{' '}
                    {fmtNum(broadcasts.reduce((s, b) => s + b.totalRecipients, 0))} recipients
                  </span>
                }
                bodyClassName="p-0"
              >
                {broadcasts.length === 0 ? (
                  <p className="px-6 py-8 text-center text-sm text-foreground-muted">No broadcasts sent yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-border bg-surface-muted/60 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                          <th className="px-5 py-2.5">Campaign</th>
                          <th className="px-5 py-2.5">Status</th>
                          <th className="hidden px-5 py-2.5 text-right md:table-cell">Recipients</th>
                          <th className="px-5 py-2.5 text-right">Sent</th>
                          <th className="hidden px-5 py-2.5 text-right lg:table-cell">Delivered</th>
                          <th className="hidden px-5 py-2.5 text-right lg:table-cell">Read</th>
                        </tr>
                      </thead>
                      <tbody>
                        {broadcasts.map((b) => (
                          <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-muted/40">
                            <td className="px-5 py-3 font-medium text-foreground">{b.name}</td>
                            <td className="px-5 py-3">
                              <span
                                className={cn(
                                  'inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize',
                                  statusChip(b.status),
                                )}
                              >
                                {b.status}
                              </span>
                            </td>
                            <td className="hidden px-5 py-3 text-right font-mono tabular-nums md:table-cell">
                              {fmtNum(b.totalRecipients)}
                            </td>
                            <td className="px-5 py-3 text-right font-mono tabular-nums">{fmtNum(b.sentCount)}</td>
                            <td className="hidden px-5 py-3 text-right font-mono tabular-nums lg:table-cell">
                              {fmtNum(b.deliveredCount)}
                            </td>
                            <td className="hidden px-5 py-3 text-right font-mono tabular-nums lg:table-cell">
                              {fmtNum(b.readCount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </Reveal>
          ) : null}
        </div>
      )}
    </>
  );
}
