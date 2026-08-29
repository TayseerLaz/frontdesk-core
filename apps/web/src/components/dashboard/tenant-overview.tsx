'use client';

// The tenant "overview" dashboard — a fixed, curated layout that mirrors the
// hader.ai sandbox: hero KPIs → conversations chart + recent activity → this
// week's bookings → an Inbox CTA. Everything is the tenant's LIVE data (see
// /api/v1/dashboard/widgets/overview + bookings-week). Replaces the old
// configurable widget board for tenants; the ALIGNED-HQ admin dashboard is a
// separate component.

import { formatMicrosUsd } from '@platform/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  Briefcase,
  Building2,
  Inbox,
  LogIn,
  type LucideIcon,
  Megaphone,
  Package,
  ShoppingCart,
  Timer,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { AiBudgetBanner } from '@/components/dashboard/ai-budget-banner';
import { WalletBalanceBanner } from '@/components/dashboard/wallet-balance-banner';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  getBookingsWeek,
  getOverview,
  getRecentActivity,
  getWalletOverview,
  type ActivityEvent,
  type OverviewData,
} from '@/lib/dashboard-api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------- helpers ---

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

type Tone = 'up' | 'down' | 'neutral';
function toneClass(t: Tone): string {
  return t === 'up' ? 'text-emerald-700' : t === 'down' ? 'text-red-600' : 'text-foreground-subtle';
}

function formatReply(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// Once-on-mount rise-up entrance (mirrors the sandbox's panel fade). The global
// reduced-motion rule neutralises it for users who ask.
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

// Sandbox-style titled card with a hairline divider header.
function Panel({
  title,
  right,
  children,
  bodyClassName,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
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

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
      <span className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" /> Live
    </span>
  );
}

// ------------------------------------------------------------------ KPIs ----

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}) {
  return (
    <Card className="rounded-lg border-border p-5">
      <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-foreground-muted">
        <Icon className="size-[1.05rem] shrink-0 text-foreground-subtle" aria-hidden />
        {label}
      </p>
      <p className="mt-2.5 font-mono text-[1.85rem] font-semibold leading-none tracking-[-0.02em] tabular-nums">
        {value}
      </p>
      <p className={cn('mt-1.5 text-xs font-semibold', toneClass(tone))}>{sub || ' '}</p>
    </Card>
  );
}

