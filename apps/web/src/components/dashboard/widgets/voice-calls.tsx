'use client';

import { useQuery } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';

import { getVoice } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function VoiceCallsWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'voice'],
    queryFn: getVoice,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  return (
    <WidgetFrame
      id="voice-calls"
      title="Voice calls"
      icon={PhoneCall}
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
          title="No calls in the last 7 days."
          hint="Calls handled by the phone voicebot are summarised here."
        />
      ) : (
        (() => {
          const { total, completed, handoff, dropped } = q.data;
          const handoffRate = total > 0 ? Math.round((handoff / total) * 100) : 0;
          return (
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold leading-tight">
                  {formatThousands(total)}
                </span>
                <span className="text-xs text-foreground-subtle">calls handled</span>
              </div>
              <dl className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-foreground-subtle">Completed</dt>
                  <dd className="text-lg font-semibold text-emerald-700">
                    {formatThousands(completed)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-foreground-subtle">To human</dt>
                  <dd className="text-lg font-semibold">{formatThousands(handoff)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-foreground-subtle">Dropped</dt>
                  <dd className={dropped > 0 ? 'text-lg font-semibold text-amber-700' : 'text-lg font-semibold'}>
                    {formatThousands(dropped)}
                  </dd>
                </div>
              </dl>
              <div className="rounded-md bg-surface-muted/60 px-3 py-2 text-xs text-foreground-subtle">
                {handoffRate}% handed to a human
              </div>
            </div>
          );
        })()
      )}
    </WidgetFrame>
  );
}
