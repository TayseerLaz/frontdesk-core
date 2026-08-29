'use client';

import { useQuery } from '@tanstack/react-query';
import {
  HelpCircle,
  Info,
  Package,
  Plus,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { isHrefDisabled } from '@platform/shared';

import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getIncompleteServices,
  getKpiStrip,
  type KpiTile,
  type ServiceMissingField,
} from '@/lib/dashboard-api';
import { formatThousands } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

import { useEditMode } from '../edit-mode-context';

// The KPI strip is one logical widget but four visual tiles. Treating
// it as one widget keeps the ADD/KEEP UX coherent — "I want the counts
// row" is one decision, not four. Individual tile actions (ADD link
// on Contacts, etc.) still ride on each tile.

const KPI_QUERY_KEY = ['dashboard', 'kpi-strip'] as const;

// Per-tile accent icon (the soft chip top-right) — gives each KPI card the
// polished SaaS look while staying on Hader's restrained palette.
const KPI_ICON: Record<string, LucideIcon> = {
  products: Package,
  services: Sparkles,
  faqs: HelpCircle,
  contacts: Users,
};

export function KpiStripWidget() {
  const { editing, layout } = useEditMode();
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const q = useQuery({
    queryKey: KPI_QUERY_KEY,
    queryFn: getKpiStrip,
    staleTime: 30_000,
  });

  if (q.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="h-[124px] animate-pulse rounded-2xl" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="rounded-md bg-red-50 p-3 text-xs text-red-700">
        Could not load key counts. <button onClick={() => q.refetch()} className="underline">Retry</button>
      </div>
    );
  }
  // Drop tiles whose page the tenant doesn't have (e.g. Products/Services when
  // the catalog feature is off). If nothing's left, hide the whole strip.
  const tiles = (q.data?.tiles ?? []).filter(
    (t) => !t.href || !isHrefDisabled(t.href, disabledFeatures),
  );
  if (tiles.length === 0) return null;

  return (
    <div className="relative">
      {editing ? (
        <button
          type="button"
          onClick={() => layout.remove('kpi-strip')}
          className="absolute -top-2 right-0 z-10 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 transition hover:bg-emerald-200"
          aria-label="Remove key counts strip"
          title="Remove from dashboard"
        >
          KEEP <X className="size-3" aria-hidden />
        </button>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <KpiTileCard key={t.id} tile={t} />
        ))}
      </div>
    </div>
  );
}

function KpiTileCard({ tile }: { tile: KpiTile }) {
  const showHint = tile.hint?.kind === 'services-incomplete' && tile.subtextTone === 'warning';
  const Icon = KPI_ICON[tile.id] ?? Package;

  return (
    // Sandbox-style stat tile: icon + label on top, a big mono figure, then a
    // tone-coloured delta line. Stretched-link pattern — one overlay <Link>
    // covers the card; interactive children (ADD, the missing-details hint)
    // opt back into pointer events above it.
    <Card className="group relative h-full rounded-2xl border-border/80 shadow-[0_1px_2px_rgba(54,5,22,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-8px_rgba(54,5,22,0.12)]">
      <Link
        href={tile.href}
        aria-label={`${tile.label}: ${tile.value}. ${tile.subtext}.`}
        className="absolute inset-0 z-0 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      />
      <CardContent className="pointer-events-none relative z-10 p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-foreground-muted">
            <Icon className="size-[1.05rem] shrink-0 text-foreground-subtle" aria-hidden />
            {tile.label}
          </p>
          {tile.action ? (
            <Link
              href={tile.action.href}
              className="pointer-events-auto relative z-20 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-500 transition hover:bg-brand-100"
              aria-label={`${tile.action.label} ${tile.label.toLowerCase()}`}
            >
              <Plus className="size-3" aria-hidden /> {tile.action.label}
            </Link>
          ) : null}
        </div>
        <p
          className="mt-2.5 font-mono text-[1.85rem] font-semibold leading-none tracking-[-0.02em] tabular-nums"
          aria-hidden
        >
          {formatThousands(tile.value)}
        </p>
        {showHint ? (
          <MissingServicesHint subtext={tile.subtext} />
        ) : (
          <p
            className={cn(
              'mt-1.5 text-xs font-semibold',
              tile.subtextTone === 'warning'
                ? 'text-amber-700'
                : tile.subtextTone === 'success'
                  ? 'text-emerald-700'
                  : 'text-foreground-subtle',
            )}
          >
            {tile.subtext}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const MISSING_FIELD_LABEL: Record<ServiceMissingField, string> = {
  description: 'description',
  price: 'base price',
};

// Press-to-reveal breakdown for the Services tile. The subtext counts how
// many services lack a description and/or a base price; this lists exactly
// which ones and what each is missing, each row deep-linking to its editor.
// The list is fetched lazily — only once the dropdown is first opened.
function MissingServicesHint({ subtext }: { subtext: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['dashboard', 'incomplete-services'],
    queryFn: getIncompleteServices,
    enabled: open,
    staleTime: 30_000,
  });
  const services = q.data ?? [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="pointer-events-auto relative z-20 mt-1 flex w-full items-center gap-1 rounded text-xs text-amber-700 transition hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={`${subtext} — show which services are incomplete`}
        >
          <span aria-hidden>!</span>
          {subtext}
          <Info className="ml-auto size-3" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-auto">
        <DropdownMenuLabel>Missing a description or base price</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {q.isLoading ? (
          <div className="space-y-2 px-2 py-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ) : q.isError ? (
          <p className="px-2 py-2 text-xs text-red-700">Couldn’t load the list.</p>
        ) : services.length === 0 ? (
          <p className="px-2 py-2 text-xs text-foreground-subtle">Nothing missing — all set.</p>
        ) : (
          services.map((s) => (
            <DropdownMenuItem key={s.id} asChild className="flex-col items-start gap-0.5">
              <Link href={`/services/${s.id}`}>
                <span className="font-medium">{s.name || 'Untitled service'}</span>
                <span className="text-[11px] text-amber-700">
                  Missing {s.missing.map((f) => MISSING_FIELD_LABEL[f]).join(' + ')}
                </span>
              </Link>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
