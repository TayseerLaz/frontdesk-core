'use client';

import {
  BROADCAST_STATUS_LABELS,
  type BroadcastDto,
  type BroadcastStatus,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, RotateCw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
// Templates page exports its own component as default — we reuse it
// here in embedded mode (showHeader=false) so the sidebar's collapsed
// "Templates & broadcasts" entry opens a single page with both as tabs.
import TemplatesPage from '@/app/(dashboard)/whatsapp/templates/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api';

const STATUS_CLASS: Record<BroadcastStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  scheduled: 'bg-amber-50 text-amber-700',
  sending: 'bg-blue-50 text-blue-700',
  paused: 'bg-yellow-50 text-yellow-700',
  completed: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-slate-100 text-slate-500',
  failed: 'bg-red-50 text-red-700',
};

type TabValue = 'broadcasts' | 'templates';

export default function BroadcastsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Segments tab was removed (audiences are now driven by contact tags).
  // Legacy ?tab=segments deep-links fall through to the broadcasts tab.
  const rawTab = searchParams.get('tab');
  const initialTab: TabValue = rawTab === 'templates' ? 'templates' : 'broadcasts';
  const [tab, setTab] = useState<TabValue>(initialTab);

  // Keep the URL in sync as the user clicks between tabs so deep-links
  // + the browser back button work.
  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    if (tab === 'broadcasts') next.delete('tab');
    else next.set('tab', tab);
    const qs = next.toString();
    router.replace(`/broadcasts${qs ? `?${qs}` : ''}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <>
      <PageHeader
        title="Templates & broadcasts"
        description="Build the WhatsApp templates that Meta approves, then use them to broadcast to a contact list or set up an automated sequence."
        actions={
          tab === 'broadcasts' ? (
            <Link href="/broadcasts/new">
              <Button>
                <Plus className="size-4" /> New broadcast
              </Button>
            </Link>
          ) : null
        }
      />

      {/* Three tabs:
            - Templates  : the Meta-approved message templates (was its
                           own /whatsapp/templates page; still resolves
                           there for back-compat).
            - Broadcasts : send-now / scheduled one-shot campaigns.
            - Sequences  : drip / multi-step flows.
          Segments tab removed earlier — audiences are driven by contact
          tags. SegmentsManager import is intentionally unused for the
          /segments redirect route until segments are fully removed. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="broadcasts">Broadcasts</TabsTrigger>
        </TabsList>

        <TabsContent value="templates">
          <TemplatesPage showHeader={false} />
        </TabsContent>

        <TabsContent value="broadcasts">
          <BroadcastsTab />
        </TabsContent>
      </Tabs>
    </>
  );
}

function BroadcastsTab() {
  const qc = useQueryClient();
  const router = useRouter();

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/broadcasts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success('Broadcast deleted');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: BroadcastDto }>(`/api/v1/broadcasts/${id}/resend`, {}),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success('Resend queued — sending to the same recipients.');
      router.push(`/broadcasts/${res.data.id}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Resend failed'),
  });

  // Resume = continue THIS broadcast: sends the recipients it skipped (e.g. when
  // the wallet ran out mid-send), after a top-up. Different from Resend (a clone).
  const resumeMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/broadcasts/${id}/resume`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success('Resumed — sending the remaining recipients.');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Resume failed'),
  });

  const broadcastsQuery = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () =>
      api.get<{ data: BroadcastDto[]; nextCursor: string | null }>('/api/v1/broadcasts'),
    refetchInterval: 5000, // live counters
  });

  const total = broadcastsQuery.data?.data.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {total} broadcast{total === 1 ? '' : 's'}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
              <tr>
                <th className="px-4 py-3 sm:px-6">Name</th>
                <th className="px-4 py-3 sm:px-6">Status</th>
                <th className="hidden px-6 py-3 lg:table-cell">Audience</th>
                <th className="hidden px-6 py-3 sm:table-cell">Sent / Delivered / Read</th>
                <th className="hidden px-6 py-3 lg:table-cell">Scheduled</th>
                <th className="hidden px-6 py-3 md:table-cell">Resend</th>
                <th className="w-16 px-4 py-3 sm:w-20 sm:px-6" />
              </tr>
            </thead>
            <tbody>
              {broadcastsQuery.isLoading ? (
                <tr>
                  <td colSpan={7} className="p-0">
                    <SkeletonRows rows={5} cols={5} />
                  </td>
                </tr>
              ) : null}
              {broadcastsQuery.data?.data.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-foreground-muted">
                    No broadcasts yet. Create your first one to start reaching customers.
                  </td>
                </tr>
              ) : null}
              {broadcastsQuery.data?.data.map((b) => (
                <tr key={b.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-4 font-medium sm:px-6">
                    <Link href={`/broadcasts/${b.id}`} className="hover:underline">
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-4 py-4 sm:px-6">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[b.status]}`}
                    >
                      {BROADCAST_STATUS_LABELS[b.status]}
                    </span>
                  </td>
                  <td className="hidden px-6 py-4 text-foreground-muted lg:table-cell">
                    {b.audienceKind === 'csv'
                      ? 'CSV'
                      : b.audienceKind === 'segment'
                        ? 'Segment'
                        : b.audienceKind === 'tags'
                          ? `Tags · ${b.audienceTags?.join(', ') ?? ''}${
                              (b.audienceTags?.length ?? 0) > 1
                                ? ` (${b.audienceTagsMode === 'all' ? 'all' : 'any'})`
                                : ''
                            }`
                          : 'Manual'}
                    {' · '}
                    <span className="font-mono text-xs">{b.totalRecipients}</span>
                  </td>
                  <td className="hidden px-6 py-4 font-mono text-sm text-foreground-muted sm:table-cell">
                    {b.sentCount} / {b.deliveredCount} / {b.readCount}
                    {b.respondedCount > 0 ? (
                      <span className="ml-2 font-sans text-emerald-600">
                        · {b.respondedCount} replied
                      </span>
                    ) : null}
                    {b.failedCount > 0 ? (
                      <span className="ml-2 text-red-600">· {b.failedCount} failed</span>
                    ) : null}
                  </td>
                  <td className="hidden px-6 py-4 text-foreground-muted lg:table-cell">
                    {b.scheduledFor
                      ? new Date(b.scheduledFor).toLocaleString()
                      : b.startedAt
                        ? new Date(b.startedAt).toLocaleString()
                        : '—'}
                  </td>
                  <td className="hidden px-6 py-4 md:table-cell">
                    {(() => {
                      // Resume = continue THIS broadcast, sending the recipients
                      // it skipped (e.g. wallet ran out). Resend = clone it.
                      // Resume only where the backend allows it (never on a
                      // completed / cancelled / failed broadcast).
                      const canResume =
                        ['paused', 'sending', 'scheduled'].includes(b.status) &&
                        (b.skippedCount > 0 || b.status === 'paused');
                      const canResend = ['completed', 'sending', 'paused', 'failed'].includes(
                        b.status,
                      );
                      if (!canResume && !canResend)
                        return <span className="text-xs text-foreground-subtle">—</span>;
                      return (
                        <div className="flex items-center gap-2">
                          {canResume ? (
                            <Button
                              size="sm"
                              disabled={resumeMutation.isPending && resumeMutation.variables === b.id}
                              onClick={() => resumeMutation.mutate(b.id)}
                              title={
                                b.skippedCount > 0
                                  ? `Send the ${b.skippedCount} skipped recipient${b.skippedCount === 1 ? '' : 's'} (e.g. when the wallet ran out).`
                                  : 'Resume sending.'
                              }
                            >
                              <Play
                                className={`size-3.5 ${
                                  resumeMutation.isPending && resumeMutation.variables === b.id
                                    ? 'animate-pulse'
                                    : ''
                                }`}
                              />
                              Resume
                              {b.skippedCount > 0 ? ` (${b.skippedCount.toLocaleString()})` : ''}
                            </Button>
                          ) : null}
                          {canResend ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={
                                resendMutation.isPending && resendMutation.variables === b.id
                              }
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Resend "${b.name}" to the same ${b.totalRecipients} recipient${b.totalRecipients === 1 ? '' : 's'}? This creates a new broadcast that starts sending immediately.`,
                                  )
                                ) {
                                  resendMutation.mutate(b.id);
                                }
                              }}
                            >
                              <RotateCw
                                className={`size-3.5 ${
                                  resendMutation.isPending && resendMutation.variables === b.id
                                    ? 'animate-spin'
                                    : ''
                                }`}
                              />
                              Resend
                            </Button>
                          ) : null}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link href={`/broadcasts/${b.id}`}>
                      <Button variant="ghost" size="sm">
                        Open
                      </Button>
                    </Link>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${b.name}`}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete "${b.name}"? Permanently removes the campaign + all recipient rows + timeline.`,
                          )
                        )
                          deleteMutation.mutate(b.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
