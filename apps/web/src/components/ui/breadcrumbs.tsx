'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

export interface Crumb {
  label: string;
  href?: string;
}

/** Compact "you are here" trail. The last crumb is the current page (no link). */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={cn('flex items-center gap-1 text-xs text-foreground-subtle', className)}>
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${c.label}-${i}`} className="flex items-center gap-1">
            {c.href && !last ? (
              <Link href={c.href} className="transition-colors hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span className={cn(last && 'font-medium text-foreground-muted')} aria-current={last ? 'page' : undefined}>
                {c.label}
              </span>
            )}
            {!last ? <ChevronRight className="size-3 opacity-60" aria-hidden /> : null}
          </span>
        );
      })}
    </nav>
  );
}
