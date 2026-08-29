import { cn } from '@/lib/utils';

// A keyboard-key hint. Used for ⌘K and inbox shortcuts so power-user paths
// are discoverable inline.
export function Kbd({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface px-1.5 font-mono text-[11px] font-medium text-foreground-subtle',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
