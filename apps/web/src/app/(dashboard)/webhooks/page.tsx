'use client';

import {
  WEBHOOK_EVENT_KINDS,
  type WebhookDeliveryDto,
  type WebhookEndpointDto,
  type WebhookEventKind,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Plus,
  RotateCw,
  Trash2,
  Webhook,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
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
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';

export default function WebhooksPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedSecret, setIssuedSecret] = useState<{ url: string; secret: string } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['webhook-endpoints'],
    queryFn: () => api.get<{ data: WebhookEndpointDto[] }>('/api/v1/webhook-endpoints'),
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; isActive: boolean }) =>
      api.patch(`/api/v1/webhook-endpoints/${vars.id}`, { isActive: vars.isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/webhook-endpoints/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
      setActiveId(null);
      toast.success('Endpoint deleted');
    },
  });

  return (
    <>
      <PageHeader
        title="Outbound webhooks"
        description="Notify your systems when catalog data changes. HMAC-signed, retried with exponential backoff."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New endpoint
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Endpoints</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <SkeletonRows rows={5} cols={4} className="px-3 py-2" />
          ) : (list.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={Webhook}
              title="No endpoints yet"
              description="Add a webhook so your chatbot or downstream systems learn about catalog changes in real time."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> Add an endpoint
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((e) => (
                <li key={e.id} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="break-all rounded bg-surface-muted px-2 py-0.5 font-mono text-xs">
                          {e.url}
                        </code>
                        <Badge variant={e.isActive ? 'success' : 'muted'}>
                          {e.isActive ? 'active' : 'paused'}
                        </Badge>
                        {e.consecutiveFailures > 0 ? (
                          <Badge variant="warning">{e.consecutiveFailures} fails in a row</Badge>
                        ) : null}
                      </div>
                      {e.description ? (
                        <p className="mt-1 text-xs text-foreground-muted">{e.description}</p>
                      ) : null}
                      <p className="mt-1 text-xs text-foreground-subtle">
                        events: {e.eventKinds.length === 0 ? 'all' : e.eventKinds.join(', ')} ·{' '}
                        {e.lastDeliveryAt ? `last delivery ${formatRelative(e.lastDeliveryAt)}` : 'no deliveries yet'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setActiveId(activeId === e.id ? null : e.id)}
                      >
                        <Activity className="size-4" /> Deliveries
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => toggle.mutate({ id: e.id, isActive: !e.isActive })}
                      >
                        {e.isActive ? 'Pause' : 'Resume'}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Delete"
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              title: 'Delete this webhook endpoint?',
                              body: 'Queued deliveries to this endpoint will be dropped. This cannot be undone.',
                              confirmLabel: 'Delete endpoint',
                              destructive: true,
                            })
                          ) {
                            remove.mutate(e.id);
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  {activeId === e.id ? <DeliveryHistory endpointId={e.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateEndpointDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onIssued={(url, secret) => {
          setIssuedSecret({ url, secret });
          setCreateOpen(false);
          queryClient.invalidateQueries({ queryKey: ['webhook-endpoints'] });
        }}
      />
      <ShowSecretDialog secret={issuedSecret} onClose={() => setIssuedSecret(null)} />
    </>
  );
}

function DeliveryHistory({ endpointId }: { endpointId: string }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ['webhook-deliveries', endpointId],
    queryFn: () =>
      api.get<{ data: WebhookDeliveryDto[] }>(`/api/v1/webhook-endpoints/${endpointId}/deliveries`),
    refetchInterval: 15_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/webhook-deliveries/${id}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-deliveries', endpointId] });
      toast.success('Re-enqueued');
    },
  });

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface-muted/30">
      {list.isLoading ? (
        <SkeletonRows rows={3} cols={4} className="px-3 py-2" />
      ) : (list.data?.data ?? []).length === 0 ? (
        <p className="px-4 py-4 text-center text-xs text-foreground-muted">No deliveries yet.</p>
      ) : (
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead className="bg-surface-muted text-foreground-subtle">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="hidden px-3 py-2 md:table-cell">Event</th>
              <th className="px-3 py-2">Status</th>
              <th className="hidden px-3 py-2 sm:table-cell">HTTP</th>
              <th className="hidden px-3 py-2 sm:table-cell">Attempts</th>
              <th className="hidden px-3 py-2 lg:table-cell">Error</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.data.map((d) => (
              <tr key={d.id} className="border-t border-border">
                <td className="px-3 py-2">{formatRelative(d.attemptedAt ?? d.createdAt)}</td>
                <td className="hidden px-3 py-2 font-mono text-[11px] md:table-cell">{d.eventKind}</td>
                <td className="px-3 py-2">
                  {d.status === 'delivered' ? (
                    <Badge variant="success">
                      <CheckCircle2 className="mr-1 size-3" /> delivered
                    </Badge>
                  ) : d.status === 'giving_up' || d.status === 'failed' ? (
                    <Badge variant="danger">
                      <XCircle className="mr-1 size-3" /> {d.status}
                    </Badge>
                  ) : (
                    <Badge variant="muted">{d.status}</Badge>
                  )}
                </td>
                <td className="hidden px-3 py-2 tabular-nums sm:table-cell">{d.responseStatus ?? '—'}</td>
                <td className="hidden px-3 py-2 tabular-nums sm:table-cell">{d.attempts}</td>
                <td className="hidden truncate px-3 py-2 text-foreground-subtle lg:table-cell">{d.errorMessage ?? '—'}</td>
                <td className="px-3 py-2 text-right">
                  {d.status !== 'delivered' ? (
                    <Button size="icon" variant="ghost" aria-label="Retry" onClick={() => retry.mutate(d.id)}>
                      <RotateCw className="size-4" />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

function CreateEndpointDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onIssued: (url: string, secret: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [eventKinds, setEventKinds] = useState<WebhookEventKind[]>([]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: { url: string; signingSecret: string } }>('/api/v1/webhook-endpoints', {
        url,
        description: description || undefined,
        eventKinds,
      }),
    onSuccess: (res) => {
      onIssued(res.data.url, res.data.signingSecret);
      setUrl('');
      setDescription('');
      setEventKinds([]);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  const toggle = (k: WebhookEventKind) =>
    setEventKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New webhook endpoint</DialogTitle>
          <DialogDescription>
            Leave events empty to subscribe to all. The signing secret is shown ONCE on creation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>URL</Label>
            <Input
              placeholder="https://your-system.example/webhook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Events (leave empty for all)</Label>
            <div className="grid grid-cols-2 gap-1.5 text-xs">
              {WEBHOOK_EVENT_KINDS.map((k) => (
                <label key={k} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={eventKinds.includes(k)}
                    onChange={() => toggle(k)}
                    className="size-3.5 rounded border-border accent-brand-500"
                  />
                  <code>{k}</code>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!url} loading={create.isPending}>
            Create endpoint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShowSecretDialog({
  secret,
  onClose,
}: {
  secret: { url: string; secret: string } | null;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  if (!secret) return null;
  return (
    <Dialog open={!!secret} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save this signing secret</DialogTitle>
          <DialogDescription>
            We'll never show it again. Verify each delivery using HMAC-SHA256:
            <code className="ml-1">sha256(secret, timestamp + "." + body)</code>.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-foreground-subtle">
          Endpoint: <code className="break-all">{secret.url}</code>
        </p>
        <div className="rounded-md border border-border bg-surface-muted px-3 py-3 font-mono text-sm">
          <div className="flex items-center justify-between gap-2">
            <code className="break-all">{revealed ? secret.secret : '•'.repeat(secret.secret.length)}</code>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Toggle reveal"
                onClick={() => setRevealed((v) => !v)}
              >
                {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Copy"
                onClick={() => {
                  navigator.clipboard.writeText(secret.secret);
                  toast.success('Copied');
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I've saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
