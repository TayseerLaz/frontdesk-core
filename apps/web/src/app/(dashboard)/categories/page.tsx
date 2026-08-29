'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';

interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  productCount?: number;
  serviceCount?: number;
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  priceMinor: number | null;
  currency: string | null;
  isAvailable: boolean;
}

interface ServiceRow {
  id: string;
  slug: string;
  name: string;
  basePriceMinor: number | null;
  currency: string | null;
  isAvailable: boolean;
}

function formatPrice(minor: number | null, currency: string | null): string {
  if (minor == null) return '—';
  return `${(minor / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

export default function CategoriesPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const cats = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ data: Category[] }>('/api/v1/categories'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success('Category deleted');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (vars: { ids?: string[]; all?: boolean; emptyOnly?: boolean }) =>
      api.post<{ data: { deleted: number } }>('/api/v1/categories/bulk-delete', vars),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      setSelected(new Set());
      toast.success(`Deleted ${res.data.deleted} categor${res.data.deleted === 1 ? 'y' : 'ies'}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  const categories = cats.data?.data ?? [];
  const allSelected = categories.length > 0 && categories.every((c) => selected.has(c.id));
  const someSelected = selected.size > 0;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(categories.map((c) => c.id)));
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
        title="Categories"
        description="Organize products and services into categories for chatbot retrieval and the storefront. Click any row to expand and see what's linked."
        actions={
          <div className="flex items-center gap-2">
            {/* "Delete empty" wipes only rows with 0 products + 0 services
                — safe one-click cleanup after a catalog wipe. "Delete all"
                is the nuclear option behind a typed DELETE prompt. */}
            <Button
              variant="ghost"
              loading={bulkDeleteMutation.isPending}
              onClick={async () => {
                const empty = categories.filter(
                  (c) => (c.productCount ?? 0) === 0 && (c.serviceCount ?? 0) === 0,
                );
                if (empty.length === 0) {
                  toast.message('No empty categories to delete.');
                  return;
                }
                const ok = await confirmDialog({
                  title: `Delete ${empty.length} empty categor${empty.length === 1 ? 'y' : 'ies'}?`,
                  body: 'Only categories with zero products and zero services will be removed. Others are kept.',
                  confirmLabel: 'Delete empty',
                  destructive: true,
                });
                if (ok) bulkDeleteMutation.mutate({ emptyOnly: true });
              }}
            >
              <Trash2 className="size-4" /> Delete empty
            </Button>
            <Button
              variant="ghost"
              loading={bulkDeleteMutation.isPending}
              onClick={async () => {
                const ok = await confirmDialog({
                  title: 'Delete every category?',
                  body: 'This removes every category in your org. Products and services keep their data; their category link is cleared. Type DELETE in the next step to confirm.',
                  confirmLabel: 'Continue',
                  destructive: true,
                });
                if (!ok) return;
                const typed = window.prompt('Type DELETE to confirm wiping every category:');
                if (typed?.trim().toUpperCase() === 'DELETE') {
                  bulkDeleteMutation.mutate({ all: true });
                }
              }}
            >
              <Trash2 className="size-4" /> Delete all
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New category
            </Button>
          </div>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>{categories.length} categories</CardTitle>
        </CardHeader>
        {someSelected ? (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-brand-50/40 px-4 py-2 text-sm">
            <span>
              <strong>{selected.size}</strong> selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="danger"
                loading={bulkDeleteMutation.isPending}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Delete ${selected.size} categor${selected.size === 1 ? 'y' : 'ies'}?`,
                    body: 'Linked products and services keep their data but lose this category link.',
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
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
              <tr>
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    className="size-4 cursor-pointer rounded border-border accent-brand-500"
                    checked={allSelected}
                    aria-label={allSelected ? 'Deselect all categories' : 'Select all categories'}
                    onChange={toggleAll}
                  />
                </th>
                <th className="w-10 px-4 py-3" />
                <th className="px-4 py-3 sm:px-6">Name</th>
                <th className="hidden px-6 py-3 lg:table-cell">Slug</th>
                <th className="hidden px-6 py-3 sm:table-cell">Products</th>
                <th className="hidden px-6 py-3 sm:table-cell">Services</th>
                <th className="w-12 px-4 py-3 sm:px-6" />
              </tr>
            </thead>
            <tbody>
              {cats.isLoading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={`skeleton-${i}`} className="border-b border-border last:border-0">
                      <td className="px-4 py-4">
                        <Skeleton className="h-4 w-4" />
                      </td>
                      <td className="px-4 py-4">
                        <Skeleton className="h-4 w-4" />
                      </td>
                      <td className="px-4 py-4 sm:px-6">
                        <Skeleton className="h-4 w-32" />
                      </td>
                      <td className="hidden px-6 py-4 lg:table-cell">
                        <Skeleton className="h-4 w-24" />
                      </td>
                      <td className="hidden px-6 py-4 sm:table-cell">
                        <Skeleton className="h-4 w-8" />
                      </td>
                      <td className="hidden px-6 py-4 sm:table-cell">
                        <Skeleton className="h-4 w-8" />
                      </td>
                      <td className="px-4 py-4 sm:px-6" />
                    </tr>
                  ))
                : null}
              {categories.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-foreground-muted">No categories yet.</td>
                </tr>
              ) : null}
              {categories.map((c) => {
                const isOpen = expandedId === c.id;
                const productCount = c.productCount ?? 0;
                const serviceCount = c.serviceCount ?? 0;
                return (
                  <CategoryRowGroup
                    key={c.id}
                    cat={c}
                    isOpen={isOpen}
                    isChecked={selected.has(c.id)}
                    onToggleChecked={() => toggleOne(c.id)}
                    onToggle={() => setExpandedId(isOpen ? null : c.id)}
                    onDelete={() => {
                      if (
                        window.confirm(
                          `Delete "${c.name}"? Linked products and services keep their data but lose this category link.`,
                        )
                      ) {
                        deleteMutation.mutate(c.id);
                      }
                    }}
                    productCount={productCount}
                    serviceCount={serviceCount}
                  />
                );
              })}
            </tbody>
          </table></div>
        </CardContent>
      </Card>

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existing={cats.data?.data ?? []}
        onCreated={() => qc.invalidateQueries({ queryKey: ['categories'] })}
      />
    </>
  );
}

// Top-level row + (when expanded) a second `<tr>` rendering the linked
// products and services. Queries fire lazy (only when the row opens)
// so we don't fan out N parallel fetches for every page load.
function CategoryRowGroup({
  cat,
  isOpen,
  isChecked,
  onToggleChecked,
  onToggle,
  onDelete,
  productCount,
  serviceCount,
}: {
  cat: Category;
  isOpen: boolean;
  isChecked: boolean;
  onToggleChecked: () => void;
  onToggle: () => void;
  onDelete: () => void;
  productCount: number;
  serviceCount: number;
}) {
  const productsQ = useQuery({
    queryKey: ['categories', cat.id, 'products'],
    queryFn: () =>
      api.get<{ data: ProductRow[] }>(`/api/v1/products?categoryId=${cat.id}&limit=100`),
    enabled: isOpen && productCount > 0,
    staleTime: 30_000,
  });
  const servicesQ = useQuery({
    queryKey: ['categories', cat.id, 'services'],
    queryFn: () =>
      api.get<{ data: ServiceRow[] }>(`/api/v1/services?categoryId=${cat.id}&limit=100`),
    enabled: isOpen && serviceCount > 0,
    staleTime: 30_000,
  });

  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-muted/40"
        onClick={onToggle}
      >
        <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
          {/* Stop click propagation so ticking the checkbox doesn't
              also expand/collapse the row group. */}
          <input
            type="checkbox"
            className="size-4 cursor-pointer rounded border-border accent-brand-500"
            checked={isChecked}
            aria-label={`Select ${cat.name}`}
            onChange={onToggleChecked}
          />
        </td>
        <td className="px-4 py-4">
          <Chevron className="size-4 text-foreground-muted" />
        </td>
        <td className="px-4 py-4 font-medium sm:px-6">{cat.name}</td>
        <td className="hidden px-6 py-4 font-mono text-xs text-foreground-muted lg:table-cell">{cat.slug}</td>
        <td className="hidden px-6 py-4 font-mono text-sm sm:table-cell">{productCount}</td>
        <td className="hidden px-6 py-4 font-mono text-sm sm:table-cell">{serviceCount}</td>
        <td className="px-4 py-4 text-right sm:px-6">
          <Button
            size="icon"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label={`Delete ${cat.name}`}
          >
            <Trash2 className="size-4" />
          </Button>
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-border bg-surface-muted/30">
          {/* Two leading empty cells — checkbox column + chevron column —
              so the colSpan that covers Name/Slug/Products/Services/Actions
              still lines up after the new select column was added. */}
          <td className="px-4 py-3" />
          <td className="px-4 py-3" />
          <td colSpan={5} className="px-6 py-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <CategoryLinkedList
                title={`Products (${productCount})`}
                loading={productsQ.isLoading && productCount > 0}
                empty={productCount === 0}
                emptyHint="No products linked to this category."
                items={(productsQ.data?.data ?? []).map((p) => ({
                  key: p.id,
                  primary: p.name,
                  secondary: `${p.sku} · ${formatPrice(p.priceMinor, p.currency)}${p.isAvailable ? '' : ' · unavailable'}`,
                  href: `/products/${p.id}`,
                }))}
              />
              <CategoryLinkedList
                title={`Services (${serviceCount})`}
                loading={servicesQ.isLoading && serviceCount > 0}
                empty={serviceCount === 0}
                emptyHint="No services linked to this category."
                items={(servicesQ.data?.data ?? []).map((s) => ({
                  key: s.id,
                  primary: s.name,
                  secondary: `${s.slug} · ${formatPrice(s.basePriceMinor, s.currency)}${s.isAvailable ? '' : ' · unavailable'}`,
                  href: `/services/${s.id}`,
                }))}
              />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function CategoryLinkedList({
  title,
  loading,
  empty,
  emptyHint,
  items,
}: {
  title: string;
  loading: boolean;
  empty: boolean;
  emptyHint: string;
  items: { key: string; primary: string; secondary: string; href: string }[];
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
        {title}
      </p>
      {loading ? (
        <Skeleton className="h-4 w-24" />
      ) : empty ? (
        <p className="text-xs italic text-foreground-subtle">{emptyHint}</p>
      ) : items.length === 0 ? (
        <p className="text-xs italic text-foreground-subtle">Nothing linked.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li key={it.key}>
              <Link
                href={it.href}
                className="block rounded px-1.5 py-1 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              >
                <p className="text-sm text-foreground">{it.primary}</p>
                <p className="font-mono text-[11px] text-foreground-subtle">{it.secondary}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateDialog({
  open,
  onOpenChange,
  existing,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  existing: Category[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [parentId, setParentId] = useState<string | ''>('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/api/v1/categories', {
        name,
        slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        parentId: parentId || undefined,
      });
      toast.success('Category created');
      onOpenChange(false);
      onCreated();
      setName('');
      setSlug('');
      setParentId('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New category</DialogTitle>
          <DialogDescription>Categories can be nested under a parent.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Slug (auto-generated if blank)</Label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="men-shoes" />
          </div>
          <div>
            <Label>Parent (optional)</Label>
            <select
              className="w-full rounded border border-border px-3 py-2 text-sm"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">No parent (top-level)</option>
              {existing.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name || busy} loading={busy}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
