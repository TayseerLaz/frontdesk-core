'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Plug, RefreshCw } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { getConnectionsSync, type WebhookHealth } from '@/lib/dashboard-api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

import { WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

const QUERY_KEY = ['dashboard', 'connections'] as const;

export function ConnectionsSyncWidget() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getConnectionsSync,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  // Mock "sync now" — invalidating the query is enough to demo the
  // round-trip. Wire to POST /connectors/:id/run when this is real.
  const syncNow = useMutation({
    mutationFn: async () => {
      await new Promise((r) => setTimeout(r, 600));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <WidgetFrame id="connections" title="Connections & sync" icon={Plug} accent="green">
      {q.isLoading ? (
        <WidgetSkeleton rows={3} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? null : (
        <ul className="divide-y divide-border text-sm">
          <li className="flex items-center justify-between py-2">
            <span className="text-foreground-muted">Last sync</span>
            {q.data.lastSyncIso ? (
              <span className="font-medium">{formatRelative(q.data.lastSyncIso)}</span>
            ) : (
              <span className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                  <AlertTriangle className="size-3" aria-hidden /> Never
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => syncNow.mutate()}
                  loading={syncNow.isPending}
                  className="h-7 px-2 text-xs"
                >
                  <RefreshCw className="size-3" /> Sync now
                </Button>
              </span>
            )}
          </li>
          <li className="flex items-center justify-between py-2">
            <span className="text-foreground-muted">Templates</span>
            <span className="flex items-center gap-2 text-xs">
              <span className="font-medium text-emerald-700">{q.data.templates.approved} approved</span>
              <span className="text-foreground-subtle">·</span>
              <Link
                href="/broadcasts?tab=templates"
                className="font-medium text-amber-700 hover:underline"
              >
                {q.data.templates.pending} pending
              </Link>
            </span>
          </li>
          <li className="flex items-center justify-between py-2">
            <span className="text-foreground-muted">Webhooks</span>
            <WebhookBadge health={q.data.webhooks} />
          </li>
        </ul>
      )}
    </WidgetFrame>
  );
}

function WebhookBadge({ health }: { health: WebhookHealth }) {
  const map: Record<
    WebhookHealth,
    { label: string; cls: string; icon: typeof CheckCircle2 }
  > = {
    healthy: { label: 'healthy', cls: 'text-emerald-700', icon: CheckCircle2 },
    degraded: { label: 'degraded', cls: 'text-amber-700', icon: AlertTriangle },
    failing: { label: 'failing', cls: 'text-red-700', icon: AlertTriangle },
  };
  const item = map[health];
  const Icon = item.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', item.cls)}>
      <Icon className="size-3" aria-hidden />
      {item.label}
    </span>
  );
}
