'use client';

import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import Link from 'next/link';

import { getAudience } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

export function AudienceComplianceWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'audience'],
    queryFn: getAudience,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  return (
    <WidgetFrame id="audience" title="Audience & compliance" icon={Users} accent="green">
      {q.isLoading ? (
        <WidgetSkeleton rows={3} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <WidgetEmpty title="No data yet." />
      ) : q.data.total === 0 ? (
        <WidgetEmpty
          title="No contacts yet."
          hint="Inbound chats auto-add contacts; you can also import them."
        />
      ) : (
        (() => {
          const optOutRate =
            q.data.total > 0 ? Math.round((q.data.optedOut / q.data.total) * 100) : 0;
          return (
            <div className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold leading-tight">
                  {formatThousands(q.data.total)}
                </span>
                <span className="text-xs text-foreground-subtle">
                  contacts
                  {q.data.newThisWeek > 0 ? (
                    <span className="ml-1 text-emerald-700">+{q.data.newThisWeek} this week</span>
                  ) : null}
                </span>
              </div>
              <dl className="grid grid-cols-1 min-[400px]:grid-cols-3 gap-2 text-sm">
                <Stat
                  label="Opted out"
                  value={formatThousands(q.data.optedOut)}
                  tone={optOutRate >= 5 ? 'warning' : 'neutral'}
                />
                <Stat label="Opt-out rate" value={`${optOutRate}%`} tone={optOutRate >= 5 ? 'warning' : 'neutral'} />
                <Stat label="Blocked" value={formatThousands(q.data.blocked)} />
              </dl>
              <Link
                href="/contacts"
                className="block rounded-md bg-surface-muted/60 px-3 py-2 text-xs text-foreground-subtle transition hover:bg-surface-muted"
              >
                Manage contacts →
              </Link>
            </div>
          );
        })()
      )}
    </WidgetFrame>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'warning' | 'neutral';
}) {
  return (
    <div>
      <dt className="text-xs text-foreground-subtle">{label}</dt>
      <dd className={tone === 'warning' ? 'text-lg font-semibold text-amber-700' : 'text-lg font-semibold'}>
        {value}
      </dd>
    </div>
  );
}
