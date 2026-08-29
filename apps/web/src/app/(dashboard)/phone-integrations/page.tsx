'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  Eye,
  EyeOff,
  Phone,
  PhoneCall,
  Plus,
  Power,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { SkeletonRows } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface PhoneLineRow {
  id: string;
  name: string;
  phoneNumber: string;
  isActive: boolean;
  botEnabled: boolean;
  keyPrefix: string | null;
  lastCallAt: string | null;
  callCount: number;
  createdAt: string;
}

interface VoiceCallRow {
  id: string;
  callUuid: string;
  callerId: string | null;
  dialedExten: string | null;
  outcome: 'in_progress' | 'completed' | 'handoff' | 'dropped';
  handoffReason: string | null;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
}

const OUTCOME_VARIANT: Record<VoiceCallRow['outcome'], 'muted' | 'success' | 'warning' | 'danger'> = {
  in_progress: 'warning',
  completed: 'success',
  handoff: 'muted',
  dropped: 'danger',
};

export default function PhoneIntegrationsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedSecret, setIssuedSecret] = useState<{ name: string; secret: string } | null>(null);
  const [openCallsId, setOpenCallsId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['phone-integrations'],
    queryFn: () => api.get<{ data: PhoneLineRow[] }>('/api/v1/phone-integrations'),
  });

  const toggle = useMutation({
    mutationFn: (line: PhoneLineRow) =>
      api.patch(`/api/v1/phone-integrations/${line.id}`, { isActive: !line.isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['phone-integrations'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  const toggleBot = useMutation({
    mutationFn: (line: PhoneLineRow) =>
      api.patch(`/api/v1/phone-integrations/${line.id}`, { botEnabled: !line.botEnabled }),
    onSuccess: (_res, line) => {
      queryClient.invalidateQueries({ queryKey: ['phone-integrations'] });
      toast.success(line.botEnabled ? 'AI bot turned off for this line' : 'AI bot turned on');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/phone-integrations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['phone-integrations'] });
      setOpenCallsId(null);
      toast.success('Phone line deleted');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  return (
    <>
      <PageHeader
        title="Phone integration"
        description="Connect phone numbers to your AI voicebot. The bot answers with your own business info, catalog, and FAQs — the phone bridge (Aseer-time) only carries the call."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New phone line
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Phone lines</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <SkeletonRows rows={5} cols={3} className="px-3 py-2" />
          ) : (list.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={Phone}
              title="No phone lines yet"
              description="Add the phone number callers dial. We issue a voice key and route the call to your AI bot."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> Add your first line
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((line) => (
                <li key={line.id} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{line.name}</p>
                        <Badge variant={line.isActive ? 'success' : 'muted'}>
                          {line.isActive ? 'Active' : 'Paused'}
                        </Badge>
                        {line.botEnabled ? null : <Badge variant="warning">AI bot off</Badge>}
                        {line.keyPrefix ? null : (
                          <Badge variant="danger">No key</Badge>
                        )}
                      </div>
                      <p className="mt-1 font-mono text-sm">{line.phoneNumber}</p>
                      <p className="mt-1 text-xs text-foreground-subtle">
                        {line.keyPrefix ? (
                          <span className="font-mono">{line.keyPrefix}… · </span>
                        ) : null}
                        {line.callCount} {line.callCount === 1 ? 'call' : 'calls'}
                        {line.lastCallAt ? ` · last ${formatRelative(line.lastCallAt)}` : ' · no calls yet'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <label className="mr-1 flex items-center gap-2 text-xs text-foreground-muted">
                        <span className="hidden sm:inline">AI bot</span>
                        <Switch
                          checked={line.botEnabled}
                          disabled={toggleBot.isPending && toggleBot.variables?.id === line.id}
                          onCheckedChange={() => toggleBot.mutate(line)}
                          aria-label={`AI bot for ${line.name}`}
                        />
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenCallsId(openCallsId === line.id ? null : line.id)}
                      >
                        <PhoneCall className="size-4" /> Calls
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={line.isActive ? 'Pause' : 'Activate'}
                        loading={toggle.isPending && toggle.variables?.id === line.id}
                        onClick={() => toggle.mutate(line)}
                      >
                        <Power className="size-4" /> {line.isActive ? 'Pause' : 'Activate'}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Delete"
                        onClick={async () => {
                          if (
                            await confirmDialog({
                              title: `Delete "${line.name}"?`,
                              body: 'The line and its voice key are removed (the key stops working immediately). Past call history is kept. This cannot be undone.',
                              confirmLabel: 'Delete line',
                              destructive: true,
                            })
                          ) {
                            remove.mutate(line.id);
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  {openCallsId === line.id ? <CallHistory phoneIntegrationId={line.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreatePhoneLineDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onIssued={(name, secret) => {
          setIssuedSecret({ name, secret });
          setCreateOpen(false);
          queryClient.invalidateQueries({ queryKey: ['phone-integrations'] });
        }}
      />

      <ShowSecretDialog secret={issuedSecret} onClose={() => setIssuedSecret(null)} />
    </>
  );
}

function CallHistory({ phoneIntegrationId }: { phoneIntegrationId: string }) {
  const calls = useQuery({
    queryKey: ['phone-line-calls', phoneIntegrationId],
    queryFn: () =>
      api.get<{ data: VoiceCallRow[] }>(
        `/api/v1/voice/calls?phoneIntegrationId=${phoneIntegrationId}&limit=50`,
      ),
    refetchInterval: 15_000,
  });

  const rows = calls.data?.data ?? [];

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-muted/40 p-3">
      {calls.isLoading ? (
        <SkeletonRows rows={3} cols={3} className="px-1 py-1" />
      ) : rows.length === 0 ? (
        <p className="py-2 text-center text-xs text-foreground-muted">No calls on this line yet.</p>
      ) : (
        <ul className="divide-y divide-border/60 text-xs">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant={OUTCOME_VARIANT[c.outcome]}>{c.outcome.replace('_', ' ')}</Badge>
                  <span className="font-mono">{c.callerId ?? 'unknown caller'}</span>
                </div>
                <p className="mt-0.5 text-foreground-subtle">
                  {formatRelative(c.startedAt)} · {c.turnCount} turns
                  {c.handoffReason ? ` · ${c.handoffReason}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreatePhoneLineDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onIssued: (name: string, secret: string) => void;
}) {
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: { secret: string } }>('/api/v1/phone-integrations', { name, phoneNumber }),
    onSuccess: (res) => {
      onIssued(name, res.data.secret);
      setName('');
      setPhoneNumber('');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a phone line</DialogTitle>
          <DialogDescription>
            Enter the number callers dial. We issue a voice key for this line — its secret is shown
            ONCE.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              placeholder="e.g. Main reception"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Phone number</Label>
            <Input
              placeholder="e.g. +961 1 234 567"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
            <p className="text-xs text-foreground-subtle">
              The dialed number this line answers. Spaces, dashes and a leading “+” are ignored when
              matching incoming calls.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={name.trim().length < 2 || phoneNumber.trim().length === 0}
            loading={create.isPending}
          >
            Add line
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
  secret: { name: string; secret: string } | null;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  if (!secret) return null;
  return (
    <Dialog open={!!secret} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save this voice key</DialogTitle>
          <DialogDescription>
            We'll never show it again. It's the credential the voicebot uses for this line
            (<code className="ml-1">X-Api-Key</code>). Share it with whoever configures the
            phone bridge.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border bg-surface-muted px-3 py-3 font-mono text-sm">
          <div className="flex items-center justify-between gap-2">
            <code className="break-all">
              {revealed ? secret.secret : '•'.repeat(secret.secret.length)}
            </code>
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
        <p className="text-xs text-foreground-subtle">
          Key for: <strong>{secret.name}</strong>
        </p>
        <DialogFooter>
          <Button onClick={onClose}>I've saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
