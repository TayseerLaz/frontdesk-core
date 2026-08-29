'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle } from 'lucide-react';

import { getAiBudgetToday } from '@/lib/dashboard-api';
import { useSession } from '@/lib/session';

// Prominent banner at the top of the dashboard when the tenant's MONTHLY
// AI-message allowance is running out (1 message = 1 bot reply / voice turn).
// This is the cap that PAUSES the bot, so it's the alert the operator must not
// miss. It PULSATES red from 80% (getting low) and goes solid red at 100%
// (allowance used → replies paused). Shares the 'ai-budget' query cache with the
// widget, so no extra request.
export function AiBudgetBanner() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['dashboard', 'ai-budget'],
    queryFn: getAiBudgetToday,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const d = q.data;
  // Tenants with the AI/bot feature off don't use AI messages — no banner.
  if (session?.organization?.disabledFeatures?.includes('ai')) return null;
  if (!d || d.unlimited) return null;
  const pct = Math.min(100, Math.max(0, Math.round(d.percentUsed)));
  if (pct < 80) return null; // only show when getting low

  const paused = pct >= 100;
  const used = d.messagesUsed;
  const cap = d.messageCap;
  return (
    <div
      role="alert"
      className={[
        'flex items-start gap-3 rounded-lg border-2 border-red-500 bg-red-50 px-4 py-3',
        'text-red-900 dark:bg-red-950/40 dark:text-red-200',
        // Pulsate while "getting low"; solid once the allowance is spent.
        paused ? '' : 'animate-pulse',
      ].join(' ')}
    >
      {paused ? (
        <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {paused
            ? 'AI replies paused — monthly allowance used up'
            : `AI messages running low — ${pct}% used`}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed">
          {cap != null
            ? `${used.toLocaleString()} / ${cap.toLocaleString()} AI messages used this month. `
            : ''}
          {paused
            ? 'The bot has stopped replying automatically. Reply to customers from the Inbox — the allowance resets on the 1st. Contact ALIGNED to raise it.'
            : 'When it reaches 100%, the bot stops replying automatically until the 1st. Contact ALIGNED to raise your allowance.'}
        </p>
      </div>
    </div>
  );
}
