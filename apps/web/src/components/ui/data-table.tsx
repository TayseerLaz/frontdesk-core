'use client';

import { ChevronDown, ChevronUp, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { EmptyState } from './empty-state';
import { SkeletonRows } from './skeleton';
import { cn } from '@/lib/utils';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Cell renderer. Return a string/number or any node. */
  cell: (row: T) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Monospace + tabular — for prices, quantities, IDs, dates. */
  mono?: boolean;
  sortable?: boolean;
  /** Width hint, e.g. 'w-32' or 'w-[120px]'. */
  className?: string;
  headerClassName?: string;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  getRowId: (row: T) => string;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  empty?: { icon: LucideIcon; title: string; description?: string; action?: React.ReactNode };
  className?: string;
  /** Optional trailing action cell (e.g. a row menu) rendered right-aligned. */
  rowActions?: (row: T) => React.ReactNode;
}

// Neutral-minimal data table: compact rows, sticky hairline header, tabular
// numerics, sortable headers, built-in loading skeleton + empty state. The
// default collection view across the app — replaces ad-hoc <table> markup.
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  loading,
  onRowClick,
  sort,
  onSortChange,
  empty,
  className,
  rowActions,
}: DataTableProps<T>) {
  const toggleSort = (key: string) => {
    if (!onSortChange) return;
    if (sort?.key === key) onSortChange({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    else onSortChange({ key, dir: 'asc' });
  };

  const alignClass = (a?: 'left' | 'right' | 'center') =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-surface', className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-muted/60">
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={cn(
                      'whitespace-nowrap px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-subtle',
                      alignClass(c.align),
                      c.headerClassName,
                      c.className,
                    )}
                  >
                    {c.sortable && onSortChange ? (
                      <button
                        onClick={() => toggleSort(c.key)}
                        className={cn(
                          'inline-flex items-center gap-1 transition-colors hover:text-foreground',
                          active && 'text-foreground',
                          c.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {c.header}
                        {active ? (
                          sort!.dir === 'asc' ? (
                            <ChevronUp className="size-3" />
                          ) : (
                            <ChevronDown className="size-3" />
                          )
                        ) : (
                          <ChevronDown className="size-3 opacity-30" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {rowActions ? <th className="w-10 px-3 py-2" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              <tr>
                <td colSpan={columns.length + (rowActions ? 1 : 0)} className="p-0">
                  <SkeletonRows rows={8} cols={columns.length} />
                </td>
              </tr>
            ) : !rows || rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (rowActions ? 1 : 0)}>
                  {empty ? (
                    <EmptyState {...empty} />
                  ) : (
                    <p className="px-4 py-12 text-center text-sm text-foreground-subtle">No results.</p>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={getRowId(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-surface-muted',
                  )}
                  style={{ height: 'var(--density-row)' }}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-3 py-1.5 text-foreground',
                        alignClass(c.align),
                        c.mono && 'font-mono tabular-nums text-[13px]',
                        c.className,
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {rowActions ? (
                    <td className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                      {rowActions(row)}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
