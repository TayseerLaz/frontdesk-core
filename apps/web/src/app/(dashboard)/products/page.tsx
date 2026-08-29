'use client';

import type { Category, ProductListItem } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCircle2, Eye, EyeOff, MoreHorizontal, Package, Plus, Search, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { formatMoney, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

const ALL_CATEGORIES = '__all__';
const ALL_AVAILABILITY = '__all__';

export default function ProductsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const Glyph = Package;
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORIES);
  const [availability, setAvailability] = useState<string>(ALL_AVAILABILITY);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  // Pagination — 20 items per page (fixed), cursor stack drives prev/next.
  // We push the previous page's nextCursor on advance + pop on Back so we
  // can walk backwards without re-running every previous query.
  const PAGE_LIMIT = 20;
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Reset pagination whenever filters change so we don't end up on a
  // cursor that no longer matches.
  useEffect(() => {
    setCursor(null);
    setCursorHistory([]);
  }, [debouncedSearch, categoryId, availability]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedSearch) p.set('q', debouncedSearch);
    if (categoryId !== ALL_CATEGORIES) p.set('categoryId', categoryId);
    if (availability !== ALL_AVAILABILITY) p.set('isAvailable', availability);
    p.set('limit', String(PAGE_LIMIT));
    if (cursor) p.set('cursor', cursor);
    return p.toString();
  }, [debouncedSearch, categoryId, availability, cursor]);

  const productsQuery = useQuery({
    queryKey: ['products', params],
    queryFn: () =>
      api.get<{ data: ProductListItem[]; nextCursor: string | null; total?: number }>(
        `/api/v1/products?${params}`,
      ),
    placeholderData: (prev) => prev,
  });

  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ data: Category[] }>('/api/v1/categories'),
  });

  const bulkAvailabilityMutation = useMutation({
    mutationFn: (vars: { ids: string[]; isAvailable: boolean }) =>
      api.post('/api/v1/products/bulk-update', vars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setSelected(new Set());
      toast.success('Updated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/products/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Product deleted');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (vars: { ids?: string[]; all?: boolean }) =>
      api.post<{ data: { deleted: number } }>('/api/v1/products/bulk-delete', vars),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setSelected(new Set());
      toast.success(`Deleted ${res.data.deleted} product${res.data.deleted === 1 ? '' : 's'}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const createDraft = async () => {
    setCreating(true);
    try {
      const stamp = Date.now().toString(36).toUpperCase();
      const res = await api.post<{ data: { id: string } }>(`/api/v1/products`, {
        sku: `DRAFT-${stamp}`,
        // Slug must also be unique per draft, otherwise the second "Untitled
        // product" collides with the first on @@unique([organizationId, slug]).
        slug: `draft-${stamp.toLowerCase()}`,
        name: 'Untitled product',
        isAvailable: false,
      });
      router.push(`/products/${res.data.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not create draft');
    } finally {
      setCreating(false);
    }
  };

  const products = productsQuery.data?.data ?? [];
  const nextCursor = productsQuery.data?.nextCursor ?? null;
  const total = productsQuery.data?.total ?? null;
  // Page index = depth of the cursor history. 0 on first page.
  const pageIndex = cursorHistory.length;
  const showingFrom = total === 0 ? 0 : pageIndex * PAGE_LIMIT + 1;
  const showingTo = pageIndex * PAGE_LIMIT + products.length;
  const allSelected = products.length > 0 && products.every((p) => selected.has(p.id));
  const someSelected = selected.size > 0;

  const goNext = () => {
    if (!nextCursor) return;
    setCursorHistory((h) => [...h, cursor]);
    setCursor(nextCursor);
  };
  const goPrev = () => {
    if (cursorHistory.length === 0) return;
    const prevCursor = cursorHistory[cursorHistory.length - 1] ?? null;
    setCursorHistory((h) => h.slice(0, -1));
    setCursor(prevCursor);
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(products.map((p) => p.id)));
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <PageHeader
        title="Products"
        description="Catalog items the chatbot can answer questions about and the team can sell."
        actions={
          (
          <div className="flex items-center gap-2">
            {/* Wipe-all is gated by a second-step confirmation that
                requires typing DELETE — keeps an itchy click from
                nuking every product in the catalog. Admin role only. */}
            <Button
              variant="ghost"
              loading={bulkDeleteMutation.isPending}
              onClick={async () => {
                const ok = await confirmDialog({
                  title: 'Delete every product?',
                  body: 'This soft-deletes every product in your catalog. The chatbot stops answering about all of them immediately. Type DELETE in the next step to confirm — you can restore from the activity log if needed.',
                  confirmLabel: 'Continue',
                  destructive: true,
                });
                if (!ok) return;
                const typed = window.prompt('Type DELETE to confirm wiping every product:');
                if (typed?.trim().toUpperCase() === 'DELETE') {
                  bulkDeleteMutation.mutate({ all: true });
                }
              }}
            >
              <Trash2 className="size-4" /> Delete all
            </Button>
            <Button variant="secondary" asChild>
              <Link href="/imports?kind=product">
                <Upload className="size-4" /> Bulk import
              </Link>
            </Button>
            <Button onClick={createDraft} loading={creating}>
              <Plus className="size-4" /> New product
            </Button>
          </div>
          )
        }
      />

      <Card>
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
            <Input
              placeholder="Search by name or SKU…"
              className="pl-9"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="w-full lg:w-48">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categoriesQuery.data?.data.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={availability} onValueChange={setAvailability}>
            <SelectTrigger className="w-full lg:w-44">
              <SelectValue placeholder="Availability" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_AVAILABILITY}>All availability</SelectItem>
              <SelectItem value="true">Available</SelectItem>
              <SelectItem value="false">Unavailable</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {someSelected ? (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-brand-50/40 px-4 py-2 text-sm">
            <span>
              <strong>{selected.size}</strong> selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  bulkAvailabilityMutation.mutate({ ids: Array.from(selected), isAvailable: true })
                }
              >
                <Eye className="size-4" /> Mark available
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  bulkAvailabilityMutation.mutate({ ids: Array.from(selected), isAvailable: false })
                }
              >
                <EyeOff className="size-4" /> Mark unavailable
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={bulkDeleteMutation.isPending}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Delete ${selected.size} product${selected.size === 1 ? '' : 's'}?`,
                    body: 'This soft-deletes the selected products. The chatbot stops answering questions about them immediately. You can restore from the activity log if needed.',
                    confirmLabel: 'Delete',
                    destructive: true,
                  });
                  if (ok) bulkDeleteMutation.mutate({ ids: Array.from(selected) });
                }}
              >
                <Trash2 className="size-4" /> Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        ) : null}

        <CardContent className="p-0">
          {productsQuery.isLoading ? (
            <div className="py-2">
              <SkeletonRows rows={6} cols={5} />
            </div>
          ) : products.length === 0 ? (
            <EmptyState
              icon={Glyph}
              title={debouncedSearch ? 'No matches' : 'No products yet'}
              description={
                debouncedSearch
                  ? 'Try a different search term or filter.'
                  : 'Add your first product to start populating your catalog.'
              }
              action={
                !debouncedSearch ? (
                  <Button onClick={createDraft} loading={creating}>
                    <Plus className="size-4" /> Create your first product
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  <tr>
                    <th className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={allSelected}
                          onChange={toggleAll}
                          className="size-4 cursor-pointer rounded border-border accent-brand-500"
                        />
                    </th>
                    <th className="px-4 py-3">Product</th>
                    <th className="hidden px-4 py-3 lg:table-cell">SKU</th>
                    <th className="hidden px-4 py-3 md:table-cell">Category</th>
                    <th className="px-4 py-3 text-right">Price</th>
                    <th className="hidden px-4 py-3 sm:table-cell">Status</th>
                    <th className="hidden px-4 py-3 lg:table-cell">Updated</th>
                    <th className="w-12 px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => {
                    const productCell = (
                      <>
                        <div className="size-12 shrink-0 overflow-hidden rounded-md border border-border bg-surface-muted">
                          {p.primaryImageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={p.primaryImageUrl}
                              alt=""
                              className="size-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex size-full items-center justify-center text-foreground-subtle">
                              <Glyph className="size-5" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{p.name}</p>
                          {p.shortDescription ? (
                            <p className="truncate text-xs text-foreground-subtle">{p.shortDescription}</p>
                          ) : null}
                        </div>
                      </>
                    );
                    return (
                      <tr
                        key={p.id}
                        className={cn(
                          'group border-b border-border transition-colors last:border-0 hover:bg-surface-muted/50',
                          selected.has(p.id) && 'bg-brand-50/30',
                        )}
                      >
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.name}`}
                            checked={selected.has(p.id)}
                            onChange={() => toggleOne(p.id)}
                            className="size-4 cursor-pointer rounded border-border accent-brand-500"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <Link href={`/products/${p.id}`} className="flex items-center gap-3">
                            {productCell}
                          </Link>
                        </td>
                        <td className="hidden px-4 py-3 font-mono text-xs text-foreground-muted lg:table-cell">
                          {p.sku}
                        </td>
                        <td className="hidden px-4 py-3 text-foreground-muted md:table-cell">
                          {p.categoryName ?? <span className="text-foreground-subtle">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {p.priceLabel ?? formatMoney(p.priceMinor, p.currency)}
                        </td>
                        <td className="hidden px-4 py-3 sm:table-cell">
                          {p.isAvailable ? (
                            <Badge variant="success">
                              <CheckCircle2 className="mr-1 size-3" /> Available
                            </Badge>
                          ) : (
                            <Badge variant="muted">Unavailable</Badge>
                          )}
                        </td>
                        <td className="hidden px-4 py-3 text-foreground-muted lg:table-cell">
                          {formatRelative(p.updatedAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem asChild>
                                  <Link href={`/products/${p.id}`}>Edit</Link>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-red-600 focus:text-red-700"
                                  onSelect={async () => {
                                    if (
                                      await confirmDialog({
                                        title: `Delete "${p.name}"?`,
                                        body: 'The product will be hidden from the chatbot immediately. You can still find it in the database for 30 days.',
                                        confirmLabel: 'Delete product',
                                        destructive: true,
                                      })
                                    ) {
                                      deleteMutation.mutate(p.id);
                                    }
                                  }}
                                >
                                  <Trash2 className="size-4" /> Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {/* Pagination + total. Always rendered when we have any data so
              operators see exactly where they are in the catalog. Hidden
              while loading the very first page to avoid a "Showing 0 of
              0" flash. */}
          {total !== null && products.length > 0 ? (
            <div className="flex flex-col items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-foreground-muted sm:flex-row">
              <span>
                Showing <strong>{showingFrom}</strong>–<strong>{showingTo}</strong> of{' '}
                <strong>{total}</strong> product{total === 1 ? '' : 's'} · {PAGE_LIMIT} per page
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={cursorHistory.length === 0}
                  onClick={goPrev}
                >
                  ← Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!nextCursor}
                  onClick={goNext}
                >
                  Next →
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
