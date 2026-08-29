'use client';

// Phase 8 / 1.7 — ALIGNED-admin provenance suppression manager.
// Shows GLOBAL + per-org rows in one table, lets the admin manually
// add new ones, delete, or promote a per-org entry to global so every
// tenant benefits.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface SuppressionRow {
  id: string;
  phrase: string;
  note: string | null;
  scope: 'global' | 'org';
  organizationId: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  createdByEmail: string | null;
  createdByName: string | null;
  createdAt: string;
  matchesCount: number;
  lastMatchedAt: string | null;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
}

export default function SuppressionsPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<'all' | 'global' | 'org'>('all');
  const [filterOrg, setFilterOrg] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [newPhrase, setNewPhrase] = useState('');
  const [newScope, setNewScope] = useState<'global' | 'org'>('global');
  const [newOrgId, setNewOrgId] = useState<string>('');
  const [newNote, setNewNote] = useState('');

  const orgsQ = useQuery({
    queryKey: ['hq-orgs-min'],
    queryFn: () =>
      api.get<{ data: OrgRow[] }>('/api/v1/hq/orgs?status=active'),
    enabled: session?.user.isSuperAdmin === true,
    staleTime: 60_000,
  });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set('scope', scope);
    if (filterOrg !== 'all') p.set('organizationId', filterOrg);
    return p;
  }, [scope, filterOrg]);

  const listQ = useQuery({
    queryKey: ['suppressions', params.toString()],
    queryFn: () =>
      api.get<{ data: SuppressionRow[] }>(
        `/api/v1/hq/provenance/suppressions?${params.toString()}`,
      ),
    enabled: session?.user.isSuperAdmin === true,
  });

  const create = useMutation({
    mutationFn: (body: {
      phrase: string;
      scope: 'global' | 'org';
      organizationId?: string;
      note?: string;
    }) => api.post('/api/v1/hq/provenance/suppressions', body),
    onSuccess: () => {
      toast.success('Suppression added.');
      setNewPhrase('');
      setNewNote('');
      queryClient.invalidateQueries({ queryKey: ['suppressions'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Add failed.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/v1/hq/provenance/suppressions/${id}`),
    onSuccess: () => {
      toast.success('Removed.');
      queryClient.invalidateQueries({ queryKey: ['suppressions'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed.'),
  });

  const promote = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/hq/provenance/suppressions/${id}/promote-global`),
    onSuccess: () => {
      toast.success('Promoted to global. Every tenant now skips this phrase.');
      queryClient.invalidateQueries({ queryKey: ['suppressions'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Promote failed.'),
  });

  if (!session?.user.isSuperAdmin) {
    return (
      <>
        <PageHeader backHref="/hq/provenance" backLabel="Provenance" title="Suppression list" />
        <Card>
          <CardContent className="p-6 text-sm text-foreground-muted">
            ALIGNED admin role required.
          </CardContent>
        </Card>
      </>
    );
  }

  const orgs = orgsQ.data?.data ?? [];
  const rows = (listQ.data?.data ?? []).filter((r) =>
    search.trim()
      ? r.phrase.toLowerCase().includes(search.trim().toLowerCase()) ||
        (r.note ?? '').toLowerCase().includes(search.trim().toLowerCase())
      : true,
  );

  return (
    <>
      <PageHeader
        backHref="/hq/provenance"
        backLabel="Provenance"
        title="Hallucination suppressions"
        description="Phrases the scanner should NOT flag. Global rows apply to every tenant; per-org rows apply to one tenant only. Each ✓ Not a problem click in /inbox adds a row here automatically."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldOff className="size-4" /> Suppression list
            </CardTitle>
            <CardDescription className="text-xs">
              {listQ.isLoading ? (
                <Skeleton className="h-3.5 w-16" />
              ) : (
                `${rows.length} row${rows.length === 1 ? '' : 's'}`
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Select value={scope} onValueChange={(v) => setScope(v as never)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All scopes</SelectItem>
                  <SelectItem value="global">Global only</SelectItem>
                  <SelectItem value="org">Per-org only</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterOrg} onValueChange={(v) => setFilterOrg(v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Tenant" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tenants</SelectItem>
                  {orgs.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Search phrase / note…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 text-xs"
              />
            </div>

            {rows.length === 0 ? (
              <p className="text-sm text-foreground-muted">No matching rows.</p>
            ) : (
              <ul className="space-y-1.5">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-start justify-between gap-2 rounded border border-border bg-surface px-2 py-1.5 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <code className="rounded bg-surface-muted px-1 font-mono text-[11px]">
                          {row.phrase}
                        </code>
                        {row.scope === 'global' ? (
                          <Badge variant="muted" className="gap-1 text-[9px]">
                            <Globe className="size-2.5" /> Global
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[9px]">
                            {row.organizationName ?? 'org'}
                          </Badge>
                        )}
                      </div>
                      {row.note ? (
                        <p className="mt-0.5 text-[10px] italic text-foreground-muted">
                          {row.note}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-[10px] text-foreground-subtle">
                        Added {new Date(row.createdAt).toLocaleString()}
                        {row.createdByEmail
                          ? ` by ${row.createdByName ?? row.createdByEmail}`
                          : ''}
                        {row.matchesCount > 0 ? ` · ${row.matchesCount} suppressed` : ''}
                      </p>
                    </div>
                    <div className="flex flex-shrink-0 gap-1">
                      {row.scope === 'org' ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-6 px-1.5 text-[10px]"
                          onClick={() => promote.mutate(row.id)}
                          disabled={promote.isPending}
                          title="Promote to global — every tenant will then skip this phrase"
                        >
                          <Globe className="size-3" />
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        className="h-6 px-1.5 text-[10px]"
                        onClick={() => remove.mutate(row.id)}
                        disabled={remove.isPending}
                        title="Remove"
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Plus className="size-4" /> Add manually
            </CardTitle>
            <CardDescription className="text-xs">
              Most rows are added automatically when an admin clicks "Not a problem" on a
              hallucination in the inbox. Use this form to seed phrases proactively.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input
              placeholder="Phrase (e.g. Subtotal)"
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
              className="h-8 text-sm"
            />
            <Select value={newScope} onValueChange={(v) => setNewScope(v as never)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global — every tenant</SelectItem>
                <SelectItem value="org">One tenant only</SelectItem>
              </SelectContent>
            </Select>
            {newScope === 'org' ? (
              <Select value={newOrgId} onValueChange={(v) => setNewOrgId(v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Pick a tenant" />
                </SelectTrigger>
                <SelectContent>
                  {orgs.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Input
              placeholder="Note (optional)"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              className="h-8 text-sm"
            />
            <Button
              type="button"
              className="w-full"
              size="sm"
              onClick={() =>
                create.mutate({
                  phrase: newPhrase.trim(),
                  scope: newScope,
                  organizationId: newScope === 'org' ? newOrgId : undefined,
                  note: newNote.trim() || undefined,
                })
              }
              disabled={
                create.isPending ||
                newPhrase.trim().length === 0 ||
                (newScope === 'org' && newOrgId.length === 0)
              }
            >
              Add suppression
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
