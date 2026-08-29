'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle } from 'lucide-react';

import { getWalletOverview } from '@/lib/dashboard-api';
import { useSession } from '@/lib/session';

// Prominent banner at the top of the dashboard when the tenant's prepaid
// WhatsApp balance is running out. Driven by the server-provided
// `overview.alert`: solid red when running low (level 'alert'), pulsating darker
// red when empty (level 'empty'). Shares the 'billing'/'overview' query cache
// with the wallet widget + billing page, so no extra request.
export function WalletBalanceBanner() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ['billing', 'overview'],
    queryFn: getWalletOverview,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const d = q.data;

  // No WhatsApp for this tenant → no prepaid balance to warn about.
  if (session?.organization?.disabledFeatures?.includes('whatsapp')) return null;
  // Only when metering is on and the server flags a non-ok alert.
  if (!d || !d.metered || d.alert.level === 'ok') return null;

  const empty = d.alert.level === 'empty';
  const message = d.alert.message;

  return (
    <div
      role="alert"
      className={[
        'flex items-start gap-3 rounded-lg border-2 px-4 py-3',
        empty
          ? 'border-red-500 bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200 animate-pulse'
          : 'border-red-400 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200',
      ].join(' ')}
    >
      {empty ? (
        <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {message ??
            (empty
              ? 'WhatsApp sending is paused — your balance is empty. Contact ALIGNED to top up.'
              : 'WhatsApp balance running low. Contact ALIGNED to top up.')}
        </p>
      </div>
    </div>
  );
}
