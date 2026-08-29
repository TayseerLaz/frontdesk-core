import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { Breadcrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: React.ReactNode;
  /** Optional uppercase eyebrow label above the title (e.g. "Overview"). */
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Optional "you are here" trail above the title. */
  breadcrumbs?: Crumb[];
  /** Optional back link shown above the title — use on any sub/detail page. */
  backHref?: string;
  /** Label for the back link (defaults to "Back"). */
  backLabel?: string;
  /** Optional row below the header — filters, tabs, a segmented control. */
  children?: React.ReactNode;
  className?: string;
}

// Neutral-minimal page header. Compact title (was an oversized 28px bold — a
// big part of the "too spacious" feel) + optional breadcrumb + actions, plus a
// slot for a filter/tab row. Used by ~46 pages, so tightening it here lifts the
// whole app at once. Vertical rhythm comes from app-shell's space-y wrapper.
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  breadcrumbs,
  backHref,
  backLabel,
  children,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          {backHref ? (
            <Link
              href={backHref}
              className="-ml-1 inline-flex items-center gap-1 rounded text-xs font-medium text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <ArrowLeft className="size-3.5" /> {backLabel ?? 'Back'}
            </Link>
          ) : null}
          {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
          {eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-foreground-subtle">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="truncate text-xl font-semibold leading-tight tracking-[-0.02em] text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm text-foreground-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
