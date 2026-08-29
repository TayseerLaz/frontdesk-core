'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpRight,
  Bot,
  Briefcase,
  Building2,
  LogIn,
  type LucideIcon,
  Megaphone,
  Package,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { getRecentActivity } from '@/lib/dashboard-api';
import { formatRelative } from '@/lib/format';

import { WidgetEmpty, WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

// Wider than the ActivityKind union so the widget keeps working when
// the API surfaces a new action type before this file gets updated —
// unknown kinds fall through to the generic Activity icon below.
const ICON_BY_KIND: Record<string, LucideIcon> = {
  product_updated: Package,
  product_created: Package,
  service_updated: Briefcase,
  service_created: Briefcase,
  login_succeeded: LogIn,
  business_info_updated: Building2,
  broadcast_sent: Megaphone,
  bot_deployed: Bot,
  bot_undeployed: Bot,
  faq_updated: Activity,
  faq_created: Activity,
  policy_updated: Activity,
};

export function RecentActivityWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'recent-activity'],
    queryFn: getRecentActivity,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // formatRelative renders "5m ago"; the dashboard stays open a long
  // time so the strings drift. Force a re-render every 30s — cheap and
  // avoids the operator looking at "5m ago" for an hour straight.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <WidgetFrame id="recent-activity" title="Recent activity" icon={Activity} accent="green">
      {q.isLoading ? (
        <WidgetSkeleton rows={3} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data || q.data.length === 0 ? (
        <WidgetEmpty title="No activity yet." hint="Changes show up here as your team makes them." />
      ) : (
        <>
          <ul className="space-y-2 text-sm">
            {q.data.slice(0, 5).map((event) => {
              const Icon = ICON_BY_KIND[event.kind] ?? Activity;
              return (
                <li key={event.id} className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-muted">
                    <Icon className="size-3.5 text-foreground-subtle" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-foreground">{event.description}</p>
                    <p className="text-xs text-foreground-subtle">{formatRelative(event.at)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <Link
            href="/audit-log"
            className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
          >
            View all <ArrowUpRight className="size-3" aria-hidden />
          </Link>
        </>
      )}
    </WidgetFrame>
  );
}
