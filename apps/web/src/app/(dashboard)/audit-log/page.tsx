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
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface AuditEntry {
  id: string;
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
  aligned_admin_accessed: 'ALIGNED HQ accessed your workspace',
  aligned_admin_exited: 'ALIGNED HQ left your workspace',
  contact_unsubscribed: 'Contact unsubscribed',
};
const humanAction = (s: string) =>
  ACTION_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Prefer a human subject (name/email captured in metadata) over the raw entity
// id, so member actions read "membership · John Doe" instead of "· 13ef2232".
function auditSubtitle(row: AuditEntry): string {
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

function toIsoStart(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  return new Date(`${dateStr}T00:00:00.000Z`).toISOString();
}
function toIsoEnd(dateStr: string): string | undefined {
  if (!dateStr) return undefined;
  return new Date(`${dateStr}T23:59:59.999Z`).toISOString();
}

export default function AuditLogPage() {
  const [entityType, setEntityType] = useState<string>('');
  const [actorEmail, setActorEmail] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (entityType) params.set('entityType', entityType);
  if (actorEmail) params.set('actorEmail', actorEmail);
  const from = toIsoStart(fromDate);
  const to = toIsoEnd(toDate);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (cursor) params.set('cursor', cursor);
  params.set('limit', '50');

  const list = useQuery({
    queryKey: ['audit-log', entityType, actorEmail, fromDate, toDate, cursor],
    queryFn: () =>
      api.get<{ data: AuditEntry[]; nextCursor: string | null }>(`/api/v1/audit-log?${params.toString()}`),
  });

  const clearFilters = () => {
    setEntityType('');
    setActorEmail('');
    setFromDate('');
    setToDate('');
    setCursor(null);
  };

  const rows = list.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Activity log"
        description="Every meaningful change in your organization, with who did it and when."
      />

      <Card>
        <CardContent className="space-y-4 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
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
              <Label htmlFor="actorEmail">Actor email contains</Label>
              <Input
                id="actorEmail"
                value={actorEmail}
                placeholder="e.g. jane@"
                onChange={(e) => {
                  setCursor(null);
                  setActorEmail(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fromDate">From</Label>
              <Input
                id="fromDate"
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setCursor(null);
                  setFromDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="toDate">To</Label>
              <Input
                id="toDate"
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
            <ul className="divide-y divide-border">
              {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="flex items-center justify-between gap-3 px-6 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Skeleton className="size-4 shrink-0" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-28" />
                    </div>
                  </div>
                  <div className="space-y-1.5 text-right">
                    <Skeleton className="ml-auto h-3.5 w-24" />
                    <Skeleton className="ml-auto h-3 w-16" />
                  </div>
                </li>
              ))}
            </ul>
          ) : rows.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">
              No activity matches your filters.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <AuditRow key={row.id} row={row} />
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCursor(list.data?.nextCursor ?? null)}
          >
            Load older
          </Button>
        ) : null}
      </div>
    </>
  );
}

function AuditRow({ row }: { row: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const hasMeta = row.metadata && Object.keys(row.metadata).length > 0;

  return (
    <li>
      <button
        type="button"
        onClick={() => hasMeta && setOpen((v) => !v)}
        aria-expanded={hasMeta ? open : undefined}
        disabled={!hasMeta}
        className="flex w-full items-center justify-between gap-3 px-6 py-3 text-left text-sm hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <div className="flex min-w-0 items-center gap-3">
          {hasMeta ? (
            open ? (
              <ChevronDown className="size-4 shrink-0 text-foreground-subtle" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-foreground-subtle" />
            )
          ) : (
            <span className="inline-block size-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{humanAction(row.action)}</p>
            <p className="truncate text-xs text-foreground-subtle">{auditSubtitle(row)}</p>
          </div>
        </div>
        <div className="text-right text-xs">
          <p className="truncate font-medium">{row.actorName ?? row.actorEmail ?? 'system'}</p>
          <p className="text-foreground-subtle">{formatRelative(row.createdAt)}</p>
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
