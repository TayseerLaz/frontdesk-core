'use client';

import {
  type ConnectorAuthKind,
  type ConnectorDto,
  IMPORT_ENTITY_KINDS,
  IMPORT_ENTITY_LABELS,
  type ImportEntityKind,
  type SyncRunDto,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Globe,
  PauseCircle,
  PlayCircle,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { WebsiteWizard } from '@/components/connectors/website-wizard';
import { PageHeader } from '@/components/shell/page-header';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';

const STATUS_VARIANT: Record<ConnectorDto['status'], 'success' | 'muted' | 'warning' | 'danger'> = {
  active: 'success',
  paused: 'muted',
  failing: 'warning',
  disabled: 'danger',
};

export default function ConnectorsPage() {
  const queryClient = useQueryClient();
  const { session } = useSession();
  // Opt-in (owner directive 2026-08-29): the wizard stays hidden until HQ
  // enables website_connector for this org. Three-valued — no flash.
  const wizardOn =
    !!session && !(session.organization?.disabledFeatures ?? []).includes('website_connector');
  const [createOpen, setCreateOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.get<{ data: ConnectorDto[] }>('/api/v1/connectors'),
  });

  const sync = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/connectors/${id}/sync`),
    onSuccess: () => {
      toast.success('Sync queued');
      if (activeId) queryClient.invalidateQueries({ queryKey: ['connector-runs', activeId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Sync failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/connectors/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      setActiveId(null);
      toast.success('Connector deleted');
    },
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      api.post<{
        data: {
          ok: boolean;
          status: number | null;
          error: string | null;
          recordCount: number | null;
          bodySample: string | null;
        };
      }>(`/api/v1/connectors/${id}/test`),
    onSuccess: (res) => {
      const d = res.data;
      if (d.ok) {
        const countMsg =
          d.recordCount == null
            ? 'response parsed but no records array found'
            : `${d.recordCount} record${d.recordCount === 1 ? '' : 's'} found`;
        toast.success(`Connected · ${countMsg}`);
      } else {
        toast.error(d.error ?? `HTTP ${d.status ?? '—'}`);
      }
    },
  });

  return (
    <>
      <PageHeader
        title="API connectors"
        description="Pull data from your existing systems on a schedule, or accept push via inbound webhooks."
        actions={
          <div className="flex gap-2">
            {wizardOn ? (
              <Button onClick={() => setWizardOpen(true)}>
                <Globe className="size-4" /> Connect your website
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New connector
            </Button>
          </div>
        }
      />

      <ConnectorsRollup connectors={list.data?.data ?? []} />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Connectors</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <SkeletonRows rows={5} cols={4} className="px-3 py-2" />
          ) : (list.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={PlugZap}
              title="No connectors yet"
              description="Connect your existing system (Shopify, WooCommerce, custom REST) to keep data in sync."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> New connector
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((c) => (
                <li key={c.id} className="px-6 py-4" data-testid={`connector-card-${c.id}`} data-connector-name={c.name}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{c.name}</p>
                        <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
                        <Badge variant="muted">{IMPORT_ENTITY_LABELS[c.entityKind]}</Badge>
                      </div>
                      <p className="mt-1 truncate text-xs text-foreground-subtle">
                        {c.endpointUrl ?? 'Webhook-only'}
                      </p>
                      <p className="mt-0.5 text-xs text-foreground-subtle">
                        {c.scheduleCron ? `Cron: ${c.scheduleCron}` : 'No schedule'} ·{' '}
                        {c.lastRunAt ? `last run ${formatRelative(c.lastRunAt)}` : 'never run'}
                      </p>
                      {c.webhookUrl ? (
                        <div className="mt-2 flex items-center gap-2">
                          <code className="truncate rounded bg-surface-muted px-2 py-0.5 font-mono text-xs">
                            {c.webhookUrl}
                          </code>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Copy webhook URL"
                            onClick={() => {
                              navigator.clipboard.writeText(c.webhookUrl!);
                              toast.success('Webhook URL copied');
                            }}
                          >
                            <Copy className="size-3.5" />
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex items-center gap-1">
                        {c.endpointUrl ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => test.mutate(c.id)}
                            loading={test.isPending}
                            data-testid="connector-test-btn"
                          >
                            <Activity className="size-4" /> Test
                          </Button>
                        ) : null}
                        {/* "Run now" pulls from the endpoint — only meaningful when
                            there IS one. Webhook-only connectors receive pushes instead. */}
                        {c.endpointUrl ? (
                          <Button size="sm" onClick={() => sync.mutate(c.id)} loading={sync.isPending}>
                            <PlayCircle className="size-4" /> Run now
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setActiveId(activeId === c.id ? null : c.id)}
                        >
                          <RefreshCw className="size-4" /> Runs
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Delete connector"
                          onClick={async () => {
                            if (
                              await confirmDialog({
                                title: `Delete "${c.name}"?`,
                                body: 'The connector and its sync history will be removed. This cannot be undone.',
                                confirmLabel: 'Delete',
                                destructive: true,
                              })
                            ) {
                              remove.mutate(c.id);
                            }
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  {activeId === c.id ? <RunHistory connectorId={c.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateConnectorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['connectors'] });
          setCreateOpen(false);
        }}
      />
      <WebsiteWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['connectors'] })}
      />
    </>
  );
}

function ConnectorsRollup({ connectors }: { connectors: ConnectorDto[] }) {
  if (connectors.length === 0) return null;

  const active = connectors.filter((c) => c.status === 'active').length;
  const failing = connectors.filter((c) => c.status === 'failing').length;
  const disabled = connectors.filter((c) => c.status === 'disabled').length;
  // `lastRunAt` is the most recent upstream poll across every connector —
  // gives operators one timestamp to scan for staleness instead of reading
  // each row below.
  const lastRunAt = connectors
    .map((c) => c.lastRunAt)
    .filter((d): d is string => !!d)
    .sort()
    .reverse()[0];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <RollupTile
        icon={CheckCircle2}
        label="Active"
        value={active}
        tone={active > 0 ? 'good' : 'muted'}
      />
      <RollupTile
        icon={AlertTriangle}
        label="Failing"
        value={failing}
        tone={failing > 0 ? 'warn' : 'muted'}
      />
      <RollupTile icon={PauseCircle} label="Disabled" value={disabled} tone="muted" />
      <RollupTile
        icon={Activity}
        label="Last sync"
        value={lastRunAt ? formatRelative(lastRunAt) : '—'}
        tone="muted"
      />
    </div>
  );
}

function RollupTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  tone: 'good' | 'warn' | 'muted';
}) {
  const colour =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : 'text-foreground';
  return (
    <Card>
      <CardContent className="flex items-start justify-between py-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            {label}
          </p>
          <p className={`mt-1 text-xl font-semibold ${colour}`}>{value}</p>
        </div>
        <Icon className="size-4 text-foreground-subtle" />
      </CardContent>
    </Card>
  );
}

function RunHistory({ connectorId }: { connectorId: string }) {
  const runs = useQuery({
    queryKey: ['connector-runs', connectorId],
    queryFn: () => api.get<{ data: SyncRunDto[] }>(`/api/v1/connectors/${connectorId}/runs?limit=50`),
    refetchInterval: 15_000,
  });
  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface-muted/30">
      {runs.isLoading ? (
        <SkeletonRows rows={3} cols={4} className="px-3 py-2" />
      ) : (runs.data?.data ?? []).length === 0 ? (
        <p className="px-4 py-4 text-center text-xs text-foreground-muted">No runs yet.</p>
      ) : (
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead className="bg-surface-muted text-foreground-subtle">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="hidden px-3 py-2 md:table-cell">Trigger</th>
              <th className="px-3 py-2">Status</th>
              <th className="hidden px-3 py-2 text-right lg:table-cell">Fetched</th>
              <th className="hidden px-3 py-2 text-right lg:table-cell">Upserted</th>
              <th className="hidden px-3 py-2 text-right sm:table-cell">Failed</th>
              <th className="hidden px-3 py-2 md:table-cell">Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.data?.data.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2">{formatRelative(r.startedAt ?? r.createdAt)}</td>
                <td className="hidden px-3 py-2 text-foreground-muted md:table-cell">{r.trigger}</td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      r.status === 'succeeded'
                        ? 'success'
                        : r.status === 'failed'
                          ? 'danger'
                          : r.status === 'partial'
                            ? 'warning'
                            : 'muted'
                    }
                  >
                    {r.status}
                  </Badge>
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums lg:table-cell">{r.recordsFetched}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums lg:table-cell">{r.recordsUpserted}</td>
                <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{r.recordsFailed}</td>
                <td className="hidden truncate px-3 py-2 text-foreground-subtle md:table-cell">{r.errorMessage ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}

function CreateConnectorDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState({
    name: '',
    entityKind: 'product' as ImportEntityKind,
    endpointUrl: '',
    authKind: 'none' as ConnectorAuthKind,
    bearerToken: '',
    apiKeyHeaderName: '',
    apiKeyValue: '',
    basicUser: '',
    basicPass: '',
    scheduleCron: '',
    enableInboundWebhook: false,
  });

  const create = useMutation({
    mutationFn: () => {
      const authConfig =
        draft.authKind === 'bearer'
          ? { kind: 'bearer' as const, token: draft.bearerToken }
          : draft.authKind === 'api_key'
            ? { kind: 'api_key' as const, headerName: draft.apiKeyHeaderName, value: draft.apiKeyValue }
            : draft.authKind === 'basic'
              ? { kind: 'basic' as const, username: draft.basicUser, password: draft.basicPass }
              : { kind: 'none' as const };
      return api.post('/api/v1/connectors', {
        name: draft.name,
        entityKind: draft.entityKind,
        endpointUrl: draft.endpointUrl || null,
        authKind: draft.authKind,
        authConfig: draft.authKind === 'none' ? undefined : authConfig,
        scheduleCron: draft.scheduleCron || null,
        enableInboundWebhook: draft.enableInboundWebhook,
      });
    },
    onSuccess: () => {
      toast.success('Connector created');
      onCreated();
      setDraft({
        name: '',
        entityKind: 'product',
        endpointUrl: '',
        authKind: 'none',
        bearerToken: '',
        apiKeyHeaderName: '',
        apiKeyValue: '',
        basicUser: '',
        basicPass: '',
        scheduleCron: '',
        enableInboundWebhook: false,
      });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New connector</DialogTitle>
          <DialogDescription>
            Pull from a REST endpoint, accept a push via inbound webhook, or both.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="conn-name">Name</Label>
              <Input id="conn-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-entity">Imports</Label>
              <Select
                value={draft.entityKind}
                onValueChange={(v) => setDraft({ ...draft, entityKind: v as ImportEntityKind })}
              >
                <SelectTrigger id="conn-entity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMPORT_ENTITY_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {IMPORT_ENTITY_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="conn-endpoint">Endpoint URL (leave empty for webhook-only)</Label>
            <Input
              id="conn-endpoint"
              value={draft.endpointUrl}
              placeholder="https://your-system.example/api/products"
              onChange={(e) => setDraft({ ...draft, endpointUrl: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="conn-auth">Auth</Label>
              <Select
                value={draft.authKind}
                onValueChange={(v) => setDraft({ ...draft, authKind: v as ConnectorAuthKind })}
              >
                <SelectTrigger id="conn-auth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bearer">Bearer token</SelectItem>
                  <SelectItem value="api_key">API key header</SelectItem>
                  <SelectItem value="basic">Basic auth</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conn-schedule">Schedule (cron)</Label>
              <Input
                id="conn-schedule"
                value={draft.scheduleCron}
                placeholder="*/15 * * * *"
                onChange={(e) => setDraft({ ...draft, scheduleCron: e.target.value })}
              />
            </div>
          </div>

          {draft.authKind === 'bearer' ? (
            <div className="space-y-1.5">
              <Label htmlFor="conn-bearer">Bearer token</Label>
              <Input
                id="conn-bearer"
                type="password"
                value={draft.bearerToken}
                onChange={(e) => setDraft({ ...draft, bearerToken: e.target.value })}
              />
            </div>
          ) : null}
          {draft.authKind === 'api_key' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="conn-api-header">Header name</Label>
                <Input
                  id="conn-api-header"
                  placeholder="X-API-Key"
                  value={draft.apiKeyHeaderName}
                  onChange={(e) => setDraft({ ...draft, apiKeyHeaderName: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conn-api-value">Header value</Label>
                <Input
                  id="conn-api-value"
                  type="password"
                  value={draft.apiKeyValue}
                  onChange={(e) => setDraft({ ...draft, apiKeyValue: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          {draft.authKind === 'basic' ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="conn-basic-user">Username</Label>
                <Input
                  id="conn-basic-user"
                  value={draft.basicUser}
                  onChange={(e) => setDraft({ ...draft, basicUser: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conn-basic-pass">Password</Label>
                <Input
                  id="conn-basic-pass"
                  type="password"
                  value={draft.basicPass}
                  onChange={(e) => setDraft({ ...draft, basicPass: e.target.value })}
                />
              </div>
            </div>
          ) : null}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enableInboundWebhook}
              onChange={(e) => setDraft({ ...draft, enableInboundWebhook: e.target.checked })}
              className="size-4 rounded border-border accent-brand-500"
            />
            Generate inbound webhook URL (for push integrations)
          </label>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            <X className="size-4" /> Cancel
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!draft.name}>
            <Check className="size-4" /> Create connector
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
