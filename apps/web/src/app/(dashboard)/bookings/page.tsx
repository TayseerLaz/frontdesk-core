'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellOff,
  BellRing,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  Filter,
  List as ListIcon,
  MessageSquare,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';

import { BookingsCalendar } from './bookings-calendar';

const STATUSES = ['new', 'confirmed', 'completed', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];

interface BookingAnswer {
  key: string;
  label: string;
  type: string;
  required: boolean;
  value: string | number | boolean | null;
}

interface Booking {
  id: string;
  threadId: string | null;
  customerPhone: string;
  customerName: string | null;
  fields: BookingAnswer[];
  status: Status;
  notes: string | null;
  appointmentAt: string | null;
  reminderTemplateId: string | null;
  reminderSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
}

function StatusBadge({ status }: { status: Status }) {
  const tone: Record<Status, 'default' | 'muted' | 'success' | 'danger'> = {
    new: 'default',
    confirmed: 'success',
    completed: 'muted',
    cancelled: 'danger',
  };
  return <Badge variant={tone[status]}>{status}</Badge>;
}

// ---------- Date / time extraction --------------------------------------
// The booking form's date/time fields can hold either ISO values
// ("2026-05-12", "17:00") OR natural-language phrases ("tomorrow at 5",
// "next Monday", "5pm") because the LLM extractor stores what the
// customer wrote. We resolve relative phrases against the booking's
// createdAt timestamp so the columns always show an explicit date + time.

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function stripTime(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Resolve a natural-language date phrase relative to `anchor`. */
function parseDatePhrase(raw: string, anchor: Date): Date | null {
  const s = raw.toLowerCase().trim();
  if (!s) return null;

  // ISO YYYY-MM-DD (with optional time chunk) — happy path.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY or MM/DD/YYYY — assume day-first (EU/UK default).
  const dmy = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]) - 1;
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const base = stripTime(anchor);
  if (/\btoday\b/.test(s)) return base;
  if (/\btomorrow\b|\btmrw\b|\btmr\b/.test(s)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (/\byesterday\b/.test(s)) {
    const d = new Date(base);
    d.setDate(d.getDate() - 1);
    return d;
  }
  // "in N days"
  const inDays = s.match(/in\s+(\d+)\s+day/);
  if (inDays) {
    const d = new Date(base);
    d.setDate(d.getDate() + Number(inDays[1]));
    return d;
  }
  // Weekday name (optionally "next monday")
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    const re = new RegExp(`\\b(next\\s+)?${name}\\b`);
    const m = s.match(re);
    if (m) {
      const d = new Date(base);
      let delta = (dow - d.getDay() + 7) % 7;
      if (delta === 0 || m[1] /* "next" */) delta += 7;
      // Special case: "next monday" said on a Monday → next Monday (7 days);
      // bare "monday" said on Monday → today (delta = 0 → keep 0).
      if (delta === 0) delta = 0;
      d.setDate(d.getDate() + delta);
      return d;
    }
  }
  return null;
}

/** Resolve a time phrase to { hour, minute } in 24h. Returns null if unparseable. */
function parseTimePhrase(raw: string): { h: number; m: number } | null {
  const s = raw.toLowerCase().trim();
  if (!s) return null;
  if (/\bnoon\b|\bmidday\b/.test(s)) return { h: 12, m: 0 };
  if (/\bmidnight\b/.test(s)) return { h: 0, m: 0 };

  // HH:MM with optional am/pm
  let m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h >= 0 && h < 24 && min >= 0 && min < 60) return { h, m: min };
  }
  // "at 5", "5pm", "5 pm"
  m = s.match(/(?:at\s+)?(\d{1,2})\s*(am|pm)?(?!\d)/);
  if (m) {
    let h = Number(m[1]);
    const mer = m[2];
    if (h >= 0 && h <= 23) {
      if (mer === 'pm' && h < 12) h += 12;
      else if (mer === 'am' && h === 12) h = 0;
      else if (!mer && h >= 1 && h <= 7) h += 12; // bare "5" → assume PM business hours
      return { h, m: 0 };
    }
  }
  return null;
}

