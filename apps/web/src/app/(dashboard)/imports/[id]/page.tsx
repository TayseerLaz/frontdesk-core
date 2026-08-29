'use client';

import {
  IMPORT_ENTITY_LABELS,
  type ImportJobDto,
  type ImportJobRowDto,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RotateCw,
  Save,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';

export default function ImportDetailPage() {
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [showFailedOnly, setShowFailedOnly] = useState(true);

  const job = useQuery({
    queryKey: ['import', params.id],
    queryFn: () => api.get<{ data: ImportJobDto }>(`/api/v1/imports/${params.id}`),
    refetchInterval: (q) => {
      const status = q.state.data?.data.status;
      return status === 'processing' || status === 'pending' || status === 'validating' ? 2000 : false;
    },
  });

  const rows = useQuery({
    queryKey: ['import-rows', params.id, showFailedOnly],
    queryFn: () =>
      api.get<{ data: ImportJobRowDto[] }>(
        `/api/v1/imports/${params.id}/rows?limit=200${showFailedOnly ? '&status=failed' : ''}`,
      ),
    refetchInterval: () => {
      const status = job.data?.data.status;
      return status === 'processing' || status === 'pending' || status === 'validating' ? 5000 : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post(`/api/v1/imports/${params.id}/cancel`),
    onSuccess: () => {
      toast.success('Cancellation requested');
      queryClient.invalidateQueries({ queryKey: ['import', params.id] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Cancel failed'),
  });

  if (job.isLoading || !job.data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    );
  }
  const j = job.data.data;
  const inProgress = ['pending', 'validating', 'processing'].includes(j.status);
  const pct = j.totalRows > 0 ? Math.round((j.processedRows / j.totalRows) * 100) : inProgress ? null : 100;

  return (
    <>
      <PageHeader
        title={`${IMPORT_ENTITY_LABELS[j.entityKind]} import`}
        description={
          <span className="text-xs text-foreground-subtle">
            {j.sourceFilename ?? '—'} · started {formatRelative(j.startedAt ?? j.createdAt)}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/imports">
                <ArrowLeft className="size-4" /> Back
              </Link>
            </Button>
            {inProgress ? (
              <Button variant="danger" onClick={() => cancelMutation.mutate()} loading={cancelMutation.isPending}>
                <Ban className="size-4" /> Cancel
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Total rows" value={j.totalRows} />
        <StatCard label="Succeeded" value={j.succeededRows} accent="emerald" />
        <StatCard label="Failed" value={j.failedRows} accent={j.failedRows > 0 ? 'red' : undefined} />
        <StatCard label="Progress" value={pct === null ? '—' : `${pct}%`} />
      </div>

      {inProgress && pct !== null ? (
        <Card className="mt-6">
          <CardContent className="flex items-center gap-3 py-4">
            <Loader2 className="size-4 animate-spin text-brand-500" />
            <div
              role="progressbar"
              aria-label={`Import progress: ${pct}%`}
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted"
            >
              <div className="h-full bg-brand-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-sm font-medium tabular-nums">{pct}%</span>
          </CardContent>
        </Card>
      ) : null}

      {j.errorMessage ? (
        <Card className="mt-6 border-red-200 bg-red-50/30">
          <CardHeader>
            <CardTitle className="text-red-700">Job error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap font-mono text-sm text-red-700">{j.errorMessage}</pre>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Rows</CardTitle>
          <div className="flex items-center gap-2">
            {j.failedRows > 0 ? (
              <Button variant="secondary" size="sm" onClick={() => downloadErrorsCsv(j.id)}>
                <Download className="size-4" /> Download errors CSV
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setShowFailedOnly((v) => !v)}>
              {showFailedOnly ? 'Show all' : 'Show failed only'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {rows.isLoading ? (
            <div className="py-2">
              <SkeletonRows rows={5} cols={3} />
            </div>
          ) : (rows.data?.data ?? []).length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">
              {showFailedOnly ? 'No failed rows. Nice!' : 'No rows recorded yet.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.data?.data.map((row) => (
                <RowItem key={row.id} row={row} jobId={j.id} entityKind={j.entityKind} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

// Schema-aware field hint set per import kind. Keys here line up with the
// Zod schemas the worker / retry endpoint use; anything outside the list
// is still shown but flagged as "extra" so operators don't think a typo
// in their header is a real field.
const KIND_FIELDS: Record<string, string[]> = {
  product: [
    'sku',
    'name',
    'shortDescription',
    'description',
    'priceMinor',
    'currency',
    'isAvailable',
    'stockQuantity',
    'categorySlug',
  ],
  service: [
    'name',
    'shortDescription',
    'description',
    'durationMinutes',
    'basePriceMinor',
    'currency',
    'priceUnit',
    'isAvailable',
    'categorySlug',
  ],
  faq: ['question', 'answer', 'visibility', 'tags'],
  business_info: ['legalName', 'tagline', 'about', 'websiteUrl', 'timezone', 'currency'],
};

function RowItem({
  row,
  jobId,
  entityKind,
}: {
  row: ImportJobRowDto;
  jobId: string;
  entityKind: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  // Initialise the edit form from the existing rawData each time the
  // row opens — keeps the editor in sync if a parallel retry succeeded.
  useEffect(() => {
    if (!editing) return;
    const seed: Record<string, string> = {};
    const fieldList = KIND_FIELDS[entityKind] ?? [];
    const raw = (row.rawData ?? {}) as Record<string, unknown>;
    // Start with every expected field (empty if missing), then layer
    // every extra key the original row had so nothing is lost on save.
    for (const k of fieldList) seed[k] = raw[k] == null ? '' : String(raw[k]);
    for (const k of Object.keys(raw)) {
      if (!(k in seed)) seed[k] = raw[k] == null ? '' : String(raw[k]);
    }
    setDraft(seed);
  }, [editing, row.rawData, entityKind]);

  const retry = useMutation({
    mutationFn: (rawData: Record<string, unknown>) =>
      api.patch<{ data: ImportJobRowDto }>(
        `/api/v1/imports/${jobId}/rows/${row.id}`,
        { rawData },
      ),
    onSuccess: (res) => {
      const ok = res.data.status === 'succeeded';
      toast[ok ? 'success' : 'error'](ok ? 'Row fixed' : 'Still failing — see errors');
      qc.invalidateQueries({ queryKey: ['import', jobId] });
      qc.invalidateQueries({ queryKey: ['import-rows', jobId] });
      if (ok) setEditing(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Retry failed'),
  });

  const save = () => {
    // Trim whitespace, drop empty strings so optional fields aren't
    // forced through validation as the empty string.
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      const t = v.trim();
      if (t === '') continue;
      cleaned[k] = t;
    }
    retry.mutate(cleaned);
  };

  const fieldList = KIND_FIELDS[entityKind] ?? Object.keys(row.rawData ?? {});
  const extras = Object.keys(row.rawData ?? {}).filter((k) => !fieldList.includes(k));
  const canEdit = row.status === 'failed';

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-6 py-3 text-left text-sm hover:bg-surface-muted/50"
      >
        <div className="flex items-center gap-3">
          {open ? (
            <ChevronDown className="size-4 text-foreground-subtle" />
          ) : (
            <ChevronRight className="size-4 text-foreground-subtle" />
          )}
          <span className="font-mono text-xs">Row {row.rowNumber}</span>
          <Badge
            variant={
              row.status === 'succeeded'
                ? 'success'
                : row.status === 'failed'
                  ? 'danger'
                  : 'muted'
            }
          >
            {row.status}
          </Badge>
        </div>
        {row.errors && row.errors.length > 0 ? (
          <span className="truncate text-xs text-red-600">{row.errors[0]?.message}</span>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border bg-surface-muted/40 px-6 py-4">
          {row.errors && row.errors.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {row.errors.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="font-mono text-foreground-subtle">{e.path || '_'}</span>
                  <span className="text-red-700">{e.message}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {canEdit && !editing ? (
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <RotateCw className="size-4" /> Edit & retry
              </Button>
            </div>
          ) : null}

          {editing ? (
            (() => {
              // Build a per-field error index so each Input can show its
              // own red border + inline message. Falls back to "_" for
              // top-level errors (e.g. wrong shape), which we render
              // above the grid instead of under any single field.
              const errorByField = new Map<string, string>();
              const generalErrors: string[] = [];
              for (const e of row.errors ?? []) {
                const key = (e.path ?? '').split('.')[0] || '_';
                if (key === '_') generalErrors.push(e.message);
                else if (!errorByField.has(key)) errorByField.set(key, e.message);
              }
              return (
                <div className="space-y-3 rounded-md border border-border bg-surface p-3">
                  <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                    Edit fields, then save to re-validate
                  </p>
                  {generalErrors.length > 0 ? (
                    <ul className="space-y-1 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                      {generalErrors.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[...fieldList, ...extras].map((key) => {
                      const fieldError = errorByField.get(key);
                      const hasError = !!fieldError;
                      return (
                        <label key={key} className="flex flex-col gap-1 text-xs">
                          <span
                            className={
                              hasError
                                ? 'font-mono font-semibold text-red-700'
                                : 'font-mono text-foreground-muted'
                            }
                          >
                            {key}
                            {extras.includes(key) ? (
                              <span className="ml-1 font-normal text-foreground-subtle">
                                (extra)
                              </span>
                            ) : null}
                          </span>
                          <Input
                            value={draft[key] ?? ''}
                            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                            placeholder={
                              extras.includes(key) ? 'extra column from your file' : undefined
                            }
                            aria-invalid={hasError || undefined}
                            className={
                              hasError
                                ? 'border-red-400 bg-red-50 text-red-900 focus-visible:border-red-500 focus-visible:ring-red-300'
                                : undefined
                            }
                          />
                          {hasError ? (
                            <span className="text-[11px] text-red-700">{fieldError}</span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(false)}
                      disabled={retry.isPending}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={save} loading={retry.isPending}>
                      <Save className="size-4" /> Save & retry
                    </Button>
                  </div>
                </div>
              );
            })()
          ) : row.rawData ? (
            <pre className="overflow-x-auto rounded bg-surface p-3 text-xs">
              {JSON.stringify(row.rawData, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

async function downloadErrorsCsv(jobId: string) {
  const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/imports/${jobId}/errors.csv`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
    credentials: 'include',
  });
  if (!res.ok) {
    toast.error(`Download failed (${res.status})`);
    return;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aligned-import-${jobId.slice(0, 8)}-errors.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: 'emerald' | 'red';
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</p>
        <p
          className={
            accent === 'emerald'
              ? 'mt-1 text-2xl font-semibold text-emerald-700'
              : accent === 'red'
                ? 'mt-1 text-2xl font-semibold text-red-600'
                : 'mt-1 text-2xl font-semibold'
          }
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
