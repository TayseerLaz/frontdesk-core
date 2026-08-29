'use client';

import {
  BROADCAST_STATUS_LABELS,
  type BroadcastDto,
  type BroadcastEventDto,
  type RecipientDto,
  RECIPIENT_STATUS_LABELS,
  type RecipientStatus,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  Download,
  Pause,
  Play,
  RefreshCw,
  Send,
  StopCircle,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { connectSse } from '@/lib/sse';

const STATUS_CLASS: Record<RecipientStatus, string> = {
  pending: 'bg-slate-100 text-slate-600',
  queued: 'bg-blue-50 text-blue-700',
  sent: 'bg-cyan-50 text-cyan-700',
  delivered: 'bg-emerald-50 text-emerald-700',
  read: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-50 text-red-700',
  skipped: 'bg-slate-100 text-slate-500',
};

interface BroadcastAnalytics {
  funnel: {
    total: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    skipped: number;
    pending: number;
    responded: number;
  };
  rates: { deliveryRate: number; readRate: number; responseRate: number; failureRate: number };
  optedOut: number;
  failureBreakdown: { code: string; message: string | null; count: number }[];
  variants: { variant: string; recipients: number; delivered: number; read: number; responded: number }[];
  timing: { startedAt: string | null; completedAt: string | null; durationMs: number | null };
}

const pctLabel = (r: number) => `${Math.round(r * 100)}%`;

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function BroadcastDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'analytics' | 'recipients' | 'timeline'>('overview');
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | ''>('');

  const broadcastQuery = useQuery({
    queryKey: ['broadcast', id],
    queryFn: () => api.get<{ data: BroadcastDto }>(`/api/v1/broadcasts/${id}`),
    // SSE drives invalidation; this is a slow-poll backstop.
    refetchInterval: 15_000,
  });

  // SSE: tick every 2s → invalidate counters/recipients/timeline. Auth is via
  // single-use nonce; `connectSse` handles reconnect-with-backoff itself
  // because a leaked-and-reused nonce would otherwise 401 on each retry.
  useEffect(() => {
    if (!getAccessToken()) return;
    const dispose = connectSse(`/api/v1/broadcasts/${id}/sse`, {
      onTick: () => {
        qc.invalidateQueries({ queryKey: ['broadcast', id] });
        qc.invalidateQueries({ queryKey: ['broadcast-recipients', id] });
        qc.invalidateQueries({ queryKey: ['broadcast-timeline', id] });
      },
    });
    return dispose;
  }, [id, qc]);

  const recipientsQuery = useQuery({
    queryKey: ['broadcast-recipients', id, statusFilter],
    queryFn: () =>
      api.get<{ data: RecipientDto[]; nextCursor: string | null }>(
        `/api/v1/broadcasts/${id}/recipients?` +
          new URLSearchParams({
            ...(statusFilter ? { status: statusFilter } : {}),
            limit: '100',
          }).toString(),
      ),
    enabled: tab === 'recipients',
    refetchInterval: tab === 'recipients' ? 4000 : false,
  });

  const timelineQuery = useQuery({
    queryKey: ['broadcast-timeline', id],
    queryFn: () =>
      api.get<{ data: BroadcastEventDto[] }>(`/api/v1/broadcasts/${id}/timeline`),
    enabled: tab === 'timeline',
    refetchInterval: tab === 'timeline' ? 5000 : false,
  });

  const analyticsQuery = useQuery({
    queryKey: ['broadcast-analytics', id],
    queryFn: () => api.get<{ data: BroadcastAnalytics }>(`/api/v1/broadcasts/${id}/analytics`),
    enabled: tab === 'analytics',
    refetchInterval: tab === 'analytics' ? 8000 : false,
  });

  const lifecycle = (action: 'pause' | 'resume' | 'cancel') =>
    api.post<{ data: BroadcastDto }>(`/api/v1/broadcasts/${id}/${action}`).then((res) => {
      qc.invalidateQueries({ queryKey: ['broadcast', id] });
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      return res;
    });

  const pauseMutation = useMutation({
    mutationFn: () => lifecycle('pause'),
    onSuccess: () => toast.success('Paused'),
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Pause failed'),
  });
  const resumeMutation = useMutation({
    mutationFn: () => lifecycle('resume'),
    onSuccess: () => toast.success('Resumed'),
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Resume failed'),
  });
  const cancelMutation = useMutation({
    mutationFn: () => lifecycle('cancel'),
    onSuccess: () => toast.success('Cancelled'),
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Cancel failed'),
  });
  const rerunMutation = useMutation({
    mutationFn: () =>
      api.post<{ data: { requeued: number } }>(`/api/v1/broadcasts/${id}/rerun-failed`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['broadcast', id] });
      qc.invalidateQueries({ queryKey: ['broadcast-recipients', id] });
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success(`Re-queued ${res.data.requeued} recipient${res.data.requeued === 1 ? '' : 's'}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Re-run failed'),
  });
  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/api/v1/broadcasts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success('Broadcast deleted');
      window.location.href = '/broadcasts';
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });
  const resendMutation = useMutation({
    mutationFn: () =>
      api.post<{ data: { id: string; name: string } }>(`/api/v1/broadcasts/${id}/resend`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success(`Resending as "${res.data.name}"`);
      // Hop straight to the new broadcast so the operator can watch
      // counters tick on the fresh campaign.
      window.location.href = `/broadcasts/${res.data.id}`;
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Resend failed'),
  });

  // "Not on WhatsApp" cleanup — how many recipients failed because the number
  // isn't a WhatsApp user (Meta 131026), + tag-aside / delete those contacts.
  const undeliverableQuery = useQuery({
    queryKey: ['broadcast-undeliverable', id],
    queryFn: () =>
      api.get<{ data: { count: number; sample: string[] } }>(
        `/api/v1/broadcasts/${id}/undeliverable`,
      ),
    enabled: (broadcastQuery.data?.data.failedCount ?? 0) > 0,
  });
  const noWa = undeliverableQuery.data?.data.count ?? 0;
  const cleanupMutation = useMutation({
    mutationFn: (action: 'tag' | 'delete') =>
      api.post<{ data: { affected: number } }>(
        `/api/v1/broadcasts/${id}/undeliverable-contacts`,
        { action },
      ),
    onSuccess: (res, action) => {
      toast.success(
        action === 'delete'
          ? `Deleted ${res.data.affected} contact${res.data.affected === 1 ? '' : 's'} not on WhatsApp`
          : `Tagged ${res.data.affected} contact${res.data.affected === 1 ? '' : 's'} as "no-whatsapp"`,
      );
      qc.invalidateQueries({ queryKey: ['broadcast-undeliverable', id] });
      qc.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Cleanup failed'),
  });

  const exportCsv = () => {
    const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/broadcasts/${id}/recipients.csv`;
    fetch(url, {
      headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const blob = await res.blob();
        const a = document.createElement('a');
        const objUrl = URL.createObjectURL(blob);
        a.href = objUrl;
        a.download = `broadcast-${id.slice(0, 8)}-recipients.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Export failed'));
  };

  const b = broadcastQuery.data?.data;

  return (
    <>
      <PageHeader
        backHref="/broadcasts"
        backLabel="Broadcasts"
        title={b?.name ?? 'Broadcast'}
        description={
          b
            ? `${BROADCAST_STATUS_LABELS[b.status]} · ${b.totalRecipients} recipient${b.totalRecipients === 1 ? '' : 's'}`
            : <Skeleton className="h-4 w-48" />
        }
        actions={
          <div className="flex gap-2">
            <Link href="/broadcasts">
              <Button variant="ghost">
                <ChevronLeft className="size-4" /> Back
              </Button>
            </Link>
            {b?.status === 'sending' || b?.status === 'scheduled' ? (
              <Button variant="secondary" onClick={() => pauseMutation.mutate()}>
                <Pause className="size-4" /> Pause
              </Button>
            ) : null}
            {b &&
            ['paused', 'sending', 'scheduled'].includes(b.status) &&
            (b.status === 'paused' || b.skippedCount > 0) ? (
              <Button
                onClick={() => resumeMutation.mutate()}
                loading={resumeMutation.isPending}
                title={
                  b.skippedCount > 0
                    ? `Send the ${b.skippedCount} recipient${b.skippedCount === 1 ? '' : 's'} that were skipped (e.g. when the wallet ran out).`
                    : 'Resume sending.'
                }
              >
                <Play className="size-4" /> Resume
                {b.skippedCount > 0 ? ` (${b.skippedCount.toLocaleString()})` : ''}
              </Button>
            ) : null}
            {b?.status &&
            !['completed', 'cancelled', 'failed'].includes(b.status) ? (
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm('Stop this broadcast now? Recipients not yet sent will be skipped.'))
                    cancelMutation.mutate();
                }}
              >
                <StopCircle className="size-4" /> Stop broadcast
              </Button>
            ) : null}
            {b && b.failedCount > 0 ? (
              <Button
                onClick={() => {
                  if (
                    window.confirm(
                      `Resend the same template to ${b.failedCount} failed recipient${b.failedCount === 1 ? '' : 's'}?`,
                    )
                  )
                    rerunMutation.mutate();
                }}
                disabled={rerunMutation.isPending}
                loading={rerunMutation.isPending}
              >
                <RefreshCw className="size-4" /> Resend to failed ({b.failedCount})
              </Button>
            ) : null}
            {b && b.totalRecipients > 0 ? (
              <Button variant="ghost" onClick={exportCsv}>
                <Download className="size-4" /> Export CSV
              </Button>
            ) : null}
            {/* Resend only makes sense once the original is in a terminal
                state — for an active campaign the operator can pause +
                cancel + re-run instead. */}
            {b &&
            ['completed', 'cancelled', 'failed'].includes(b.status) &&
            b.totalRecipients > 0 ? (
              <Button
                onClick={() => {
                  if (
                    window.confirm(
                      `Resend "${b.name}" to the same ${b.totalRecipients} recipient${
                        b.totalRecipients === 1 ? '' : 's'
                      }? Creates a new broadcast and fires it immediately.`,
                    )
                  )
                    resendMutation.mutate();
                }}
                disabled={resendMutation.isPending}
              >
                <Send className="size-4" />{' '}
                {resendMutation.isPending ? 'Resending…' : 'Resend'}
              </Button>
            ) : null}
            {b ? (
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete broadcast "${b.name}"? This permanently removes the campaign + all recipient rows + timeline. Can't be undone.`,
                    )
                  )
                    deleteMutation.mutate();
                }}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="size-4" /> Delete
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Counter cards */}
      {b ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <CounterCard label="Queued" value={b.queuedCount} />
          <CounterCard label="Sent" value={b.sentCount} />
          <CounterCard label="Delivered" value={b.deliveredCount} />
          <CounterCard label="Read" value={b.readCount} />
          <CounterCard label="Failed" value={b.failedCount} accent="text-red-600" />
        </div>
      ) : null}

      {/* "Not on WhatsApp" cleanup — surfaces recipients Meta marked
          undeliverable because the number isn't a WhatsApp user, and lets the
          operator tag them aside or delete them. */}
      {noWa > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-400/40 dark:bg-amber-400/10">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {noWa.toLocaleString()} number{noWa === 1 ? '' : 's'} on this broadcast{' '}
            {noWa === 1 ? "isn't" : "aren't"} on WhatsApp
          </p>
          <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-200/70">
            Meta returned “undeliverable” for {noWa === 1 ? 'it' : 'these'} — the number
            {noWa === 1 ? " doesn't have" : "s don't have"} WhatsApp, so resending won’t reach{' '}
            {noWa === 1 ? 'it' : 'them'}. Clean {noWa === 1 ? 'it' : 'them'} out of your list:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              loading={cleanupMutation.isPending && cleanupMutation.variables === 'tag'}
              onClick={() => cleanupMutation.mutate('tag')}
            >
              Tag aside (“no-whatsapp”)
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={cleanupMutation.isPending && cleanupMutation.variables === 'delete'}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete ${noWa} contact${noWa === 1 ? '' : 's'} that ${noWa === 1 ? "isn't" : "aren't"} on WhatsApp from your contact list? Their conversation history is kept, but they're removed from the list.`,
                  )
                )
                  cleanupMutation.mutate('delete');
              }}
            >
              Delete from contacts
            </Button>
          </div>
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(['overview', 'analytics', 'recipients', 'timeline'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-4 py-2 text-sm font-medium capitalize ${
              tab === t
                ? 'border-primary text-foreground'
                : 'border-transparent text-foreground-muted hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && b ? (
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Audience" value={b.audienceKind} />
            <Field
              label="A/B test"
              value={b.abTest ? 'Yes' : 'No'}
            />
            <Field
              label="Template A"
              value={b.variantATemplateId.slice(0, 8)}
            />
            {b.variantBTemplateId ? (
              <Field label="Template B" value={b.variantBTemplateId.slice(0, 8)} />
            ) : null}
            <Field
              label="Scheduled for"
              value={b.scheduledFor ? new Date(b.scheduledFor).toLocaleString() : '—'}
            />
            <Field
              label="Started at"
              value={b.startedAt ? new Date(b.startedAt).toLocaleString() : '—'}
            />
            <Field
              label="Completed at"
              value={b.completedAt ? new Date(b.completedAt).toLocaleString() : '—'}
            />
            <Field label="Total recipients" value={String(b.totalRecipients)} />
          </CardContent>
        </Card>
      ) : null}

      {tab === 'analytics' ? (
        analyticsQuery.isLoading || !analyticsQuery.data ? (
          <Card>
            <CardContent className="space-y-3 py-6">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </CardContent>
          </Card>
        ) : (
          (() => {
            const a = analyticsQuery.data.data;
            return (
              <div className="space-y-4">
                {/* Funnel — headline numbers */}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <MetricCard label="Recipients" value={a.funnel.total} />
                  <MetricCard label="Delivered" value={a.funnel.delivered} sub={pctLabel(a.rates.deliveryRate) + ' of sent'} />
                  <MetricCard label="Read" value={a.funnel.read} sub={pctLabel(a.rates.readRate) + ' of delivered'} />
                  <MetricCard
                    label="Responded"
                    value={a.funnel.responded}
                    sub={pctLabel(a.rates.responseRate) + ' of delivered'}
                    accent
                  />
                  <MetricCard label="Sent" value={a.funnel.sent} />
                  <MetricCard label="Failed" value={a.funnel.failed} sub={pctLabel(a.rates.failureRate) + ' of all'} />
                  <MetricCard label="Opted out" value={a.optedOut} />
                  <MetricCard label="Send duration" value={fmtDuration(a.timing.durationMs)} />
                </div>

                {/* Delivery funnel bar */}
                <Card>
                  <CardHeader><CardTitle>Delivery funnel</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {([
                      ['Sent', a.funnel.sent],
                      ['Delivered', a.funnel.delivered],
                      ['Read', a.funnel.read],
                      ['Responded', a.funnel.responded],
                    ] as const).map(([label, val]) => {
                      const w = a.funnel.total > 0 ? Math.round((val / a.funnel.total) * 100) : 0;
                      return (
                        <div key={label} className="flex items-center gap-3 text-sm">
                          <span className="w-24 shrink-0 text-foreground-muted">{label}</span>
                          <div className="h-5 flex-1 overflow-hidden rounded bg-surface-muted">
                            <div className="h-full rounded bg-primary/70" style={{ width: `${w}%` }} />
                          </div>
                          <span className="w-24 shrink-0 text-right font-medium">
                            {val} <span className="text-foreground-muted">({w}%)</span>
                          </span>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                {/* A/B comparison */}
                {a.variants.length > 1 ? (
                  <Card>
                    <CardHeader><CardTitle>A/B comparison</CardTitle></CardHeader>
                    <CardContent className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="text-xs uppercase text-foreground-subtle">
                          <tr>
                            <th className="py-2">Variant</th>
                            <th className="py-2">Recipients</th>
                            <th className="py-2">Delivered</th>
                            <th className="py-2">Read</th>
                            <th className="py-2">Responded</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.variants.map((v) => (
                            <tr key={v.variant} className="border-t border-border">
                              <td className="py-2 font-medium">{v.variant}</td>
                              <td className="py-2">{v.recipients}</td>
                              <td className="py-2">{v.delivered}</td>
                              <td className="py-2">{v.read}</td>
                              <td className="py-2">{v.responded}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  </Card>
                ) : null}

                {/* Failure breakdown */}
                {a.failureBreakdown.length > 0 ? (
                  <Card>
                    <CardHeader><CardTitle>Why messages failed</CardTitle></CardHeader>
                    <CardContent className="space-y-1.5 text-sm">
                      {a.failureBreakdown.map((f) => (
                        <div key={f.code} className="flex items-start justify-between gap-3 border-b border-border py-1.5 last:border-0">
                          <div className="min-w-0">
                            <p className="font-medium">Error {f.code}</p>
                            {f.message ? <p className="truncate text-xs text-foreground-muted">{f.message}</p> : null}
                          </div>
                          <span className="shrink-0 font-medium">{f.count}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            );
          })()
        )
      ) : null}

      {tab === 'recipients' ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recipients</CardTitle>
            <select
              className="rounded border border-border px-2 py-1 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as RecipientStatus | '')}
            >
              <option value="">All</option>
              {Object.entries(RECIPIENT_STATUS_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
                  <tr>
                    <th className="px-6 py-3">Phone</th>
                    <th className="px-6 py-3">Variant</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3">Sent</th>
                    <th className="px-6 py-3">Delivered</th>
                    <th className="px-6 py-3">Read</th>
                    <th className="px-6 py-3">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {recipientsQuery.isLoading ? (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <SkeletonRows rows={5} cols={5} />
                      </td>
                    </tr>
                  ) : null}
                  {recipientsQuery.data?.data.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-6 py-3 font-mono text-xs">{r.phoneE164}</td>
                      <td className="px-6 py-3 text-foreground-muted">{r.variant}</td>
                      <td className="px-6 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[r.status]}`}
                        >
                          {RECIPIENT_STATUS_LABELS[r.status]}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-foreground-muted">
                        {r.sentAt ? new Date(r.sentAt).toLocaleTimeString() : '—'}
                      </td>
                      <td className="px-6 py-3 text-foreground-muted">
                        {r.deliveredAt ? new Date(r.deliveredAt).toLocaleTimeString() : '—'}
                      </td>
                      <td className="px-6 py-3 text-foreground-muted">
                        {r.readAt ? new Date(r.readAt).toLocaleTimeString() : '—'}
                      </td>
                      <td className="px-6 py-3 text-xs text-red-600">
                        {r.metaErrorCode ? `${r.metaErrorCode}: ${r.metaErrorMessage ?? ''}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {tab === 'timeline' ? (
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(timelineQuery.data?.data ?? []).map((e) => (
              <div key={e.id} className="flex items-start gap-3 text-sm">
                <span className="font-mono text-xs text-foreground-subtle">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                <span className="font-medium">{e.kind.replace(/_/g, ' ')}</span>
                {e.detail ? (
                  <code className="text-xs text-foreground-muted">{JSON.stringify(e.detail)}</code>
                ) : null}
              </div>
            ))}
            {timelineQuery.data?.data.length === 0 ? (
              <p className="text-sm text-foreground-muted">No events yet.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function CounterCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</div>
        <div className={`mt-1 font-mono text-2xl font-semibold ${accent ?? ''}`}>
          {value.toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</div>
      <div className="mt-1">{value}</div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        accent ? 'border-primary/40 bg-primary/5' : 'border-border bg-surface'
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-foreground-muted">{sub}</div> : null}
    </div>
  );
}