function pickAppointment(fields: BookingAnswer[]): {
  dateFieldKey: string | null;
  timeFieldKey: string | null;
  dateRaw: string | null;
  timeRaw: string | null;
} {
  const findByType = (...types: string[]) =>
    fields.find((f) => types.includes(f.type.toLowerCase()));
  const findByText = (needle: string) =>
    fields.find(
      (f) =>
        f.key.toLowerCase().includes(needle) || f.label.toLowerCase().includes(needle),
    );

  // datetime (single combined field) — split it.
  const dt = findByType('datetime', 'datetime-local') ?? findByText('datetime');
  if (dt && typeof dt.value === 'string' && dt.value) {
    const [d, t] = dt.value.split(/[T\s]/);
    return { dateFieldKey: dt.key, timeFieldKey: dt.key, dateRaw: d ?? null, timeRaw: t ?? null };
  }

  const dateField =
    findByType('date') ?? findByText('date') ?? findByText('day') ?? findByText('when');
  const timeField = findByType('time') ?? findByText('time') ?? findByText('hour');
  return {
    dateFieldKey: dateField?.key ?? null,
    timeFieldKey: timeField?.key ?? null,
    dateRaw:
      typeof dateField?.value === 'string' && dateField.value ? dateField.value : null,
    timeRaw:
      typeof timeField?.value === 'string' && timeField.value ? timeField.value : null,
  };
}

/** Build the date label from a (possibly natural-language) raw value. */
function formatBookingDate(raw: string | null, anchor: Date): string {
  let d: Date | null = null;
  if (raw) d = parseDatePhrase(raw, anchor);
  if (!d) {
    // No raw value → use createdAt as the proxy. Operators see "captured on" below.
    d = anchor;
  }
  if (!d || Number.isNaN(d.getTime())) return raw ?? '';
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return fmt.format(d);
}

/** Resolve a booking row to a UTC ISO datetime suitable for the reminder
 * tick. Returns null if either date or time can't be parsed — the
 * reminder column then disables the picker for that row. Kept in sync
 * with formatBookingDate/Time so the operator sees the same answer
 * we'll fire on.
 */
function resolveAppointmentIso(
  fields: BookingAnswer[],
  createdAt: string,
): string | null {
  const created = new Date(createdAt);
  const apt = pickAppointment(fields);
  const day = apt.dateRaw ? parseDatePhrase(apt.dateRaw, created) : null;
  if (!day) return null;
  const time =
    (apt.timeRaw ? parseTimePhrase(apt.timeRaw) : null) ??
    (apt.dateRaw ? parseTimePhrase(apt.dateRaw) : null);
  if (!time) return null;
  const dt = new Date(day);
  dt.setHours(time.h, time.m, 0, 0);
  return dt.toISOString();
}

/** Build the time label from a (possibly natural-language) raw value. */
function formatBookingTime(raw: string | null, fallbackPhrase: string | null): string {
  // 1) Try the dedicated time field.
  if (raw) {
    const t = parseTimePhrase(raw);
    if (t) return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
  }
  // 2) If the date phrase carried a time ("tomorrow at 5"), try that.
  if (fallbackPhrase) {
    const t = parseTimePhrase(fallbackPhrase);
    if (t) return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
  }
  return raw ?? '—';
}

