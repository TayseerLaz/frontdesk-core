'use client';

import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';

import { getAiBudgetToday, type AiBudgetToday } from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

import { WidgetError, WidgetFrame, WidgetSkeleton } from '../widget-frame';

// Every enforced limit the tenant can hit — the things that "stop" when full:
// the AI-message allowance (pauses the bot) plus plan messages/broadcasts/
// imports and catalog/member/key caps. Color-coded so the tenant sees what's
// close to a limit (amber ≥80%) or already reached (red 100%), and understands
// WHY something stopped. Pairs with the bell notifications fired before each cap.
export function UsageLimitsWidget() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['dashboard', 'ai-budget'],
    queryFn: getAiBudgetToday,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // The widget still shows plan quotas when AI is off — only the AI-messages
  // row is skipped. Quotas for features the tenant lacks are hidden entirely.
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const hasAi = !disabledFeatures.includes('ai');

  return (
    <WidgetFrame id="usage-limits" title="Usage & limits" icon={Gauge} accent="blue">
      {q.isLoading ? (
        <WidgetSkeleton rows={4} />
      ) : q.isError ? (
        <WidgetError onRetry={() => q.refetch()} />
      ) : !q.data ? null : (
        <Body data={q.data} hasAi={hasAi} disabledFeatures={disabledFeatures} />
      )}
    </WidgetFrame>
  );
}

interface Row {
  label: string;
  used: number;
  cap: number | null;
  pct: number | null;
}

// Which org-feature each plan-quota belongs to (hidden when the tenant lacks it).
const QUOTA_FEATURE: Record<string, string> = {
  monthly_broadcasts: 'broadcasts',
  monthly_imports: 'imports',
  products: 'products',
  services: 'services',
};

// Developer-plumbing quotas that aren't meaningful "usage" for a tenant — hidden
// from the tenant-facing Usage & limits widget (they read as "Unlimited" noise).
const HIDDEN_QUOTAS = new Set(['api_keys', 'webhooks']);

function Body({
  data,
  hasAi,
  disabledFeatures,
}: {
  data: AiBudgetToday;
  hasAi: boolean;
  disabledFeatures: string[];
}) {
  const rows: Row[] = [];
  // AI messages first — it's the cap that actually pauses the bot. Skipped for
  // tenants without the AI feature.
  if (hasAi && !data.unlimited) {
    rows.push({
      label: 'AI messages (bot replies)',
      used: data.messagesUsed,
      cap: data.messageCap,
      pct: data.percentUsed,
    });
  }
  for (const qa of data.quotas) {
    if (HIDDEN_QUOTAS.has(qa.key)) continue;
    const feat = QUOTA_FEATURE[qa.key];
    if (feat && disabledFeatures.includes(feat)) continue;
    rows.push({ label: qa.label, used: qa.used, cap: qa.cap, pct: qa.pct });
  }
  // Closest-to-stopping first (capped + highest %).
  rows.sort((a, b) => (b.cap == null ? -1 : b.pct ?? 0) - (a.cap == null ? -1 : a.pct ?? 0));

  const reached = rows.filter((r) => r.cap != null && (r.pct ?? 0) >= 100);
  const low = rows.filter((r) => r.cap != null && (r.pct ?? 0) >= 80 && (r.pct ?? 0) < 100);

  return (
    <div className="space-y-3">
      {reached.length > 0 ? (
        <p className="text-xs font-medium text-red-600 dark:text-red-400">
          {reached.map((r) => r.label).join(', ')} reached — those actions are paused until they
          reset.
        </p>
      ) : low.length > 0 ? (
        <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
          Close to a limit: {low.map((r) => r.label).join(', ')}. Upgrade or contact us before it
          stops.
        </p>
      ) : (
        <p className="text-xs text-foreground-muted">Everything is within its limit.</p>
      )}

      <div className="space-y-2">
        {rows.map((r) => (
          <QuotaRow key={r.label} {...r} />
        ))}
      </div>
    </div>
  );
}

function QuotaRow({ label, used, cap, pct }: Row) {
  const unlimited = cap == null;
  const p = unlimited ? 0 : Math.min(100, Math.max(0, pct ?? 0));
  const barColor = unlimited
    ? 'bg-emerald-500'
    : p >= 100
      ? 'bg-red-500'
      : p >= 80
        ? 'bg-amber-500'
        : 'bg-emerald-500';
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-foreground">{label}</span>
        <span
          className={cn(
            'shrink-0 tabular-nums',
            !unlimited && p >= 100 ? 'font-semibold text-red-600 dark:text-red-400' : 'text-foreground-muted',
          )}
        >
          {unlimited ? 'Unlimited' : `${formatThousands(used)} / ${formatThousands(cap)}`}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
        <div
          className={cn('h-full transition-all', barColor)}
          style={{ width: `${unlimited ? 8 : p}%`, opacity: unlimited ? 0.4 : 1 }}
        />
      </div>
    </div>
  );
}
