'use client';

import { formatMicrosUsd } from '@platform/shared';
import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';

import { getWalletOverview, type WalletOverview } from '@/lib/dashboard-api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

import { WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function WalletBalanceWidget() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['billing', 'overview'],
    queryFn: getWalletOverview,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // No WhatsApp for this tenant → no prepaid balance to show.
  if (session?.organization?.disabledFeatures?.includes('whatsapp')) return null;
  // Metered billing isn't enabled → this widget is irrelevant, hide it.
  if (q.data && !q.data.metered) return null;

  return (
    <WidgetFrame
      id="wallet-balance"
      title="WhatsApp balance"
      icon={Wallet}
      accent="green"
      headerExtra={
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">PREPAID</span>
      }
    >
      {q.isLoading ? (
        <WidgetSkeleton rows={2} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data || !q.data.metered ? null : (
        <Body data={q.data} />
      )}
    </WidgetFrame>
  );
}

function Body({ data }: { data: WalletOverview }) {
  const { availableMicros, messagesRemaining, lowBalanceThresholdMicros, pricePerMessageMicros } =
    data;

  const paused = messagesRemaining === 0;
  const low =
    !paused &&
    ((lowBalanceThresholdMicros > 0 && availableMicros <= lowBalanceThresholdMicros) ||
      messagesRemaining < 50);

  const amountColour = paused
    ? 'text-red-600'
    : low
      ? 'text-amber-600'
      : 'text-foreground';
  const barColour = paused ? 'bg-red-500' : low ? 'bg-amber-500' : 'bg-emerald-500';

  // Indicative fill: fraction of a nominal "healthy" bar (50 messages = full),
  // capped at 100%. Purely cosmetic — the number is the real signal.
  const fill = paused ? 0 : Math.min(100, Math.max(6, (messagesRemaining / 50) * 100));

  return (
    <div className="space-y-3">
      <p className={cn('text-3xl font-semibold leading-tight tabular-nums', amountColour)}>
        ${formatMicrosUsd(availableMicros)}
      </p>
      <p className="text-xs text-foreground-muted">
        {paused ? (
          <span className="font-medium text-red-600">
            Sending paused — balance empty
          </span>
        ) : (
          <>
            <span className="font-medium text-foreground">
              {messagesRemaining.toLocaleString()}
            </span>{' '}
            message{messagesRemaining === 1 ? '' : 's'} left · $
            {formatMicrosUsd(pricePerMessageMicros)} each
          </>
        )}
      </p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill)}
        aria-label={`${messagesRemaining} WhatsApp messages remaining`}
      >
        <div className={cn('h-full transition-all', barColour)} style={{ width: `${fill}%` }} />
      </div>
      {low ? (
        <p className="text-xs font-medium text-amber-600">Running low — top up soon.</p>
      ) : null}
    </div>
  );
}
