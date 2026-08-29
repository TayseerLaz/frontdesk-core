'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CalendarCheck,
  Bell,
  Clock,
  Globe,
  Hash,
  Phone,
  Plus,
  ShoppingBag,
  Sparkles,
  Tag as TagIcon,
  UserPen,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Overview {
  contact: {
    id: string;
    phoneE164: string;
    displayName: string | null;
    whatsappName: string | null;
    optedInAt: string | null;
    optedOutAt: string | null;
    timezone: string | null;
    source: string;
    tags: string[];
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    createdAt: string | null;
  } | null;
  memory: {
    persona: string | null;
    operatorNote: string | null;
    operatorNoteAt: string | null;
    language: string | null;
    facts: Record<string, unknown>;
    lastSummaryAt: string | null;
  } | null;
  orders: {
    id: string;
    createdAt: string;
    status: string;
    totalMinor: number;
    currency: string;
    itemsCount: number;
    items: { name: string; quantity: number }[];
  }[];
  bookings: {
    id: string;
    status: string;
    appointmentAt: string | null;
    notes: string | null;
    createdAt: string;
    fields: { label: string; value: string }[];
  }[];
  stats: { inboundCount: number; outboundCount: number; threadId: string | null };
  // hader-support only: the lead + distilled portfolio + tailored brief.
  lead: {
    name: string;
    phone: string;
    source: string;
    status: string;
    note: string | null;
    capturedAt: string;
    summary: string | null;
    portfolio: { label: string; value: string }[];
    howHaderHelps: string[];
    howToApproach: string[];
  } | null;
}

function money(minor: number, currency: string): string {
  const dec = ['KWD', 'BHD', 'OMR', 'JOD'].includes(currency) ? 3 : 2;
  return `${(minor / Math.pow(10, dec)).toFixed(dec)} ${currency}`;
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Phone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border px-5 py-4">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
        <Icon className="size-3.5" /> {title}
      </h3>
      {children}
    </div>
  );
}

/**
 * Right-side slide-over showing everything we know about one customer, keyed
 * by phone. Used from the inbox conversation header AND the contacts page.
 * Reads GET /contacts/overview; tag add/remove writes through the existing
 * /contacts/:id/tags endpoints.
 */
