'use client';

import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  Bot,
  Briefcase,
  Building2,
  CalendarCheck,
  Contact as ContactIcon,
  Inbox,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Megaphone,
  Moon,
  Package,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Upload,
  Users,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { isHrefBlockedByPageAccess, isHrefDisabled } from '@platform/shared';

import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

interface Command {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  keywords?: string;
  href?: string;
  run?: () => void;
  adminOnly?: boolean;
  /** When the command maps to a feature route, gate it on disabledFeatures. */
  featureHref?: string;
}

interface Ctx {
  open: () => void;
}
const CommandCtx = React.createContext<Ctx>({ open: () => {} });
export const useCommandPalette = () => React.useContext(CommandCtx);

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const openPalette = React.useCallback(() => setOpen(true), []);

  // Global ⌘K / Ctrl+K.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <CommandCtx.Provider value={{ open: openPalette }}>
      {children}
      <Palette open={open} onOpenChange={setOpen} />
    </CommandCtx.Provider>
  );
}

function toggleTheme() {
  try {
    const root = document.documentElement;
    const isDark = root.classList.toggle('dark');
    root.style.colorScheme = isDark ? 'dark' : 'light';
    localStorage.setItem('platform:theme', isDark ? 'dark' : 'light');
  } catch {
    /* noop */
  }
}

function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const { session, signOut, switchOrg } = useSession();
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const isAdmin = !!session?.user.isSuperAdmin;
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];

  const commands = React.useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'dashboard', label: 'Dashboard', group: 'Go to', icon: LayoutDashboard, href: '/dashboard' },
      { id: 'inbox', label: 'Inbox', group: 'Go to', icon: Inbox, href: '/inbox', keywords: 'chat messages conversations' },
      { id: 'contacts', label: 'Contacts', group: 'Go to', icon: ContactIcon, href: '/contacts', keywords: 'crm customers' },
      { id: 'broadcasts', label: 'Broadcasts & templates', group: 'Go to', icon: Megaphone, href: '/broadcasts', keywords: 'campaign blast' },
      { id: 'products', label: 'Products', group: 'Go to', icon: Package, href: '/products' },
      { id: 'services', label: 'Services', group: 'Go to', icon: Briefcase, href: '/services' },
      { id: 'categories', label: 'Categories', group: 'Go to', icon: Building2, href: '/categories' },
      { id: 'business', label: 'Business info', group: 'Go to', icon: Building2, href: '/business-info' },
      { id: 'orders', label: 'Orders', group: 'Go to', icon: ShoppingCart, href: '/cart' },
      { id: 'bookings', label: 'Bookings', group: 'Go to', icon: CalendarCheck, href: '/bookings' },
      { id: 'bot', label: 'AI bot builder', group: 'Go to', icon: Bot, href: '/bot', keywords: 'persona deploy' },
      { id: 'imports', label: 'Imports', group: 'Go to', icon: Upload, href: '/imports', keywords: 'csv upload' },
      { id: 'members', label: 'Members', group: 'Go to', icon: Users, href: '/members', keywords: 'team users invite' },
      { id: 'settings', label: 'Settings', group: 'Go to', icon: Settings, href: '/settings' },
    ];
    const actions: Command[] = [
      { id: 'new-product', label: 'New product', group: 'Create', icon: Plus, href: '/products?new=1' },
      { id: 'new-broadcast', label: 'New broadcast', group: 'Create', icon: Plus, href: '/broadcasts/new' },
      { id: 'new-import', label: 'Import a CSV', group: 'Create', icon: Upload, href: '/imports?new=1' },
      { id: 'theme', label: 'Toggle light / dark theme', group: 'Actions', icon: Moon, run: toggleTheme, keywords: 'dark mode light' },
      { id: 'signout', label: 'Sign out', group: 'Actions', icon: LogOut, run: () => void signOut() },
    ];
    const admin: Command[] = isAdmin
      ? [
          { id: 'hq-tenants', label: 'HQ · Tenants', group: 'HQ', icon: ShieldCheck, href: '/hq', adminOnly: true },
          { id: 'hq-system', label: 'HQ · System health', group: 'HQ', icon: ShieldCheck, href: '/hq/system', adminOnly: true },
        ]
      : [];
    const orgs: Command[] =
      (session?.availableOrganizations ?? [])
        .filter((o) => o.id !== session?.organization?.id)
        .map((o) => ({
          id: `org-${o.id}`,
          label: `Switch to ${o.name}`,
          group: 'Organization',
          icon: Building2,
          keywords: 'org tenant switch',
          run: () => void switchOrg(o.id),
        }));
    return [...nav, ...actions, ...admin, ...orgs].filter(
      (c) =>
        (!c.href ||
          (!isHrefDisabled(c.href.split('?')[0]!, disabledFeatures) &&
            !isHrefBlockedByPageAccess(c.href.split('?')[0]!, session?.organization?.pageAccess ?? null))),
    );
  }, [isAdmin, disabledFeatures, session, signOut, switchOrg]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.keywords ?? ''} ${c.group}`.toLowerCase().includes(q));
  }, [commands, query]);

  React.useEffect(() => setActive(0), [query, open]);

  const run = React.useCallback(
    (c: Command | undefined) => {
      if (!c) return;
      onOpenChange(false);
      setQuery('');
      if (c.href) router.push(c.href);
      else c.run?.();
    },
    [onOpenChange, router],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(filtered[active]);
    }
  };

  // Keep the active row scrolled into view.
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // Group while preserving order.
  let lastGroup = '';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-foreground/20 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          onKeyDown={onKeyDown}
          className="fixed left-1/2 top-[12vh] z-[101] w-[min(36rem,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg focus:outline-none"
          aria-label="Command palette"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-foreground-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pages and actions…"
              className="h-11 w-full bg-transparent text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-foreground-subtle">No matches for “{query}”.</p>
            ) : (
              filtered.map((c, i) => {
                const Icon = c.icon;
                const header = c.group !== lastGroup ? c.group : null;
                lastGroup = c.group;
                return (
                  <React.Fragment key={c.id}>
                    {header ? (
                      <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground-subtle">
                        {header}
                      </p>
                    ) : null}
                    <button
                      data-idx={i}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => run(c)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                        i === active ? 'bg-surface-elevated text-foreground' : 'text-foreground-muted',
                      )}
                    >
                      <Icon className={cn('size-4 shrink-0', i === active ? 'text-brand-500' : 'text-foreground-subtle')} />
                      <span className="flex-1 truncate">{c.label}</span>
                      {i === active ? <ArrowRight className="size-3.5 shrink-0 text-foreground-subtle" /> : null}
                    </button>
                  </React.Fragment>
                );
              })
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
