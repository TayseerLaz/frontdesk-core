'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/lib/session';

/**
 * Layout for chrome-less, full-tab workspaces (e.g. /inbox-full).
 *
 * Security: identical auth gate to the dashboard layout — an unauthenticated
 * visitor is bounced to /login and never sees a frame of the UI. There is NO
 * weaker path in here: the page renders the same components that hit the same
 * RBAC- + RLS-enforced API. The only thing dropped versus the dashboard is the
 * visual chrome (sidebar + top bar), not a single security control. The route
 * also inherits the app-wide CSP (`frame-ancestors 'none'`), `X-Frame-Options:
 * DENY`, HSTS and COOP from middleware.ts + next.config, so it can't be framed
 * or clickjacked.
 */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status } = useSession();

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="w-48 space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  // No AppShell: the workspace owns the whole viewport.
  return <div className="min-h-dvh bg-surface-muted/30">{children}</div>;
}
