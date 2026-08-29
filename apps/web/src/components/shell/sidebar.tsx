'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Bot,
  Briefcase,
  Building2,
  CalendarCheck,
  Contact as ContactIcon,
  ExternalLink,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Megaphone,
  Package,
  PhoneCall,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Tags,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { isHrefBlockedByPageAccess, isHrefDisabled } from '@platform/shared';

import { useAiSupport } from '@/components/admin/ai-support';
import { AlignedLogo } from '@/components/brand/logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  badgeKey?: BadgeKey;
  newTab?: boolean;
  // Role-aware placement: `adminOnly` shows the item only to ALIGNED admins;
  // `hideForAdmin` hides it from admins (because it's relocated into the
  // ALIGNED HQ group for them, but stays in Configure for regular tenants).
  // `hideForAdminHome` hides it only while the admin is in their OWN HQ account
  // (it stays visible when the admin is controlling a tenant, so tenant-only
  // features like voice calls still show inside that tenant's portal).
  adminOnly?: boolean;
  hideForAdmin?: boolean;
  hideForAdminHome?: boolean;
  // When an ALIGNED admin is in their own HQ account, route this item here
  // instead of `href` (e.g. Activity log → the cross-tenant view).
  adminHomeHref?: string;
}

type BadgeKey = 'inboxEscalated';

interface NavGroup {
  label: string;
  items: NavItem[];
}

// Clearer information architecture: five plain-language groups that map a
// tenant's mental model (what I do daily · what I sell · transactions · setup).
// Advanced integrations (connectors/webhooks/API keys) are SURFACED under
// Configure instead of hidden — discoverable, just out of the daily path.
const groups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, exact: true },
      { href: '/analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    label: 'Operate',
    items: [
      { href: '/inbox-full', label: 'Inbox', icon: Inbox, badgeKey: 'inboxEscalated', newTab: true },
      { href: '/voice-calls', label: 'Voice calls', icon: PhoneCall, hideForAdminHome: true },
      { href: '/contacts', label: 'Contacts', icon: ContactIcon },
      { href: '/broadcasts', label: 'Broadcasts', icon: Megaphone },
      // Canned replies moved INTO the inbox (a dialog from the inbox header),
      // so it's no longer a separate nav item. The /inbox/canned route still
      // resolves for deep links + the command palette.
    ],
  },
  {
    label: 'Business',
    items: [
      { href: '/products', label: 'Products', icon: Package },
      { href: '/services', label: 'Services', icon: Briefcase },
      { href: '/categories', label: 'Categories', icon: Tags },
      { href: '/business-info', label: 'Business info', icon: Building2 },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { href: '/cart', label: 'Orders', icon: ShoppingCart },
      { href: '/bookings', label: 'Bookings', icon: CalendarCheck },
    ],
  },
  {
    label: 'Configure',
    items: [
      { href: '/bot', label: 'AI bot builder', icon: Bot },
      // Bulk import lives contextually on Products / Services / Business info now
      // (a "Bulk import" button per page). /imports route + ⌘K still work.
      // Tenants (ALIGNED HQ) shows here for admins. Members + Settings show here
      // for regular tenants but move into the ALIGNED HQ group for admins.
      { href: '/hq', label: 'Tenants', icon: ShieldCheck, adminOnly: true },
      { href: '/members', label: 'Members', icon: Users, hideForAdmin: true },
      { href: '/billing', label: 'Billing', icon: Wallet, hideForAdminHome: true },
      // ALIGNED admins in HQ get the cross-tenant activity log (all tenants);
      // regular tenants + admins controlling a tenant get the org-scoped one.
      { href: '/audit-log', label: 'Activity log', icon: Activity, adminHomeHref: '/hq/audit' },
      // Developer integrations (Connectors / Webhooks / API keys) live under
      // Settings now, not the nav. Routes still resolve + the command palette
      // (⌘K) still reaches them.
      { href: '/settings', label: 'Settings', icon: Settings, hideForAdmin: true },
    ],
  },
];

