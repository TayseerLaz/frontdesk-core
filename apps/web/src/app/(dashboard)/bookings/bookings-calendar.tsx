'use client';

// Calendar view for the bookings page. Hader.ai-style: a clean
// week/month grid with appointment blocks placed by appointmentAt.
//
// Self-contained — no calendar library, no date-fns. The grid math is
// the small bit of code; the rest is the same status palette + click
// handlers as the list view, so the operator can do the same things
// (open detail, change status) from either tab.

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// Booking shape is duplicated locally rather than imported from the page
// so this component stays decoupled and is easier to extract / test.
type BookingStatus = 'new' | 'confirmed' | 'completed' | 'cancelled';

interface BookingAnswer {
  key: string;
  label: string;
  type: string;
  required: boolean;
  value: string | number | boolean | null;
}

export interface CalendarBooking {
  id: string;
  threadId: string | null;
  customerPhone: string;
  customerName: string | null;
  fields: BookingAnswer[];
  status: BookingStatus;
  notes: string | null;
  appointmentAt: string | null;
  reminderSentAt: string | null;
  createdAt: string;
}

interface Props {
  bookings: CalendarBooking[];
  isLoading: boolean;
  /** Caller-controlled appointment resolver — same parser the list uses. */
  resolveAppointmentIso: (fields: BookingAnswer[], createdAt: string) => string | null;
  onChangeStatus: (id: string, status: BookingStatus) => void;
}

type View = 'month' | 'week';

// ---------- Google Calendar overlay --------------------------------------
// Events from the tenant's connected Google Calendar, shown alongside the
// bookings so the operator sees one timeline instead of two. Read-only:
// Hader never edits them, and clicking one opens it in Google.

interface GoogleEvent {
  id: string;
  summary: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  /** Marked "free"/declined in Google — shown, but it never blocks a slot. */
  free: boolean;
  htmlLink: string | null;
}

interface GoogleEventsResponse {
  connected: boolean;
  ok: boolean;
  events: GoogleEvent[];
}

type PlacedEvent = GoogleEvent & { _start: Date; _end: Date };

/** Bucket Google events by local day, splitting nothing — multi-day events
 *  land on each day they cover so a 3-day trip isn't invisible on days 2-3. */
