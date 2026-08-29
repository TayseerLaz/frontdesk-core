'use client';

import { useQuery } from '@tanstack/react-query';
import { ShoppingBag } from 'lucide-react';

import { getOrdersByChannel } from '@/lib/dashboard-api';
import { formatMoney, formatThousands } from '@/lib/format';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
  voice: 'Voice',
};

function channelLabel(c: string): string {
  return CHANNEL_LABELS[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

export function OrdersByChannelWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'orders-by-channel'],
    queryFn: getOrdersByChannel,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  return (
    <WidgetFrame
      id="orders-by-channel"
      title="Orders by channel"
      icon={ShoppingBag}
      accent="green"
      headerExtra={
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">7 DAYS</span>
      }
    >
      {q.isLoading ? (
        <WidgetSkeleton rows={3} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <WidgetEmpty title="No data yet." />
      ) : (
        (() => {
          const { channels, currency } = q.data;
          const totalOrders = channels.reduce((s, c) => s + c.orders, 0);
          if (totalOrders === 0) {
            return (
              <WidgetEmpty
                title="No orders in the last 7 days."
                hint="Orders from WhatsApp, Messenger, Instagram, and voice calls break out here."
              />
            );
          }
          return (
            <div className="space-y-2">
              {channels.map((c) => {
                const pct = totalOrders > 0 ? Math.round((c.orders / totalOrders) * 100) : 0;
                return (
                  <div key={c.channel}>
                    <div className="mb-0.5 flex items-baseline justify-between text-xs">
                      <span className="text-foreground-muted">{channelLabel(c.channel)}</span>
                      <span className="tabular-nums">
                        <span className="font-semibold text-foreground">
                          {formatThousands(c.orders)}
                        </span>
                        <span className="ml-1 text-foreground-subtle">
                          · {formatMoney(c.revenueMinor, currency)}
                        </span>
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className="h-full rounded-full bg-brand-500 transition-all"
                        style={{ width: `${Math.max(pct, c.orders > 0 ? 3 : 0)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()
      )}
    </WidgetFrame>
  );
}
