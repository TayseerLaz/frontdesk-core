'use client';

import { useQuery } from '@tanstack/react-query';
import { Filter } from 'lucide-react';

import { getConversionFunnel } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

interface Stage {
  label: string;
  value: number;
  href?: string;
}

export function ConversionFunnelWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'conversion-funnel'],
    queryFn: getConversionFunnel,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <WidgetFrame
      id="conversion-funnel"
      title="Conversion funnel"
      icon={Filter}
      headerExtra={
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">7 DAYS</span>
      }
    >
      {q.isLoading ? (
        <WidgetSkeleton rows={4} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <WidgetEmpty title="No data yet." />
      ) : q.data.conversations === 0 ? (
        <WidgetEmpty
          title="No conversations in the last 7 days."
          hint="The chats → carts → orders funnel appears here once traffic starts."
        />
      ) : (
        <Funnel
          stages={[
            { label: 'Conversations', value: q.data.conversations, href: '/inbox' },
            { label: 'Carts started', value: q.data.cartsStarted },
            { label: 'Orders placed', value: q.data.ordersPlaced, href: '/orders' },
            { label: 'Orders paid', value: q.data.ordersPaid },
          ]}
        />
      )}
    </WidgetFrame>
  );
}

function Funnel({ stages }: { stages: Stage[] }) {
  const top = stages[0]?.value ?? 0;
  return (
    <div className="space-y-2">
      {stages.map((s, i) => {
        const pctOfTop = top > 0 ? Math.round((s.value / top) * 100) : 0;
        const prev = stages[i - 1]?.value ?? null;
        const stepPct =
          prev !== null && prev > 0 ? Math.round((s.value / prev) * 100) : null;
        return (
          <div key={s.label}>
            <div className="mb-0.5 flex items-baseline justify-between text-xs">
              <span className="text-foreground-muted">{s.label}</span>
              <span className="tabular-nums">
                <span className="font-semibold text-foreground">{formatThousands(s.value)}</span>
                {stepPct !== null ? (
                  <span className="ml-1 text-foreground-subtle">({stepPct}%)</span>
                ) : null}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-all"
                style={{ width: `${Math.max(pctOfTop, s.value > 0 ? 3 : 0)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
