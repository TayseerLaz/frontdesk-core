'use client';

import {
  type BusinessInfoDto,
  CONTACT_KINDS,
  type ContactKind,
  type FaqDto,
  type LocationDto,
  type PolicyDto,
  POLICY_KINDS,
  type PolicyKind,
  DAY_OF_WEEK_LABELS,
  DAYS_OF_WEEK,
  FaqVisibility,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Building2, CalendarCheck, CheckCircle2, ChevronDown, MessageSquare, Plus, Save, ScrollText, ShoppingCart, Trash2, Upload, Users } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownEditor } from '@/components/ui/lazy-editor';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function BusinessInfoPage() {
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  // Booking-form tab tracks the 'bookings' feature; Shop-form tab tracks
  // 'orders'. When ALIGNED-admin turns the feature off the tab is hidden;
  // when it's on, the flow is forced enabled (the org toggle is the master).
  const bookingsOn = !disabledFeatures.includes('bookings');
  const ordersOn = !disabledFeatures.includes('orders');
  return (
    <>
      <PageHeader
        title="Business info"
        description="The profile, hours, FAQs, and policies the chatbot reads from. Team-only data lives in its own tab so operators can tell what the bot sees at a glance."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" asChild>
              <Link href="/imports?kind=business_info">
                <Upload className="size-4" /> Bulk import
              </Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link href="/imports?kind=faq">
                <Upload className="size-4" /> Import FAQs
              </Link>
            </Button>
          </div>
        }
      />
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">
            <Building2 className="mr-2 size-4" /> Profile &amp; hours
          </TabsTrigger>
          <TabsTrigger value="faqs">
            <MessageSquare className="mr-2 size-4" /> FAQs
          </TabsTrigger>
          <TabsTrigger value="policies">
            <ScrollText className="mr-2 size-4" /> Policies
          </TabsTrigger>
          {bookingsOn ? (
            <TabsTrigger value="booking">
              <CalendarCheck className="mr-2 size-4" /> Booking form
            </TabsTrigger>
          ) : null}
          {ordersOn ? (
            <TabsTrigger value="shop">
              <ShoppingCart className="mr-2 size-4" /> Shop form
            </TabsTrigger>
          ) : null}
          {/* Locations + Contact channels — fed into the bot's
              system prompt by gatherBotData(), so the bot can quote
              an address or phone when the customer asks. */}
          <TabsTrigger value="team">
            <Users className="mr-2 size-4" /> Locations &amp; contacts
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfilePanel />
        </TabsContent>
        <TabsContent value="faqs">
          <FaqsPanel />
        </TabsContent>
        <TabsContent value="policies">
          <PoliciesPanel />
        </TabsContent>
        {bookingsOn ? (
          <TabsContent value="booking">
            <BookingFormPanel forceEnabled />
          </TabsContent>
        ) : null}
        {ordersOn ? (
          <TabsContent value="shop">
            <ShopFormPanel forceEnabled />
          </TabsContent>
        ) : null}
        <TabsContent value="team">
          <TeamInfoPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------- profile + hours ------------------------------------------------
type HoursMap = Record<(typeof DAYS_OF_WEEK)[number], { open: string; close: string }[]>;

function emptyHours(): HoursMap {
  return DAYS_OF_WEEK.reduce(
    (acc, d) => ({ ...acc, [d]: [] }),
    {} as HoursMap,
  );
}

function ProfilePanel() {
  const queryClient = useQueryClient();
  const infoQuery = useQuery({
    queryKey: ['business-info'],
    queryFn: () => api.get<{ data: BusinessInfoDto | null }>('/api/v1/business-info'),
  });

  const [draft, setDraft] = useState<{
    legalName: string;
    tagline: string;
    about: string;
    websiteUrl: string;
    timezone: string;
    currency: string;
    hours: HoursMap;
  }>({
    legalName: '',
    tagline: '',
    about: '',
    websiteUrl: '',
    timezone: 'UTC',
    currency: 'USD',
    hours: emptyHours(),
  });

  useEffect(() => {
    const info = infoQuery.data?.data;
    if (!info) return;
    setDraft({
      legalName: info.legalName ?? '',
      tagline: info.tagline ?? '',
      about: info.about ?? '',
      websiteUrl: info.websiteUrl ?? '',
      timezone: info.timezone,
      currency: info.currency,
      hours: { ...emptyHours(), ...((info.operatingHours as HoursMap | null) ?? {}) },
    });
  }, [infoQuery.data]);

  const save = useMutation({
    mutationFn: () => {
      // Sanitize hours before sending: a day toggled open but with a time
      // field cleared would serialize as { open: '', close: '17:00' } and the
      // API (correctly) 400s on the empty HH:MM. Drop any slot missing either
      // time so a half-filled row reads as "closed" instead of failing the
      // whole save.
      const cleanHours = Object.fromEntries(
        DAYS_OF_WEEK.map((day) => [
          day,
          (draft.hours[day] ?? []).filter((s) => s.open && s.close),
        ]),
      );
      return api.put('/api/v1/business-info', {
        legalName: draft.legalName || null,
        tagline: draft.tagline || null,
        about: draft.about || null,
        websiteUrl: draft.websiteUrl || null,
        timezone: draft.timezone,
        currency: draft.currency,
        operatingHours: cleanHours,
      });
    },
    onSuccess: () => {
      toast.success('Business profile saved');
      queryClient.invalidateQueries({ queryKey: ['business-info'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            The fields above the &ldquo;Internal info&rdquo; divider are read by the chatbot — keep
            them accurate.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Bot-facing fields first — these are the rows actually sent
              into the LLM prompt by bot-engine.ts (about, tagline,
              timezone, currency, operatingHours). */}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="tagline">Tagline</Label>
            <Input
              id="tagline"
              placeholder="One short sentence the bot uses to describe the business."
              value={draft.tagline}
              onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="about">About</Label>
            <Textarea
              id="about"
              rows={5}
              placeholder="2–6 sentences. The bot reads this when customers ask about you."
              value={draft.about}
              onChange={(e) => setDraft({ ...draft, about: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              value={draft.timezone}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="currency">Currency (3-letter)</Label>
            <Input
              id="currency"
              value={draft.currency}
              maxLength={3}
              onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })}
            />
          </div>

          {/* Internal info: stored on BusinessInfo but NEVER pulled into
              the bot prompt today. We keep the editor so operators have
              one source of truth, but collapse it + flag it so they
              stop expecting these fields to appear in chatbot replies. */}
          <details className="sm:col-span-2 group rounded-md border border-border bg-surface-muted/30 px-3 py-2 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground-muted">
              <span className="inline-flex items-center gap-2">
                Internal info
                <span className="rounded-full bg-foreground-subtle/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground-subtle">
                  not seen by chatbot
                </span>
              </span>
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="legalName">Legal name</Label>
                <Input
                  id="legalName"
                  value={draft.legalName}
                  onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="websiteUrl">Website</Label>
                <Input
                  id="websiteUrl"
                  type="url"
                  placeholder="https://"
                  value={draft.websiteUrl}
                  onChange={(e) => setDraft({ ...draft, websiteUrl: e.target.value })}
                />
              </div>
            </div>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Operating hours</CardTitle>
          <CardDescription>Add open/close times per day. Leave a day blank to be closed.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {DAYS_OF_WEEK.map((day) => {
            const slot = draft.hours[day]?.[0];
            const open = slot?.open ?? '';
            const close = slot?.close ?? '';
            const isOpen = !!slot;
            return (
              // Flex layout (not grid) so the time inputs can shrink with
              // `min-w-0` and never overflow the card on narrow columns.
              // Time inputs use a tighter h-9 / px-2 style for this row only.
              <div key={day} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 cursor-pointer rounded border-border accent-brand-500"
                  checked={isOpen}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      hours: { ...prev.hours, [day]: e.target.checked ? [{ open: '09:00', close: '17:00' }] : [] },
                    }))
                  }
                />
                <span className="w-[68px] shrink-0 text-xs font-medium">
                  {DAY_OF_WEEK_LABELS[day]}
                </span>
                <Input
                  type="time"
                  disabled={!isOpen}
                  value={open}
                  className="h-9 min-w-0 flex-1 rounded-md px-2 text-xs"
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      hours: { ...prev.hours, [day]: [{ open: e.target.value, close }] },
                    }))
                  }
                />
                <span className="shrink-0 text-foreground-subtle">–</span>
                <Input
                  type="time"
                  disabled={!isOpen}
                  value={close}
                  className="h-9 min-w-0 flex-1 rounded-md px-2 text-xs"
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      hours: { ...prev.hours, [day]: [{ open, close: e.target.value }] },
                    }))
                  }
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="lg:col-span-3">
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          <Save className="size-4" /> Save profile &amp; hours
        </Button>
      </div>
    </div>
  );
}

