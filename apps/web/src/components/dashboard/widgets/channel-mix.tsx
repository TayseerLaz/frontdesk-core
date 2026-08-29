'use client';

import { useQuery } from '@tanstack/react-query';
import { Radio } from 'lucide-react';

import { getChannelMix } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

function channelLabel(c: string): string {
  return CHANNEL_LABELS[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

export function ChannelMixWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'channel-mix'],
    queryFn: getChannelMix,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  return (
    <WidgetFrame
      id="channel-mix"
      title="Channel mix"
      icon={Radio}
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
          const rows = [
            ...q.data.channels.map((c) => ({
              label: channelLabel(c.channel),
              value: c.conversations,
            })),
            ...(q.data.voiceCalls > 0
              ? [{ label: 'Voice', value: q.data.voiceCalls }]
              : []),
          ];
          const total = rows.reduce((s, r) => s + r.value, 0);
          if (total === 0) {
            return (
              <WidgetEmpty
                title="No conversations in the last 7 days."
                hint="Per-channel volume appears here once messages arrive."
              />
            );
          }
          return (
            <div className="space-y-2">
              {rows.map((r) => {
                const pct = total > 0 ? Math.round((r.value / total) * 100) : 0;
                return (
                  <div key={r.label}>
                    <div className="mb-0.5 flex items-baseline justify-between text-xs">
                      <span className="text-foreground-muted">{r.label}</span>
                      <span className="tabular-nums">
                        <span className="font-semibold text-foreground">
                          {formatThousands(r.value)}
                        </span>
                        <span className="ml-1 text-foreground-subtle">({pct}%)</span>
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
                      <div
                        className="h-full rounded-full bg-brand-500 transition-all"
                        style={{ width: `${Math.max(pct, r.value > 0 ? 3 : 0)}%` }}
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
