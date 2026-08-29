'use client';

import type { ShopifyStagedItemDto } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Download, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

const TABS: { key: string; label: string }[] = [
  { key: 'product', label: 'Products' },
  { key: 'contact', label: 'Contacts' },
  { key: 'business_info', label: 'Business info' },
  { key: 'policy', label: 'Policies' },
  { key: 'faq', label: 'FAQs' },
  { key: 'location', label: 'Locations' },
];

// One-line secondary preview per section, pulled from the normalized payload.
function previewLine(item: ShopifyStagedItemDto): string {
  const n = (item.normalized ?? {}) as Record<string, unknown>;
  switch (item.section) {
    case 'product': {
      const core = (n.core ?? {}) as Record<string, unknown>;
      const price = core.priceMinor != null ? `${(Number(core.priceMinor) / 100).toFixed(2)}` : '—';
      return `${core.sku ?? ''} · ${price} · stock ${core.stockQuantity ?? '—'}`;
    }
    case 'contact':
      return `${n.phoneE164 ?? ''}${n.optedIn ? ' · opted in' : ''}`;
    case 'policy':
      return String(n.kind ?? '');
    case 'faq':
      return String(n.answer ?? '').slice(0, 80);
    case 'location':
      return [n.city, n.country].filter(Boolean).join(', ');
    default:
      return '';
  }
}

export default function ShopifyReviewPage() {
  const { session } = useSession();
  const shopifyOn = !(session?.organization?.disabledFeatures ?? []).includes('shopify');
  const qc = useQueryClient();
  const [tab, setTab] = useState('product');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const stagedQ = useQuery({
    queryKey: ['shopify-staged', tab],
    queryFn: () =>
      api.get<{ data: ShopifyStagedItemDto[]; nextCursor: string | null }>(
        `/api/v1/shopify/staged?section=${tab}&status=pending&limit=200`,
      ),
    enabled: shopifyOn,
  });
  const items = useMemo(() => stagedQ.data?.data ?? [], [stagedQ.data]);

  const refresh = () => {
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ['shopify-staged'] });
    qc.invalidateQueries({ queryKey: ['shopify-config'] });
  };

  const decide = useMutation({
    mutationFn: ({ action, ids }: { action: 'approve' | 'reject'; ids: string[] }) =>
      api.post(`/api/v1/shopify/staged/${action}`, { ids }),
    onSuccess: () => {
      toast.success('Updated');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Failed'),
  });

  const approveAll = useMutation({
    mutationFn: () => api.post('/api/v1/shopify/staged/approve-all', { section: tab }),
    onSuccess: () => {
      toast.success('All approved');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Failed'),
  });

  const importApproved = useMutation({
    mutationFn: () => api.post('/api/v1/shopify/import', {}),
    onSuccess: () => {
      toast.success('Importing approved items…');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Failed'),
  });

  if (!shopifyOn) {
    return (
      <>
        <PageHeader title="Shopify review" description="Not enabled." />
        <Card>
          <CardContent className="py-10 text-center text-sm text-foreground-muted">
            Shopify sync isn’t enabled for your account.
          </CardContent>
        </Card>
      </>
    );
  }

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedIds = Array.from(selected);

  return (
    <>
      <PageHeader
        title="Review Shopify items"
        description="Approve what should go live, reject what shouldn’t, then import. Nothing is added to your catalog until you import."
        actions={
          <div className="flex gap-2">
            <Link href="/settings/shopify">
              <Button variant="ghost">
                <ArrowLeft className="size-4" /> Back
              </Button>
            </Link>
            <Button onClick={() => importApproved.mutate()} loading={importApproved.isPending}>
              <Download className="size-4" /> Import approved
            </Button>
          </div>
        }
      />

      {/* Section tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setSelected(new Set());
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.key
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-foreground-muted hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} /> Select all
        </label>
        <span className="text-xs text-foreground-subtle">{selectedIds.length} selected</span>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={selectedIds.length === 0 || decide.isPending}
            onClick={() => decide.mutate({ action: 'approve', ids: selectedIds })}
          >
            <Check className="size-4" /> Approve selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedIds.length === 0 || decide.isPending}
            onClick={() => decide.mutate({ action: 'reject', ids: selectedIds })}
          >
            <X className="size-4" /> Reject selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={items.length === 0 || approveAll.isPending}
            onClick={() => approveAll.mutate()}
          >
            Approve all {TABS.find((t) => t.key === tab)?.label}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {stagedQ.isLoading ? (
            <SkeletonRows rows={5} cols={2} />
          ) : items.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-foreground-muted">
              No pending {TABS.find((t) => t.key === tab)?.label.toLowerCase()} to review.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.title}</div>
                    <div className="truncate text-xs text-foreground-muted">{previewLine(item)}</div>
                  </div>
                  <Badge variant="muted">{item.status}</Badge>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Approve"
                      onClick={() => decide.mutate({ action: 'approve', ids: [item.id] })}
                    >
                      <Check className="size-4 text-emerald-600" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Reject"
                      onClick={() => decide.mutate({ action: 'reject', ids: [item.id] })}
                    >
                      <X className="size-4 text-rose-600" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
