'use client';

import { useQuery } from '@tanstack/react-query';
import { Bot, Info } from 'lucide-react';
import Link from 'next/link';

import { getBotPerformanceToday } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';
import { useSession } from '@/lib/session';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function BotPerformanceWidget() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['dashboard', 'bot-performance'],
    queryFn: getBotPerformanceToday,
    // Today's window — refresh once a minute so the percentage drifts
    // visibly as conversations are resolved.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Tenants with the AI/bot feature turned off have no bot performance to show.
  if (session?.organization?.disabledFeatures?.includes('ai')) return null;

  return (
    <WidgetFrame
      id="bot-performance"
      title="Bot performance · today"
      icon={Bot}
      // No accent — bot performance is neutral / informational.
      headerExtra={
        <span
          title="Resets daily in your account timezone."
          className="text-[10px] uppercase tracking-wider text-foreground-subtle"
        >
          TODAY
        </span>
      }
    >
      {q.isLoading ? (
        <WidgetSkeleton rows={3} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <WidgetEmpty title="No data yet." />
      ) : (
        <div className="space-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold leading-tight">{q.data.autoResolvedPercent}%</span>
            <span className="flex items-center gap-1 text-xs text-foreground-subtle">
              auto-resolved
              <span
                title="Auto-resolved = bot replies that ended the conversation without a human stepping in."
                className="inline-flex"
                aria-label="How auto-resolved is calculated"
              >
                <Info className="size-3" aria-hidden />
              </span>
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Stat label="Bot-handled msgs" value={formatThousands(q.data.botHandledMessages)} />
            <Stat
              label="Handed to human"
              value={formatThousands(q.data.handedToHuman)}
              href="/inbox?filter=escalated"
            />
          </dl>
          <div className="rounded-md bg-surface-muted/60 px-3 py-2 text-xs">
            <span className="text-foreground-subtle">Top FAQ </span>
            <span className="font-medium">“{q.data.topFaq}”</span>
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
      <dd className="text-xl font-semibold">{value}</dd>
    </>
  );
  if (!href) {
    return <div>{inner}</div>;
  }
  return (
    <Link
      href={href}
      className="block rounded-md p-1 -m-1 transition hover:bg-surface-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      aria-label={`${label}: ${value}. Opens escalated conversations.`}
    >
      {inner}
    </Link>
  );
}
