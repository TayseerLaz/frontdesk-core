'use client';

import {
  CONTACT_SOURCES,
  type SegmentClause,
  type SegmentDto,
  type SegmentFilter,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';

const FIELD_OPTIONS = [
  { value: 'tag', label: 'Tag' },
  { value: 'attribute', label: 'Attribute' },
  { value: 'locale', label: 'Locale' },
  { value: 'last_inbound_at', label: 'Last inbound (days)' },
  { value: 'source', label: 'Source' },
] as const;

const EMPTY_CLAUSE: SegmentClause = {
  field: 'tag',
  op: 'in',
  value: [],
};

// Reusable segments management component. Lives outside the routes
// directory so both the standalone /segments redirect-shim and the
// /broadcasts tabs can mount it.
//
// Props:
//   showHeader — when false, the embedded PageHeader is suppressed
//     (the outer page already renders a header). Defaults to true so
//     direct rendering at /segments stays unchanged.
export default function SegmentsManager({ showHeader = true }: { showHeader?: boolean } = {}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SegmentDto | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const segmentsQuery = useQuery({
    queryKey: ['segments'],
    queryFn: () => api.get<{ data: SegmentDto[] }>('/api/v1/segments'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/segments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['segments'] });
      toast.success('Segment deleted');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  return (
    <>
      {showHeader ? (
        <PageHeader
          title="Segments"
          description="Saved contact filters. Use these to target broadcasts."
          actions={
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="size-4" /> New segment
            </Button>
          }
        />
      ) : (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="size-4" /> New segment
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{segmentsQuery.data?.data.length ?? 0} segments</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-6 py-3">Name</th>
                  <th className="px-6 py-3">Description</th>
                  <th className="px-6 py-3">Contacts</th>
                  <th className="px-6 py-3">Updated</th>
                  <th className="w-24 px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {segmentsQuery.isLoading ? (
                  <tr>
                    <td colSpan={5} className="p-0">
                      <SkeletonRows rows={5} cols={4} />
                    </td>
                  </tr>
                ) : null}
                {segmentsQuery.data?.data.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-foreground-muted">
                      No segments yet. Create one to start targeting broadcasts.
                    </td>
                  </tr>
                ) : null}
                {segmentsQuery.data?.data.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="px-6 py-4 font-medium">{s.name}</td>
                    <td className="px-6 py-4 text-foreground-muted">{s.description ?? '—'}</td>
                    <td className="px-6 py-4 font-mono text-sm">{s.contactCount ?? '—'}</td>
                    <td className="px-6 py-4 text-foreground-muted">
                      {new Date(s.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                        Edit
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                          if (window.confirm(`Delete "${s.name}"?`)) deleteMutation.mutate(s.id);
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

      <SegmentEditorDialog
        open={newOpen || editing !== null}
        existing={editing}
        onOpenChange={(v) => {
          if (!v) {
            setNewOpen(false);
            setEditing(null);
          }
        }}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['segments'] });
          setNewOpen(false);
          setEditing(null);
        }}
      />
    </>
  );
}

