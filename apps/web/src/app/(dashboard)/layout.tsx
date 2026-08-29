'use client';

import { isHrefBlockedByPageAccess, isHrefDisabled } from '@platform/shared';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { AiSupportProvider } from '@/components/admin/ai-support';
import { AppShell } from '@/components/shell/app-shell';
import { AppShellSkeleton } from '@/components/shell/app-shell-skeleton';
import { useSession } from '@/lib/session';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, session } = useSession();

  useEffect(() => {
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  // super-admin per-tenant access control: if the current page belongs to a
  // feature the admin disabled for this org, bounce away. (Sidebar already
  // hides it; this stops direct-URL access.) Manual-inbox tenants (AI off, not
  // a platform admin) land on the inbox instead of the empty dashboard.
  useEffect(() => {
    if (status !== 'authenticated' || !pathname) return;
    const disabled = session?.organization?.disabledFeatures ?? [];
    const isAdmin = session?.user.isSuperAdmin === true;
    const manualInbox = !isAdmin && disabled.includes('ai');
    if (manualInbox && (pathname === '/dashboard' || pathname === '/')) {
      router.replace('/inbox');
      return;
    }
    const pageAccess = session?.organization?.pageAccess ?? null;
    if (isHrefDisabled(pathname, disabled) || isHrefBlockedByPageAccess(pathname, pageAccess)) {
      router.replace(manualInbox ? '/inbox' : '/dashboard');
    }
  }, [status, pathname, session, router]);

  if (status !== 'authenticated') {
    return <AppShellSkeleton />;
  }

  return (
    <AiSupportProvider>
      <AppShell>{children}</AppShell>
    </AiSupportProvider>
  );
}
