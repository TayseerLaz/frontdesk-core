import { cn } from '@/lib/utils';

// Neutral-minimal loading placeholder. Use shapes that MATCH the real layout
// (a row skeleton for a table, a card skeleton for a card) so there's no
// layout shift when data arrives — never a bare "Loading…" string.
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-surface-elevated', className)}
      {...props}
    />
  );
}

// A few presets for the common cases.

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

/** N table-style rows. Drop into a table body / list while data loads. */
export function SkeletonRows({ rows = 6, cols = 4, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={cn('divide-y divide-border', className)}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-3" style={{ height: 'var(--density-row)' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn('h-3.5', c === 0 ? 'w-1/3' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface p-5', className)}>
      <Skeleton className="h-4 w-1/3" />
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </div>
  );
}
