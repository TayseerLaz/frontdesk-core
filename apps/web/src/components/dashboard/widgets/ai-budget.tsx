'use client';

import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';

import { getAiBudgetToday } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

import { WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function AiBudgetWidget() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['dashboard', 'ai-budget'],
    queryFn: getAiBudgetToday,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Tenants with the AI/bot feature turned off don't use AI messages — hide it.
  if (session?.organization?.disabledFeatures?.includes('ai')) return null;

  return (
    <WidgetFrame
      id="ai-budget"
      title="AI messages"
      icon={Sparkles}
      accent="green"
      headerExtra={
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">THIS MONTH</span>
      }
    >
      {q.isLoading ? (
        <WidgetSkeleton rows={2} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? null : (
        <Body data={q.data} />
      )}
    </WidgetFrame>
  );
}

function Body({ data }: { data: NonNullable<ReturnType<typeof useQuery<Awaited<ReturnType<typeof getAiBudgetToday>>>>['data']> }) {
  // Tenant-facing widget: ONLY percentages + messages used. We deliberately do
  // NOT render token counts or dollar cost — those are admin-only and live on
  // the tenant details page in the ALIGNED admin panel.
  const unlimited = data.plan === 'Unlimited' || data.messageCap == null;
  const percentUsed = unlimited ? 0 : Math.min(100, Math.max(0, data.messagePct ?? 0));

  // Threshold logic per spec: amber at 80%, red at 95%. Unlimited stays
  // green (with a faint indicative fill).
  const barColour = unlimited
    ? 'bg-emerald-500'
    : percentUsed >= 95
      ? 'bg-red-500'
      : percentUsed >= 80
        ? 'bg-amber-500'
        : 'bg-emerald-500';
  const indicativeFill = unlimited ? 18 : percentUsed;

  const remaining =
    unlimited || data.messageCap == null ? null : Math.max(0, data.messageCap - data.messagesUsed);
  return (
    <div className="space-y-3">
      {/* Headline is the tenant's remaining BALANCE this month, not % used. */}
      <p className="text-3xl font-semibold leading-tight">
        {remaining == null ? 'Unlimited' : formatThousands(remaining)}
      </p>
      <p className="text-xs text-foreground-muted">
        {remaining == null ? (
          'AI messages — no monthly limit'
        ) : (
          <>
            AI messages left this month ·{' '}
            <span className="font-medium text-foreground">{formatThousands(data.messagesUsed)}</span> of{' '}
            {formatThousands(data.messageCap ?? 0)} used
          </>
        )}
      </p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={unlimited ? 0 : 100}
        aria-valuenow={unlimited ? undefined : percentUsed}
        aria-label={unlimited ? 'Unlimited plan — indicative usage only' : `${percentUsed}% of monthly message limit used`}
      >
        <div
          className={cn('h-full transition-all', barColour)}
          style={{ width: `${indicativeFill}%`, opacity: unlimited ? 0.5 : 1 }}
        />
      </div>
      {!unlimited ? (
        <p className="text-xs text-foreground-subtle">{percentUsed}% of your monthly allowance used</p>
      ) : null}
    </div>
  );
}
