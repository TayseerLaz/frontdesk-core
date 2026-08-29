'use client';

import { AdminPlatformDashboard } from '@/components/dashboard/admin-platform-dashboard';
import { TenantOverview } from '@/components/dashboard/tenant-overview';
import type { WidgetId } from '@/components/dashboard/widget-registry';
import { useSession } from '@/lib/session';
import { fullName } from '@/lib/utils';

// The dashboard has two faces:
//   • HQ (admin on their own org) → platform overview across all tenants.
//   • A tenant (incl. an admin "controlling" one) → the sandbox-style overview:
//     hero KPIs, a conversations chart, recent activity, this week's bookings,
//     and an Inbox CTA — all on that tenant's live data.
export default function DashboardPage() {
  const { session } = useSession();
  const greeting = session
    ? (fullName(session.user.firstName, session.user.lastName, '').split(' ')[0] ?? '')
    : '';

  // Gate: the user is an super-admin AND the active org is one of their real
  // memberships. While "controlling" a tenant (impersonation mints a
  // no-membership session for that org), the active org is NOT in
  // availableOrganizations — so the admin sees that tenant's normal overview.
  const inOwnHqAsAdmin =
    !!session?.user.isSuperAdmin &&
    session.availableOrganizations.some((o) => o.id === session.organization.id);

  if (inOwnHqAsAdmin) {
    return <AdminPlatformDashboard greeting={greeting} />;
  }

  return <TenantOverview greeting={greeting} />;
}

// Type-only re-export kept for callers that wired against the old page shape.
export type { WidgetId };
