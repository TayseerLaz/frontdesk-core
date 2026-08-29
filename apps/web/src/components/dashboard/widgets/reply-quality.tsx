'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';

import { getReplyQuality } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';
import { useSession } from '@/lib/session';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function ReplyQualityWidget() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['dashboard', 'reply-quality'],
    queryFn: getReplyQuality,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  // Reply quality is an AI-bot metric — hide it when the AI feature is off.
  if (session?.organization?.disabledFeatures?.includes('ai')) return null;

  return (
    <WidgetFrame
      id="reply-quality"
      title="Reply quality"
      icon={ShieldCheck}
      headerExtra={
        <span className="text-[10px] uppercase tracking-wider text-foreground-subtle">7 DAYS</span>
      }
    >
      {q.isLoading ? (
        <WidgetSkeleton rows={2} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <WidgetEmpty title="No data yet." />
      ) : q.data.total === 0 ? (
        <WidgetEmpty
          title="No bot replies in the last 7 days."
          hint="Each AI reply is checked for unsupported claims; flags appear here."
        />
      ) : (
        (() => {
          const { total, flagged } = q.data;
          const flagRate = total > 0 ? Math.round((flagged / total) * 1000) / 10 : 0;
          const cleanPct = total > 0 ? Math.round(((total - flagged) / total) * 100) : 100;
          return (
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold leading-tight">{cleanPct}%</span>
                <span className="text-xs text-foreground-subtle">grounded replies</span>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-foreground-subtle">Replies checked</dt>
                  <dd className="text-lg font-semibold">{formatThousands(total)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-foreground-subtle">Flagged</dt>
                  <dd
                    className={
                      flagged > 0 ? 'text-lg font-semibold text-rose-600' : 'text-lg font-semibold'
                    }
                  >
                    {formatThousands(flagged)}
                    {flagged > 0 ? (
                      <span className="ml-1 text-xs font-normal text-foreground-subtle">
                        ({flagRate}%)
                      </span>
                    ) : null}
                  </dd>
                </div>
              </dl>
              <div className="rounded-md bg-surface-muted/60 px-3 py-2 text-xs text-foreground-subtle">
                {flagged === 0
                  ? 'No unsupported claims detected — clean week.'
                  : 'Flagged replies mention a product or price not found in your catalog.'}
              </div>
            </div>
          );
        })()
      )}
    </WidgetFrame>
  );
}
