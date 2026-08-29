'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Filter,
  MessageSquare,
  PhoneCall,
  ShoppingCart,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

// Status flow (v1): new → confirmed → completed; cancelled is a terminal
// escape hatch. Match the backend exactly so the dropdown maps 1:1.
// `draft` carts are in-progress orders the bot is still building. Filter
// is opt-in (the API hides drafts by default) so operators only see them
// when they explicitly switch the filter — useful for abandoned-cart
// recovery, ignored on the day-to-day Orders view.
const STATUSES = ['draft', 'new', 'confirmed', 'completed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

interface CartFieldAnswer {
  key: string;
  label: string;
  type: string;
  required: boolean;
  value: string | number | boolean | null;
}

interface CartItem {
  id: string;
  productId: string | null;
  serviceId: string | null;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantLabel: string | null;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  notes: string | null;
  needsPricing: boolean;
  createdAt: string;
}

interface Cart {
  id: string;
  threadId: string | null;
  customerPhone: string;
  customerName: string | null;
  fields: CartFieldAnswer[];
  items: CartItem[];
  subtotalMinor: number;
  deliveryMinor: number;
  totalMinor: number;
  currency: string;
  status: Status;
  notes: string | null;
  itemsCount: number;
  channel: string;
  phoneIntegrationId: string | null;
  phoneIntegrationName: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_BADGE: Record<Status, 'default' | 'muted' | 'success' | 'danger'> = {
  // 'draft' = bot is still building the cart with the customer. Shown
  // in muted yellow-ish "muted" tone so it's visually distinct from
  // confirmed orders without being alarming.
  draft: 'muted',
  new: 'default',
  confirmed: 'success',
  completed: 'muted',
  cancelled: 'danger',
};

// KWD/BHD/OMR use 3-decimal minor units; everyone else uses 2.
function decimalsForCurrency(currency: string): number {
  return currency === 'KWD' || currency === 'BHD' || currency === 'OMR' ? 3 : 2;
}
function formatMoney(minor: number, currency: string): string {
  const d = decimalsForCurrency(currency);
  const divisor = d === 3 ? 1000 : 100;
  const major = (minor / divisor).toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
  return `${major} ${currency}`;
}

// "2x Cappuccino, 1x Dubai Crepe" — used as the inline summary in the list
// table. Caps at 3 items + a "+N more" suffix so wide carts don't break the
// row layout.
function itemsSummary(items: CartItem[]): string {
  if (items.length === 0) return '—';
  const shown = items.slice(0, 3).map((it) => `${it.quantity}× ${it.name}`);
  const remaining = items.length - shown.length;
  return remaining > 0 ? `${shown.join(', ')} +${remaining} more` : shown.join(', ');
}

function StatusBadge({ status }: { status: Status }) {
  return <Badge variant={STATUS_BADGE[status]}>{status}</Badge>;
}

// Origin-channel pill. Voice orders get a distinct badge (with the originating
// phone line when known) so operators can tell a phone order at a glance.
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
  voice: 'Voice',
};

function ChannelBadge({ cart }: { cart: Cart }) {
  if (cart.channel === 'voice') {
    return (
      <Badge variant="brand" className="gap-1">
        <PhoneCall className="size-3" />
        Voice{cart.phoneIntegrationName ? ` · ${cart.phoneIntegrationName}` : ''}
      </Badge>
    );
  }
  // WhatsApp is the default origin; only surface a pill for the non-default
  // channels so the common case stays uncluttered.
  if (cart.channel && cart.channel !== 'whatsapp') {
    return <Badge variant="muted">{CHANNEL_LABELS[cart.channel] ?? cart.channel}</Badge>;
  }
  return null;
}

export default function CartPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Track which rows are expanded so the operator can pop open the line
  // items + form answers without leaving the table.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useMemo(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useQuery({
    queryKey: ['carts', statusFilter, debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (debouncedSearch) params.set('q', debouncedSearch);
      params.set('limit', '100');
      return api.get<{ data: Cart[] }>(`/api/v1/carts?${params.toString()}`);
    },
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Status }) =>
      api.patch(`/api/v1/carts/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['carts'] });
      toast.success('Status updated');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/carts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['carts'] });
      toast.success('Cart deleted');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  const rows = list.data?.data ?? [];

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <PageHeader
        title="Cart"
        description="Customer orders placed via the AI chatbot or entered manually. Configure the order form on /business-info → Shop form."
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <ShoppingCart className="size-4 text-brand-600" />
            {rows.length} carts
          </CardTitle>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search phone, name, notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64"
            />
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as Status | 'all')}>
              <SelectTrigger className="w-40">
                <Filter className="mr-2 size-3.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
              <tr>
                <th className="w-10 px-4 py-3" />
                <th className="hidden px-6 py-3 md:table-cell">Created</th>
                <th className="px-6 py-3">Customer</th>
                <th className="hidden px-6 py-3 sm:table-cell">Items</th>
                <th className="px-6 py-3 text-right">Total</th>
                <th className="hidden px-6 py-3 lg:table-cell">Status</th>
                <th className="w-20 px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading ? (
                <tr>
                  <td colSpan={7} className="p-0">
                    <SkeletonRows rows={5} cols={5} />
                  </td>
                </tr>
              ) : null}
              {!list.isLoading && rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-16 text-center text-foreground-muted">
                    No carts yet. When a customer asks the bot to order something, the cart will
                    appear here.
                  </td>
                </tr>
              ) : null}
              {rows.map((c) => {
                const isOpen = expanded.has(c.id);
                return (
                  <CartRow
                    key={c.id}
                    cart={c}
                    isOpen={isOpen}
                    onToggle={() => toggleExpand(c.id)}
                    onStatus={(status) => setStatus.mutate({ id: c.id, status })}
                    onDelete={() => {
                      if (
                        window.confirm(
                          `Delete cart from ${c.customerName ?? c.customerPhone}? This removes the order and all its items.`,
                        )
                      ) {
                        remove.mutate(c.id);
                      }
                    }}
                  />
                );
              })}
            </tbody>
          </table></div>
        </CardContent>
      </Card>
    </>
  );
}

function CartRow({
  cart,
  isOpen,
  onToggle,
  onStatus,
  onDelete,
}: {
  cart: Cart;
  isOpen: boolean;
  onToggle: () => void;
  onStatus: (status: Status) => void;
  onDelete: () => void;
}) {
  return (
    <>
      <tr className="border-b border-border align-top last:border-0">
        <td className="px-4 py-4">
          <button
            type="button"
            onClick={onToggle}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            className="rounded p-1 text-foreground-subtle hover:bg-surface-muted hover:text-foreground"
          >
            {isOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        </td>
        <td className="hidden whitespace-nowrap px-6 py-4 text-xs text-foreground-muted md:table-cell">
          {new Date(cart.createdAt).toLocaleString()}
        </td>
        <td className="px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="font-medium">{cart.customerName ?? cart.customerPhone}</span>
            <ChannelBadge cart={cart} />
          </div>
          <div className="font-mono text-[11px] text-foreground-subtle">{cart.customerPhone}</div>
          {cart.threadId ? (
            <Link
              href={`/inbox?thread=${cart.threadId}`}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
            >
              <MessageSquare className="size-3" /> View chat
            </Link>
          ) : null}
        </td>
        <td className="hidden px-6 py-4 sm:table-cell">
          <div className="text-sm">
            <span className="font-medium">{cart.itemsCount}</span>{' '}
            <span className="text-foreground-muted">item{cart.itemsCount === 1 ? '' : 's'}</span>
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs text-foreground-muted">
            {itemsSummary(cart.items)}
          </div>
          {cart.items.some((it) => it.needsPricing) ? (
            <Badge variant="warning" className="mt-1">
              Needs pricing
            </Badge>
          ) : null}
        </td>
        <td className="whitespace-nowrap px-6 py-4 text-right font-mono text-sm">
          {formatMoney(cart.totalMinor, cart.currency)}
          {cart.deliveryMinor > 0 ? (
            <div className="text-[10px] text-foreground-subtle">
              incl. {formatMoney(cart.deliveryMinor, cart.currency)} delivery
            </div>
          ) : null}
        </td>
        <td className="hidden px-6 py-4 lg:table-cell">
          <Select value={cart.status} onValueChange={(v) => onStatus(v as Status)}>
            <SelectTrigger className="w-36">
              <SelectValue>
                <StatusBadge status={cart.status} />
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </td>
        <td className="px-6 py-4 text-right">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete cart"
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        </td>
      </tr>
      {isOpen ? (
        <tr className={cn('border-b border-border bg-surface-muted/30')}>
          <td colSpan={7} className="px-6 py-4">
            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  Line items
                </div>
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-foreground-subtle">
                      <th className="py-1 text-left font-medium">Item</th>
                      <th className="hidden py-1 text-right font-medium sm:table-cell">Qty</th>
                      <th className="hidden py-1 text-right font-medium md:table-cell">Unit</th>
                      <th className="py-1 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.items.map((it) => (
                      <tr key={it.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{it.name}</span>
                            {it.needsPricing ? (
                              <Badge variant="warning">Needs pricing</Badge>
                            ) : null}
                          </div>
                          {it.variantLabel ? (
                            <div className="text-[10px] text-foreground-subtle">
                              {it.variantLabel}
                            </div>
                          ) : null}
                          {it.sku ? (
                            <div className="font-mono text-[10px] text-foreground-subtle">
                              {it.sku}
                            </div>
                          ) : null}
                          {it.notes ? (
                            <div className="text-[11px] italic text-foreground-muted">
                              note: {it.notes}
                            </div>
                          ) : null}
                        </td>
                        <td className="hidden py-2 text-right font-mono text-sm sm:table-cell">{it.quantity}</td>
                        <td className="hidden py-2 text-right font-mono text-sm md:table-cell">
                          {formatMoney(it.unitPriceMinor, cart.currency)}
                        </td>
                        <td className="py-2 text-right font-mono text-sm">
                          {formatMoney(it.lineTotalMinor, cart.currency)}
                        </td>
                      </tr>
                    ))}
                    <tr className="text-xs text-foreground-subtle">
                      <td colSpan={3} className="py-1 text-right">
                        Subtotal
                      </td>
                      <td className="py-1 text-right font-mono">
                        {formatMoney(cart.subtotalMinor, cart.currency)}
                      </td>
                    </tr>
                    {cart.deliveryMinor > 0 ? (
                      <tr className="text-xs text-foreground-subtle">
                        <td colSpan={3} className="py-1 text-right">
                          Delivery
                        </td>
                        <td className="py-1 text-right font-mono">
                          {formatMoney(cart.deliveryMinor, cart.currency)}
                        </td>
                      </tr>
                    ) : null}
                    <tr className="text-sm font-semibold">
                      <td colSpan={3} className="py-1 text-right">
                        Total
                      </td>
                      <td className="py-1 text-right font-mono">
                        {formatMoney(cart.totalMinor, cart.currency)}
                      </td>
                    </tr>
                  </tbody>
                </table></div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  Form answers
                </div>
                {cart.fields.length === 0 ? (
                  <p className="text-xs italic text-foreground-muted">
                    (no extra fields collected)
                  </p>
                ) : (
                  <dl className="space-y-1.5 text-xs">
                    {cart.fields.map((f) => (
                      <div key={f.key}>
                        <dt className="font-semibold text-foreground-subtle">{f.label}</dt>
                        <dd className="text-foreground">
                          {f.value === null || f.value === '' ? (
                            <span className="italic text-foreground-subtle">(empty)</span>
                          ) : (
                            String(f.value)
                          )}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {cart.notes ? (
                  <div className="mt-3">
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                      Notes
                    </div>
                    <p className="whitespace-pre-wrap text-xs">{cart.notes}</p>
                  </div>
                ) : null}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
