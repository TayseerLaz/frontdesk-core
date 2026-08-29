'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CheckCircle2, ExternalLink } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api';

interface Status {
  configured: boolean;
  connected: boolean;
  email: string | null;
  calendarId: string | null;
  blockOnBusy: boolean;
  pushBookings: boolean;
  meetingMode: 'online' | 'onsite';
  autoConfirm: boolean;
}

const ERRORS: Record<string, string> = {
  norefresh:
    'Google didn’t return a refresh token. Remove Hader at myaccount.google.com/permissions, then reconnect.',
  state: 'That connection link expired — please try again.',
  exchange: 'Couldn’t complete the connection. Please try again.',
  '1': 'Connection was cancelled.',
};

export default function GoogleCalendarSettingsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const [connecting, setConnecting] = useState(false);

  const q = useQuery({
    queryKey: ['google-calendar', 'status'],
    queryFn: () => api.get<{ data: Status }>('/api/v1/google-calendar/status'),
  });
  const s = q.data?.data;

  // Handle the OAuth return (?connected=1 / ?error=…), then clean the URL.
  useEffect(() => {
    if (params.get('connected')) {
      toast.success('Google Calendar connected — your bookings will now sync.');
      qc.invalidateQueries({ queryKey: ['google-calendar', 'status'] });
      router.replace('/settings/google-calendar');
    } else if (params.get('error')) {
      toast.error(ERRORS[params.get('error')!] ?? 'Could not connect Google Calendar.');
      router.replace('/settings/google-calendar');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function connect() {
    setConnecting(true);
    try {
      const res = await api.get<{ data: { url: string } }>('/api/v1/google-calendar/connect');
      window.location.href = res.data.url; // hand off to Google's consent screen
    } catch (err) {
      setConnecting(false);
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not start the connection.');
    }
  }

  const saveSetting = useMutation({
    mutationFn: (patch: Partial<Pick<Status, 'blockOnBusy' | 'pushBookings' | 'meetingMode' | 'autoConfirm'>>) =>
      api.put('/api/v1/google-calendar/settings', patch),
    onSuccess: () => {
      toast.success('Saved.');
      qc.invalidateQueries({ queryKey: ['google-calendar'] });
    },
    onError: () => toast.error('Could not save that setting.'),
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/api/v1/google-calendar/disconnect', {}),
    onSuccess: () => {
      toast.success('Google Calendar disconnected.');
      qc.invalidateQueries({ queryKey: ['google-calendar', 'status'] });
    },
    onError: () => toast.error('Could not disconnect.'),
  });

  return (
    <>
      <PageHeader
        backHref="/settings"
        eyebrow="Integrations"
        title="Google Calendar"
        description="Keep Hader and Google Calendar in step — bookings appear on your calendar automatically, and your calendar's events show up in Hader and can hold booking slots."
      />

      <div className="mt-6 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="size-4 text-brand-500" /> Calendar connection
            </CardTitle>
            <CardDescription>
              Connect a Google account; bookings are added to its primary calendar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {q.isLoading ? (
              <Skeleton className="h-10 w-64" />
            ) : !s?.configured ? (
              <div className="rounded-md border border-amber-300 bg-amber-50/50 p-4 text-sm text-amber-900">
                Google Calendar isn’t set up on this platform yet. The ALIGNED team needs to add the
                Google OAuth credentials before you can connect.
              </div>
            ) : s.connected ? (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <CheckCircle2 className="size-5" />
                  </span>
                  <div>
                    <p className="text-sm font-medium text-foreground">Connected</p>
                    <p className="text-xs text-foreground-muted">
                      {s.email ?? 'Google account'} · calendar: {s.calendarId ?? 'primary'}
                    </p>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: 'Disconnect Google Calendar?',
                      body: 'New bookings will stop syncing, your calendar will stop appearing in Hader, and it will no longer hold booking slots. Events already on the calendar stay.',
                      confirmLabel: 'Disconnect',
                    });
                    if (ok) disconnect.mutate();
                  }}
                  loading={disconnect.isPending}
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-foreground-muted">
                  Not connected yet. You’ll be sent to Google to grant Hader permission to read your
                  calendar’s events and add its own.
                </p>
                <Button onClick={connect} loading={connecting}>
                  <ExternalLink className="size-4" /> Connect Google Calendar
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {s?.connected ? (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarClock className="size-4 text-brand-500" /> Bookings
              </CardTitle>
              <CardDescription>
                What happens when a customer books an appointment.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Add bookings to my Google Calendar
                  </p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    Off: bookings stay in Hader only — no calendar event, no meeting link, no
                    invitation. Everything below applies only while this is on.
                  </p>
                </div>
                <Switch
                  checked={s.pushBookings}
                  disabled={saveSetting.isPending}
                  onCheckedChange={(v) => saveSetting.mutate({ pushBookings: v })}
                  aria-label="Add bookings to my Google Calendar"
                />
              </div>

              <div className={s.pushBookings ? '' : 'pointer-events-none opacity-50'}>
                <p className="text-sm font-medium text-foreground">Meeting type</p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Applies to every booking you take. Customers are never asked.
                </p>
                <div className="mt-2 inline-flex rounded-md border border-border p-0.5 text-xs">
                  {(
                    [
                      ['onsite', 'At our location'],
                      ['online', 'Online (Google Meet)'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={saveSetting.isPending}
                      onClick={() => saveSetting.mutate({ meetingMode: value })}
                      className={
                        s.meetingMode === value
                          ? 'rounded bg-brand-50 px-3 py-1 text-brand-700'
                          : 'rounded px-3 py-1 text-foreground-muted hover:text-foreground'
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-foreground-muted">
                  {s.meetingMode === 'online'
                    ? 'Each booking gets a Google Meet link, sent to the customer.'
                    : 'Customers receive your address instead of a video link.'}
                </p>
              </div>

              <div
                className={`flex items-start justify-between gap-4 ${
                  s.pushBookings ? '' : 'pointer-events-none opacity-50'
                }`}
              >
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm bookings automatically</p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    The bot confirms the appointment in the conversation and sends the details
                    straight away. Turn this off and each booking waits for someone to approve it —
                    but the confirmation then falls outside WhatsApp&apos;s 24-hour window and needs
                    an approved template.
                  </p>
                </div>
                <Switch
                  checked={s.autoConfirm}
                  disabled={saveSetting.isPending}
                  onCheckedChange={(v) => saveSetting.mutate({ autoConfirm: v })}
                  aria-label="Confirm bookings automatically"
                />
              </div>
            </CardContent>
          </Card>
        ) : null}

        {s?.connected ? (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CalendarClock className="size-4 text-brand-500" /> Availability
              </CardTitle>
              <CardDescription>
                What the bot does with the times you&apos;re already busy.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Don&apos;t offer slots I&apos;m busy for
                  </p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    When a customer asks to book, the bot skips any slot that clashes with a timed
                    event on this calendar. All-day events (birthdays, holidays) are ignored so they
                    don&apos;t wipe out a whole day, and events you&apos;ve marked &ldquo;free&rdquo;
                    or declined never block anything. If Google can&apos;t be reached we offer the
                    slot anyway — a customer is never turned away because of us.
                  </p>
                </div>
                <Switch
                  checked={s.blockOnBusy}
                  disabled={saveSetting.isPending}
                  onCheckedChange={(v) => saveSetting.mutate({ blockOnBusy: v })}
                  aria-label="Don't offer slots I'm busy for"
                />
              </div>
            </CardContent>
          </Card>
        ) : null}

        <p className="mt-4 text-xs text-foreground-subtle">
          Only bookings that have a resolved date &amp; time are synced to Google. Hader also
          <strong className="font-medium"> reads</strong> this calendar so its events appear in your
          bookings calendar and can hold slots — we never edit or delete events Hader didn&apos;t
          create, and nothing from your calendar is shown to customers.
        </p>
      </div>
    </>
  );
}