const superAdminItems: NavItem[] = [
  // Tenants now lives in the Configure group for admins. Members + Settings are
  // relocated here for admins (they stay in Configure for regular tenants).
  { href: '/members', label: 'Members', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/hq/eval', label: 'Bot quality', icon: FlaskConical },
  { href: '/hq/system', label: 'System health', icon: Activity },
];

export function Sidebar({
  onNavigate,
  collapsed = false,
}: { onNavigate?: () => void; collapsed?: boolean; onToggleCollapsed?: () => void } = {}) {
  const pathname = usePathname();
  const { session } = useSession();

  const counts = useQuery({
    enabled: !!session,
    queryKey: ['sidebar-inbox-counts'],
    queryFn: () =>
      api.get<{ data: { escalated: number; pending: number; open: number } }>('/api/v1/inbox/counts'),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const badges: Record<BadgeKey, number> = {
    inboxEscalated: counts.data?.data.escalated ?? 0,
  };

  const { open: openAiSupport } = useAiSupport();
  const isAdmin = !!session?.user.isSuperAdmin;
  // "Admin home" = an ALIGNED admin viewing their OWN HQ org (not controlling a
  // tenant). Controlling = active org isn't one of the admin's own memberships.
  const adminOrgIds = new Set((session?.availableOrganizations ?? []).map((o) => o.id));
  const isControlling =
    isAdmin && !!session?.organization && !adminOrgIds.has(session.organization.id);
  const isAdminHome = isAdmin && !isControlling;

  // The destination for an item, honouring the admin-home override.
  const hrefFor = (item: NavItem) =>
    isAdminHome && item.adminHomeHref ? item.adminHomeHref : item.href;
  const isActive = (item: NavItem) => {
    const href = hrefFor(item);
    return item.exact ? pathname === href : pathname.startsWith(href);
  };
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const visibleGroups = groups
    .map((g) => ({
      ...g,
      items: g.items
        .filter(
          (it) =>
            !isHrefDisabled(it.href, disabledFeatures) &&
            !isHrefBlockedByPageAccess(it.href, session?.organization?.pageAccess ?? null) &&
            !(it.adminOnly && !isAdmin) &&
            !(it.hideForAdmin && isAdmin) &&
            !(it.hideForAdminHome && isAdminHome),
        ),
    }))
    .filter((g) => g.items.length > 0);

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = !item.newTab && isActive(item);
    const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
    const showBadge = badgeCount > 0;
    return (
      <Link
        key={item.href}
        href={hrefFor(item)}
        onClick={onNavigate}
        target={item.newTab ? 'aligned-inbox' : undefined}
        rel={item.newTab ? 'noopener noreferrer' : undefined}
        prefetch={item.newTab ? false : undefined}
        title={
          collapsed
            ? `${item.label}${item.newTab ? ' (new tab)' : ''}${showBadge ? ` (${badgeCount})` : ''}`
            : item.newTab
              ? 'Opens the full-screen inbox in its own tab'
              : undefined
        }
        aria-label={item.newTab ? `${item.label} (opens in a new tab)` : item.label}
        className={cn(
          'relative flex items-center rounded-xl text-[13px] font-medium transition-colors duration-[var(--dur-fast)]',
          collapsed ? 'justify-center px-2 py-2' : 'gap-2.5 px-2.5 py-1.5',
          active
            ? 'bg-white/[0.12] text-white dark:bg-surface-elevated dark:text-foreground'
            : 'text-white/65 hover:bg-white/[0.07] hover:text-white dark:text-foreground-muted dark:hover:bg-surface-muted dark:hover:text-foreground',
        )}
      >
        <Icon
          className={cn(
            'size-4 shrink-0',
            active ? 'text-white dark:text-brand-500' : 'text-white/55 dark:text-foreground-subtle',
          )}
        />
        {collapsed ? null : <span className="truncate">{item.label}</span>}
        {!collapsed && item.newTab ? (
          <ExternalLink className="ml-auto size-3 shrink-0 opacity-40" aria-hidden />
        ) : null}
        {showBadge ? (
          collapsed ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-coral-500 px-1 text-[10px] font-semibold text-white">
              {badgeCount > 9 ? '9+' : badgeCount}
            </span>
          ) : (
            <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded bg-coral-500 px-1 text-[11px] font-semibold text-white">
              {badgeCount > 99 ? '99+' : badgeCount}
            </span>
          )
        ) : null}
      </Link>
    );
  };

  return (
    <div className="flex h-full flex-col bg-[#360516] text-white dark:bg-surface dark:text-foreground">
      <div
        className={cn(
          'flex h-14 items-center border-b border-white/10 dark:border-border',
          collapsed ? 'justify-center px-2' : 'px-4',
        )}
      >
        {/* currentColor-masked logo → cream on the oxblood (light) panel; the
            brand token (white in dark) restores the original dark-mode logo.
            h-7 shrinks the wordmark from the 36px default. */}
        <AlignedLogo iconOnly={collapsed} className="h-7 text-[#f7eef0] dark:text-brand-500" />
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto overscroll-none p-2.5">
        {visibleGroups.map((group) => (
          <div key={group.label} className="space-y-0.5">
            {!collapsed ? (
              <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/40 dark:text-foreground-subtle">
                {group.label}
              </p>
            ) : null}
            {group.items.map(renderItem)}
          </div>
        ))}

        {session?.user.isSuperAdmin ? (
          <div className="space-y-0.5 border-t border-white/10 pt-4 dark:border-border">
            {!collapsed ? (
              <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#e9aab7] dark:text-brand-500">
                ALIGNED HQ
              </p>
            ) : null}
            {/* AI support copilot button — hidden for now (panel + endpoint
                stay wired; re-enable by restoring this button). */}
            {false ? (
              <button
                type="button"
                onClick={() => {
                  openAiSupport();
                  onNavigate?.();
                }}
                title="AI support"
                aria-label="AI support"
                className={cn(
                  'group relative flex w-full items-center rounded-xl text-[13px] font-semibold transition-colors duration-[var(--dur-fast)]',
                  collapsed ? 'justify-center px-2 py-2' : 'gap-2.5 px-2.5 py-1.5',
                  'bg-white/[0.08] text-white hover:bg-white/[0.16] dark:bg-brand-500/10 dark:text-brand-500 dark:hover:bg-brand-500/20',
                )}
              >
                <Sparkles className="size-4 shrink-0 text-[#f7c9d4] dark:text-brand-500" />
                {collapsed ? null : <span className="truncate">AI support</span>}
              </button>
            ) : null}
            {superAdminItems.map(renderItem)}
          </div>
        ) : null}
      </nav>
    </div>
  );
}
