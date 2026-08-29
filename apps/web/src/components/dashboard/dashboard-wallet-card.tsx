'use client';

import { formatMicrosUsd } from '@platform/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, ArrowUpRight, Wallet } from 'lucide-react';
import Link from 'next/link';

import { Card, CardContent } from '@/components/ui/card';
import { getWalletOverview } from '@/lib/dashboard-api';
import { cn } from '@/lib/utils';

// Always-on wallet balance card, pinned to the top of every tenant's dashboard.
// Shows "the money they have" front and center, with a link to Billing. Red when
// the balance is empty/paused, amber when a configured alert threshold is crossed.
export function DashboardWalletCard() {
  const q = useQuery({
    queryKey: ['billing', 'overview'],
    queryFn: getWalletOverview,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const d = q.data;
  if (!d) return null;

  const paused = d.metered && d.alert.level === 'empty';
  const low = d.metered && d.alert.level === 'alert';

  return (
    <Link href="/billing" className="group block">
      <Card
        className={cn(
          'rounded-2xl shadow-[0_1px_2px_rgba(54,5,22,0.04)] transition-shadow duration-200 group-hover:shadow-[0_8px_24px_-12px_rgba(54,5,22,0.12)]',
          paused
            ? 'border-red-300 bg-red-50/50'
            : low
              ? 'border-amber-300 bg-amber-50/40'
              : 'border-border/80',
        )}
      >
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground-muted">
              <Wallet className="size-4 text-brand-500" /> WhatsApp balance
            </div>
            <p className="mt-1 font-mono text-3xl font-semibold leading-tight tabular-nums">
              ${formatMicrosUsd(d.availableMicros)}
            </p>
            <p className="mt-0.5 text-sm text-foreground-muted">
              {d.metered
                ? `≈ ${d.messagesRemaining.toLocaleString()} WhatsApp message${d.messagesRemaining === 1 ? '' : 's'} left`
                : 'Pay-as-you-go billing isn’t enabled — broadcasts send without a per-message charge.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {paused ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-800">
                <AlertOctagon className="size-3.5" /> Sending paused
              </span>
            ) : low ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">
                Running low
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 group-hover:underline">
              Billing <ArrowUpRight className="size-4" />
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