export function CustomerInfoSheet({
  phone,
  fallbackName,
  open,
  onClose,
}: {
  phone: string | null;
  fallbackName?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { session } = useSession();
  // Respect the org's feature access: only show Orders / Bookings here when the
  // tenant actually has those features enabled (orders → /cart, bookings).
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const ordersOn = !disabledFeatures.includes('orders');
  const bookingsOn = !disabledFeatures.includes('bookings');
  const stockWatchOn = !disabledFeatures.includes('stock_watch');
  const [tagInput, setTagInput] = useState('');
  // Editable "User info" — null means "not edited this session" (show the
  // saved value); a string means the operator is editing.
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  // Reset the editor when switching contacts.
  useEffect(() => {
    setNoteDraft(null);
  }, [phone]);

  const q = useQuery({
    queryKey: ['contact-overview', phone],
    queryFn: () =>
      api.get<{ data: Overview }>(
        `/api/v1/contacts/overview?phone=${encodeURIComponent(phone ?? '')}`,
      ),
    enabled: open && !!phone,
  });
  const data = q.data?.data;
  const contactId = data?.contact?.id ?? null;

  // F5 — back-in-stock watches: what this customer asked for while it was
  // out of stock. Auto-captured by the bot; removable here.
  const watchesQ = useQuery({
    queryKey: ['stock-watches', phone],
    queryFn: () =>
      api.get<{
        data: {
          id: string;
          entityKind: 'product' | 'service';
          entityName: string;
          isAvailable: boolean;
          inquiryText: string | null;
          createdAt: string;
          notifiedAt: string | null;
        }[];
      }>(`/api/v1/stock-watches?phone=${encodeURIComponent(phone ?? '')}`),
    enabled: open && !!phone && stockWatchOn,
  });
  const watches = watchesQ.data?.data ?? [];
  const removeWatch = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/stock-watches/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stock-watches', phone] }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['contact-overview', phone] });
    qc.invalidateQueries({ queryKey: ['contacts'] });
  };
  const addTag = useMutation({
    mutationFn: (tag: string) => api.post(`/api/v1/contacts/${contactId}/tags`, { tag }),
    onSuccess: () => {
      setTagInput('');
      invalidate();
    },
    onError: () => toast.error('Could not add tag'),
  });
  const removeTag = useMutation({
    mutationFn: (tag: string) =>
      api.delete(`/api/v1/contacts/${contactId}/tags/${encodeURIComponent(tag)}`),
    onSuccess: invalidate,
    onError: () => toast.error('Could not remove tag'),
  });
  const saveUserInfo = useMutation({
    mutationFn: (userInfo: string) =>
      api.put('/api/v1/contacts/memory', { phone: phone ?? '', userInfo }),
    onSuccess: () => {
      toast.success('User info saved — the AI will use it on the next reply.');
      setNoteDraft(null);
      invalidate();
    },
    onError: () => toast.error('Could not save user info'),
  });

  if (!open) return null;

  const name = data?.contact?.displayName ?? data?.contact?.whatsappName ?? fallbackName ?? phone;
  const initial =
    (name ?? '#').replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '#';
  const facts = data?.memory?.facts ?? {};
  const factEntries = Object.entries(facts).filter(
    ([, v]) => v != null && v !== '' && (typeof v !== 'object' || Object.keys(v as object).length > 0),
  );
  // Render an AI-detected fact value for humans: JSON arrays/objects become
  // separated phrases, snake_case tokens become words.
  const fmtFact = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(fmtFact).join(' \u00b7 ');
    if (v && typeof v === 'object')
      return Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${k.replace(/_/g, ' ')}: ${fmtFact(x)}`)
        .join(' \u00b7 ');
    const str = String(v ?? '');
    if (/^\s*[\[{]/.test(str)) {
      try {
        return fmtFact(JSON.parse(str));
      } catch {
        /* not JSON — fall through */
      }
    }
    return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(str) ? str.replace(/_/g, ' ') : str;
  };
  // The "User info" the AI uses: operator edit wins, else the AI's persona.
  const savedUserInfo = data?.memory?.operatorNote ?? data?.memory?.persona ?? '';
  const noteValue = noteDraft ?? savedUserInfo;
  const noteDirty = noteDraft !== null && noteDraft.trim() !== savedUserInfo.trim();
  const isOperatorEdited = !!data?.memory?.operatorNote;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto bg-surface shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-surface px-5 py-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-base font-semibold text-brand-700">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground">{name}</p>
            <p className="flex items-center gap-1 truncate font-mono text-xs text-foreground-subtle">
              <Phone className="size-3" /> {phone}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>

        {q.isLoading ? (
          <div className="space-y-6 p-5">
            <div className="space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        ) : (
          <>
            {/* Lead portfolio (hader-support only) — who this is, what we've
                learned about their business, and how to win them. */}
            {data?.lead ? (
              <Section icon={Sparkles} title="Sales playbook">
                <div className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-500/30 dark:bg-brand-500/10">
                  {/* One compact line: where the lead came from + where it stands.
                      Who they are lives in the header; what we know lives in
                      "User info" below — no duplicates here. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="capitalize text-foreground">
                      {data.lead.source.replace(/_/g, ' ')}
                    </span>
                    <Badge variant={data.lead.status === 'converted' ? 'success' : 'info'}>
                      {data.lead.status.replace(/_/g, ' ')}
                    </Badge>
                    <span className="text-xs text-foreground-subtle">
                      captured {formatRelative(data.lead.capturedAt)}
                    </span>
                  </div>

                  {data.lead.howHaderHelps.length > 0 ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                        How Hader can help them
                      </p>
                      <ul className="list-disc space-y-1 pl-4 text-sm text-foreground">
                        {data.lead.howHaderHelps.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {data.lead.howToApproach.length > 0 ? (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                        How to approach
                      </p>
                      <ul className="list-disc space-y-1 pl-4 text-sm text-foreground">
                        {data.lead.howToApproach.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </Section>
            ) : null}

            {/* Profile */}
            <Section icon={Hash} title="Profile">
              <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                {data?.contact?.whatsappName ? (
                  <>
                    <dt className="text-foreground-subtle">WhatsApp name</dt>
                    <dd className="text-foreground">{data.contact.whatsappName}</dd>
                  </>
                ) : null}
                <dt className="text-foreground-subtle">Status</dt>
                <dd>
                  {data?.contact?.optedOutAt ? (
                    <Badge variant="warning">Opted out</Badge>
                  ) : (
                    <Badge variant="success">Subscribed</Badge>
                  )}
                </dd>
                {data?.memory?.language ? (
                  <>
                    <dt className="flex items-center gap-1 text-foreground-subtle">
                      <Globe className="size-3" /> Language
                    </dt>
                    <dd className="uppercase text-foreground">{data.memory.language}</dd>
                  </>
                ) : null}
                {data?.contact?.timezone ? (
                  <>
                    <dt className="text-foreground-subtle">Timezone</dt>
                    <dd className="text-foreground">{data.contact.timezone}</dd>
                  </>
                ) : null}
                <dt className="text-foreground-subtle">Source</dt>
                <dd className="capitalize text-foreground">
                  {data?.contact?.source?.replace(/_/g, ' ') ?? '—'}
                </dd>
                {data?.contact?.createdAt ? (
                  <>
                    <dt className="text-foreground-subtle">First seen</dt>
                    <dd className="text-foreground">{formatRelative(data.contact.createdAt)}</dd>
                  </>
                ) : null}
                {data?.contact?.lastInboundAt ? (
                  <>
                    <dt className="text-foreground-subtle">Last message</dt>
                    <dd className="text-foreground">{formatRelative(data.contact.lastInboundAt)}</dd>
                  </>
                ) : null}
              </dl>
            </Section>

            {/* Tags — add + remove */}
            <Section icon={TagIcon} title="Tags">
              {!contactId ? (
                <p className="text-xs text-foreground-subtle">
                  Tags appear once this customer is saved to Contacts (happens automatically on
                  their next message).
                </p>
              ) : (
                <>
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {(data?.contact?.tags ?? []).length === 0 ? (
                      <span className="text-xs text-foreground-subtle">No tags yet.</span>
                    ) : (
                      data!.contact!.tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-xs font-medium text-foreground"
                        >
                          {t}
                          <button
                            type="button"
                            onClick={() => removeTag.mutate(t)}
                            className="text-foreground-subtle hover:text-rose-600"
                            aria-label={`Remove tag ${t}`}
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const v = tagInput.trim();
                      if (v) addTag.mutate(v);
                    }}
                  >
                    <Input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      placeholder="Add a tag…"
                      maxLength={40}
                      className="h-9 text-sm"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!tagInput.trim() || addTag.isPending}
                    >
                      <Plus className="size-4" /> Add
                    </Button>
                  </form>
                </>
              )}
            </Section>

            {/* User info — editable; fed into the bot's prompt on every reply.
                Prefilled from what the AI wrote; operator edits supersede it
                and are never overwritten by the AI. */}
            <Section icon={UserPen} title="User info">
              <p className="mb-2 text-xs text-foreground-muted">
                What the AI knows about this customer. Edit to correct or add details — the bot uses
                this on every reply, and your edits are kept (the AI won&apos;t overwrite them).
              </p>
              <Textarea
                value={noteValue}
                onChange={(e) => setNoteDraft(e.target.value)}
                rows={5}
                maxLength={4000}
                placeholder="e.g. Prefers Arabic. Allergic to nuts. VIP — always offer free delivery. Usually orders for a family of 5."
                className="text-sm"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-foreground-subtle">
                  {isOperatorEdited
                    ? `Edited by staff${data?.memory?.operatorNoteAt ? ` ${formatRelative(data.memory.operatorNoteAt)}` : ''}`
                    : savedUserInfo
                      ? 'Written by the AI — edit to take over'
                      : 'Nothing yet'}
                </span>
                <div className="flex items-center gap-2">
                  {noteDirty ? (
                    <Button size="sm" variant="ghost" onClick={() => setNoteDraft(null)}>
                      Cancel
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    loading={saveUserInfo.isPending}
                    disabled={!noteDirty}
                    onClick={() => saveUserInfo.mutate(noteValue.trim())}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </Section>

            {/* AI-detected structured facts (read-only) */}
            {factEntries.length > 0 ? (
              <Section icon={Bot} title="AI-detected details">
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
                  {factEntries.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="truncate capitalize text-foreground-subtle">
                        {k.replace(/_/g, ' ')}
                      </dt>
                      <dd className="text-foreground">{fmtFact(v)}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            ) : null}

            {/* F5 — asked-about-while-out-of-stock flags (auto-captured). */}
            {stockWatchOn && watches.length > 0 ? (
              <Section icon={Bell} title={`Asked about (waiting for stock) (${watches.length})`}>
                <ul className="space-y-2">
                  {watches.map((w) => (
                    <li key={w.id} className="rounded-lg border border-border p-2.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">{w.entityName}</span>
                        <span className="flex items-center gap-2">
                          <Badge variant={w.notifiedAt ? 'muted' : 'outline'}>
                            {w.notifiedAt ? 'notified' : w.isAvailable ? 'sending soon' : 'waiting'}
                          </Badge>
                          <button
                            type="button"
                            onClick={() => removeWatch.mutate(w.id)}
                            className="text-xs text-foreground-subtle hover:text-rose-600"
                            title="Stop watching — no notification will be sent"
                          >
                            remove
                          </button>
                        </span>
                      </div>
                      {w.inquiryText ? (
                        <p className="mt-1 line-clamp-2 text-xs text-foreground-muted">“{w.inquiryText}”</p>
                      ) : null}
                      <p className="mt-1 text-[10px] uppercase tracking-wide text-foreground-subtle">
                        {formatRelative(w.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {/* Orders — only when the tenant has the orders/cart feature. */}
            {ordersOn ? (
            <Section icon={ShoppingBag} title={`Orders (${data?.orders.length ?? 0})`}>
              {(data?.orders.length ?? 0) === 0 ? (
                <p className="text-xs text-foreground-subtle">No orders yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data!.orders.map((o) => (
                    <li key={o.id} className="rounded-lg border border-border p-2.5 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">
                          {money(o.totalMinor, o.currency)}
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge variant={o.status === 'confirmed' ? 'muted' : 'outline'}>
                            {o.status}
                          </Badge>
                          <span className="text-xs text-foreground-subtle">
                            {formatRelative(o.createdAt)}
                          </span>
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-foreground-muted">
                        {o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            ) : null}

            {/* Bookings — only when the tenant has the bookings feature. */}
            {bookingsOn ? (
            <Section icon={CalendarCheck} title={`Bookings (${data?.bookings.length ?? 0})`}>
              {(data?.bookings.length ?? 0) === 0 ? (
                <p className="text-xs text-foreground-subtle">No bookings yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data!.bookings.map((b) => (
                    <li key={b.id} className="rounded-lg border border-border p-2.5 text-sm">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-foreground-subtle">
                          {b.appointmentAt
                            ? new Date(b.appointmentAt).toLocaleString()
                            : `Requested ${formatRelative(b.createdAt)}`}
                        </span>
                        <Badge variant="outline">{b.status}</Badge>
                      </div>
                      {/* The actual answers the customer gave (name, preferred
                          date, …). This is the real content of the booking. */}
                      {b.fields.length > 0 ? (
                        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5 text-xs">
                          {b.fields
                            .filter((f) => {
                              // The header already shows who/number — echoing the
                              // form's name/phone answers is pure noise.
                              const v = f.value.trim().toLowerCase();
                              if (!v) return false;
                              if (v === (name ?? '').trim().toLowerCase()) return false;
                              const digits = v.replace(/\D/g, '');
                              return !(digits.length >= 6 && (phone ?? '').replace(/\D/g, '').endsWith(digits.slice(-8)) && digits === v.replace(/\D/g, '') && /^[+\d\s()-]+$/.test(f.value.trim()));
                            })
                            .map((f) => (
                            <div key={f.label} className="contents">
                              <dt className="truncate text-foreground-subtle">{f.label}</dt>
                              <dd className="break-words text-foreground">{f.value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p className="text-xs text-foreground-subtle">No details captured.</p>
                      )}
                      {b.notes ? (
                        <p className="mt-1 text-xs text-foreground-muted">{b.notes}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            ) : null}

            {/* Activity */}
            <Section icon={Clock} title="Activity">
              <p className="text-sm text-foreground">
                <span className="font-semibold">{data?.stats.inboundCount ?? 0}</span> received ·{' '}
                <span className="font-semibold">{data?.stats.outboundCount ?? 0}</span> sent
              </p>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