function buildGoogleIndex(events: GoogleEvent[]): Map<string, PlacedEvent[]> {
  const out = new Map<string, PlacedEvent[]>();
  for (const e of events) {
    const start = new Date(e.startIso);
    const end = new Date(e.endIso);
    if (Number.isNaN(start.getTime())) continue;
    const placed: PlacedEvent = { ...e, _start: start, _end: Number.isNaN(end.getTime()) ? start : end };
    // Walk from the start day to the last day the event touches (cap at 31 so
    // a malformed year-long event can't blow up the loop).
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    const lastDay = new Date(placed._end.getTime() - 1); // end is exclusive
    lastDay.setHours(0, 0, 0, 0);
    for (let i = 0; i < 31; i++) {
      const key = dayKey(cursor);
      out.set(key, [...(out.get(key) ?? []), placed]);
      if (cursor.getTime() >= lastDay.getTime()) break;
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  for (const bucket of out.values()) {
    bucket.sort((a, b) => a._start.getTime() - b._start.getTime());
  }
  return out;
}

const STATUS_COLOR: Record<
  BookingStatus,
  { chip: string; dot: string; ring: string; label: string }
> = {
  new: {
    chip: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
    dot: 'bg-brand-500',
    ring: 'ring-brand-200',
    label: 'New',
  },
  confirmed: {
    chip: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-200',
    label: 'Confirmed',
  },
  completed: {
    chip: 'bg-slate-100 text-slate-600 hover:bg-slate-200',
    dot: 'bg-slate-400',
    ring: 'ring-slate-200',
    label: 'Completed',
  },
  cancelled: {
    chip: 'bg-rose-50 text-rose-700 line-through opacity-70 hover:bg-rose-100',
    dot: 'bg-rose-500',
    ring: 'ring-rose-200',
    label: 'Cancelled',
  },
};

const STATUS_BADGE: Record<BookingStatus, 'default' | 'muted' | 'success' | 'danger'> = {
  new: 'default',
  confirmed: 'success',
  completed: 'muted',
  cancelled: 'danger',
};

// Build the per-day buckets once: a Map keyed by 'YYYY-MM-DD' in local
// time → bookings whose resolved appointment falls on that day, sorted
// by start time. This is the only date math we cache.
function buildDayIndex(
  bookings: CalendarBooking[],
  resolveAppointmentIso: Props['resolveAppointmentIso'],
): Map<string, Array<CalendarBooking & { _start: Date }>> {
  const out = new Map<string, Array<CalendarBooking & { _start: Date }>>();
  for (const b of bookings) {
    const iso = b.appointmentAt ?? resolveAppointmentIso(b.fields, b.createdAt);
    if (!iso) continue;
    const start = new Date(iso);
    if (Number.isNaN(start.getTime())) continue;
    const key = dayKey(start);
    const bucket = out.get(key) ?? [];
    bucket.push({ ...b, _start: start });
    out.set(key, bucket);
  }
  for (const bucket of out.values()) {
    bucket.sort((a, b) => a._start.getTime() - b._start.getTime());
  }
  return out;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfWeek(d: Date): Date {
  // Mon-first week — matches the EU/UK norm + the existing date parser
  // in the bookings page which assumes day-first.
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const dow = (out.getDay() + 6) % 7; // 0 = Monday
  out.setDate(out.getDate() - dow);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function BookingsCalendar({
  bookings,
  isLoading,
  resolveAppointmentIso,
  onChangeStatus,
}: Props) {
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [open, setOpen] = useState<CalendarBooking | null>(null);
  const [showGoogle, setShowGoogle] = useState(true);

  const dayIndex = useMemo(
    () => buildDayIndex(bookings, resolveAppointmentIso),
    [bookings, resolveAppointmentIso],
  );

  const today = new Date();

  // The window currently on screen — the month grid always paints 6 weeks
  // from the Monday on or before the 1st, so ask Google for exactly that.
  const range = useMemo(() => {
    const start =
      view === 'month' ? startOfWeek(startOfMonth(anchor)) : startOfWeek(anchor);
    const end = addDays(start, view === 'month' ? 42 : 7);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [view, anchor]);

  const gcalStatus = useQuery({
    queryKey: ['google-calendar', 'status'],
    queryFn: () =>
      api.get<{ data: { connected: boolean } }>('/api/v1/google-calendar/status'),
    staleTime: 5 * 60_000,
  });
  const connected = gcalStatus.data?.data.connected ?? false;

  const gcalEvents = useQuery({
    queryKey: ['google-calendar', 'events', range.from, range.to],
    queryFn: () =>
      api.get<{ data: GoogleEventsResponse }>(
        `/api/v1/google-calendar/events?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
    enabled: connected && showGoogle,
    staleTime: 60_000,
  });
  const googleFailed = gcalEvents.data?.data.ok === false;

  const googleIndex = useMemo(
    () => buildGoogleIndex(showGoogle ? (gcalEvents.data?.data.events ?? []) : []),
    [showGoogle, gcalEvents.data],
  );

  function shift(dir: -1 | 1) {
    const d = new Date(anchor);
    if (view === 'month') {
      d.setMonth(d.getMonth() + dir);
      d.setDate(1);
    } else {
      d.setDate(d.getDate() + dir * 7);
    }
    setAnchor(d);
  }

  function goToday() {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    setAnchor(t);
  }

  const headerLabel = useMemo(() => {
    if (view === 'month') return MONTH_FMT.format(anchor);
    const ws = startOfWeek(anchor);
    const we = addDays(ws, 6);
    const sameMonth = ws.getMonth() === we.getMonth();
    const sameYear = ws.getFullYear() === we.getFullYear();
    const startFmt = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      ...(sameMonth ? {} : { month: 'short' }),
      ...(sameYear ? {} : { year: 'numeric' }),
    });
    const endFmt = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
    return `${startFmt.format(ws)} – ${endFmt.format(we)}`;
  }, [view, anchor]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={goToday}>
            Today
          </Button>
          <div className="flex items-center rounded-md border border-border">
            <button
              type="button"
              aria-label="Previous"
              onClick={() => shift(-1)}
              className="px-2 py-1 hover:bg-surface-muted"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={() => shift(1)}
              className="px-2 py-1 hover:bg-surface-muted"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="ml-2 text-sm font-semibold text-foreground">{headerLabel}</div>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <button
              type="button"
              onClick={() => setShowGoogle((s) => !s)}
              aria-pressed={showGoogle}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
                showGoogle
                  ? 'border-border bg-surface-muted text-foreground'
                  : 'border-dashed border-border text-foreground-subtle hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'inline-block size-2 rounded-full',
                  showGoogle ? 'bg-violet-500' : 'bg-border',
                )}
              />
              Google Calendar
            </button>
          ) : null}
          <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
            {(['month', 'week'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={cn(
                  'rounded px-3 py-1 capitalize transition-colors',
                  view === v
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-foreground-muted hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-foreground-muted">
        {(Object.keys(STATUS_COLOR) as BookingStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span className={cn('inline-block size-2 rounded-full', STATUS_COLOR[s].dot)} />
            {STATUS_COLOR[s].label}
          </span>
        ))}
        {connected && showGoogle ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full bg-violet-400" />
            Google Calendar
          </span>
        ) : null}
        <span className="ml-auto inline-flex items-center italic">
          {isLoading ? (
            <Skeleton className="h-4 w-40" />
          ) : (
            `${bookings.filter((b) => b.appointmentAt || resolveAppointmentIso(b.fields, b.createdAt)).length} bookings with date+time`
          )}
        </span>
      </div>

      {/* Google is best-effort: say so rather than implying an empty calendar. */}
      {connected && showGoogle && googleFailed ? (
        <div className="rounded-md border border-amber-300 bg-amber-50/50 px-3 py-2 text-xs text-amber-900">
          Couldn’t load your Google Calendar just now — bookings below are still accurate.
        </div>
      ) : null}

      {view === 'month' ? (
        <MonthGrid
          anchor={anchor}
          today={today}
          dayIndex={dayIndex}
          googleIndex={googleIndex}
          onOpenBooking={setOpen}
        />
      ) : (
        <WeekGrid
          anchor={anchor}
          today={today}
          dayIndex={dayIndex}
          googleIndex={googleIndex}
          onOpenBooking={setOpen}
        />
      )}

      {/* Detail dialog — opens when the operator clicks an appointment. */}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-lg">
          {open ? (
            <BookingDetail
              booking={open}
              onChangeStatus={(s) => {
                onChangeStatus(open.id, s);
                setOpen({ ...open, status: s });
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- Google event chip --------------------------------------------
// Visually subordinate to bookings on purpose: bookings are what the operator
// acts on here, Google events are context. Clicking opens the event in Google
// (new tab) — Hader never edits it.

function GoogleChip({ event, className }: { event: PlacedEvent; className?: string }) {
  const label = event.allDay
    ? event.summary
    : `${TIME_FMT.format(event._start)} ${event.summary}`;
  const classes = cn(
    'flex items-center gap-1 truncate rounded border-l-2 border-violet-400 bg-violet-50/70 px-1.5 py-0.5 text-left text-[11px] leading-tight text-violet-900 transition-colors hover:bg-violet-100',
    event.free && 'opacity-60',
    className,
  );
  const title = `${event.summary} · Google Calendar${event.free ? ' (free/declined — does not block slots)' : ''}`;
  if (!event.htmlLink) {
    return (
      <span className={classes} title={title}>
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <a
      href={event.htmlLink}
      target="_blank"
      rel="noreferrer noopener"
      className={classes}
      title={title}
    >
      <span className="truncate">{label}</span>
      <ExternalLink className="size-2.5 shrink-0 opacity-50" />
    </a>
  );
}

// ---------- Month grid ----------------------------------------------------

function MonthGrid({
  anchor,
  today,
  dayIndex,
  googleIndex,
  onOpenBooking,
}: {
  anchor: Date;
  today: Date;
  dayIndex: Map<string, Array<CalendarBooking & { _start: Date }>>;
  googleIndex: Map<string, PlacedEvent[]>;
  onOpenBooking: (b: CalendarBooking) => void;
}) {
  // 6 rows × 7 cols starting from the Monday on or before the 1st.
  const monthStart = startOfMonth(anchor);
  const gridStart = startOfWeek(monthStart);
  const days = useMemo(() => {
    const out: Date[] = [];
    for (let i = 0; i < 42; i++) out.push(addDays(gridStart, i));
    return out;
  }, [gridStart]);

  const weekdayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <div className="grid min-w-[680px] grid-cols-7 border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
        {weekdayHeaders.map((d) => (
          <div key={d} className="px-3 py-2 text-center">
            {d}
          </div>
        ))}
      </div>
      <div className="grid min-w-[680px] grid-cols-7">
        {days.map((d, i) => {
          const inMonth = d.getMonth() === anchor.getMonth();
          const isToday = sameDay(d, today);
          const bucket = dayIndex.get(dayKey(d)) ?? [];
          const gBucket = googleIndex.get(dayKey(d)) ?? [];
          // Bookings are the operator's work — they get the visible slots
          // first; Google fills whatever's left of the 3-row budget.
          const visible = bucket.slice(0, 3);
          const gVisible = gBucket.slice(0, Math.max(0, 3 - visible.length));
          const overflow =
            bucket.length - visible.length + (gBucket.length - gVisible.length);
          // Bottom-row borders sit on the parent; we add a right border
          // on every cell except column 7 + top border except row 1.
          return (
            <div
              key={i}
              className={cn(
                'group min-h-[120px] border-b border-r border-border p-1.5 text-left',
                (i + 1) % 7 === 0 && 'border-r-0',
                i >= 35 && 'border-b-0',
                inMonth ? 'bg-surface' : 'bg-surface-muted/40',
              )}
            >
              <div className="mb-1 flex items-center justify-between text-xs">
                <span
                  className={cn(
                    'inline-flex size-6 items-center justify-center rounded-full',
                    isToday
                      ? // text-on-brand, not text-white: dark mode flips brand-600
                        // to near-white, which made today's date invisible.
                        'bg-brand-600 font-semibold text-on-brand'
                      : inMonth
                        ? 'text-foreground'
                        : 'text-foreground-subtle',
                  )}
                >
                  {d.getDate()}
                </span>
                {bucket.length > 0 ? (
                  <span className="text-[10px] tabular-nums text-foreground-subtle">
                    {bucket.length}
                  </span>
                ) : null}
                {bucket.length === 0 && gBucket.length > 0 ? (
                  <span className="text-[10px] tabular-nums text-violet-400">{gBucket.length}</span>
                ) : null}
              </div>
              <div className="flex flex-col gap-1">
                {visible.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onOpenBooking(b)}
                    className={cn(
                      'truncate rounded px-1.5 py-0.5 text-left text-[11px] font-medium leading-tight transition-colors',
                      STATUS_COLOR[b.status].chip,
                    )}
                    title={`${b.customerName ?? b.customerPhone} · ${TIME_FMT.format(b._start)}`}
                  >
                    <span className="font-mono">{TIME_FMT.format(b._start)}</span>{' '}
                    <span className="truncate">{b.customerName ?? b.customerPhone}</span>
                  </button>
                ))}
                {gVisible.map((e) => (
                  <GoogleChip key={`${e.id}-${dayKey(d)}`} event={e} />
                ))}
                {overflow > 0 ? (
                  <button
                    type="button"
                    onClick={() => bucket[visible.length] && onOpenBooking(bucket[visible.length]!)}
                    className="text-left text-[10px] text-foreground-muted hover:underline"
                  >
                    +{overflow} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Week grid ----------------------------------------------------

const HOURS: number[] = Array.from({ length: 14 }, (_, i) => i + 7); // 07:00–20:00
const HOUR_HEIGHT = 56; // px — keep in sync with the inline style

function WeekGrid({
  anchor,
  today,
  dayIndex,
  googleIndex,
  onOpenBooking,
}: {
  anchor: Date;
  today: Date;
  dayIndex: Map<string, Array<CalendarBooking & { _start: Date }>>;
  googleIndex: Map<string, PlacedEvent[]>;
  onOpenBooking: (b: CalendarBooking) => void;
}) {
  const weekStart = startOfWeek(anchor);
  const days = useMemo(() => {
    const out: Date[] = [];
    for (let i = 0; i < 7; i++) out.push(addDays(weekStart, i));
    return out;
  }, [weekStart]);

  const totalHeight = HOURS.length * HOUR_HEIGHT;

  function topForTime(d: Date): number {
    const minutes = d.getHours() * 60 + d.getMinutes() - HOURS[0]! * 60;
    return Math.max(0, (minutes / 60) * HOUR_HEIGHT);
  }

  // All-day Google events don't belong anywhere on an hour grid, so they get
  // their own strip under the day headers (only rendered when there are any).
  const allDayByDay = days.map((d) =>
    (googleIndex.get(dayKey(d)) ?? []).filter((e) => e.allDay),
  );
  const hasAllDay = allDayByDay.some((list) => list.length > 0);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      {/* Day headers */}
      <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] border-b border-border bg-surface-muted">
        <div />
        {days.map((d) => {
          const isToday = sameDay(d, today);
          return (
            <div
              key={d.toISOString()}
              className={cn(
                'border-l border-border px-2 py-2 text-center text-xs',
                isToday ? 'bg-brand-50' : '',
              )}
            >
              <div className="font-medium uppercase tracking-wide text-foreground-subtle">
                {new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(d)}
              </div>
              <div
                className={cn(
                  'mx-auto mt-0.5 inline-flex size-7 items-center justify-center rounded-full text-sm',
                  isToday ? 'bg-brand-600 font-semibold text-on-brand' : 'text-foreground',
                )}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {hasAllDay ? (
        <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] border-b border-border bg-surface-muted/40">
          <div className="px-2 py-1 text-right text-[10px] uppercase tracking-wide text-foreground-subtle">
            All day
          </div>
          {days.map((d, i) => (
            <div
              key={`allday-${d.toISOString()}`}
              className="flex flex-col gap-0.5 border-l border-border p-1"
            >
              {allDayByDay[i]!.map((e) => (
                <GoogleChip key={`${e.id}-allday`} event={e} />
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* Time grid */}
      <div
        className="relative grid grid-cols-[64px_repeat(7,minmax(0,1fr))]"
        style={{ height: totalHeight }}
      >
        {/* Hour gutter */}
        <div className="relative">
          {HOURS.map((h) => (
            <div
              key={h}
              className="absolute left-0 right-0 border-t border-border pr-2 text-right text-[10px] tabular-nums text-foreground-subtle"
              style={{ top: (h - HOURS[0]!) * HOUR_HEIGHT, height: HOUR_HEIGHT }}
            >
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
        </div>

        {/* Day columns */}
        {days.map((d) => {
          const bucket = dayIndex.get(dayKey(d)) ?? [];
          const gTimed = (googleIndex.get(dayKey(d)) ?? []).filter((e) => !e.allDay);
          const isToday = sameDay(d, today);
          return (
            <div
              key={d.toISOString()}
              className={cn('relative border-l border-border', isToday && 'bg-brand-50/30')}
            >
              {/* Hour grid lines */}
              {HOURS.map((h) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 border-t border-border/60"
                  style={{ top: (h - HOURS[0]!) * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                />
              ))}
              {/* Current-time line */}
              {isToday && today.getHours() >= HOURS[0]! && today.getHours() <= HOURS.at(-1)! ? (
                <div
                  className="absolute left-0 right-0 z-10 h-0.5 bg-rose-500"
                  style={{ top: topForTime(today) }}
                >
                  <span className="absolute -left-1 -top-1 size-2 rounded-full bg-rose-500" />
                </div>
              ) : null}
              {/* Google events — full width, behind the bookings (z-0 vs the
                  booking blocks' default stacking) so an appointment is never
                  hidden by an event we don't own. Height follows the real
                  duration, clamped to the visible 07:00–20:00 band. */}
              {gTimed.map((e) => {
                // A multi-day event shows on each day it covers; clamp its
                // block to this column's own midnight..midnight span.
                const dayStart = new Date(d);
                dayStart.setHours(0, 0, 0, 0);
                const dayEnd = addDays(dayStart, 1);
                const from = e._start < dayStart ? dayStart : e._start;
                const to = e._end > dayEnd ? dayEnd : e._end;
                const top = topForTime(from);
                const rawHeight = ((to.getTime() - from.getTime()) / 3_600_000) * HOUR_HEIGHT;
                const height = Math.max(14, Math.min(rawHeight, totalHeight - top));
                if (top >= totalHeight) return null;
                return (
                  <div
                    key={`${e.id}-timed`}
                    className="absolute inset-x-1 z-0 overflow-hidden"
                    style={{ top, height }}
                  >
                    <GoogleChip event={e} className="h-full items-start bg-violet-50" />
                  </div>
                );
              })}

              {/* Appointment blocks */}
              {bucket.map((b) => {
                // Bookings don't carry a duration today; default to 60 min
                // so blocks render visibly. Overlap is handled by stacking
                // (later events sit on top — operators rarely double-book
                // the same start minute in this dataset).
                const top = topForTime(b._start);
                const height = HOUR_HEIGHT - 4;
                if (top < 0 || top > totalHeight) return null;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onOpenBooking(b)}
                    className={cn(
                      'absolute inset-x-1 z-10 overflow-hidden rounded-md px-2 py-1 text-left text-xs font-medium shadow-sm ring-1 transition-colors',
                      STATUS_COLOR[b.status].chip,
                      STATUS_COLOR[b.status].ring,
                    )}
                    style={{ top, height }}
                  >
                    <div className="truncate">
                      <span className="mr-1 font-mono">{TIME_FMT.format(b._start)}</span>
                      {b.customerName ?? b.customerPhone}
                    </div>
                    {b.notes ? (
                      <div className="truncate text-[10px] font-normal opacity-75">{b.notes}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Booking detail (dialog body) ---------------------------------

function BookingDetail({
  booking,
  onChangeStatus,
}: {
  booking: CalendarBooking;
  onChangeStatus: (s: BookingStatus) => void;
}) {
  const when = booking.appointmentAt ? new Date(booking.appointmentAt) : null;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span>{booking.customerName ?? booking.customerPhone}</span>
          <Badge variant={STATUS_BADGE[booking.status]}>{STATUS_COLOR[booking.status].label}</Badge>
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
              When
            </div>
            <div className="mt-0.5">
              {when ? (
                <span className="font-mono">
                  {new Intl.DateTimeFormat('en-GB', {
                    weekday: 'short',
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  }).format(when)}
                </span>
              ) : (
                <span className="italic text-foreground-subtle">unparsed</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
              Phone
            </div>
            <div className="mt-0.5 font-mono text-xs">{booking.customerPhone}</div>
          </div>
        </div>
        {booking.fields.length > 0 ? (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
              Answers
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              {booking.fields.map((f) => (
                <div key={f.key}>
                  <dt className="font-semibold text-foreground-subtle">{f.label}</dt>
                  <dd className="break-words">
                    {f.value === null || f.value === '' ? (
                      <span className="italic text-foreground-subtle">(empty)</span>
                    ) : (
                      String(f.value)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
        {booking.notes ? (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-subtle">
              Notes
            </div>
            <div className="whitespace-pre-wrap text-xs">{booking.notes}</div>
          </div>
        ) : null}
        {booking.reminderSentAt ? (
          <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            Reminder template sent {new Date(booking.reminderSentAt).toLocaleString()}.
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {(['new', 'confirmed', 'completed', 'cancelled'] as BookingStatus[]).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={booking.status === s ? 'primary' : 'ghost'}
              onClick={() => onChangeStatus(s)}
            >
              {s}
            </Button>
          ))}
          {booking.threadId ? (
            <Link
              href={`/inbox?thread=${booking.threadId}`}
              className="ml-auto inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
            >
              <MessageSquare className="size-3.5" /> View chat
            </Link>
          ) : null}
        </div>
      </div>
    </>
  );
}
