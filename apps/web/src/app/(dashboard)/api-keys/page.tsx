'use client';

import { apiKeyScopes, type ApiKeyScope } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedSecret, setIssuedSecret] = useState<{ name: string; secret: string } | null>(null);

  const list = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<{ data: ApiKeyRow[] }>('/api/v1/api-keys'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/api-keys/${id}/revoke`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('API key revoked');
    },
  });

  return (
    <>
      <PageHeader
        title="API keys"
        description="Issue keys for the chatbot read API. Each key is scoped to this organization."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New API key
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Active keys</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <SkeletonRows rows={5} cols={3} className="px-3 py-2" />
          ) : (list.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No API keys yet"
              description="Issue a key so the WhatsApp chatbot can read your catalog."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> Issue your first key
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((k) => (
                <li key={k.id} className="flex items-start justify-between gap-3 px-6 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{k.name}</p>
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="muted">
                          {s}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-1 font-mono text-xs text-foreground-subtle">
                      {k.prefix}
                      <span className="ml-1 text-foreground-subtle">… (full secret only shown on create)</span>
                    </p>
                    <p className="mt-1 text-xs text-foreground-subtle">
                      created {formatRelative(k.createdAt)} ·{' '}
                      {k.lastUsedAt ? `last used ${formatRelative(k.lastUsedAt)}` : 'never used'}
                      {k.expiresAt ? ` · expires ${formatRelative(k.expiresAt)}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Revoke"
                    onClick={async () => {
                      if (
                        await confirmDialog({
                          title: `Revoke "${k.name}"?`,
                          body: 'Any chatbot or script using this key will start returning 401 immediately. You cannot undo this.',
                          confirmLabel: 'Revoke key',
                          destructive: true,
                        })
                      ) {
                        revoke.mutate(k.id);
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onIssued={(name, secret) => {
          setIssuedSecret({ name, secret });
          setCreateOpen(false);
          queryClient.invalidateQueries({ queryKey: ['api-keys'] });
        }}
      />

      <ShowSecretDialog
        secret={issuedSecret}
        onClose={() => setIssuedSecret(null)}
      />
    </>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onIssued: (name: string, secret: string) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['read:catalog', 'read:business-info', 'read:faqs']);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: { secret: string } }>('/api/v1/api-keys', { name, scopes }),
    onSuccess: (res) => {
      onIssued(name, res.data.secret);
      setName('');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  const toggleScope = (s: ApiKeyScope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue an API key</DialogTitle>
          <DialogDescription>
            The secret is shown ONCE. Copy it into the chatbot configuration immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              placeholder="e.g. WhatsApp production bot"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Scopes</Label>
            <div className="space-y-2">
              {apiKeyScopes.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={() => toggleScope(s)}
                    className="size-4 rounded border-border accent-brand-500"
                  />
                  <code className="text-xs">{s}</code>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!name || scopes.length === 0} loading={create.isPending}>
            Issue key
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
          <DialogTitle>Save this secret</DialogTitle>
          <DialogDescription>
            We'll never show it again. Store it in your chatbot's configuration as
            <code className="ml-1">X-Api-Key</code>.
          </DialogDescription>
        </DialogHeader>
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
