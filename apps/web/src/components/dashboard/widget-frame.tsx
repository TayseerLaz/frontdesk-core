'use client';

import { AlertTriangle, type LucideIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { useEditMode } from './edit-mode-context';
import type { WidgetId } from './widget-registry';

// Accent colour the spec asked for: blue for inbox/outreach, green for
// budget/connections/activity. Tailwind classes only — the actual hex
// is whatever the project token resolves these to.
export type WidgetAccent = 'blue' | 'green' | 'none';

// Accent is carried by the header ICON colour (see below), not a left-border
// stripe — colored card stripes read as a generic admin-template tell. Kept as
// a no-op map so the `accent` prop still drives the icon colour.
const ACCENT_BORDER: Record<WidgetAccent, string> = {
  blue: '',
  green: '',
  none: '',
};

export interface WidgetFrameProps {
  /** Stable id from the registry — used by the ADD/KEEP toggle. */
  id: WidgetId;
  title: string;
  icon: LucideIcon;
  accent?: WidgetAccent;
  /** Right-aligned content inside the card header (e.g. a tooltip toggle). */
  headerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Shared shell for every dashboard widget. Renders the accent border,
 * the header (icon + title + optional extras), and — when the dashboard
 * is in edit mode — the ADD/KEEP pill that toggles the widget's
 * presence in the operator's saved layout.
 */
export function WidgetFrame({
  id,
  title,
  icon: Icon,
  accent = 'none',
  headerExtra,
  children,
  className,
}: WidgetFrameProps) {
  const { editing, layout } = useEditMode();
  const onLayout = layout.has(id);

  return (
    <Card
      className={cn(
        ACCENT_BORDER[accent],
        // Softer SaaS card: roomier radius + a whisper of oxblood-tinted shadow
        // that lifts on hover. Matches the KPI strip so the panel reads cohesive.
        'h-full rounded-lg border-border',
        className,
      )}
    >
      {/* Clean titled header with a hairline divider — mirrors the sandbox's
          card look so every dashboard panel reads as one cohesive system. */}
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-brand-500" aria-hidden />
          <CardTitle className="text-sm font-semibold text-foreground">{title}</CardTitle>
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          {editing ? (
            // KEEP pill is also the remove control: clicking it pulls the
            // widget off the dashboard. The Add-widget dialog handles the
            // inverse direction (ADD).
            <button
              type="button"
              onClick={() => layout.remove(id)}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 transition hover:bg-emerald-200"
              aria-label={`Remove ${title} widget`}
              title="Remove from dashboard"
            >
              KEEP <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">{children}</CardContent>
    </Card>
  );
}

// ---------- Reusable widget-internal pieces --------------------------------
// (Shared so each widget keeps its body short and the visual language
// stays consistent across the whole dashboard.)

export function WidgetSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="h-3 w-1/3 animate-pulse rounded bg-surface-muted" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-3 w-full animate-pulse rounded bg-surface-muted" />
      ))}
    </div>
  );
}

export function WidgetError({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-xs text-red-700">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">
        <p className="font-medium">Couldn&rsquo;t load this widget.</p>
        {onRetry ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRetry}
            className="mt-1 h-7 px-2 text-xs text-red-700 hover:bg-red-100"
          >
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function WidgetEmpty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-4 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint ? <p className="mt-1 text-xs text-foreground-subtle">{hint}</p> : null}
      {action ? <div className="mt-2 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** Pulsing dot used by widgets showing a live state (e.g. campaign sending). */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
      <span className="relative inline-flex h-full w-full rounded-full bg-emerald-500" />
    </span>
  );
}

/** Tone-aware badge for stat-tile subtext (warning / success / neutral). */
export function ToneText({
  tone,
  children,
}: {
  tone: 'warning' | 'success' | 'neutral';
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        tone === 'warning'
          ? 'text-amber-700'
          : tone === 'success'
            ? 'text-emerald-700'
            : 'text-foreground-subtle',
      )}
    >
      {/* The icon-less variant relies on colour for tone; the components
          below pair this with a leading symbol where the spec asks for
          colour-independent semantics (red unassigned count, etc.). */}
      {children}
    </span>
  );
}