export default function BookingsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useMemo(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useQuery({
    queryKey: ['bookings', statusFilter, debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (debouncedSearch) params.set('q', debouncedSearch);
      params.set('limit', '100');
      return api.get<{ data: Booking[] }>(`/api/v1/bookings?${params.toString()}`);
    },
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Status }) =>
      api.patch(`/api/v1/bookings/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      toast.success('Status updated');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/bookings/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      toast.success('Booking deleted');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  // Approved WhatsApp templates only — Meta will reject anything else
  // when the reminder fires, so we don't surface them to the operator
  // in the first place. `staleTime` keeps the dropdown snappy.
  const templates = useQuery({
    queryKey: ['whatsapp-templates', 'approved'],
    queryFn: () =>
      api.get<{ data: WhatsAppTemplate[] }>('/api/v1/whatsapp/templates'),
    staleTime: 60_000,
  });
  const approvedTemplates =
    templates.data?.data.filter((t) => t.status === 'approved') ?? [];

  const setReminder = useMutation({
    mutationFn: (args: {
      id: string;
      reminderTemplateId: string | null;
      appointmentAt: string | null;
    }) =>
      api.patch(`/api/v1/bookings/${args.id}`, {
        reminderTemplateId: args.reminderTemplateId,
        appointmentAt: args.appointmentAt,
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      toast.success(
        vars.reminderTemplateId
          ? 'Reminder scheduled for 2 h before the appointment.'
          : 'Reminder disabled.',
      );
    },
    onError: (e) =>
      toast.error(e instanceof ApiError ? e.payload.message : 'Could not update reminder'),
  });

  const rows = list.data?.data ?? [];

  // Stable identity so the calendar's useMemo doesn't bust the day index
  // on every keystroke — the parser itself is purely functional.
  const resolveAppointmentIsoStable = useCallback(
    (fields: BookingAnswer[], createdAt: string) => resolveAppointmentIso(fields, createdAt),
    [],
  );

  return (
    <>
      <PageHeader
        title="Bookings"
        description="Customer intakes captured by the AI chatbot. Configure the form on /business-info → Booking form."
      />
      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">
            <ListIcon className="mr-1.5 size-4" />
            List
          </TabsTrigger>
          <TabsTrigger value="calendar">
            <CalendarDays className="mr-1.5 size-4" />
            Calendar
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <CalendarCheck className="size-4 text-brand-600" />
            {rows.length} bookings
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
                <th className="hidden px-6 py-3 sm:table-cell">Date</th>
                <th className="hidden px-6 py-3 sm:table-cell">Time</th>
                <th className="px-4 py-3 sm:px-6">Customer</th>
                <th className="hidden px-6 py-3 lg:table-cell">Answers</th>
                <th className="hidden px-6 py-3 lg:table-cell">Notes</th>
                <th className="px-6 py-3">Status</th>
                <th className="hidden px-6 py-3 md:table-cell">Reminder</th>
                <th className="w-32 px-4 py-3 text-right sm:px-6">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading ? (
                <tr>
                  <td colSpan={8} className="p-0">
                    <SkeletonRows rows={5} cols={6} />
                  </td>
                </tr>
              ) : null}
              {!list.isLoading && rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-16 text-center text-foreground-muted">
                    No bookings yet. When a customer asks the bot to book something, the captured
                    answers will appear here.
                  </td>
                </tr>
              ) : null}
              {rows.map((b) => {
                const created = new Date(b.createdAt);
                const apt = pickAppointment(b.fields);
                const dateLabel = formatBookingDate(apt.dateRaw, created);
                // Time falls back to whatever was in the date phrase
                // ("tomorrow at 5" → 17:00) when the dedicated time field
                // is empty.
                const timeLabel = formatBookingTime(apt.timeRaw, apt.dateRaw);
                // Pull a "notes" answer out of the form. Prefer a field
                // whose key === 'notes' / 'note' / 'comments', or whose
                // label contains "anything else" or "notes". Falls back
                // to the booking's own b.notes column.
                const notesField = b.fields.find((f) => {
                  const k = f.key.toLowerCase();
                  const l = f.label.toLowerCase();
                  return (
                    k === 'notes' ||
                    k === 'note' ||
                    k === 'comments' ||
                    k === 'comment' ||
                    l.includes('anything else') ||
                    l.includes('note') ||
                    l.includes('comment')
                  );
                });
                const notesValue =
                  (typeof notesField?.value === 'string' && notesField.value.trim()) ||
                  (b.notes && b.notes.trim()) ||
                  '';
                // Hide date/time AND the notes field from the Answers cell —
                // they get their own columns now.
                const otherFields = b.fields.filter(
                  (f) =>
                    f.key !== apt.dateFieldKey &&
                    f.key !== apt.timeFieldKey &&
                    f.key !== notesField?.key,
                );
                return (
                <tr key={b.id} className="border-b border-border last:border-0 align-top">
                  <td className="hidden whitespace-nowrap px-6 py-4 text-sm font-medium sm:table-cell">
                    {dateLabel}
                    {!apt.dateRaw ? (
                      <div className="text-[10px] font-normal text-foreground-subtle">
                        captured
                      </div>
                    ) : null}
                    {apt.dateRaw && parseDatePhrase(apt.dateRaw, created) === null ? (
                      // We failed to parse the natural language — surface the
                      // original phrase so the operator isn't misled.
                      <div className="mt-0.5 text-[10px] font-normal italic text-foreground-subtle">
                        said: {apt.dateRaw}
                      </div>
                    ) : null}
                  </td>
                  <td className="hidden whitespace-nowrap px-6 py-4 font-mono text-sm sm:table-cell">
                    {timeLabel}
                  </td>
                  <td className="px-4 py-4 sm:px-6">
                    <div className="font-medium">{b.customerName ?? b.customerPhone}</div>
                    <div className="font-mono text-[11px] text-foreground-subtle">
                      {b.customerPhone}
                    </div>
                    {b.threadId ? (
                      <Link
                        href={`/inbox?thread=${b.threadId}`}
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
                      >
                        <MessageSquare className="size-3" /> View chat
                      </Link>
                    ) : null}
                  </td>
                  <td className="hidden px-6 py-4 lg:table-cell">
                    {otherFields.length > 0 ? (
                      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                        {otherFields.map((f) => (
                          <div key={f.key} className="text-xs">
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
                    ) : (
                      <span className="text-xs italic text-foreground-subtle">
                        (no extra fields)
                      </span>
                    )}
                  </td>
                  <td className="hidden max-w-xs px-6 py-4 align-top text-xs lg:table-cell">
                    {notesValue ? (
                      <span className="whitespace-pre-wrap break-words text-foreground">
                        {notesValue}
                      </span>
                    ) : (
                      <span className="italic text-foreground-subtle">empty</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <Select
                      value={b.status}
                      onValueChange={(v) => setStatus.mutate({ id: b.id, status: v as Status })}
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue>{<StatusBadge status={b.status} />}</SelectValue>
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
                  <td className="hidden px-6 py-4 md:table-cell">
                    {(() => {
                      // Reminders only fire for confirmed bookings — Meta
                      // session-window rules + the user's spec require it.
                      // For other statuses we surface the gate so the
                      // operator isn't confused by an inactive dropdown.
                      if (b.status !== 'confirmed') {
                        return (
                          <span className="text-xs italic text-foreground-subtle">
                            confirmed only
                          </span>
                        );
                      }
                      // Already fired — show a stamp so it's clear we won't
                      // re-send (toggling the template off + on resets it).
                      if (b.reminderSentAt) {
                        return (
                          <div className="flex flex-col gap-0.5 text-xs">
                            <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                              <CheckCircle2 className="size-3.5" />
                              Sent {new Date(b.reminderSentAt).toLocaleString()}
                            </span>
                            <button
                              type="button"
                              className="text-left text-[10px] text-foreground-subtle hover:underline"
                              onClick={() =>
                                setReminder.mutate({
                                  id: b.id,
                                  reminderTemplateId: null,
                                  appointmentAt: null,
                                })
                              }
                            >
                              Clear &amp; reset
                            </button>
                          </div>
                        );
                      }
                      const computedAppointment = resolveAppointmentIso(
                        b.fields,
                        b.createdAt,
                      );
                      const hasAppointment = Boolean(
                        b.appointmentAt ?? computedAppointment,
                      );
                      const canArm =
                        hasAppointment && approvedTemplates.length > 0;
                      const value = b.reminderTemplateId ?? '__off__';
                      return (
                        <div className="flex flex-col gap-1">
                          <Select
                            value={value}
                            onValueChange={(v) => {
                              if (v === '__off__') {
                                setReminder.mutate({
                                  id: b.id,
                                  reminderTemplateId: null,
                                  appointmentAt: null,
                                });
                                return;
                              }
                              const appointmentAt =
                                b.appointmentAt ?? computedAppointment;
                              if (!appointmentAt) {
                                toast.error(
                                  "Can't parse a date+time from this booking's fields — set them first.",
                                );
                                return;
                              }
                              setReminder.mutate({
                                id: b.id,
                                reminderTemplateId: v,
                                appointmentAt,
                              });
                            }}
                            disabled={!canArm && !b.reminderTemplateId}
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue placeholder="Off">
                                {b.reminderTemplateId ? (
                                  <span className="inline-flex items-center gap-1">
                                    <BellRing className="size-3.5 text-brand-600" />
                                    {approvedTemplates.find(
                                      (t) => t.id === b.reminderTemplateId,
                                    )?.name ?? 'Reminder set'}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-foreground-subtle">
                                    <BellOff className="size-3.5" />
                                    Off
                                  </span>
                                )}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__off__">Off</SelectItem>
                              {approvedTemplates.map((t) => (
                                <SelectItem key={t.id} value={t.id}>
                                  {t.name}
                                  <span className="ml-1 text-[10px] text-foreground-subtle">
                                    {t.language}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {!hasAppointment ? (
                            <span className="text-[10px] italic text-foreground-subtle">
                              no date+time set
                            </span>
                          ) : approvedTemplates.length === 0 ? (
                            <Link
                              href="/whatsapp/templates"
                              className="text-[10px] text-brand-600 hover:underline"
                            >
                              No approved templates — submit one
                            </Link>
                          ) : b.reminderTemplateId ? (
                            <span className="text-[10px] text-foreground-subtle">
                              Fires 2 h before{' '}
                              {new Date(
                                b.appointmentAt ?? computedAppointment!,
                              ).toLocaleString()}
                            </span>
                          ) : null}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-4 text-right sm:px-6">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Delete booking"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete booking from ${b.customerName ?? b.customerPhone}?`,
                          )
                        ) {
                          remove.mutate(b.id);
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table></div>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="calendar">
          <Card>
            <CardContent className="p-4">
              <BookingsCalendar
                bookings={rows}
                isLoading={list.isLoading}
                resolveAppointmentIso={resolveAppointmentIsoStable}
                onChangeStatus={(id, status) => setStatus.mutate({ id, status })}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
