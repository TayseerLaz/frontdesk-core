'use client';

import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { formatThousands } from '@/lib/format';
import { cn } from '@/lib/utils';

import { LiveDot, WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

// Recent broadcasts with their live status — clicking any row opens that
// broadcast. Polls while anything is in flight so "sending" counts stay live.
interface BroadcastRow {
  id: string;
  name: string;
  status: string;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  createdAt: string;
}

const STATUS_TONE: Record<string, string> = {
  sending: 'border-blue-200 bg-blue-50 text-blue-700',
  scheduled: 'border-amber-200 bg-amber-50 text-amber-800',
  paused: 'border-amber-200 bg-amber-50 text-amber-800',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  cancelled: 'border-border bg-surface-muted text-foreground-muted',
  draft: 'border-border bg-surface-muted text-foreground-muted',
};

function statusLabel(s: string): string {
  return s === 'sending' ? 'sending live' : s;
}

export function OutreachCampaignsWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'outreach-list'],
    queryFn: () => api.get<{ data: BroadcastRow[] }>('/api/v1/broadcasts?limit=6'),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const rows = q.data?.data ?? [];

  return (
    <WidgetFrame
      id="outreach"
      title="Outreach & campaigns"
      icon={Send}
      accent="blue"
      headerExtra={
        <Link href="/broadcasts" className="text-xs font-medium text-brand-600 hover:underline">
          All →
        </Link>
      }
    >
      {q.isLoading ? (
        <WidgetSkeleton rows={3} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <WidgetEmpty
          title="No broadcasts yet."
          hint="Send a one-off message to a list of contacts."
          action={
            <Button asChild size="sm">
              <Link href="/broadcasts/new">Create broadcast</Link>
            </Button>
          }
        />
      ) : (
        <ul className="space-y-1">
          {rows.map((b) => (
            <li key={b.id}>
              <Link
                href={`/broadcasts/${b.id}`}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {b.status === 'sending' ? <LiveDot /> : null}
                  <span className="truncate text-sm font-medium">{b.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {b.failedCount > 0 ? (
                    <span className="text-[11px] font-medium text-red-600">
                      {formatThousands(b.failedCount)} failed
                    </span>
                  ) : b.status === 'sending' ? (
                    <span className="text-[11px] text-foreground-subtle">
                      {formatThousands(b.sentCount)}/{formatThousands(b.totalRecipients)}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                      STATUS_TONE[b.status] ?? 'border-border bg-surface-muted text-foreground-muted',
                    )}
                  >
                    {statusLabel(b.status)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}
