'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Filter } from 'lucide-react';
import { useState } from 'react';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface AdminAuditEntry {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  organizationSlug: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

const ENTITY_TYPES = [
  'product',
  'service',
  'category',
  'faq',
  'policy',
  'business_info',
  'asset',
  'import_job',
  'api_connector',
  'api_key',
  'webhook_endpoint',
  'user',
  'invitation',
];

const ACTION_LABELS: Record<string, string> = {
  integration_credentials_set: 'Integration credentials entered (tenant)',
  aligned_admin_accessed: 'ALIGNED HQ accessed workspace',
  aligned_admin_exited: 'ALIGNED HQ left workspace',
  contact_unsubscribed: 'Contact unsubscribed',
};
const humanAction = (s: string) =>
  ACTION_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Prefer a human subject (name/email captured in metadata) over the raw entity
// id, so member actions read "membership · John Doe" instead of "· 13ef2232".
function auditSubtitle(row: AdminAuditEntry): string {
  const m = row.metadata ?? {};
  const subject =
    (typeof m.subjectName === 'string' && m.subjectName) ||
    (typeof m.subjectEmail === 'string' && m.subjectEmail) ||
    (typeof m.email === 'string' && m.email) ||
    null;
  if (!row.entityType) return subject || '—';
  const tail = subject || (row.entityId ? row.entityId.slice(0, 8) : '');
  return tail ? `${row.entityType} · ${tail}` : row.entityType;
}

function toIsoStart(d: string): string | undefined {
  return d ? new Date(`${d}T00:00:00.000Z`).toISOString() : undefined;
}
function toIsoEnd(d: string): string | undefined {
  return d ? new Date(`${d}T23:59:59.999Z`).toISOString() : undefined;
}

export default function AdminAuditPage() {
  const [entityType, setEntityType] = useState('');
  const [actorEmail, setActorEmail] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (entityType) params.set('entityType', entityType);
  if (actorEmail) params.set('actorEmail', actorEmail);
  if (organizationId) params.set('organizationId', organizationId);
  const from = toIsoStart(fromDate);
  const to = toIsoEnd(toDate);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', '50');

  const list = useQuery({
    queryKey: ['admin-audit', entityType, actorEmail, organizationId, fromDate, toDate, cursor],
    queryFn: () =>
      api.get<{ data: AdminAuditEntry[]; nextCursor: string | null }>(
        `/api/v1/hq/audit-log?${params.toString()}`,
      ),
  });

  // Tenants for the "filter by tenant" dropdown (name → id).
  const orgsQ = useQuery({
    queryKey: ['admin-orgs-audit-filter'],
    queryFn: () =>
      api.get<{ data: { id: string; name: string; slug: string }[] }>('/api/v1/hq/orgs'),
    staleTime: 5 * 60_000,
  });
  const orgs = (orgsQ.data?.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  // When a tenant is chosen, load its members so the actor filter can pick a
  // specific user of that tenant. No tenant → the actor filter stays "all".
  const membersQ = useQuery({
    enabled: !!organizationId,
    queryKey: ['admin-org-members-audit', organizationId],
    queryFn: () =>
      api.get<{
        data: { members: { userId: string; email: string; firstName: string | null; lastName: string | null }[] };
      }>(`/api/v1/hq/orgs/${organizationId}`),
    staleTime: 60_000,
  });
  const members = organizationId ? (membersQ.data?.data.members ?? []) : [];

  const clearFilters = () => {
    setEntityType('');
    setActorEmail('');
    setOrganizationId('');
    setFromDate('');
    setToDate('');
    setCursor(null);
  };

  const rows = list.data?.data ?? [];

  return (
    <>
      <PageHeader
        backHref="/hq"
        backLabel="Tenants"
        title="Cross-tenant audit"
        description="Every audit event across every tenant. Gated by ALIGNED super-admin."
      />

      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="entityType">Entity</Label>
              <Select
                value={entityType || '__all__'}
                onValueChange={(v) => {
                  setCursor(null);
                  setEntityType(v === '__all__' ? '' : v);
                }}
              >
                <SelectTrigger id="entityType">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Any</SelectItem>
                  {ENTITY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {humanAction(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="orgId">Tenant</Label>
              <Select
                value={organizationId || '__all__'}
                onValueChange={(v) => {
                  setCursor(null);
                  setActorEmail(''); // the user list changes with the tenant — reset the actor
                  setOrganizationId(v === '__all__' ? '' : v);
                }}
              >
                <SelectTrigger id="orgId">
                  <SelectValue placeholder="All tenants" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All tenants</SelectItem>
                  {orgs.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="actor">User / actor</Label>
              <Select
                value={actorEmail || '__all__'}
                onValueChange={(v) => {
                  setCursor(null);
                  setActorEmail(v === '__all__' ? '' : v);
                }}
                disabled={!organizationId}
              >
                <SelectTrigger id="actor">
                  <SelectValue placeholder={organizationId ? 'All users' : 'All actors'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{organizationId ? 'All users' : 'All actors'}</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.userId} value={m.email}>
                      {`${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!organizationId ? (
                <p className="text-[11px] text-foreground-subtle">Pick a tenant to filter by a specific user.</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="from">From</Label>
              <Input
                id="from"
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setCursor(null);
                  setFromDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="date"
                value={toDate}
                onChange={(e) => {
                  setCursor(null);
                  setToDate(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-foreground-subtle">
              <Filter className="mr-1 inline size-3" /> {rows.length} event{rows.length === 1 ? '' : 's'} shown
            </p>
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardContent className="p-0">
          {list.isLoading ? (
            <SkeletonRows rows={6} cols={4} className="px-3 py-2" />
          ) : rows.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">No events match your filters.</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <AdminAuditRow key={row.id} row={row} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 flex justify-end gap-2">
        {cursor ? (
          <Button variant="secondary" size="sm" onClick={() => setCursor(null)}>
            Back to top
          </Button>
        ) : null}
        {list.data?.nextCursor ? (
          <Button variant="secondary" size="sm" onClick={() => setCursor(list.data?.nextCursor ?? null)}>
            Load older
          </Button>
        ) : null}
      </div>
    </>
  );
}

function AdminAuditRow({ row }: { row: AdminAuditEntry }) {
  const [open, setOpen] = useState(false);
  const hasMeta = row.metadata && Object.keys(row.metadata).length > 0;

  return (
    <li>
      <button
        type="button"
        onClick={() => hasMeta && setOpen((v) => !v)}
        aria-expanded={hasMeta ? open : undefined}
        disabled={!hasMeta}
        className="grid w-full grid-cols-[1.5fr_2fr_1.5fr_auto] items-center gap-3 px-6 py-3 text-left text-sm hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <div className="min-w-0">
          <p className="truncate font-semibold">{row.organizationName ?? '—'}</p>
          <p className="truncate text-xs text-foreground-subtle">
            {row.organizationSlug ?? row.organizationId?.slice(0, 8) ?? '—'}
          </p>
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium">{humanAction(row.action)}</p>
          <p className="truncate text-xs text-foreground-subtle">{auditSubtitle(row)}</p>
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium">{row.actorName ?? row.actorEmail ?? 'system'}</p>
          <p className="truncate text-xs text-foreground-subtle">{formatRelative(row.createdAt)}</p>
        </div>
        <div>
          {hasMeta ? (
            open ? (
              <ChevronDown className="size-4 text-foreground-subtle" />
            ) : (
              <ChevronRight className="size-4 text-foreground-subtle" />
            )
          ) : (
            <span className="inline-block size-4" />
          )}
        </div>
      </button>
      {open && hasMeta ? (
        <div className="border-t border-border bg-surface-muted/40 px-6 py-3">
          <pre className="overflow-x-auto rounded bg-surface p-3 text-xs">
            {JSON.stringify(row.metadata, null, 2)}
          </pre>
        </div>
      ) : null}
    </li>
  );
}
