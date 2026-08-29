// Full-shell loading skeleton — mirrors AppShell's real geometry (oxblood
// sidebar at w-60, h-14 top bar, padded content) so the pre-auth / pre-data
// frame shows the actual layout shape instead of a floating box. Big
// perceived-speed win: the page "snaps" into the same silhouette it loads into.
import { Skeleton } from '@/components/ui/skeleton';

export function AppShellSkeleton() {
  return (
    <div className="flex h-dvh bg-surface-muted" aria-busy aria-label="Loading">
      {/* Sidebar — matches the oxblood brand panel (fixed colors, lg+ only). */}
      <aside className="hidden h-dvh w-60 shrink-0 flex-col gap-6 overflow-hidden rounded-r-2xl bg-[#360516] p-4 dark:bg-surface lg:flex">
        <div className="h-8 w-28 rounded-md bg-white/10 dark:bg-surface-elevated" />
        <div className="space-y-5">
          {[5, 3, 4, 2, 4].map((count, g) => (
            <div key={g} className="space-y-2">
              <div className="h-2.5 w-16 rounded bg-white/10 dark:bg-surface-elevated" />
              {Array.from({ length: count }).map((_, i) => (
                <div key={i} className="h-7 w-full rounded-md bg-white/[0.06] dark:bg-surface-elevated/70" />
              ))}
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 lg:px-4">
          <Skeleton className="h-8 w-72 rounded-md max-sm:w-9" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="size-8 rounded-full" />
          </div>
        </header>

        {/* Content — a KPI strip + a couple of card rows. */}
        <main className="flex-1 overflow-y-auto overscroll-none">
          <div className="container-page space-y-5 py-6">
            <div className="space-y-2">
              <Skeleton className="h-7 w-48" />
              <Skeleton className="h-4 w-72" />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-lg" />
              ))}
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-44 rounded-lg" />
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