// WhatsApp prepaid credits as a KPI-row card (links to Billing). Amber/red
// when the balance is running low / paused.
function WhatsAppCreditsCard() {
  const q = useQuery({
    queryKey: ['billing', 'overview'],
    queryFn: getWalletOverview,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const d = q.data;
  const paused = !!d?.metered && d.alert.level === 'empty';
  const low = !!d?.metered && d.alert.level === 'alert';
  const sub = !d
    ? ' '
    : paused
      ? 'Sending paused'
      : low
        ? 'Running low'
        : d.metered
          ? `≈ ${d.messagesRemaining.toLocaleString()} left`
          : 'Billing →';
  const subClass = paused
    ? 'text-red-600'
    : low
      ? 'text-amber-700'
      : d?.metered
        ? 'text-foreground-subtle'
        : 'text-brand-600';

  return (
    <Link href="/billing" className="group block h-full">
      <Card
        className={cn(
          'h-full rounded-lg p-5',
          paused
            ? 'border-red-300 bg-red-50/40'
            : low
              ? 'border-amber-300 bg-amber-50/30'
              : 'border-border',
        )}
      >
        <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-foreground-muted">
          <Wallet className="size-[1.05rem] shrink-0 text-brand-500" aria-hidden /> WhatsApp credits
        </p>
        <p className="mt-2.5 font-mono text-[1.85rem] font-semibold leading-none tracking-[-0.02em] tabular-nums">
          {d ? `$${formatMicrosUsd(d.availableMicros)}` : '—'}
        </p>
        <p className={cn('mt-1.5 text-xs font-semibold', subClass)}>{sub}</p>
      </Card>
    </Link>
  );
}

// Static class strings so Tailwind keeps them; the row width adapts to how many
// KPI cards survive feature-gating (2–5).
const KPI_COLS: Record<number, string> = {
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
};

function KpiRow({ d, disabled }: { d?: OverviewData; disabled: string[] }) {
  const hasAi = !disabled.includes('ai');
  const hasOrders = !disabled.includes('orders');

  const convSub = !d
    ? ''
    : d.conversationsDeltaPct == null
      ? d.conversations7d > 0
        ? 'first activity'
        : 'no chats yet'
      : `${d.conversationsDeltaPct >= 0 ? '+' : ''}${d.conversationsDeltaPct}% vs last week`;
  const convTone: Tone =
    !d || d.conversationsDeltaPct == null ? 'neutral' : d.conversationsDeltaPct >= 0 ? 'up' : 'down';

  // WhatsApp credits + Conversations are always shown; the AI + orders KPIs are
  // gated on those features so a tenant only sees numbers that apply to them.
  const cards: ReactNode[] = [
    <WhatsAppCreditsCard key="credits" />,
    <KpiCard
      key="conv"
      icon={Inbox}
      label="Conversations"
      value={d ? String(d.conversations7d) : '—'}
      sub={convSub}
      tone={convTone}
    />,
  ];
  if (hasAi) {
    cards.push(
      <KpiCard
        key="reply"
        icon={Timer}
        label="Median first reply"
        value={d ? formatReply(d.medianReplySeconds) : '—'}
        sub="across recent chats"
        tone="neutral"
      />,
    );
  }
  if (hasOrders) {
    cards.push(
      <KpiCard
        key="orders"
        icon={ShoppingCart}
        label="Orders captured"
        value={d ? String(d.orders7d) : '—'}
        sub={d ? (d.ordersToday > 0 ? `+${d.ordersToday} today` : 'this week') : ''}
        tone={d && d.ordersToday > 0 ? 'up' : 'neutral'}
      />,
    );
  }
  if (hasAi) {
    cards.push(
      <KpiCard
        key="ai"
        icon={Bot}
        label="Handled by AI"
        value={d ? `${d.aiHandledPercent}%` : '—'}
        sub={d ? `${d.humanPercent}% sent to a human` : ''}
        tone="down"
      />,
    );
  }

  return (
    <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2', KPI_COLS[cards.length] ?? 'lg:grid-cols-4')}>
      {cards}
    </div>
  );
}

// ------------------------------------------------------------- chart --------

// Round a raw max up to a "nice" axis ceiling (1/2/5 × 10ⁿ) so the Y-axis ticks
// read as round numbers (…3→5, 7→10, 12→20) instead of the exact bar value.
function niceMax(m: number): number {
  const v = Math.max(1, m);
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

function ConversationsChart({ d, loading }: { d?: OverviewData; loading: boolean }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGrown(true), 60);
    return () => clearTimeout(t);
  }, []);
  const byDay = d?.byDay ?? [];
  const total = byDay.reduce((s, x) => s + x.count, 0);
  const max = Math.max(1, ...byDay.map((x) => x.count));
  // Y-axis scale: bars are measured against a rounded ceiling, and we draw a
  // tick + gridline at the top, the midpoint, and 0 (top→bottom).
  const axisTop = niceMax(max);
  const yTicks = axisTop <= 2 ? [axisTop, 0] : [axisTop, Math.round(axisTop / 2), 0];

  return (
    <Panel title="Conversations this week" right={<LiveBadge />}>
      {loading ? (
        <div className="h-[176px] animate-pulse rounded-lg bg-surface-muted" />
      ) : total === 0 ? (
        <div className="flex h-[176px] flex-col items-center justify-center text-center">
          <p className="text-sm font-medium text-foreground">No conversations yet this week.</p>
          <p className="mt-1 text-xs text-foreground-subtle">
            They&rsquo;ll appear here as customers message you.
          </p>
        </div>
      ) : (
        <div className="flex gap-2">
          {/* Y axis — value ticks aligned to the gridlines */}
          <div className="flex h-[150px] w-6 shrink-0 flex-col justify-between text-right font-mono text-[10px] leading-none text-foreground-subtle">
            {yTicks.map((t, i) => (
              <span key={i} className="-translate-y-1/2 tabular-nums first:translate-y-0">
                {t}
              </span>
            ))}
          </div>
          {/* plot + X-axis labels (share the column so labels sit under the bars) */}
          <div className="min-w-0 flex-1">
            <div className="relative h-[150px]">
              {/* horizontal gridlines (one per Y tick); the bottom line is the X axis */}
              <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
                {yTicks.map((_, i) => (
                  <div
                    key={i}
                    className={i === yTicks.length - 1 ? 'border-t border-border' : 'border-t border-border/50'}
                  />
                ))}
              </div>
              {/* bars, measured against the rounded axis ceiling */}
              <div className="relative flex h-full items-end gap-2.5">
                {byDay.map((x, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-t-md rounded-b-sm bg-gradient-to-b from-[#7d4152] to-[#360516] transition-[height] duration-700 ease-out"
                    style={{ height: grown ? `${Math.max(2, Math.round((x.count / axisTop) * 100))}%` : '3px' }}
                    title={`${x.label}: ${x.count}`}
                  />
                ))}
              </div>
            </div>
            <div className="mt-2 flex gap-2.5">
              {byDay.map((x, i) => (
                <span key={i} className="flex-1 text-center font-mono text-[11px] text-foreground-subtle">
                  {x.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

// -------------------------------------------------------- recent activity ---

const ACTIVITY_ICON: Record<string, LucideIcon> = {
  product_updated: Package,
  product_created: Package,
  service_updated: Briefcase,
  service_created: Briefcase,
  login_succeeded: LogIn,
  business_info_updated: Building2,
  broadcast_sent: Megaphone,
  bot_deployed: Bot,
  bot_undeployed: Bot,
};

function RecentActivityPanel() {
  const q = useQuery({
    queryKey: ['dashboard', 'recent-activity'],
    queryFn: getRecentActivity,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const events: ActivityEvent[] = q.data ?? [];

  return (
    <Panel title="Recent activity" bodyClassName="py-1.5">
      {q.isLoading ? (
        <div className="space-y-3 py-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-surface-muted" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="py-8 text-center text-sm text-foreground-muted">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {events.slice(0, 5).map((ev) => {
            const Icon = ACTIVITY_ICON[ev.kind] ?? Activity;
            return (
              <li key={ev.id} className="flex items-center gap-3 py-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-muted text-foreground-muted">
                  <Icon className="size-4" aria-hidden />
                </span>
                <p className="min-w-0 flex-1 truncate text-[13px] text-foreground">{ev.description}</p>
                <span className="shrink-0 font-mono text-[11.5px] text-foreground-subtle">
                  {formatRelative(ev.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// --------------------------------------------------------- bookings week ----

function bookingBorder(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('pending')) return '#8a6a12';
  if (s.includes('cancel')) return '#9a9088';
  if (s.includes('complete')) return '#2e8849';
  return '#360516';
}

function BookingsWeek() {
  const q = useQuery({ queryKey: ['dashboard', 'bookings-week'], queryFn: getBookingsWeek, staleTime: 60_000 });
  const d = q.data;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="text-[15px] font-semibold">This week&rsquo;s bookings</h3>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-elevated px-2.5 py-0.5 text-xs font-medium text-foreground-muted">
          {d?.total ?? 0} appointment{(d?.total ?? 0) === 1 ? '' : 's'}
        </span>
        <Button asChild variant="secondary" size="sm" className="ml-auto">
          <Link href="/bookings">Open calendar</Link>
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface p-2">
        <div className="grid min-w-[860px] grid-cols-7 gap-2">
          {(d?.days ?? Array.from({ length: 7 }, () => null)).map((day, i) => (
            <div key={i} className={cn('rounded-xl p-2', day?.isToday && 'bg-coral-50')}>
              <div className="mb-2 flex items-baseline gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-subtle">
                {day ? (
                  <>
                    <span>{day.label}</span>
                    <span className={cn('font-mono text-sm', day.isToday ? 'text-coral-600' : 'text-foreground')}>
                      {day.dayNum}
                    </span>
                  </>
                ) : (
                  <span className="h-4 w-10 animate-pulse rounded bg-surface-muted" />
                )}
              </div>
              <div className="space-y-1.5">
                {day?.items.map((it, j) => (
                  <div
                    key={j}
                    className="rounded-lg border border-border border-l-2 bg-surface-muted/40 p-2"
                    style={{ borderLeftColor: bookingBorder(it.status) }}
                  >
                    <div className="font-mono text-[11px] text-foreground-subtle">{it.time}</div>
                    <div className="mt-0.5 text-[13px] font-semibold leading-tight text-foreground">
                      {it.title}
                    </div>
                    {it.subtitle ? (
                      <div className="truncate text-[11.5px] text-foreground-muted">{it.subtitle}</div>
                    ) : null}
                    {it.status.toLowerCase().includes('pending') ? (
                      <div className="mt-0.5 text-[11px] font-semibold text-amber-700">pending</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {d && d.total === 0 ? (
        <p className="mt-2 text-center text-xs text-foreground-subtle">
          No bookings scheduled this week.
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------- inbox CTA ----

function InboxCta() {
  return (
    <Card className="flex flex-wrap items-center gap-4 rounded-lg border-border p-5">
      <div className="min-w-[220px] flex-1">
        <p className="text-[14.5px] font-semibold text-foreground">Try the part your customers feel →</p>
        <p className="mt-0.5 text-sm text-foreground-muted">
          Open the Inbox and chat with your AI. It replies exactly like it would on WhatsApp.
        </p>
      </div>
      <Button asChild>
        <Link href="/inbox">Open the Inbox</Link>
      </Button>
    </Card>
  );
}

// ----------------------------------------------------------------- shell ----

export function TenantOverview({ greeting }: { greeting: string }) {
  const { session } = useSession();
  const disabled = session?.organization?.disabledFeatures ?? [];
  const overview = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: getOverview,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const d = overview.data;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title={greeting ? `${timeGreeting()}, ${greeting}` : timeGreeting()}
        description="Here's a live snapshot of your business on Hader — every number updates in real time."
      />

      <div className="mt-6 space-y-6">
        {/* Critical alerts only (empty balance / over budget) — hidden otherwise. */}
        <div className="space-y-3 empty:hidden">
          <AiBudgetBanner />
          <WalletBalanceBanner />
        </div>

        {/* KPI row — WhatsApp credits sits beside the four hero metrics. */}
        <Reveal>
          <KpiRow d={d} disabled={disabled} />
        </Reveal>

        <Reveal delay={90} className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
          <ConversationsChart d={d} loading={overview.isLoading} />
          <RecentActivityPanel />
        </Reveal>

        {!disabled.includes('bookings') ? (
          <Reveal delay={170}>
            <BookingsWeek />
          </Reveal>
        ) : null}

        {!disabled.includes('inbox') ? (
          <Reveal delay={230}>
            <InboxCta />
          </Reveal>
        ) : null}
      </div>
    </>
  );
}
