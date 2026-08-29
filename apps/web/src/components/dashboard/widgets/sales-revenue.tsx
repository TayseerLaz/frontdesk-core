'use client';

import { useQuery } from '@tanstack/react-query';
import { ShoppingBag } from 'lucide-react';
import Link from 'next/link';

import { getSales } from '@/lib/dashboard-api';
import { formatMoney, formatThousands } from '@/lib/format';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function SalesRevenueWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'sales'],
    queryFn: getSales,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <WidgetFrame
      id="sales-revenue"
      title="Sales & revenue"
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
      ) : q.data.orders7d === 0 ? (
        <WidgetEmpty
          title="No orders in the last 7 days."
          hint="Orders placed through the bot show up here."
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold leading-tight">
              {formatMoney(q.data.revenue7dMinor, q.data.currency)}
            </span>
            <span className="text-xs text-foreground-subtle">revenue</span>
          </div>
          <dl className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-2 text-sm">
            <Stat label="Orders" value={formatThousands(q.data.orders7d)} href="/orders" />
            <Stat label="Avg order" value={formatMoney(q.data.aovMinor, q.data.currency)} />
            <Stat label="Paid" value={formatThousands(q.data.paid7d)} />
          </dl>
          <div className="rounded-md bg-surface-muted/60 px-3 py-2 text-xs text-foreground-subtle">
            {q.data.ordersToday > 0
              ? `${formatThousands(q.data.ordersToday)} order${q.data.ordersToday === 1 ? '' : 's'} today`
              : 'No orders yet today'}
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href?: string }) {
  const inner = (
    <>
      <dt className="text-xs text-foreground-subtle">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </>
  );
  if (!href) return <div>{inner}</div>;
  return (
    <Link
      href={href}
      className="block rounded-md p-1 -m-1 transition hover:bg-surface-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      aria-label={`${label}: ${value}`}
    >
      {inner}
    </Link>
  );
}
