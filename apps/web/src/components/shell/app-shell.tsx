'use client';

import { Menu, Search } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

import { CommandPaletteProvider, useCommandPalette } from './command-palette';
import { ControllingBanner } from './controlling-banner';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

// The ⌘K trigger — a search-box affordance so the command palette is
// discoverable (not just a hidden hotkey). Full pill on desktop, icon on mobile.
function CommandTrigger() {
  const { open } = useCommandPalette();
  return (
    <>
      <button
        onClick={open}
        className="hidden h-8 items-center gap-2 rounded-md border border-border bg-surface-muted pl-2.5 pr-1.5 text-sm text-foreground-subtle transition-colors hover:border-border-strong hover:text-foreground-muted sm:flex sm:w-72 lg:w-80"
        aria-label="Open command palette"
      >
        <Search className="size-4" />
        <span>Search…</span>
        <Kbd className="ml-auto">⌘K</Kbd>
      </button>
      <Button variant="ghost" size="icon" onClick={open} className="sm:hidden" aria-label="Search">
        <Search className="size-5" />
      </Button>
    </>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <CommandPaletteProvider>
      <div className="flex h-dvh bg-surface-muted">
        {/* Desktop sidebar — flush to the left edge, full height, with only the
            RIGHT corners rounded. Deep-oxblood brand panel (fixed colors so it
            stays dark in light mode too). */}
        <aside className="hidden h-dvh w-60 shrink-0 overflow-hidden rounded-r-2xl bg-[#360516] shadow-[0_8px_30px_-12px_rgba(54,5,22,0.35)] dark:bg-surface dark:shadow-none lg:block">
          <Sidebar />
        </aside>

        {/* Mobile sidebar drawer */}
        {mobileOpen ? (
          <div
            className="fixed inset-0 z-40 bg-foreground/30 lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        ) : null}
        <aside
          className={`fixed inset-y-0 left-0 z-50 w-60 transform border-r border-black/10 bg-[#360516] transition-transform dark:border-border dark:bg-surface lg:hidden ${
            mobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 lg:px-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="size-5" />
            </Button>
            <CommandTrigger />
            <TopBar />
          </header>
          {/* Impersonation banner — visible on every page while an ALIGNED admin
              is controlling a tenant, with a one-click way back. */}
          <ControllingBanner />
          {/* overscroll-none stops the rubber-band/scroll-chaining at the top and
              bottom of the content — the page stops exactly at its ends. */}
          <main className="flex-1 overflow-y-auto overscroll-none">
            <div className="container-page space-y-5 py-6 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
              {children}
            </div>
          </main>
        </div>
      </div>
    </CommandPaletteProvider>
  );
}
