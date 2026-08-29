'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Inbox } from 'lucide-react';
import Link from 'next/link';

import { getInboxSnapshot } from '@/lib/dashboard-api';
import { formatDuration, formatThousands } from '@/lib/format';
import { cn } from '@/lib/utils';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function InboxSnapshotWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'inbox-snapshot'],
    queryFn: getInboxSnapshot,
    // Spec: refresh on an interval (every 30s) — operators leave the
    // dashboard open during shift handoffs and need fresh numbers.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return (
    <WidgetFrame id="inbox-snapshot" title="Inbox snapshot" icon={Inbox} accent="blue">
      {q.isLoading ? (
        <WidgetSkeleton rows={2} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <WidgetEmpty title="No inbox data yet." />
      ) : (
        <Snapshot data={q.data} />
      )}
    </WidgetFrame>
  );
}

function Snapshot({ data }: { data: NonNullable<ReturnType<typeof useQuery<Awaited<ReturnType<typeof getInboxSnapshot>>>>['data']> }) {
  const unassignedAlert = data.unassigned > 0;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Metric label="Open threads" value={formatThousands(data.openThreads)} href="/inbox" />
      <Metric
        label="Unassigned"
        value={formatThousands(data.unassigned)}
        href="/inbox?filter=unassigned"
        valueClassName={cn(unassignedAlert && 'text-red-600')}
        ariaPrefix={unassignedAlert ? 'Alert: ' : undefined}
      />
      <Metric label="Awaiting reply" value={formatThousands(data.awaitingReply)} href="/inbox?filter=awaiting" />
      <Metric label="Avg first response" value={formatDuration(data.avgFirstResponseSeconds)} href="/inbox" />
    </div>
  );
}

function Metric({
  label,
  value,
  href,
  valueClassName,
  ariaPrefix,
}: {
  label: string;
  value: string;
  href: string;
  valueClassName?: string;
  ariaPrefix?: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-md p-2 transition hover:bg-surface-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      aria-label={`${ariaPrefix ?? ''}${label}: ${value}`}
    >
      <span className={cn('text-2xl font-semibold leading-tight', valueClassName)}>{value}</span>
      <span className="mt-0.5 flex items-center gap-1 text-xs text-foreground-subtle">
        {label}
        <ArrowUpRight className="size-3 opacity-0 transition group-hover:opacity-100" aria-hidden />
      </span>
    </Link>
  );
}