// ---------- locations + contacts (BOT-FACING) -------------------------------
// Combines Locations + Contacts into a single tab. As of Phase 14 both
// ARE fed into the bot's system prompt (gatherBotData → "Locations" /
// "Contact channels" sections), so the bot can quote a branch address
// or phone number when a customer asks. The green banner replaces the
// older "not seen by chatbot" warning to make that clear.
function TeamInfoPanel() {
  return (
    <div className="space-y-6">
      <div
        role="note"
        className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
      >
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
        <div>
          <p className="font-medium">The chatbot uses this data.</p>
          <p className="mt-0.5 text-xs">
            Locations and contact channels are read into every reply, so the bot can quote a
            branch address or phone number when a customer asks. Primary entries (the star icon
            below) are used by default when the customer doesn&apos;t name a specific branch or
            channel.
          </p>
        </div>
      </div>
      <LocationsPanel />
      <ContactsPanel />
    </div>
  );
}

// ---------- locations ------------------------------------------------------
function LocationsPanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ['locations'],
    queryFn: () => api.get<{ data: LocationDto[] }>('/api/v1/business-info/locations'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/business-info/locations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations'] });
      toast.success('Location removed');
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Locations</CardTitle>
          <CardDescription>Where the business operates from.</CardDescription>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" /> Add location
        </Button>
      </CardHeader>
      <CardContent>
        {list.data?.data.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-foreground-muted">
            No locations yet. Add one so the chatbot can answer "where are you?".
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {list.data?.data.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{l.name}</p>
                    {l.isPrimary ? <Badge variant="default">Primary</Badge> : null}
                  </div>
                  <p className="text-xs text-foreground-muted">
                    {[l.addressLine1, l.city, l.region, l.postalCode, l.country]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  {(l.phone || l.email) && (
                    <p className="text-xs text-foreground-subtle">
                      {[l.phone, l.email].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove location"
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: `Remove "${l.name}"?`,
                        body: 'This location will stop appearing in chatbot replies.',
                        confirmLabel: 'Remove location',
                        destructive: true,
                      })
                    ) {
                      remove.mutate(l.id);
                    }
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <LocationDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

function LocationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    name: '',
    addressLine1: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    phone: '',
    email: '',
    isPrimary: false,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/business-info/locations', {
        name: draft.name,
        addressLine1: draft.addressLine1 || null,
        city: draft.city || null,
        region: draft.region || null,
        postalCode: draft.postalCode || null,
        country: draft.country.toUpperCase() || null,
        phone: draft.phone || null,
        email: draft.email || null,
        isPrimary: draft.isPrimary,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['locations'] });
      toast.success('Location added');
      onOpenChange(false);
      setDraft({
        name: '',
        addressLine1: '',
        city: '',
        region: '',
        postalCode: '',
        country: '',
        phone: '',
        email: '',
        isPrimary: false,
      });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Could not add'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a location</DialogTitle>
          <DialogDescription>
            All fields except name are optional. You can set this location as primary.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="loc-name">Name</Label>
            <Input
              id="loc-name"
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="loc-addr">Address</Label>
            <Input
              id="loc-addr"
              value={draft.addressLine1}
              onChange={(e) => setDraft({ ...draft, addressLine1: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Region / state</Label>
              <Input value={draft.region} onChange={(e) => setDraft({ ...draft, region: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Postal code</Label>
              <Input
                value={draft.postalCode}
                onChange={(e) => setDraft({ ...draft, postalCode: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Country (2-letter)</Label>
              <Input
                maxLength={2}
                value={draft.country}
                onChange={(e) => setDraft({ ...draft, country: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.isPrimary}
              onChange={(e) => setDraft({ ...draft, isPrimary: e.target.checked })}
              className="size-4 rounded border-border accent-brand-500"
            />
            Mark as primary
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add location
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------- contacts -------------------------------------------------------
interface ContactItem {
  id: string;
  kind: ContactKind;
  label: string | null;
  value: string;
  isPrimary: boolean;
  sortOrder: number;
}

function ContactsPanel() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.get<{ data: ContactItem[] }>('/api/v1/business-info/contacts'),
  });
  const [draft, setDraft] = useState<{ kind: ContactKind; label: string; value: string }>({
    kind: 'whatsapp',
    label: '',
    value: '',
  });
  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/business-info/contacts', {
        kind: draft.kind,
        label: draft.label || null,
        value: draft.value,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast.success('Contact added');
      setDraft({ kind: 'whatsapp', label: '', value: '' });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/business-info/contacts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts'] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contact channels</CardTitle>
        <CardDescription>Phones, emails, and social handles your customers can reach you at.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Select value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as ContactKind })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Label (optional)"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <Input
            required
            placeholder="Value (e.g. +1 555 0100)"
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          />
          <Button type="submit" loading={create.isPending}>
            <Plus className="size-4" /> Add
          </Button>
        </form>

        <ul className="divide-y divide-border">
          {list.data?.data.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2">
              <div className="flex items-center gap-3">
                <Badge variant="muted">{c.kind}</Badge>
                <span className="font-medium">{c.value}</span>
                {c.label ? <span className="text-xs text-foreground-subtle">{c.label}</span> : null}
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove"
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: 'Remove this contact?',
                      confirmLabel: 'Remove',
                      destructive: true,
                    })
                  ) {
                    remove.mutate(c.id);
                  }
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------- FAQs -----------------------------------------------------------
function FaqsPanel() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['faqs'],
    queryFn: () => api.get<{ data: FaqDto[] }>('/api/v1/business-info/faqs'),
  });
  const [draft, setDraft] = useState({ question: '', answer: '' });
  const create = useMutation({
    mutationFn: () => api.post('/api/v1/business-info/faqs', draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['faqs'] });
      setDraft({ question: '', answer: '' });
      toast.success('FAQ added');
    },
  });
  const update = useMutation({
    mutationFn: (vars: { id: string; patch: Partial<FaqDto> }) =>
      api.patch(`/api/v1/business-info/faqs/${vars.id}`, vars.patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['faqs'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/business-info/faqs/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['faqs'] }),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Add FAQ</CardTitle>
          <CardDescription>Public FAQs are exposed to the chatbot read API.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="faq-q">Question</Label>
              <Input
                id="faq-q"
                required
                value={draft.question}
                onChange={(e) => setDraft({ ...draft, question: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="faq-a">Answer</Label>
              <Textarea
                id="faq-a"
                rows={4}
                required
                value={draft.answer}
                onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
              />
            </div>
            <Button type="submit" loading={create.isPending}>
              <Plus className="size-4" /> Add FAQ
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing FAQs</CardTitle>
        </CardHeader>
        <CardContent>
          {list.data?.data.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-foreground-muted">No FAQs yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((f) => (
                <li key={f.id} className="space-y-2 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <p className="font-medium">{f.question}</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-foreground-muted">{f.answer}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={f.visibility}
                        onValueChange={(v) =>
                          update.mutate({ id: f.id, patch: { visibility: v as FaqVisibility } })
                        }
                      >
                        <SelectTrigger className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="public">Public</SelectItem>
                          <SelectItem value="private">Private</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Delete FAQ"
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              title: 'Delete this FAQ?',
                              confirmLabel: 'Delete FAQ',
                              destructive: true,
                            })
                          ) {
                            remove.mutate(f.id);
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Policies -------------------------------------------------------
function PoliciesPanel() {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['policies'],
    queryFn: () => api.get<{ data: PolicyDto[] }>('/api/v1/business-info/policies'),
  });
  const [kind, setKind] = useState<PolicyKind>('return');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const upsert = useMutation({
    mutationFn: () => api.put('/api/v1/business-info/policies', { kind, title, content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies'] });
      toast.success('Policy saved');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/business-info/policies/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['policies'] }),
  });

  // Pre-fill from existing policy of same kind.
  useEffect(() => {
    const existing = list.data?.data.find((p) => p.kind === kind);
    if (existing) {
      setTitle(existing.title);
      setContent(existing.content);
    } else {
      setTitle('');
      setContent('');
    }
  }, [kind, list.data]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Edit policy</CardTitle>
          <CardDescription>One policy per kind. Saving replaces the existing one.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as PolicyKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POLICY_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Return policy" />
          </div>
          <div className="space-y-1.5">
            <Label>Content</Label>
            <MarkdownEditor
              rows={10}
              value={content}
              placeholder="Use the toolbar for formatting. Stored as markdown."
              onChange={setContent}
            />
          </div>
          <Button onClick={() => upsert.mutate()} loading={upsert.isPending} disabled={!title || !content}>
            <Save className="size-4" /> Save policy
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Existing</CardTitle>
        </CardHeader>
        <CardContent>
          {list.data?.data.length === 0 ? (
            <p className="text-sm text-foreground-muted">No policies yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((p) => (
                <li key={p.id} className="flex items-start justify-between py-3">
                  <div>
                    <p className="text-sm font-medium">{p.title}</p>
                    <Badge variant="muted">{p.kind}</Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete"
                    onClick={async () => {
                      if (
                        await confirmDialog({
                          title: 'Delete this policy?',
                          confirmLabel: 'Delete policy',
                          destructive: true,
                        })
                      ) {
                        remove.mutate(p.id);
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- booking form ---------------------------------------------------
const BOOKING_FIELD_TYPES = ['text', 'email', 'phone', 'date', 'time', 'number', 'long_text'] as const;
type BookingFieldType = (typeof BOOKING_FIELD_TYPES)[number];

interface BookingFieldDraft {
  key: string;
  label: string;
  type: BookingFieldType;
  required: boolean;
}

interface AvailabilityWindowDraft {
  day: number; // 0=Sun..6=Sat
  start: string; // HH:MM
  end: string; // HH:MM
}

interface BookingAvailabilityDraft {
  enabled: boolean;
  timezone: string;
  slotMinutes: number;
  capacityPerSlot: number;
  leadMinutes: number;
  horizonDays: number;
  windows: AvailabilityWindowDraft[];
}

interface BookingFormDraft {
  enabled: boolean;
  title: string;
  intentKeywords: string[];
  fields: BookingFieldDraft[];
  availability: BookingAvailabilityDraft;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function defaultAvailability(): BookingAvailabilityDraft {
  return {
    enabled: false,
    timezone:
      (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC',
    slotMinutes: 30,
    capacityPerSlot: 1,
    leadMinutes: 60,
    horizonDays: 14,
    // Default Mon–Fri 09:00–17:00.
    windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
  };
}

function defaultBookingForm(): BookingFormDraft {
  return {
    enabled: false,
    title: 'Book a consultation',
    intentKeywords: ['book', 'appointment', 'consultation', 'reserve', 'schedule'],
    fields: [
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true },
      { key: 'date', label: 'Preferred date', type: 'date', required: true },
      { key: 'notes', label: 'Anything else?', type: 'long_text', required: false },
    ],
    availability: defaultAvailability(),
  };
}

function BookingFormPanel({ forceEnabled = false }: { forceEnabled?: boolean }) {
  const queryClient = useQueryClient();
  const infoQuery = useQuery({
    queryKey: ['business-info'],
    queryFn: () => api.get<{ data: BusinessInfoDto | null }>('/api/v1/business-info'),
  });

  const [draft, setDraft] = useState<BookingFormDraft>(defaultBookingForm());
  const [keywordsInput, setKeywordsInput] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Master switch: when the org has the 'bookings' feature on, keep the flow
  // enabled (covers the no-saved-form default case too).
  useEffect(() => {
    if (forceEnabled) setDraft((d) => (d.enabled ? d : { ...d, enabled: true }));
  }, [forceEnabled]);

  useEffect(() => {
    if (!infoQuery.data || loaded) return;
    const incoming = (
      infoQuery.data.data as {
        bookingForm?: BookingFormDraft & { availability?: Partial<BookingAvailabilityDraft> | null };
      } | null
    )?.bookingForm;
    if (incoming && Array.isArray(incoming.fields)) {
      const av = incoming.availability;
      const baseAv = defaultAvailability();
      setDraft({
        // Org-level 'bookings' feature is the master switch — when on, the
        // booking flow is always enabled (the in-page toggle is locked on).
        enabled: forceEnabled ? true : !!incoming.enabled,
        title: incoming.title || 'Book a consultation',
        intentKeywords: incoming.intentKeywords ?? [],
        fields: incoming.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: (BOOKING_FIELD_TYPES as readonly string[]).includes(f.type)
            ? (f.type as BookingFieldType)
            : 'text',
          required: f.required !== false,
        })),
        availability: av
          ? {
              enabled: !!av.enabled,
              timezone: av.timezone || baseAv.timezone,
              slotMinutes: av.slotMinutes ?? baseAv.slotMinutes,
              capacityPerSlot: av.capacityPerSlot ?? baseAv.capacityPerSlot,
              leadMinutes: av.leadMinutes ?? baseAv.leadMinutes,
              horizonDays: av.horizonDays ?? baseAv.horizonDays,
              windows: Array.isArray(av.windows) ? (av.windows as AvailabilityWindowDraft[]) : baseAv.windows,
            }
          : baseAv,
      });
      setKeywordsInput((incoming.intentKeywords ?? []).join(', '));
    } else {
      const d = defaultBookingForm();
      setDraft(d);
      setKeywordsInput(d.intentKeywords.join(', '));
    }
    setLoaded(true);
  }, [infoQuery.data, loaded]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/business-info', {
        bookingForm: {
          enabled: draft.enabled,
          title: draft.title.trim() || 'Booking',
          intentKeywords: keywordsInput
            .split(/[,\n]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          fields: draft.fields,
          availability: {
            enabled: draft.availability.enabled,
            timezone: draft.availability.timezone.trim() || 'UTC',
            slotMinutes: draft.availability.slotMinutes,
            capacityPerSlot: draft.availability.capacityPerSlot,
            leadMinutes: draft.availability.leadMinutes,
            horizonDays: draft.availability.horizonDays,
            windows: draft.availability.windows,
          },
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-info'] });
      toast.success('Booking form saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const setField = (i: number, patch: Partial<BookingFieldDraft>) => {
    setDraft((d) => {
      const next = [...d.fields];
      next[i] = { ...next[i]!, ...patch };
      return { ...d, fields: next };
    });
  };

  const addField = () => {
    setDraft((d) => ({
      ...d,
      fields: [
        ...d.fields,
        { key: `field_${d.fields.length + 1}`, label: '', type: 'text', required: true },
      ],
    }));
  };

  const removeField = (i: number) => {
    setDraft((d) => ({ ...d, fields: d.fields.filter((_, idx) => idx !== i) }));
  };

  // Move field at index `i` by `delta` (-1 / +1). The bot asks for
  // fields in array order, so reordering directly changes the question
  // sequence the customer experiences during booking.
  const moveField = (i: number, delta: number) => {
    setDraft((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.fields.length) return d;
      const next = [...d.fields];
      const tmp = next[i]!;
      next[i] = next[j]!;
      next[j] = tmp;
      return { ...d, fields: next };
    });
  };

  // ----- availability setters -----
  const setAv = (patch: Partial<BookingAvailabilityDraft>) =>
    setDraft((d) => ({ ...d, availability: { ...d.availability, ...patch } }));
  const setWindow = (i: number, patch: Partial<AvailabilityWindowDraft>) =>
    setDraft((d) => {
      const next = [...d.availability.windows];
      next[i] = { ...next[i]!, ...patch };
      return { ...d, availability: { ...d.availability, windows: next } };
    });
  const addWindow = () =>
    setDraft((d) => ({
      ...d,
      availability: {
        ...d.availability,
        windows: [...d.availability.windows, { day: 1, start: '09:00', end: '17:00' }],
      },
    }));
  const removeWindow = (i: number) =>
    setDraft((d) => ({
      ...d,
      availability: { ...d.availability, windows: d.availability.windows.filter((_, idx) => idx !== i) },
    }));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Booking form</CardTitle>
          <CardDescription>
            Configure the fields the AI chatbot asks for when a customer wants to book a meeting,
            consultation, or appointment. Each completed booking lands on the{' '}
            <a className="text-brand-600 hover:underline" href="/bookings">
              /bookings
            </a>{' '}
            page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {forceEnabled ? (
            <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 dark:border-emerald-400/30 dark:bg-emerald-400/10">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
              <div className="text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-300">
                  Booking flow is on
                </p>
                <p className="text-xs text-foreground-muted">
                  Bookings are enabled for your workspace, so this flow is always on. Configure the
                  fields below.
                </p>
              </div>
            </div>
          ) : (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-brand-600"
                checked={draft.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              />
              <div className="text-sm">
                <p className="font-medium">Enable booking flow</p>
                <p className="text-xs text-foreground-muted">
                  When on, the AI will offer to collect these fields when a customer asks to book.
                </p>
              </div>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Title (shown in the prompt + on /bookings)</Label>
              <Input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="Book a consultation"
              />
            </div>
            <div>
              <Label>Trigger keywords (comma-separated)</Label>
              <Input
                value={keywordsInput}
                onChange={(e) => setKeywordsInput(e.target.value)}
                placeholder="book, appointment, consultation, reserve"
              />
              <p className="mt-1 text-xs text-foreground-muted">
                The AI starts the booking flow when the customer's message matches one of these.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Fields to collect</Label>
              <Button size="sm" variant="ghost" onClick={addField}>
                <Plus className="mr-1 size-4" /> Add field
              </Button>
            </div>
            {draft.fields.length === 0 ? (
              <p className="rounded border border-dashed border-border bg-surface-muted/40 p-4 text-center text-xs italic text-foreground-muted">
                No fields yet. Add at least one to enable the flow.
              </p>
            ) : (
              <div className="space-y-2">
                {draft.fields.map((f, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-1 gap-2 rounded border border-border bg-surface p-3 sm:grid-cols-[1fr_1.5fr_140px_120px_32px_32px_36px]"
                  >
                    <Input
                      placeholder="key (e.g. name)"
                      value={f.key}
                      onChange={(e) =>
                        setField(i, {
                          key: e.target.value
                            .replace(/[^a-z0-9_]/gi, '_')
                            .toLowerCase()
                            .slice(0, 60),
                        })
                      }
                    />
                    <Input
                      placeholder="Label shown to the customer"
                      value={f.label}
                      onChange={(e) => setField(i, { label: e.target.value.slice(0, 120) })}
                    />
                    <Select
                      value={f.type}
                      onValueChange={(v) => setField(i, { type: v as BookingFieldType })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BOOKING_FIELD_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand-600"
                        checked={f.required}
                        onChange={(e) => setField(i, { required: e.target.checked })}
                      />
                      Required
                    </label>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => moveField(i, -1)}
                      aria-label="Move field up"
                      disabled={i === 0}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => moveField(i, 1)}
                      aria-label="Move field down"
                      disabled={i === draft.fields.length - 1}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => removeField(i)}
                      aria-label="Remove field"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ---- Availability (weekly recurring) ---- */}
          <div className="space-y-4 rounded-lg border border-border p-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={draft.availability.enabled}
                onChange={(e) => setAv({ enabled: e.target.checked })}
              />
              <span>
                <p className="font-medium">Limit bookings to my availability</p>
                <p className="text-sm text-foreground-muted">
                  When on, the AI offers only open time slots from your weekly schedule and hides any
                  slot that's already full. Off = the AI just collects a free-text date.
                </p>
              </span>
            </label>

            {draft.availability.enabled ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Timezone (IANA)</Label>
                    <Input
                      value={draft.availability.timezone}
                      onChange={(e) => setAv({ timezone: e.target.value })}
                      placeholder="Asia/Beirut"
                    />
                  </div>
                  <div>
                    <Label>Slot length (minutes)</Label>
                    <Input
                      type="number"
                      min={5}
                      max={480}
                      value={draft.availability.slotMinutes}
                      onChange={(e) => setAv({ slotMinutes: Math.max(5, Number(e.target.value) || 30) })}
                    />
                  </div>
                  <div>
                    <Label>Capacity per slot</Label>
                    <Input
                      type="number"
                      min={1}
                      max={1000}
                      value={draft.availability.capacityPerSlot}
                      onChange={(e) =>
                        setAv({ capacityPerSlot: Math.max(1, Number(e.target.value) || 1) })
                      }
                    />
                    <p className="mt-1 text-xs text-foreground-muted">
                      How many bookings fit one slot before it's hidden as full (1 = exclusive).
                    </p>
                  </div>
                  <div>
                    <Label>Minimum notice (minutes)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={draft.availability.leadMinutes}
                      onChange={(e) => setAv({ leadMinutes: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  </div>
                  <div>
                    <Label>Offer up to (days ahead)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={120}
                      value={draft.availability.horizonDays}
                      onChange={(e) => setAv({ horizonDays: Math.max(1, Number(e.target.value) || 14) })}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Weekly hours</Label>
                  {draft.availability.windows.length === 0 ? (
                    <p className="text-sm text-foreground-muted">
                      No hours yet — add at least one window.
                    </p>
                  ) : null}
                  {draft.availability.windows.map((w, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
                        value={w.day}
                        onChange={(e) => setWindow(i, { day: Number(e.target.value) })}
                      >
                        {DOW.map((name, idx) => (
                          <option key={idx} value={idx}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <Input
                        type="time"
                        value={w.start}
                        onChange={(e) => setWindow(i, { start: e.target.value })}
                        className="w-32"
                      />
                      <span className="text-foreground-muted">–</span>
                      <Input
                        type="time"
                        value={w.end}
                        onChange={(e) => setWindow(i, { end: e.target.value })}
                        className="w-32"
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeWindow(i)}
                        aria-label="Remove window"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Button variant="secondary" size="sm" onClick={addWindow}>
                    + Add hours
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              <Save className="mr-2 size-4" /> Save booking form
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- shop form ------------------------------------------------------
const SHOP_FIELD_TYPES = [
  'text',
  'email',
  'phone',
  'date',
  'time',
  'datetime',
  'number',
  'long_text',
  'select',
] as const;
type ShopFieldType = (typeof SHOP_FIELD_TYPES)[number];

interface ShopFieldDraft {
  key: string;
  label: string;
  type: ShopFieldType;
  required: boolean;
  options?: string[];
}

interface ShopFormDraft {
  enabled: boolean;
  title: string;
  intentKeywords: string[];
  fields: ShopFieldDraft[];
  // Stored in minor units in the DB; this draft uses major (KD, USD) for the
  // operator UI and only converts on save / load.
  minOrderMajor: string;
  deliveryFeeMajor: string;
  freeDeliveryAboveMajor: string;
  confirmationMessage: string;
  // Public menu URL — the bot sends this when the customer asks about
  // the menu. Empty string = no link configured.
  menuUrl: string;
  // Serviceable delivery areas, comma-separated in the UI (stored as an
  // array). Empty = deliver anywhere. The bot refuses out-of-area addresses.
  deliveryAreas: string;
}

function defaultShopForm(): ShopFormDraft {
  return {
    enabled: false,
    title: 'Place an order',
    intentKeywords: ['order', 'buy', 'delivery', 'menu', 'want', 'get'],
    fields: [
      { key: 'delivery_address', label: 'Delivery address', type: 'text', required: true },
      { key: 'delivery_time', label: 'When do you want it?', type: 'datetime', required: false },
      {
        key: 'payment_method',
        label: 'Payment',
        type: 'select',
        required: true,
        options: ['Cash', 'Card on delivery', 'KNET / online'],
      },
      { key: 'notes', label: 'Anything else?', type: 'long_text', required: false },
    ],
    minOrderMajor: '',
    deliveryFeeMajor: '',
    freeDeliveryAboveMajor: '',
    confirmationMessage:
      "Got it! Order #{{cart_id_short}} is confirmed. Total {{total}}. We'll be in touch shortly. 🙏",
    menuUrl: '',
    deliveryAreas: '',
  };
}

// Currencies follow ISO 4217 minor-unit counts. KWD uses 3; USD/EUR/GBP use 2.
// `currency` is the org-default loaded alongside the shop form below.
function minorToMajor(value: number | null | undefined, currency: string): string {
  if (value == null) return '';
  const minorUnits = currency === 'KWD' || currency === 'BHD' || currency === 'OMR' ? 1000 : 100;
  return (value / minorUnits).toString();
}
function majorToMinor(raw: string, currency: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  const minorUnits = currency === 'KWD' || currency === 'BHD' || currency === 'OMR' ? 1000 : 100;
  return Math.round(n * minorUnits);
}

function ShopFormPanel({ forceEnabled = false }: { forceEnabled?: boolean }) {
  const queryClient = useQueryClient();
  const infoQuery = useQuery({
    queryKey: ['business-info'],
    queryFn: () => api.get<{ data: BusinessInfoDto | null }>('/api/v1/business-info'),
  });

  const orgCurrency = infoQuery.data?.data?.currency ?? 'USD';
  const [draft, setDraft] = useState<ShopFormDraft>(defaultShopForm());
  const [keywordsInput, setKeywordsInput] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [dismissedSuggestion, setDismissedSuggestion] = useState(false);

  // Master switch: when the org has the 'orders' feature on, keep the cart
  // flow enabled (covers the no-saved-form default case too).
  useEffect(() => {
    if (forceEnabled) setDraft((d) => (d.enabled ? d : { ...d, enabled: true }));
  }, [forceEnabled]);

  // Heuristic: if the org has visible products AND most of them are
  // priced, suggest enabling the shop form. Quiet for orgs that look
  // service-only or that have already enabled / dismissed it.
  const productsHeuristicQ = useQuery({
    queryKey: ['business-info', 'products-heuristic'],
    queryFn: async () => {
      const res = await api.get<{
        data: { id: string; priceMinor: number | null }[];
      }>(`/api/v1/products?limit=20`);
      const rows = res.data ?? [];
      const priced = rows.filter((p) => p.priceMinor != null && p.priceMinor > 0);
      return {
        productsCount: rows.length,
        pricedShare: rows.length > 0 ? priced.length / rows.length : 0,
      };
    },
    // Cheap — runs once per session for this org.
    staleTime: 1000 * 60 * 10,
  });
  const heuristicSuggests =
    !forceEnabled &&
    !draft.enabled &&
    !dismissedSuggestion &&
    (productsHeuristicQ.data?.productsCount ?? 0) >= 3 &&
    (productsHeuristicQ.data?.pricedShare ?? 0) >= 0.5;

  useEffect(() => {
    if (!infoQuery.data || loaded) return;
    const incoming = (
      infoQuery.data.data as {
        shopForm?: {
          enabled?: boolean;
          title?: string;
          intentKeywords?: string[];
          fields?: { key: string; label: string; type: string; required?: boolean; options?: string[] }[];
          minOrderMinor?: number | null;
          deliveryFeeMinor?: number | null;
          freeDeliveryAboveMinor?: number | null;
          confirmationMessage?: string;
          menuUrl?: string | null;
          deliveryAreas?: string[];
        };
      } | null
    )?.shopForm;
    if (incoming && Array.isArray(incoming.fields)) {
      setDraft({
        enabled: forceEnabled ? true : !!incoming.enabled,
        title: incoming.title || 'Place an order',
        intentKeywords: incoming.intentKeywords ?? [],
        fields: incoming.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: (SHOP_FIELD_TYPES as readonly string[]).includes(f.type)
            ? (f.type as ShopFieldType)
            : 'text',
          required: f.required !== false,
          options: Array.isArray(f.options) ? f.options.slice(0, 40) : undefined,
        })),
        minOrderMajor: minorToMajor(incoming.minOrderMinor, orgCurrency),
        deliveryFeeMajor: minorToMajor(incoming.deliveryFeeMinor, orgCurrency),
        freeDeliveryAboveMajor: minorToMajor(incoming.freeDeliveryAboveMinor, orgCurrency),
        confirmationMessage:
          incoming.confirmationMessage ?? defaultShopForm().confirmationMessage,
        menuUrl: incoming.menuUrl ?? '',
        deliveryAreas: (incoming.deliveryAreas ?? []).join(', '),
      });
      setKeywordsInput((incoming.intentKeywords ?? []).join(', '));
    } else {
      const d = defaultShopForm();
      setDraft(d);
      setKeywordsInput(d.intentKeywords.join(', '));
    }
    setLoaded(true);
  }, [infoQuery.data, loaded, orgCurrency]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/business-info', {
        shopForm: {
          enabled: draft.enabled,
          title: draft.title.trim() || 'Shop',
          intentKeywords: keywordsInput
            .split(/[,\n]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          fields: draft.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            // Only include options for select-type fields.
            ...(f.type === 'select' && f.options && f.options.length > 0
              ? { options: f.options }
              : {}),
          })),
          minOrderMinor: majorToMinor(draft.minOrderMajor, orgCurrency),
          deliveryFeeMinor: majorToMinor(draft.deliveryFeeMajor, orgCurrency),
          freeDeliveryAboveMinor: majorToMinor(draft.freeDeliveryAboveMajor, orgCurrency),
          confirmationMessage: draft.confirmationMessage.trim(),
          // Send null when blank so the engine treats the field as
          // explicitly unset instead of as an empty string.
          menuUrl: draft.menuUrl.trim() || null,
          deliveryAreas: draft.deliveryAreas
            .split(/[,\n]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-info'] });
      toast.success('Shop form saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const setField = (i: number, patch: Partial<ShopFieldDraft>) => {
    setDraft((d) => {
      const next = [...d.fields];
      next[i] = { ...next[i]!, ...patch };
      return { ...d, fields: next };
    });
  };

  const addField = () => {
    setDraft((d) => ({
      ...d,
      fields: [
        ...d.fields,
        { key: `field_${d.fields.length + 1}`, label: '', type: 'text', required: true },
      ],
    }));
  };

  const removeField = (i: number) => {
    setDraft((d) => ({ ...d, fields: d.fields.filter((_, idx) => idx !== i) }));
  };

  // Move field at index `i` by `delta` (typically -1 or +1). The bot
  // asks for fields in array order, so this directly controls the
  // question sequence the customer experiences.
  const moveField = (i: number, delta: number) => {
    setDraft((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.fields.length) return d;
      const next = [...d.fields];
      const tmp = next[i]!;
      next[i] = next[j]!;
      next[j] = tmp;
      return { ...d, fields: next };
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Shop form</CardTitle>
          <CardDescription>
            Configure what the AI bot asks for once a customer's cart is settled. Each placed order
            lands on the{' '}
            <a className="text-brand-600 hover:underline" href="/cart">
              /cart
            </a>{' '}
            page. Money values use this org's currency ({orgCurrency}).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {heuristicSuggests ? (
            <div className="flex items-start gap-3 rounded-md border border-brand-200 bg-brand-50/60 p-3 text-sm">
              <ShoppingCart className="mt-0.5 size-4 text-brand-600" />
              <div className="flex-1">
                <p className="font-medium text-brand-700">Looks like you sell products.</p>
                <p className="mt-0.5 text-xs text-brand-700/80">
                  Your catalog has {productsHeuristicQ.data?.productsCount} priced products. Turn on
                  the shop flow and the bot will help customers build a cart from your menu.
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDraft((d) => ({ ...d, enabled: true }))}
              >
                Enable
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDismissedSuggestion(true)}
                aria-label="Dismiss suggestion"
              >
                Dismiss
              </Button>
            </div>
          ) : null}
          {forceEnabled ? (
            <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2.5 dark:border-emerald-400/30 dark:bg-emerald-400/10">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
              <div className="text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-300">
                  Shop / cart flow is on
                </p>
                <p className="text-xs text-foreground-muted">
                  Orders are enabled for your workspace, so the cart flow is always on. Configure the
                  fields below.
                </p>
              </div>
            </div>
          ) : (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-brand-600"
                checked={draft.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              />
              <div className="text-sm">
                <p className="font-medium">Enable shop / cart flow</p>
                <p className="text-xs text-foreground-muted">
                  When on, the bot will help customers build a cart from your products and ask for
                  these fields to finalize the order.
                </p>
              </div>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Title (shown in the prompt + on /cart)</Label>
              <Input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="Place an order"
              />
            </div>
            <div>
              <Label>Trigger keywords (comma-separated)</Label>
              <Input
                value={keywordsInput}
                onChange={(e) => setKeywordsInput(e.target.value)}
                placeholder="order, buy, delivery, menu"
              />
              <p className="mt-1 text-xs text-foreground-muted">
                The bot starts the cart flow when the customer's message matches one of these.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Minimum order ({orgCurrency})</Label>
              <Input
                inputMode="decimal"
                value={draft.minOrderMajor}
                onChange={(e) => setDraft((d) => ({ ...d, minOrderMajor: e.target.value }))}
                placeholder="0"
              />
              <p className="mt-1 text-xs text-foreground-muted">
                Refuse to place carts below this. Leave blank for no minimum.
              </p>
            </div>
            <div>
              <Label>Delivery fee ({orgCurrency})</Label>
              <Input
                inputMode="decimal"
                value={draft.deliveryFeeMajor}
                onChange={(e) => setDraft((d) => ({ ...d, deliveryFeeMajor: e.target.value }))}
                placeholder="0"
              />
              <p className="mt-1 text-xs text-foreground-muted">
                Flat fee added to every cart. Leave blank for free delivery.
              </p>
            </div>
            <div>
              <Label>Free delivery above ({orgCurrency})</Label>
              <Input
                inputMode="decimal"
                value={draft.freeDeliveryAboveMajor}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, freeDeliveryAboveMajor: e.target.value }))
                }
                placeholder="—"
              />
              <p className="mt-1 text-xs text-foreground-muted">
                Subtotal threshold that waives the delivery fee. Blank = never waive.
              </p>
            </div>
          </div>

          <div>
            <Label>Confirmation message</Label>
            <Textarea
              rows={3}
              value={draft.confirmationMessage}
              onChange={(e) =>
                setDraft((d) => ({ ...d, confirmationMessage: e.target.value }))
              }
              placeholder="Got it! Your order is in. We'll be in touch soon."
            />
            <p className="mt-1 text-xs text-foreground-muted">
              What the bot replies when the cart is placed. Supports{' '}
              <code className="rounded bg-surface-muted px-1 text-[11px]">{`{{cart_id_short}}`}</code>{' '}
              and{' '}
              <code className="rounded bg-surface-muted px-1 text-[11px]">{`{{total}}`}</code>{' '}
              placeholders.
            </p>
          </div>

          <div>
            <Label htmlFor="shop-menu-url">Menu link (optional)</Label>
            <Input
              id="shop-menu-url"
              type="url"
              inputMode="url"
              value={draft.menuUrl}
              onChange={(e) => setDraft((d) => ({ ...d, menuUrl: e.target.value }))}
              placeholder="https://your-business.com/menu"
            />
            <p className="mt-1 text-xs text-foreground-muted">
              Public URL to your online menu / catalog. When set, the bot sends this link
              whenever the customer asks about the menu (e.g. &quot;menu link&quot;, &quot;what do you
              have&quot;, &quot;show me your menu&quot;). Leave blank to skip the rule.
            </p>
          </div>

          <div>
            <Label htmlFor="shop-delivery-areas">Delivery areas (optional)</Label>
            <Input
              id="shop-delivery-areas"
              value={draft.deliveryAreas}
              onChange={(e) => setDraft((d) => ({ ...d, deliveryAreas: e.target.value }))}
              placeholder="Salmiya, Hawalli, Kuwait City"
            />
            <p className="mt-1 text-xs text-foreground-muted">
              Comma-separated areas you deliver to. When set, the bot only accepts delivery
              to these areas — for an out-of-area address it politely declines and offers
              pickup or a teammate (instead of confirming an undeliverable order). Leave
              blank to deliver anywhere.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Fields to collect</Label>
              <Button size="sm" variant="ghost" onClick={addField}>
                <Plus className="mr-1 size-4" /> Add field
              </Button>
            </div>
            {draft.fields.length === 0 ? (
              <p className="rounded border border-dashed border-border bg-surface-muted/40 p-4 text-center text-xs italic text-foreground-muted">
                No fields yet. Add at least one to enable the flow.
              </p>
            ) : (
              <div className="space-y-2">
                {draft.fields.map((f, i) => (
                  <div
                    key={i}
                    className="space-y-2 rounded border border-border bg-surface p-3"
                  >
                    {/* Grid columns: key · label · type · required · move-up · move-down · delete.
                        The reorder buttons control the order in which the bot asks for the fields. */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.5fr_140px_120px_32px_32px_36px]">
                      <Input
                        placeholder="key (e.g. address)"
                        value={f.key}
                        onChange={(e) =>
                          setField(i, {
                            key: e.target.value
                              .replace(/[^a-z0-9_]/gi, '_')
                              .toLowerCase()
                              .slice(0, 60),
                          })
                        }
                      />
                      <Input
                        placeholder="Label shown to the customer"
                        value={f.label}
                        onChange={(e) => setField(i, { label: e.target.value.slice(0, 120) })}
                      />
                      <Select
                        value={f.type}
                        onValueChange={(v) =>
                          setField(i, {
                            type: v as ShopFieldType,
                            // Reset options if switching away from select.
                            options: v === 'select' ? f.options ?? [''] : undefined,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SHOP_FIELD_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          className="size-4 accent-brand-600"
                          checked={f.required}
                          onChange={(e) => setField(i, { required: e.target.checked })}
                        />
                        Required
                      </label>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => moveField(i, -1)}
                        aria-label="Move field up"
                        disabled={i === 0}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => moveField(i, 1)}
                        aria-label="Move field down"
                        disabled={i === draft.fields.length - 1}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeField(i)}
                        aria-label="Remove field"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    {f.type === 'select' ? (
                      <div className="pl-1">
                        <Label className="text-xs">Choices (one per line)</Label>
                        <Textarea
                          rows={2}
                          value={(f.options ?? []).join('\n')}
                          onChange={(e) =>
                            setField(i, {
                              options: e.target.value
                                .split(/\n+/)
                                .map((s) => s.trim())
                                .filter(Boolean)
                                .slice(0, 40),
                            })
                          }
                          placeholder={'Cash\nCard\nKNET'}
                        />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              <Save className="mr-2 size-4" /> Save shop form
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
