'use client';

import type { AvailabilityWindow, Category, PriceUnit, Service, ServicePricingTier } from '@platform/shared';
import { DAY_OF_WEEK_LABELS, DAYS_OF_WEEK, PRICE_UNIT_LABELS } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MarkdownEditor } from '@/components/ui/lazy-editor';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { minorToMajorString, minutesToTime, parseMoneyMajor, timeToMinutes } from '@/lib/format';

const NO_CATEGORY = '__none__';
const PRICE_UNITS: PriceUnit[] = ['flat', 'per_hour', 'per_day', 'per_session', 'per_unit'];

export default function ServiceEditPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const serviceQuery = useQuery({
    queryKey: ['service', params.id],
    queryFn: () => api.get<{ data: Service }>(`/api/v1/services/${params.id}`),
  });
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ data: Category[] }>('/api/v1/categories'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/api/v1/services/${params.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['services'] });
      toast.success('Service deleted');
      router.push('/services');
    },
  });

  if (serviceQuery.isLoading || !serviceQuery.data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    );
  }
  const service = serviceQuery.data.data;

  return (
    <>
      <PageHeader
        title={service.name}
        description={service.shortDescription}
        actions={
          <Button variant="secondary" asChild>
            <Link href="/services">
              <ArrowLeft className="size-4" /> Back to list
            </Link>
          </Button>
        }
      />
      {/* Layout rationale:
            Main column = the "what is this service?" cards (Details,
            Pricing, Weekly availability). Operators spend 95% of their
            time here.
            Right sidebar = the "manage this service" cards (Booking
            rules, Visibility toggle, Danger zone). Lower-frequency
            edits, denser layout.
          Visibility toggle moved INSIDE the Details card header so
          there's no standalone Visibility card competing for space. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <DetailsCard service={service} categories={categoriesQuery.data?.data ?? []} />
          <PricingTiersCard service={service} />
          <AvailabilityCard service={service} />
        </div>
        <div className="space-y-6">
          <BookingRulesCard service={service} />
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Danger zone</CardTitle>
            </CardHeader>
            <CardContent>
              <Button
                variant="danger"
                size="sm"
                className="w-full"
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: `Delete "${service.name}"?`,
                      body: 'The service will be hidden from the chatbot immediately.',
                      confirmLabel: 'Delete service',
                      destructive: true,
                    })
                  ) {
                    deleteMutation.mutate();
                  }
                }}
                loading={deleteMutation.isPending}
              >
                <Trash2 className="size-4" /> Delete service
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function DetailsCard({ service, categories }: { service: Service; categories: Category[] }) {
  const queryClient = useQueryClient();
  // Org-level currency is the single source of truth — same pattern as
  // /products/[id]. Per-service currency is locked server-side.
  const businessInfoQ = useQuery({
    queryKey: ['business-info'],
    queryFn: () =>
      api.get<{ data: { currency?: string } | null }>('/api/v1/business-info'),
    staleTime: 60_000,
  });
  const orgCurrency = businessInfoQ.data?.data?.currency ?? service.currency;
  const [draft, setDraft] = useState({
    name: service.name,
    shortDescription: service.shortDescription ?? '',
    description: service.description ?? '',
    durationMinutes: service.durationMinutes ?? 0,
    basePriceMajor: minorToMajorString(service.basePriceMinor, orgCurrency),
    priceUnit: service.priceUnit,
    isAvailable: service.isAvailable,
    categoryId: service.categoryId ?? NO_CATEGORY,
  });
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const skipNext = useRef(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft({
      name: service.name,
      shortDescription: service.shortDescription ?? '',
      description: service.description ?? '',
      durationMinutes: service.durationMinutes ?? 0,
      basePriceMajor: minorToMajorString(service.basePriceMinor, orgCurrency),
      priceUnit: service.priceUnit,
      isAvailable: service.isAvailable,
      categoryId: service.categoryId ?? NO_CATEGORY,
    });
    skipNext.current = true;
  }, [service, orgCurrency]);

  const buildPayload = () => ({
    name: draft.name.trim() || 'Untitled service',
    shortDescription: draft.shortDescription || null,
    description: draft.description || null,
    durationMinutes: draft.durationMinutes || null,
    basePriceMinor: parseMoneyMajor(draft.basePriceMajor, orgCurrency),
    // Currency is locked to BusinessInfo.currency server-side.
    priceUnit: draft.priceUnit,
    isAvailable: draft.isAvailable,
    categoryId: draft.categoryId === NO_CATEGORY ? null : draft.categoryId,
  });

  // "Completely empty" = nothing worth keeping; a never-filled blank draft is
  // discarded on leave instead of cluttering the catalog as "Untitled service".
  const isEmpty =
    (draft.name.trim() === '' || draft.name.trim() === 'Untitled service') &&
    draft.shortDescription.trim() === '' &&
    draft.description.trim() === '' &&
    !draft.durationMinutes &&
    !parseMoneyMajor(draft.basePriceMajor, orgCurrency) &&
    draft.categoryId === NO_CATEGORY;
  // Only never-filled drafts are auto-discarded — an existing service that's
  // cleared out is never deleted.
  const startedEmptyRef = useRef(
    (service.name.trim() === '' || service.name.trim() === 'Untitled service') &&
      !service.shortDescription &&
      !service.description &&
      !service.durationMinutes &&
      service.basePriceMinor == null,
  );
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;

  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.patch(`/api/v1/services/${service.id}`, buildPayload());
        setSavedAt(new Date());
        queryClient.invalidateQueries({ queryKey: ['service', service.id] });
      } catch (err) {
        toast.error(err instanceof ApiError ? err.payload.message : 'Save failed');
      } finally {
        setSaving(false);
      }
    }, 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft, service.id, queryClient]);

  // Discard a never-filled blank draft when leaving (unmount). Fire-and-forget.
  useEffect(() => {
    return () => {
      if (startedEmptyRef.current && isEmptyRef.current) {
        void api.delete(`/api/v1/services/${service.id}`).catch(() => undefined);
      }
    };
  }, [service.id]);

  // Explicit Save — flushes the pending auto-save; refuses a completely empty item.
  const saveNow = async () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (isEmpty) {
      toast.message('Add a name or some details before saving.');
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/v1/services/${service.id}`, buildPayload());
      setSavedAt(new Date());
      queryClient.invalidateQueries({ queryKey: ['service', service.id] });
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Details</CardTitle>
        <div className="flex items-center gap-3 text-xs text-foreground-subtle">
          {/* Inline visibility toggle — replaces the standalone
              VisibilityCard. Same PATCH endpoint, same optimistic
              invalidation pattern; just lives next to the Save status
              so the operator can see + change "is the bot offering
              this?" without a separate card. */}
          <InlineVisibilityToggle service={service} />
          <span aria-live="polite">
            {saving ? 'Saving…' : savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : 'Auto-save on'}
          </span>
          <Button size="sm" onClick={() => void saveNow()} loading={saving} disabled={isEmpty}>
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="category">Category</Label>
          <Select value={draft.categoryId} onValueChange={(v) => setDraft({ ...draft, categoryId: v })}>
            <SelectTrigger id="category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_CATEGORY}>Uncategorized</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="duration">Duration (minutes)</Label>
          <Input
            id="duration"
            type="number"
            min={0}
            value={draft.durationMinutes}
            onChange={(e) => setDraft({ ...draft, durationMinutes: Number(e.target.value) || 0 })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="basePrice">Base price ({orgCurrency})</Label>
          <Input
            id="basePrice"
            inputMode="decimal"
            value={draft.basePriceMajor}
            placeholder="0.00"
            onChange={(e) => setDraft({ ...draft, basePriceMajor: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="priceUnit">Price unit</Label>
          <Select
            value={draft.priceUnit}
            onValueChange={(v) => setDraft({ ...draft, priceUnit: v as PriceUnit })}
          >
            <SelectTrigger id="priceUnit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRICE_UNITS.map((u) => (
                <SelectItem key={u} value={u}>
                  {PRICE_UNIT_LABELS[u]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="shortDescription">Short description</Label>
          <Input
            id="shortDescription"
            value={draft.shortDescription}
            onChange={(e) => setDraft({ ...draft, shortDescription: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <MarkdownEditor
            id="description"
            rows={8}
            value={draft.description}
            placeholder="Use the toolbar for bold, italic, headings, lists, and links. Stored as markdown."
            onChange={(next) => setDraft({ ...draft, description: next })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function PricingTiersCard({ service }: { service: Service }) {
  const queryClient = useQueryClient();
  const [tiers, setTiers] = useState<ServicePricingTier[]>(service.pricingTiers);
  useEffect(() => setTiers(service.pricingTiers), [service]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/services/${service.id}/pricing-tiers`, {
        tiers: tiers.map((t, i) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          priceMinor: t.priceMinor,
          currency: t.currency,
          priceUnit: t.priceUnit,
          features: t.features,
          sortOrder: i,
        })),
      }),
    onSuccess: () => {
      toast.success('Pricing tiers saved');
      queryClient.invalidateQueries({ queryKey: ['service', service.id] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pricing tiers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {tiers.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-6 py-8 text-center text-sm text-foreground-muted">
            No tiers yet. Add a tier to offer multiple price points (e.g. Basic / Premium).
          </div>
        ) : (
          tiers.map((t, i) => (
            <div key={t.id ?? i} className="rounded-lg border border-border p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input
                    value={t.name}
                    onChange={(e) =>
                      setTiers((prev) => prev.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))
                    }
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Price (cents)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={t.priceMinor}
                      onChange={(e) =>
                        setTiers((prev) =>
                          prev.map((x, idx) =>
                            idx === i ? { ...x, priceMinor: Number(e.target.value) || 0 } : x,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Unit</Label>
                    <Select
                      value={t.priceUnit}
                      onValueChange={(v) =>
                        setTiers((prev) =>
                          prev.map((x, idx) => (idx === i ? { ...x, priceUnit: v as PriceUnit } : x)),
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRICE_UNITS.map((u) => (
                          <SelectItem key={u} value={u}>
                            {PRICE_UNIT_LABELS[u]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>Description</Label>
                  <Textarea
                    rows={2}
                    value={t.description ?? ''}
                    onChange={(e) =>
                      setTiers((prev) =>
                        prev.map((x, idx) => (idx === i ? { ...x, description: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>Features (comma-separated)</Label>
                  <Input
                    value={t.features.join(', ')}
                    onChange={(e) =>
                      setTiers((prev) =>
                        prev.map((x, idx) =>
                          idx === i
                            ? {
                                ...x,
                                features: e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              }
                            : x,
                        ),
                      )
                    }
                  />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTiers((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className="size-4" /> Remove
                </Button>
              </div>
            </div>
          ))
        )}
        <div className="flex items-center justify-between">
          <Button
            variant="secondary"
            onClick={() =>
              setTiers((prev) => [
                ...prev,
                {
                  id: `temp-${Date.now()}` as never,
                  name: `Tier ${prev.length + 1}`,
                  description: null,
                  priceMinor: 0,
                  currency: service.currency,
                  priceUnit: service.priceUnit,
                  features: [],
                  sortOrder: prev.length,
                },
              ])
            }
          >
            <Plus className="size-4" /> Add tier
          </Button>
          <Button
            onClick={() => {
              const clean = tiers.map((t) =>
                t.id && !t.id.startsWith('temp-') ? t : { ...t, id: undefined },
              );
              setTiers(clean as never);
              save.mutate();
            }}
            loading={save.isPending}
          >
            Save tiers
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface WeeklyRow {
  dayOfWeek: (typeof DAYS_OF_WEEK)[number];
  open: boolean;
  start: string; // HH:MM
  end: string;
}

// Inline Available/Unavailable toggle rendered in the DetailsCard
// header. Replaces the standalone VisibilityCard so the page goes from
// 6 cards → 5. Same PATCH endpoint + same optimistic invalidation
// pattern as the old card; the badge + button just live inline.
function InlineVisibilityToggle({ service }: { service: Service }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (isAvailable: boolean) =>
      api.patch(`/api/v1/services/${service.id}`, { isAvailable }),
    onSuccess: () => {
      toast.success(service.isAvailable ? 'Marked unavailable' : 'Marked available');
      queryClient.invalidateQueries({ queryKey: ['service', service.id] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });
  return (
    <button
      type="button"
      onClick={() => mutation.mutate(!service.isAvailable)}
      disabled={mutation.isPending}
      title={
        service.isAvailable
          ? 'Click to hide this service from the chatbot'
          : 'Click to make this service available to the chatbot'
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-2 py-0.5 transition hover:border-border hover:bg-surface-muted disabled:opacity-50"
    >
      <span
        aria-hidden
        className={`inline-block size-2 rounded-full ${
          service.isAvailable ? 'bg-emerald-500' : 'bg-foreground-subtle'
        }`}
      />
      <span className={service.isAvailable ? 'text-emerald-700' : 'text-foreground-subtle'}>
        {service.isAvailable ? 'Available' : 'Unavailable'}
      </span>
    </button>
  );
}

function AvailabilityCard({ service }: { service: Service }) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<WeeklyRow[]>(() => buildRows(service.availability));
  useEffect(() => setRows(buildRows(service.availability)), [service]);

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/services/${service.id}/availability`, {
        windows: rows
          .filter((r) => r.open)
          .map((r) => ({
            dayOfWeek: r.dayOfWeek,
            startMinute: timeToMinutes(r.start),
            endMinute: timeToMinutes(r.end),
          })),
      }),
    onSuccess: () => {
      toast.success('Availability saved');
      queryClient.invalidateQueries({ queryKey: ['service', service.id] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Weekly availability</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((row, i) => (
          <div key={row.dayOfWeek} className="grid grid-cols-[100px_auto_1fr_1fr] items-center gap-3">
            <span className="text-sm font-medium">{DAY_OF_WEEK_LABELS[row.dayOfWeek]}</span>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={row.open}
                onChange={(e) =>
                  setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, open: e.target.checked } : r)))
                }
                className="size-4 cursor-pointer rounded border-border accent-brand-500"
              />
              Open
            </label>
            <Input
              type="time"
              disabled={!row.open}
              value={row.start}
              onChange={(e) =>
                setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, start: e.target.value } : r)))
              }
            />
            <Input
              type="time"
              disabled={!row.open}
              value={row.end}
              onChange={(e) =>
                setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, end: e.target.value } : r)))
              }
            />
          </div>
        ))}
        <div className="flex justify-end pt-2">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save availability
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function buildRows(windows: AvailabilityWindow[]): WeeklyRow[] {
  const byDay = new Map(windows.map((w) => [w.dayOfWeek, w]));
  return DAYS_OF_WEEK.map((d) => {
    const w = byDay.get(d);
    return {
      dayOfWeek: d,
      open: !!w,
      start: w ? minutesToTime(w.startMinute) : '09:00',
      end: w ? minutesToTime(w.endMinute) : '17:00',
    };
  });
}

// ---------- Booking rules -------------------------------------------------
// Typed subset of the freeform `bookingRules` JSONB on the service. The
// chatbot can quote any of these back to customers when answering "can I
// cancel?" / "how far in advance?" / "do I need to pay upfront?".
interface BookingRulesForm {
  depositRequired: boolean;
  depositPercent: number | null;
  cancellationWindowHours: number | null;
  leadTimeHours: number | null;
  minPartySize: number | null;
  maxPartySize: number | null;
  notes: string;
}

function readBookingRules(raw: Record<string, unknown> | null): BookingRulesForm {
  const get = (k: string) => (raw && k in raw ? raw[k] : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    depositRequired: get('depositRequired') === true,
    depositPercent: num(get('depositPercent')),
    cancellationWindowHours: num(get('cancellationWindowHours')),
    leadTimeHours: num(get('leadTimeHours')),
    minPartySize: num(get('minPartySize')),
    maxPartySize: num(get('maxPartySize')),
    notes: typeof get('notes') === 'string' ? (get('notes') as string) : '',
  };
}

function BookingRulesCard({ service }: { service: Service }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<BookingRulesForm>(() => readBookingRules(service.bookingRules));
  useEffect(() => setForm(readBookingRules(service.bookingRules)), [service]);

  const save = useMutation({
    mutationFn: () => {
      // Strip null/empty fields so the stored JSONB stays compact and the
      // chatbot only sees the rules the client actually set.
      const payload: Record<string, unknown> = {};
      if (form.depositRequired) payload.depositRequired = true;
      if (form.depositPercent != null) payload.depositPercent = form.depositPercent;
      if (form.cancellationWindowHours != null)
        payload.cancellationWindowHours = form.cancellationWindowHours;
      if (form.leadTimeHours != null) payload.leadTimeHours = form.leadTimeHours;
      if (form.minPartySize != null) payload.minPartySize = form.minPartySize;
      if (form.maxPartySize != null) payload.maxPartySize = form.maxPartySize;
      if (form.notes.trim()) payload.notes = form.notes.trim();
      return api.patch(`/api/v1/services/${service.id}`, { bookingRules: payload });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service', service.id] });
      toast.success('Booking rules saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const intField = (key: keyof BookingRulesForm, label: string, placeholder?: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`br-${String(key)}`}>{label}</Label>
      <Input
        id={`br-${String(key)}`}
        type="number"
        min={0}
        inputMode="numeric"
        placeholder={placeholder}
        value={form[key] == null ? '' : String(form[key])}
        onChange={(e) => {
          const raw = e.target.value.trim();
          setForm({ ...form, [key]: raw === '' ? null : Math.max(0, Number(raw)) });
        }}
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Booking rules</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="br-depositRequired" className="flex items-center gap-2 text-sm">
            <input
              id="br-depositRequired"
              type="checkbox"
              checked={form.depositRequired}
              onChange={(e) => setForm({ ...form, depositRequired: e.target.checked })}
              className="size-4 rounded border-border text-brand-500 focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2"
            />
            <span>Deposit required to book</span>
          </label>
        </div>
        {intField('depositPercent', 'Deposit percent (%)', 'e.g. 25')}
        {intField('cancellationWindowHours', 'Cancellation window (hours)', 'e.g. 24')}
        {intField('leadTimeHours', 'Minimum lead time (hours)', 'e.g. 2')}
        {intField('minPartySize', 'Minimum party size')}
        {intField('maxPartySize', 'Maximum party size')}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="br-notes">Notes for customers</Label>
          <Textarea
            id="br-notes"
            rows={3}
            placeholder="Anything else the chatbot should mention when someone asks about booking rules."
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>
        <div className="sm:col-span-2">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save booking rules
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
