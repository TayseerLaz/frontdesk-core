'use client';

import { formatMicrosUsd } from '@platform/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, Gauge, Wallet } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { getAiBudgetToday, getWalletOverview, type AiBudgetToday, type WalletOverview } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

type LedgerKind = 'topup' | 'adjust' | 'settle' | 'release' | 'hold';

// Grouped wallet activity — the API rolls per-message charges/refunds up into
// one line per (day, kind, broadcast) so we never render thousands of rows.
interface LedgerGroup {
  day: string; // YYYY-MM-DD
  kind: LedgerKind;
  type: string; // friendly label ("Messages sent", "Refunds", …)
  count: number;
  amountMicros: number;
  availableAfterMicros: number;
  note: string | null;
}

export default function BillingPage() {
  const { session } = useSession();
  // Tenants without the AI/bot feature (e.g. Lexy) don't have an AI-message
  // allowance — hide every AI part of the page for them.
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const hasAi = !disabledFeatures.includes('ai');

  const overviewQ = useQuery({
    queryKey: ['billing', 'overview'],
    queryFn: getWalletOverview,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Plan + AI-message allowance + all plan quotas (same source the dashboard
  // "Usage & limits" widget reads — shared cache key). Lets the tenant see
  // their plan and how much of every enforced limit they've used.
  const aiUsageQ = useQuery({
    queryKey: ['dashboard', 'ai-budget'],
    queryFn: getAiBudgetToday,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const subQ = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: () =>
      api.get<{ data: { planName: string; status: string } }>('/api/v1/billing/subscription'),
    staleTime: 60_000,
  });
  const planName = subQ.data?.data.planName ?? null;

  const ledgerQ = useQuery({
    queryKey: ['billing', 'ledger'],
    queryFn: () => api.get<{ data: LedgerGroup[] }>('/api/v1/billing/ledger?limit=200'),
    staleTime: 30_000,
  });

  const ledgerRows = ledgerQ.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Billing & usage"
        description="Your plan, usage limits, and prepaid WhatsApp balance."
      />

      <div className="space-y-6">
        {overviewQ.data &&
        overviewQ.data.alert.level !== 'ok' &&
        overviewQ.data.alert.message ? (
          <div
            role="alert"
            className={cn(
              'flex items-start gap-3 rounded-lg border-2 px-4 py-3',
              overviewQ.data.alert.level === 'empty'
                ? 'animate-pulse border-red-500 bg-red-100 text-red-900'
                : 'border-red-400 bg-red-50 text-red-800',
            )}
          >
            <AlertOctagon className="mt-0.5 size-5 shrink-0" />
            <p className="text-sm font-semibold">{overviewQ.data.alert.message}</p>
          </div>
        ) : null}

        {overviewQ.isLoading ? (
          <Card>
            <CardContent className="space-y-3 p-6">
              <Skeleton className="h-10 w-48" />
              <Skeleton className="h-4 w-64" />
            </CardContent>
          </Card>
        ) : overviewQ.isError ? (
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start gap-2 text-sm text-red-700">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">Couldn&rsquo;t load your balance.</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-1 h-7 px-2 text-xs text-red-700 hover:bg-red-100"
                    onClick={() => overviewQ.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : overviewQ.data ? (
          <BalanceCard data={overviewQ.data} />
        ) : null}

        {/* Plan & usage */}
        {aiUsageQ.isLoading ? (
          <Card>
            <CardContent className="space-y-3 p-6">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
            </CardContent>
          </Card>
        ) : aiUsageQ.data ? (
          <PlanUsageCard
            ai={aiUsageQ.data}
            planName={planName}
            hasAi={hasAi}
            disabledFeatures={disabledFeatures}
          />
        ) : null}

        {/* Ledger */}
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {ledgerQ.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : ledgerRows.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-foreground-muted">
                No activity yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-surface-muted/60 text-[11px] uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-2">Date</th>
                      <th className="px-4 py-2">Type</th>
                      <th className="px-4 py-2 text-right">Amount</th>
                      <th className="hidden px-4 py-2 text-right sm:table-cell">Balance after</th>
                      <th className="hidden px-4 py-2 md:table-cell">Note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ledgerRows.map((r, i) => {
                      const positive = r.amountMicros >= 0;
                      return (
                        <tr key={`${r.day}-${r.kind}-${i}`}>
                          <td className="whitespace-nowrap px-4 py-2 text-foreground-muted">
                            {new Date(`${r.day}T00:00:00`).toLocaleDateString()}
                          </td>
                          <td className="px-4 py-2">
                            {r.type}
                            {r.count > 1 ? (
                              <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[11px] tabular-nums text-foreground-muted">
                                ×{r.count.toLocaleString()}
                              </span>
                            ) : null}
                          </td>
                          <td
                            className={cn(
                              'px-4 py-2 text-right font-medium tabular-nums',
                              positive ? 'text-emerald-700' : 'text-red-700',
                            )}
                          >
                            {positive ? '+' : '−'}${formatMicrosUsd(Math.abs(r.amountMicros))}
                          </td>
                          <td className="hidden px-4 py-2 text-right tabular-nums text-foreground-muted sm:table-cell">
                            ${formatMicrosUsd(r.availableAfterMicros)}
                          </td>
                          <td className="hidden px-4 py-2 text-foreground-muted md:table-cell">
                            {r.note ?? '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function BalanceCard({ data }: { data: WalletOverview }) {
  const {
    metered,
    availableMicros,
    messagesRemaining,
    pricePerMessageMicros,
    lowBalanceThresholdMicros,
    lifetimeMessages,
    lifetimeSpentMicros,
    lifetimeToppedUpMicros,
  } = data;

  // Tone: paused (0 messages) → red; running low → amber; else neutral.
  const paused = metered && messagesRemaining === 0;
  const low =
    metered &&
    !paused &&
    ((lowBalanceThresholdMicros > 0 && availableMicros <= lowBalanceThresholdMicros) ||
      messagesRemaining < 50);

  const tone = paused ? 'red' : low ? 'amber' : 'neutral';

  return (
    <Card
      className={cn(
        tone === 'red'
          ? 'border-red-300'
          : tone === 'amber'
            ? 'border-amber-300'
            : 'border-border',
      )}
    >
      <CardContent className="space-y-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground-muted">
              <Wallet className="size-4 text-brand-500" /> Available balance
            </div>
            <p className="mt-1 text-4xl font-semibold leading-tight tabular-nums">
              ${formatMicrosUsd(availableMicros)}
            </p>
            {metered ? (
              <p className="mt-1 text-sm text-foreground-muted">
                ≈{' '}
                <span className="font-medium text-foreground">
                  {messagesRemaining.toLocaleString()}
                </span>{' '}
                WhatsApp message{messagesRemaining === 1 ? '' : 's'} left · at $
                {formatMicrosUsd(pricePerMessageMicros)} per message
              </p>
            ) : (
              <p className="mt-1 max-w-lg text-sm text-foreground-muted">
                Pay-as-you-go WhatsApp billing isn&rsquo;t enabled for your workspace — your
                broadcasts send without a per-message charge.
                <span className="mt-1 block text-xs text-foreground-subtle">
                  For reference, the per-message price is ${formatMicrosUsd(pricePerMessageMicros)}.
                </span>
              </p>
            )}
          </div>
        </div>

        {/* Status line */}
        {paused ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-800">
            <AlertOctagon className="mt-0.5 size-4 shrink-0" />
            <span className="font-medium">Sending paused — top up to resume.</span>
          </div>
        ) : low ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="font-medium">Running low — consider topping up soon.</span>
          </div>
        ) : metered ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
            Balance healthy — your bot and broadcasts are sending normally.
          </div>
        ) : null}

        {/* Lifetime stats */}
        <div className="grid grid-cols-1 gap-2 border-t border-border pt-4 sm:grid-cols-3">
          <Stat label="Messages sent (lifetime)" value={lifetimeMessages.toLocaleString()} />
          <Stat label="Spent (lifetime)" value={`$${formatMicrosUsd(lifetimeSpentMicros)}`} />
          <Stat label="Topped up (lifetime)" value={`$${formatMicrosUsd(lifetimeToppedUpMicros)}`} />
        </div>

        {/* How top-ups work */}
        <p className="text-xs text-foreground-subtle">
          Top-ups are added by the platform team. Contact your account manager to add balance.
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted/40 p-3">
      <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

// Which org-feature each plan-quota belongs to. A tenant that lacks the feature
// doesn't see the row (no catalog → no Products/Services/Imports; no broadcasts
// → no Broadcasts). Messages/members/keys/webhooks are core → always shown.
const QUOTA_FEATURE: Record<string, string> = {
  monthly_broadcasts: 'broadcasts',
  monthly_imports: 'imports',
  products: 'products',
  services: 'services',
};

function PlanUsageCard({
  ai,
  planName,
  hasAi,
  disabledFeatures,
}: {
  ai: AiBudgetToday;
  planName: string | null;
  hasAi: boolean;
  disabledFeatures: string[];
}) {
  // AI bot replies first (the cap that pauses the bot) — only for tenants that
  // actually have the AI feature — then every plan quota the tenant HAS.
  const rows: { label: string; used: number; cap: number | null; pct: number | null }[] = [];
  if (hasAi && !ai.unlimited) {
    rows.push({
      label: 'AI bot replies (this month)',
      used: ai.messagesUsed,
      cap: ai.messageCap,
      pct: ai.percentUsed,
    });
  }
  for (const q of ai.quotas) {
    const feat = QUOTA_FEATURE[q.key];
    if (feat && disabledFeatures.includes(feat)) continue; // tenant lacks this feature
    rows.push({ label: q.label, used: q.used, cap: q.cap, pct: q.pct });
  }

  const aiRemaining =
    ai.unlimited || ai.messageCap == null ? null : Math.max(0, ai.messageCap - ai.messagesUsed);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-4 text-brand-500" /> Your plan &amp; usage
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className={cn('grid grid-cols-1 gap-3', hasAi && 'sm:grid-cols-2')}>
          <div className="rounded-lg border border-border bg-surface-muted/40 p-4">
            <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">Current plan</p>
            <p className="mt-0.5 text-xl font-semibold">{planName ?? '—'}</p>
          </div>
          {hasAi ? (
            <div className="rounded-lg border border-border bg-surface-muted/40 p-4">
              <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                AI bot replies left this month
              </p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {aiRemaining == null ? 'Unlimited' : formatThousands(aiRemaining)}
                {aiRemaining != null && ai.messageCap != null ? (
                  <span className="ml-1 text-sm font-normal text-foreground-muted">
                    of {formatThousands(ai.messageCap)}
                  </span>
                ) : null}
              </p>
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          {rows.map((r) => (
            <QuotaBar key={r.label} {...r} />
          ))}
        </div>

        <p className="text-xs text-foreground-subtle">
          These are your plan limits. When a bar reaches 100% that activity pauses until the next
          month or a plan upgrade — contact support to change your plan.
        </p>
      </CardContent>
    </Card>
  );
}

function QuotaBar({
  label,
  used,
  cap,
  pct,
}: {
  label: string;
  used: number;
  cap: number | null;
  pct: number | null;
}) {
  const unlimited = cap == null;
  const p = unlimited ? 0 : Math.min(100, Math.max(0, pct ?? 0));
  const color = unlimited
    ? 'bg-emerald-500'
    : p >= 100
      ? 'bg-red-500'
      : p >= 80
        ? 'bg-amber-500'
        : 'bg-brand-500';
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-foreground-muted">{label}</span>
        <span className="tabular-nums text-foreground-subtle">
          {unlimited
            ? 'Unlimited'
            : `${formatThousands(used)} / ${formatThousands(cap)}${pct != null ? ` · ${p}%` : ''}`}
        </span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-muted">
        <div
          className={cn('h-full transition-all', color)}
          style={{ width: `${unlimited ? 8 : p}%`, opacity: unlimited ? 0.5 : 1 }}
        />
      </div>
    </div>
  );
}