// ---------- editor ---------------------------------------------------------
function SegmentEditorDialog({
  open,
  existing,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  existing: SegmentDto | null;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'all' | 'any'>('all');
  const [clauses, setClauses] = useState<SegmentClause[]>([EMPTY_CLAUSE]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description ?? '');
      setMode(existing.filter.mode);
      setClauses(existing.filter.clauses.length > 0 ? existing.filter.clauses : [EMPTY_CLAUSE]);
    } else {
      setName('');
      setDescription('');
      setMode('all');
      setClauses([EMPTY_CLAUSE]);
    }
  }, [existing, open]);

  const filter: SegmentFilter = useMemo(
    () => ({ mode, clauses: clauses.filter((c) => clauseIsValid(c)) }),
    [mode, clauses],
  );

  const previewQuery = useQuery({
    queryKey: ['segment-preview', filter],
    queryFn: () =>
      api.post<{ data: { count: number } }>('/api/v1/segments/preview', { filter }),
    enabled: open && filter.clauses.length > 0,
  });

  const submit = async () => {
    setSubmitting(true);
    try {
      const body = { name, description: description || null, filter };
      if (existing) {
        await api.patch(`/api/v1/segments/${existing.id}`, body);
        toast.success('Segment updated');
      } else {
        await api.post('/api/v1/segments', body);
        toast.success('Segment created');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const updateClause = (idx: number, patch: Partial<SegmentClause>) => {
    setClauses((prev) =>
      prev.map((c, i) => (i === idx ? mergeClause(c, patch) : c)),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit segment' : 'New segment'}</DialogTitle>
          <DialogDescription>
            Build a filter over your contacts. Live count below; this is what a broadcast targeting
            this segment would reach.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="seg-name">Name</Label>
            <Input
              id="seg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="VIP Austin customers"
            />
          </div>
          <div>
            <Label htmlFor="seg-desc">Description</Label>
            <Input
              id="seg-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="rounded border border-border p-4">
          <div className="mb-3 flex items-center gap-3 text-sm">
            <span>Match</span>
            <Select value={mode} onValueChange={(v) => setMode(v as 'all' | 'any')}>
              <SelectTrigger className="h-8 w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all</SelectItem>
                <SelectItem value="any">any</SelectItem>
              </SelectContent>
            </Select>
            <span>of the following:</span>
          </div>
          <div className="space-y-2">
            {clauses.map((c, idx) => (
              <ClauseRow
                key={idx}
                clause={c}
                onChange={(patch) => updateClause(idx, patch)}
                onRemove={() =>
                  setClauses((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))
                }
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => setClauses((prev) => [...prev, EMPTY_CLAUSE])}
          >
            <Plus className="size-4" /> Add condition
          </Button>
        </div>

        <div className="rounded bg-surface-muted p-3 text-sm">
          {filter.clauses.length === 0 ? (
            <span className="text-foreground-subtle">Add a condition to see the preview…</span>
          ) : previewQuery.isLoading ? (
            <span className="text-foreground-subtle">Counting…</span>
          ) : previewQuery.data ? (
            <span>
              <strong>{previewQuery.data.data.count.toLocaleString()}</strong> matching contact
              {previewQuery.data.data.count === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !name || filter.clauses.length === 0}>
            {submitting ? 'Saving…' : existing ? 'Save changes' : 'Create segment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClauseRow({
  clause,
  onChange,
  onRemove,
}: {
  clause: SegmentClause;
  onChange: (patch: Partial<SegmentClause>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Select
        value={clause.field}
        onValueChange={(v) => onChange(defaultClauseFor(v as SegmentClause['field']))}
      >
        <SelectTrigger className="h-9 w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELD_OPTIONS.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {clause.field === 'tag' ? (
        <>
          <Select value={clause.op} onValueChange={(v) => onChange({ op: v as 'in' | 'not_in' })}>
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="in">in</SelectItem>
              <SelectItem value="not_in">not in</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={clause.value.join(', ')}
            onChange={(e) =>
              onChange({
                value: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            placeholder="vip, austin"
            className="flex-1"
          />
        </>
      ) : null}

      {clause.field === 'attribute' ? (
        <>
          <Input
            value={clause.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder="key (e.g. loyalty_tier)"
            className="w-44"
          />
          <Select
            value={clause.op}
            onValueChange={(v) => onChange({ op: v as 'eq' | 'neq' | 'contains' })}
          >
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eq">equals</SelectItem>
              <SelectItem value="neq">not equals</SelectItem>
              <SelectItem value="contains">contains</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={clause.value}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="value"
            className="flex-1"
          />
        </>
      ) : null}

      {clause.field === 'locale' ? (
        <>
          <Select value={clause.op} onValueChange={(v) => onChange({ op: v as 'eq' | 'neq' })}>
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eq">equals</SelectItem>
              <SelectItem value="neq">not equals</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={clause.value}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder="en, en_US"
            className="flex-1"
          />
        </>
      ) : null}

      {clause.field === 'last_inbound_at' ? (
        <>
          <Select
            value={clause.op}
            onValueChange={(v) => onChange({ op: v as 'within_days' | 'not_within_days' })}
          >
            <SelectTrigger className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="within_days">within last (days)</SelectItem>
              <SelectItem value="not_within_days">NOT within last (days)</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="number"
            value={clause.value}
            onChange={(e) => onChange({ value: Number(e.target.value || 0) })}
            className="w-24"
          />
        </>
      ) : null}

      {clause.field === 'source' ? (
        <>
          <Select value={clause.op} onValueChange={(v) => onChange({ op: v as 'eq' | 'neq' })}>
            <SelectTrigger className="h-9 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eq">equals</SelectItem>
              <SelectItem value="neq">not equals</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={clause.value}
            onValueChange={(v) => onChange({ value: v as (typeof CONTACT_SOURCES)[number] })}
          >
            <SelectTrigger className="h-9 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      ) : null}

      <Button size="icon" variant="ghost" onClick={onRemove}>
        <X className="size-4" />
      </Button>
    </div>
  );
}

// ---------- helpers --------------------------------------------------------
function defaultClauseFor(field: SegmentClause['field']): SegmentClause {
  switch (field) {
    case 'tag':
      return { field: 'tag', op: 'in', value: [] };
    case 'attribute':
      return { field: 'attribute', key: '', op: 'eq', value: '' };
    case 'locale':
      return { field: 'locale', op: 'eq', value: '' };
    case 'last_inbound_at':
      return { field: 'last_inbound_at', op: 'within_days', value: 30 };
    case 'source':
      return { field: 'source', op: 'eq', value: 'manual' };
  }
}

function mergeClause(c: SegmentClause, patch: Partial<SegmentClause>): SegmentClause {
  // Type-narrowed merge: TS can't see through Partial<discriminated union>.
  return { ...c, ...patch } as SegmentClause;
}

function clauseIsValid(c: SegmentClause): boolean {
  switch (c.field) {
    case 'tag':
      return c.value.length > 0;
    case 'attribute':
      return c.key.length > 0 && c.value.length > 0;
    case 'locale':
      return c.value.length > 0;
    case 'last_inbound_at':
      return c.value > 0;
    case 'source':
      return Boolean(c.value);
  }
}
