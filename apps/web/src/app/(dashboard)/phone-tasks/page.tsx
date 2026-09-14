'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, PhoneForwarded, RefreshCw, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

// Mirrors packages/shared/src/schemas/phone-task.ts. Kept local (like the
// voice-calls page) so the web build never depends on the shared dist.
type Kind = 'cod_order_confirm' | 'booking_confirm' | 'custom';
type Status = 'queued' | 'in_progress' | 'completed' | 'failed' | 'canceled' | 'needs_review';

interface PhoneTask {
  id: string;
  kind: Kind;
  targetType: 'cart' | 'booking' | 'thread' | null;
  targetId: string | null;
  threadId: string | null;
  phoneE164: string;
  dialedPhone: string | null;
  region: string | null;
  locale: string | null;
  task: string;
  resultSchema: Record<string, unknown>;
  status: Status;
  dryRun: boolean;
  calleCallId: string | null;
  structuredResult: Record<string, unknown> | null;
  summary: string | null;
  taskCompleted: boolean | null;
  confidence: number | null;
  transcript: { speaker: string; text: string; offsetMs: number | null }[] | null;
  error: string | null;
  appliedAt: string | null;
  appliedAction: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface Runtime {
  dryRun: boolean;
  liveOverridePhone: string | null;
  configured: boolean;
  supportedRegions: string[];
}

interface Settings {
  codAutoConfirm: boolean;
  delayMinutes: number;
  dailyCap: number;
}

const KIND_LABEL: Record<Kind, string> = {
  cod_order_confirm: 'Confirm COD order',
  booking_confirm: 'Confirm booking',
  custom: 'Custom goal',
};

const STATUS_VARIANT: Record<Status, 'muted' | 'success' | 'warning' | 'danger' | 'info'> = {
  queued: 'muted',
  in_progress: 'info',
  completed: 'success',
  failed: 'danger',
  canceled: 'muted',
  needs_review: 'warning',
};

const STATUS_LABEL: Record<Status, string> = {
  queued: 'Queued',
  in_progress: 'Calling…',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
  needs_review: 'Needs review',
};

const ACTION_LABEL: Record<string, string> = {
  confirmed: 'Record confirmed',
  cancelled: 'Record cancelled',
  needs_review: 'Left for a human',
  noop: 'Noted only',
};

function isOpen(s: Status) {
  return s === 'queued' || s === 'in_progress';
}

export default function PhoneTasksPage() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);

  const runtime = useQuery({
    queryKey: ['phone-tasks', 'runtime'],
    queryFn: () => api.get<{ data: Runtime }>('/api/v1/phone-tasks/runtime'),
  });

  const list = useQuery({
    queryKey: ['phone-tasks', 'list'],
    queryFn: () =>
      api.get<{ data: PhoneTask[]; nextCursor: string | null }>('/api/v1/phone-tasks?limit=100'),
    // Live calls move through queued → in_progress → completed; poll while any is open.
    refetchInterval: (q) => {
      const rows = q.state.data?.data ?? [];
      return rows.some((t) => isOpen(t.status)) ? 5000 : false;
    },
  });

  const rows = list.data?.data ?? [];
  const rt = runtime.data?.data;

  return (
    <>
      <PageHeader
        title="Phone tasks"
        description="Outbound AI phone calls placed through CALL-E to close the loop on orders and bookings the chat bot opened. Results are written back to the record and posted as a note in the conversation."
      />

      {rt ? <RuntimeBanner rt={rt} /> : null}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <PhoneForwarded className="size-4 text-brand-600" />
              {rows.length} {rows.length === 1 ? 'call' : 'calls'}
            </CardTitle>
            <Button
              size="sm"
              variant="ghost"
              loading={list.isFetching}
              onClick={() => qc.invalidateQueries({ queryKey: ['phone-tasks'] })}
            >
              <RefreshCw className="size-4" /> Refresh
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {list.isLoading ? (
              <div className="py-2">
                <SkeletonRows rows={6} cols={4} />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={PhoneForwarded}
                title="No phone calls yet"
                description="Open Orders and click “Confirm by phone” on a cash-on-delivery order, or turn on auto-confirm on the right."
                action={
                  <Button asChild size="sm">
                    <Link href="/cart">Go to Orders</Link>
                  </Button>
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-3 sm:px-6">When</th>
                      <th className="px-6 py-3">Task</th>
                      <th className="px-6 py-3">Status</th>
                      <th className="hidden px-6 py-3 text-right sm:table-cell">Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr
                        key={t.id}
                        onClick={() => setOpenId(t.id)}
                        className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-surface-muted/40"
                      >
                        <td className="whitespace-nowrap px-4 py-4 text-xs text-foreground-muted sm:px-6">
                          {new Date(t.createdAt).toLocaleString()}
                          <div className="text-[10px] text-foreground-subtle">{formatRelative(t.createdAt)}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-medium">{KIND_LABEL[t.kind]}</div>
                          <div className="font-mono text-[11px] text-foreground-subtle">
                            {t.phoneE164}
                            {t.dialedPhone && t.dialedPhone !== t.phoneE164 ? ` → ${t.dialedPhone}` : ''}
                            {t.dryRun ? ' · dry run' : ''}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant={STATUS_VARIANT[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                          {t.appliedAction ? (
                            <div className="mt-0.5 text-[11px] text-foreground-subtle">
                              {ACTION_LABEL[t.appliedAction] ?? t.appliedAction}
                            </div>
                          ) : null}
                        </td>
                        <td className="hidden whitespace-nowrap px-6 py-4 text-right font-mono text-sm sm:table-cell">
                          {t.confidence == null ? '—' : `${Math.round(t.confidence * 100)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <SettingsCard />
          <TryCallCard />
        </div>
      </div>

      <TaskDialog taskId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function RuntimeBanner({ rt }: { rt: Runtime }) {
  if (rt.dryRun) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-100/60 px-4 py-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <span className="font-medium">Dry run.</span> No real calls are placed; each task completes with a
          synthetic result after 15 seconds so you can see the full write-back. Set{' '}
          <code className="rounded bg-surface-muted px-1">CALLE_DRY_RUN=false</code> and{' '}
          <code className="rounded bg-surface-muted px-1">CALLE_API_KEY</code> on the API to go live.
        </div>
      </div>
    );
  }
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-success/40 bg-success-100/60 px-4 py-3 text-sm">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
      <div>
        <span className="font-medium">Live via CALL-E.</span>{' '}
        {rt.liveOverridePhone ? (
          <>
            Every call is redirected to the verified number{' '}
            <span className="font-mono">{rt.liveOverridePhone}</span> (override enforced in code).
          </>
        ) : (
          <>Calls dial the customer&apos;s number directly. Supported regions: {rt.supportedRegions.join(', ')}.</>
        )}
      </div>
    </div>
  );
}

function SettingsCard() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['phone-tasks', 'settings'],
    queryFn: () => api.get<{ data: Settings }>('/api/v1/phone-tasks/settings'),
  });
  const s = settings.data?.data;
  const [delay, setDelay] = useState<string>('');
  const [cap, setCap] = useState<string>('');
  useEffect(() => {
    if (s) {
      setDelay(String(s.delayMinutes));
      setCap(String(s.dailyCap));
    }
  }, [s]);

  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) =>
      api.patch<{ data: Settings }>('/api/v1/phone-tasks/settings', patch),
    onSuccess: () => {
      toast.success('Phone settings saved');
      qc.invalidateQueries({ queryKey: ['phone-tasks', 'settings'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not save settings'),
  });

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle className="text-base">Automation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">Auto-confirm cash-on-delivery orders</div>
            <p className="mt-0.5 text-xs text-foreground-muted">
              Every new order without an online payment gets a confirmation call after the delay
              below. Ambiguous answers are left for a human — nothing is cancelled automatically
              without a clear “no”.
            </p>
          </div>
          <Switch
            checked={s?.codAutoConfirm ?? false}
            disabled={!s || save.isPending}
            onCheckedChange={(v) => save.mutate({ codAutoConfirm: v })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs text-foreground-muted">Delay (minutes)</span>
            <Input
              type="number"
              min={0}
              max={1440}
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              onBlur={() => {
                const n = Number(delay);
                if (s && Number.isInteger(n) && n !== s.delayMinutes) save.mutate({ delayMinutes: n });
              }}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-foreground-muted">Daily call cap</span>
            <Input
              type="number"
              min={1}
              max={1000}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              onBlur={() => {
                const n = Number(cap);
                if (s && Number.isInteger(n) && n !== s.dailyCap) save.mutate({ dailyCap: n });
              }}
            />
          </label>
        </div>
        <p className="text-xs text-foreground-subtle">
          Contacts who opted out or are blocked are never called. Each task keeps a durable
          idempotency key so a retry can never place a second call.
        </p>
      </CardContent>
    </Card>
  );
}

function TryCallCard() {
  const qc = useQueryClient();
  const runtime = useQuery({
    queryKey: ['phone-tasks', 'runtime'],
    queryFn: () => api.get<{ data: Runtime }>('/api/v1/phone-tasks/runtime'),
  });
  const rt = runtime.data?.data;
  const [phone, setPhone] = useState('');
  const [goal, setGoal] = useState(
    'Introduce yourself as the clinic, ask whether they can hear you clearly, and ask if 4:30pm tomorrow would suit them for a skin consultation.',
  );

  const place = useMutation({
    mutationFn: () =>
      api.post<{ data: PhoneTask }>('/api/v1/phone-tasks', {
        kind: 'custom',
        phoneE164: phone.trim(),
        goal: goal.trim(),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['phone-tasks'] });
      toast.success(
        res.data.dryRun
          ? 'Queued as a dry run — no call placed. Set CALLE_DRY_RUN=false to dial for real.'
          : 'Calling you now. Answer your phone.',
      );
      setPhone('');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not place the call'),
  });

  const valid = /^\+?[0-9][0-9\s-]{7,19}$/.test(phone.trim()) && goal.trim().length >= 10;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Try it on your own phone</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-foreground-muted">
          Places a one-off CALL-E call to any number you own, so you can hear the agent without
          touching a customer record. The result lands in the list on the left with its transcript
          and structured JSON.
        </p>
        <label className="block space-y-1">
          <span className="text-xs text-foreground-muted">Your number, international format</span>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+14155550100"
            inputMode="tel"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-foreground-muted">What should the AI do on the call?</span>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
        </label>
        <Button
          className="w-full"
          disabled={!valid}
          loading={place.isPending}
          onClick={() => place.mutate()}
        >
          <PhoneForwarded className="size-4" />
          {rt && !rt.dryRun ? 'Call me now' : 'Queue a dry run'}
        </Button>
        {rt && !rt.dryRun && rt.liveOverridePhone ? (
          <p className="text-xs text-warning">
            An override is set, so this will ring {rt.liveOverridePhone} rather than the number above.
            Clear CALLE_LIVE_OVERRIDE_PHONE to dial your own number.
          </p>
        ) : null}
        <p className="text-xs text-foreground-subtle">
          Supported countries: {rt?.supportedRegions.join(', ') ?? '…'}. Anything else is refused
          before a call is attempted.
        </p>
      </CardContent>
    </Card>
  );
}

function TaskDialog({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    enabled: !!taskId,
    queryKey: ['phone-tasks', 'detail', taskId],
    queryFn: () => api.get<{ data: PhoneTask }>(`/api/v1/phone-tasks/${taskId}`),
    refetchInterval: (q) => (q.state.data && isOpen(q.state.data.data.status) ? 4000 : false),
  });
  const t = detail.data?.data ?? null;

  const refresh = useMutation({
    mutationFn: () => api.post<{ data: PhoneTask }>(`/api/v1/phone-tasks/${taskId}/refresh`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['phone-tasks'] });
      qc.invalidateQueries({ queryKey: ['carts'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Refresh failed'),
  });

  return (
    <Dialog open={!!taskId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PhoneForwarded className="size-4 text-brand-600" />
            {t ? KIND_LABEL[t.kind] : 'Phone task'}
          </DialogTitle>
          <DialogDescription>
            {t ? (
              <>
                {t.phoneE164}
                {t.dialedPhone && t.dialedPhone !== t.phoneE164 ? ` (dialed ${t.dialedPhone})` : ''} ·{' '}
                {new Date(t.createdAt).toLocaleString()} · <Badge variant={STATUS_VARIANT[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                {t.dryRun ? <Badge variant="warning" className="ml-1">dry run</Badge> : null}
              </>
            ) : (
              'Loading…'
            )}
          </DialogDescription>
        </DialogHeader>

        {!t ? (
          <SkeletonRows rows={4} cols={1} />
        ) : (
          <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {isOpen(t.status) ? (
                <Button size="sm" variant="secondary" loading={refresh.isPending} onClick={() => refresh.mutate()}>
                  <RefreshCw className="size-4" /> Check now
                </Button>
              ) : null}
              {t.targetType === 'cart' ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href="/cart">Open order</Link>
                </Button>
              ) : null}
              {t.threadId ? (
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/inbox?thread=${t.threadId}`}>Open conversation</Link>
                </Button>
              ) : null}
            </div>

            {t.error ? (
              <div className="rounded-md border border-danger/40 bg-danger-100/60 px-3 py-2 text-danger">{t.error}</div>
            ) : null}

            {t.summary ? (
              <Section title="Summary">
                <p className="whitespace-pre-wrap">{t.summary}</p>
                <div className="mt-1 text-xs text-foreground-subtle">
                  {t.taskCompleted == null ? '' : t.taskCompleted ? 'Task completed' : 'Task not completed'}
                  {t.confidence == null ? '' : ` · confidence ${Math.round(t.confidence * 100)}%`}
                  {t.appliedAction ? ` · ${ACTION_LABEL[t.appliedAction] ?? t.appliedAction}` : ''}
                </div>
              </Section>
            ) : null}

            {t.structuredResult ? (
              <Section title="Structured result">
                <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1">
                  {Object.entries(t.structuredResult).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-mono text-xs text-foreground-muted">{k}</dt>
                      <dd className="break-words">{String(v ?? '')}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            ) : null}

            {t.transcript && t.transcript.length > 0 ? (
              <Section title="Transcript">
                <div className="space-y-2">
                  {t.transcript.map((turn, i) => {
                    const bot = turn.speaker === 'bot' || turn.speaker === 'agent' || turn.speaker === 'assistant';
                    return (
                      <div key={i} className={cn('flex flex-col', bot ? 'items-end' : 'items-start')}>
                        <div
                          className={cn(
                            'max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed shadow-sm',
                            bot ? 'bg-brand-500 text-on-brand' : 'bg-surface-muted text-foreground',
                          )}
                        >
                          <p className={cn('mb-0.5 text-[10px] font-semibold uppercase tracking-wide', bot ? 'text-white/80' : 'text-foreground-subtle')}>
                            {bot ? 'AI caller' : 'Customer'}
                          </p>
                          <p className="whitespace-pre-wrap break-words">{turn.text}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Section>
            ) : null}

            <Section title="Brief given to the AI caller">
              <p className="whitespace-pre-wrap text-xs text-foreground-muted">{t.task}</p>
            </Section>

            <Section title="Result schema">
              <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 text-[11px]">
                {JSON.stringify(t.resultSchema, null, 2)}
              </pre>
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-foreground-subtle">{title}</div>
      {children}
    </section>
  );
}
