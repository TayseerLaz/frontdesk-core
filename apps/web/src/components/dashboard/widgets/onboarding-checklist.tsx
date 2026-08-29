'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, X } from 'lucide-react';
import Link from 'next/link';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getOnboardingChecklist } from '@/lib/dashboard-api';

import { useEditMode } from '../edit-mode-context';

// First-run golden path. The #1 felt-quality gap was "new tenants hit a blank
// canvas; the core loop is invisible." This presents setup as an opinionated,
// numbered path with visible progress and a clear next action — shown only
// while setup is incomplete. Reuses the existing onboarding data + the two
// dismiss paths (edit-mode KEEP + the X), so all the plumbing is unchanged.
export function OnboardingChecklistWidget() {
  const { editing, layout } = useEditMode();
  const q = useQuery({
    queryKey: ['dashboard', 'onboarding'],
    queryFn: getOnboardingChecklist,
    staleTime: 60_000,
  });

  if (layout.onboardingDismissed && !editing) return null;

  if (q.isLoading) {
    return (
      <div className="rounded-lg border border-border bg-surface p-5">
        <Skeleton className="h-5 w-40" />
        <div className="mt-4 space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      </div>
    );
  }
  if (q.isError || !q.data) return null;

  const { steps, complete } = q.data;
  if (complete && !editing) return null; // only while incomplete

  const done = steps.filter((s) => s.completed).length;
  const total = steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  // The first not-yet-done step is the "next action" — gets the primary CTA.
  const nextId = steps.find((s) => !s.completed)?.id;

  return (
    <div
      role="region"
      aria-label="Set up your workspace"
      className="relative overflow-hidden rounded-lg border border-border bg-surface"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Set up your bot</h2>
          <p className="text-xs text-foreground-muted">
            {total - done === 1
              ? 'One step left to a live AI assistant.'
              : `${total - done} steps to a live AI assistant — about 10 minutes.`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 sm:flex">
            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-elevated">
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono text-xs text-foreground-subtle">{done}/{total}</span>
          </div>
          {editing ? (
            <button
              type="button"
              onClick={() => layout.remove('onboarding')}
              className="rounded bg-surface-elevated px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-foreground-muted transition hover:text-foreground"
              aria-label="Remove from dashboard"
            >
              Keep
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => layout.dismissOnboarding()}
            className="rounded p-1 text-foreground-subtle transition hover:bg-surface-muted hover:text-foreground"
            aria-label="Dismiss setup guide"
            title="Dismiss"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <ol className="divide-y divide-border">
        {steps.map((step, i) => {
          const isNext = step.id === nextId;
          return (
            <li key={step.id}>
              <Link
                href={step.href}
                className={cn(
                  'group flex items-center gap-3 px-5 py-3 transition-colors',
                  isNext ? 'bg-brand-50/60' : 'hover:bg-surface-muted',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold',
                    step.completed
                      ? 'bg-success text-white'
                      : isNext
                        ? 'bg-brand-500 text-on-brand'
                        : 'border border-border-strong text-foreground-subtle',
                  )}
                >
                  {step.completed ? <Check className="size-3.5" aria-hidden /> : i + 1}
                </span>
                <span
                  className={cn(
                    'flex-1 text-sm',
                    step.completed ? 'text-foreground-muted line-through' : 'font-medium text-foreground',
                  )}
                >
                  {step.label}
                </span>
                {!step.completed ? (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-xs font-medium',
                      isNext ? 'text-brand-600' : 'text-foreground-subtle group-hover:text-foreground',
                    )}
                  >
                    {isNext ? 'Start' : 'Open'}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
