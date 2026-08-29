'use client';

import {
  IMPORT_ENTITY_KINDS,
  IMPORT_ENTITY_LABELS,
  type ImportEntityKind,
  type ImportFieldHint,
  type ImportJobDto,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
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
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS_BADGE: Record<
  ImportJobDto['status'],
  { label: string; variant: 'default' | 'muted' | 'success' | 'warning' | 'danger' }
> = {
  pending: { label: 'Pending', variant: 'muted' },
  validating: { label: 'Validating', variant: 'default' },
  processing: { label: 'Processing', variant: 'default' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  partial: { label: 'Partial', variant: 'warning' },
  failed: { label: 'Failed', variant: 'danger' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
};

export default function ImportsPage() {
  const [wizardOpen, setWizardOpen] = useState(false);
  // When arriving via a contextual "Bulk import" button (e.g. /imports?kind=
  // product from the Products page), pre-scope the wizard to that entity and
  // open it automatically.
  const [initialKind, setInitialKind] = useState<ImportEntityKind>('product');
  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get('kind');
    if (k && (IMPORT_ENTITY_KINDS as string[]).includes(k)) {
      setInitialKind(k as ImportEntityKind);
      setWizardOpen(true);
    }
  }, []);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ['imports'],
    queryFn: () => api.get<{ data: ImportJobDto[] }>('/api/v1/imports?limit=50'),
    refetchInterval: (q) => {
      const data = q.state.data?.data ?? [];
      return data.some((j) => j.status === 'processing' || j.status === 'pending' || j.status === 'validating')
        ? 2000
        : false;
    },
  });

  const deleteOne = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/imports/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['imports'] });
      toast.success('Import removed');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  const clearAll = useMutation({
    mutationFn: (statuses?: ImportJobDto['status'][]) =>
      api.post<{ data: { removed: number } }>('/api/v1/imports/clear', statuses ? { statuses } : {}),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['imports'] });
      toast.success(`Cleared ${res.data.removed} import${res.data.removed === 1 ? '' : 's'}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Clear failed'),
  });

  const jobs = list.data?.data ?? [];
  const clearableCount = jobs.filter((j) =>
    ['succeeded', 'partial', 'failed', 'cancelled'].includes(j.status),
  ).length;
  const failedCount = jobs.filter((j) => j.status === 'failed').length;

  return (
    <>
      <PageHeader
        title="Imports"
        description="Upload spreadsheets to bulk-create or update products, services, and FAQs."
        actions={
          <Button onClick={() => setWizardOpen(true)}>
            <Upload className="size-4" /> New import
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
          <CardDescription>Download the pre-formatted XLSX for the entity you want to import.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {IMPORT_ENTITY_KINDS.map((kind) => (
            <a
              key={kind}
              href={`${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1/imports/templates/${kind}`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                // The download endpoint is JWT-authed, so we POST a one-time download link instead.
                // Simpler: open with the access token in a query param? We pass it via Authorization
                // by triggering an XHR fetch + Blob download.
                e.preventDefault();
                downloadTemplate(kind).catch((err) =>
                  toast.error(err instanceof ApiError ? err.payload.message : 'Download failed'),
                );
              }}
              className="flex items-center justify-between rounded-md border border-border bg-surface px-4 py-3 text-sm transition-colors hover:bg-surface-muted"
            >
              <div className="flex items-center gap-3">
                <FileSpreadsheet className="size-5 text-brand-500" />
                <span className="font-medium">{IMPORT_ENTITY_LABELS[kind]}</span>
              </div>
              <Download className="size-4 text-foreground-subtle" />
            </a>
          ))}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Recent imports</CardTitle>
            <CardDescription>
              Delete any import to clear history. Imported catalog data is NOT reverted.
            </CardDescription>
          </div>
          {clearableCount > 0 ? (
            <div className="flex items-center gap-2">
              {failedCount > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={clearAll.isPending && clearAll.variables?.length === 1}
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: `Delete ${failedCount} failed import${failedCount === 1 ? '' : 's'}?`,
                        body: 'Only jobs with status "failed" are removed. In-progress and successful jobs are kept.',
                        confirmLabel: 'Delete failed',
                        destructive: true,
                      })
                    ) {
                      clearAll.mutate(['failed']);
                    }
                  }}
                >
                  <Trash2 className="size-3.5" /> Clear failed ({failedCount})
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                loading={clearAll.isPending && !clearAll.variables?.length}
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: `Delete all ${clearableCount} finished import${clearableCount === 1 ? '' : 's'}?`,
                      body: 'Removes every succeeded, partial, failed, and cancelled job. In-progress jobs are kept. Cannot be undone.',
                      confirmLabel: 'Delete all',
                      destructive: true,
                    })
                  ) {
                    clearAll.mutate(undefined);
                  }
                }}
              >
                <Trash2 className="size-3.5" /> Clear all ({clearableCount})
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="py-2">
              <SkeletonRows rows={5} cols={4} />
            </div>
          ) : (list.data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={Upload}
              title="No imports yet"
              description="Upload a spreadsheet to populate your catalog in seconds."
              action={
                <Button onClick={() => setWizardOpen(true)}>
                  <Upload className="size-4" /> Start an import
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {list.data?.data.map((job) => {
                const badge = STATUS_BADGE[job.status];
                const inProgress = ['pending', 'validating', 'processing'].includes(job.status);
                const pct =
                  job.totalRows > 0
                    ? Math.round((job.processedRows / job.totalRows) * 100)
                    : inProgress
                      ? null
                      : 100;
                return (
                  <li key={job.id} className="flex items-center justify-between gap-4 px-6 py-4">
                    <Link
                      href={`/imports/${job.id}`}
                      className="flex min-w-0 flex-1 items-center justify-between gap-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{IMPORT_ENTITY_LABELS[job.entityKind]}</span>
                          <Badge variant={badge.variant}>
                            {inProgress ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                            {badge.label}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-foreground-subtle">
                          {job.sourceFilename ?? '—'} · {formatRelative(job.createdAt)}
                        </p>
                        {inProgress && pct !== null ? (
                          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                            <div
                              className="h-full bg-brand-500 transition-[width] duration-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-6">
                        <CountStat label="Rows" value={job.totalRows} />
                        <CountStat label="Succeeded" value={job.succeededRows} ok={job.succeededRows > 0} />
                        <CountStat label="Failed" value={job.failedRows} bad={job.failedRows > 0} />
                        <ChevronRight className="size-4 text-foreground-subtle" />
                      </div>
                    </Link>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Delete import"
                      loading={deleteOne.isPending && deleteOne.variables === job.id}
                      onClick={async () => {
                        if (
                          await confirmDialog({
                            title: `Delete this ${IMPORT_ENTITY_LABELS[job.entityKind]} import?`,
                            body: inProgress
                              ? 'This job is still running — it will be cancelled and removed. Imported data so far is NOT reverted.'
                              : 'The job row and its per-row results will be removed. Imported catalog data is NOT reverted.',
                            confirmLabel: 'Delete import',
                            destructive: true,
                          })
                        ) {
                          deleteOne.mutate(job.id);
                        }
                      }}
                    >
                      <Trash2 className="size-4 text-red-600" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ImportWizard
        key={initialKind}
        initialKind={initialKind}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['imports'] });
          setWizardOpen(false);
        }}
      />
    </>
  );
}

function CountStat({
  label,
  value,
  ok,
  bad,
}: {
  label: string;
  value: number;
  ok?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="text-right">
      <p
        className={cn(
          'text-sm font-semibold tabular-nums',
          bad && 'text-red-600',
          ok && !bad && 'text-emerald-700',
        )}
      >
        {value}
      </p>
      <p className="text-[10px] uppercase tracking-wide text-foreground-subtle">{label}</p>
    </div>
  );
}

async function downloadTemplate(kind: ImportEntityKind) {
  const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/imports/templates/${kind}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${kind}-template.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// ---------- wizard ---------------------------------------------------------
// Three steps:
//   1) Pick entity + file
//   2) Map columns (CSV only — for XLSX we trust the template; if your XLSX
//      came from our downloadable template, the headers already match).
//   3) Review + start
//
// The mapping step is skipped when every uploaded header matches a known
// target field exactly — the common case when the user used our template.
const MAPPING_KEEP = '__keep__';
const MAPPING_IGNORE = '__ignore__';

type WizardStep = 'pick' | 'map' | 'review';

async function readCsvHeaders(file: File): Promise<string[] | null> {
  if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return null;
  // Read only the first ~64 KB — enough for a header line in any realistic file.
  const slice = file.slice(0, 64 * 1024);
  const text = await slice.text();
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (!firstLine.trim()) return [];
  // Minimal CSV header parser: handles "quoted,commas" and doubled quotes.
  const headers: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (inQuotes) {
      if (ch === '"' && firstLine[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      headers.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  headers.push(cur.trim());
  return headers.filter((h) => h.length > 0);
}

function ImportWizard({
  open,
  onOpenChange,
  onCreated,
  initialKind = 'product',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
  initialKind?: ImportEntityKind;
}) {
  const [step, setStep] = useState<WizardStep>('pick');
  const [entityKind, setEntityKind] = useState<ImportEntityKind>(initialKind);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadedHeaders, setUploadedHeaders] = useState<string[] | null>(null);
  // `mapping[uploadedHeader] = targetField | MAPPING_IGNORE`.
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const fieldsQuery = useQuery({
    queryKey: ['import-fields', entityKind],
    queryFn: () => api.get<{ data: ImportFieldHint[] }>(`/api/v1/imports/templates/${entityKind}/fields`),
    enabled: open,
  });

  const reset = () => {
    setStep('pick');
    setFile(null);
    setEntityKind(initialKind);
    setUploadedHeaders(null);
    setMapping({});
    if (fileInput.current) fileInput.current.value = '';
  };

  // Proceed from pick → map (or straight to review if mapping not needed).
  const nextFromPick = async () => {
    if (!file) return;
    const headers = await readCsvHeaders(file);
    // Make sure the target-fields response has actually arrived before we
    // run auto-detection — otherwise targetFields is empty and the
    // auto-detector defaults every column to "__ignored__", which causes
    // a silent import where the worker stores `{"__ignored__": ...}` as
    // rawData and Zod fails on required fields (sku / name etc).
    let targetFields = fieldsQuery.data?.data ?? [];
    if (targetFields.length === 0) {
      try {
        const fresh = await fieldsQuery.refetch();
        targetFields = fresh.data?.data ?? [];
      } catch {
        /* fall through — handled by the empty-targets guard below */
      }
    }
    const targetNames = new Set(targetFields.map((f) => f.field));
    if (!headers || headers.every((h) => targetNames.has(h))) {
      // XLSX or already-matching CSV — skip the mapping step.
      setUploadedHeaders(headers);
      setMapping({});
      setStep('review');
      return;
    }
    // Defensive: target fields couldn't be loaded at all. Send no mapping
    // and let the worker's header-normalizer + alias table take care of
    // it. Better to attempt the import than to map every column to
    // __ignored__ and produce a row of nothing.
    if (targetFields.length === 0) {
      setUploadedHeaders(headers);
      setMapping({});
      setStep('review');
      return;
    }
    // CSV with custom headers: pre-fill the mapping with best guesses
    // (exact match preferred; otherwise lowercase-match).
    const lowerToField: Record<string, string> = {};
    for (const f of targetFields) lowerToField[f.field.toLowerCase()] = f.field;
    const initial: Record<string, string> = {};
    for (const h of headers) {
      const loweredMatch = lowerToField[h.toLowerCase()];
      if (targetNames.has(h)) initial[h] = h;
      else if (loweredMatch) initial[h] = loweredMatch;
      else initial[h] = MAPPING_IGNORE;
    }
    setUploadedHeaders(headers);
    setMapping(initial);
    setStep('map');
  };

  // Build the `columnMapping` body for POST /imports. Empty object when
  // headers already match targets; null when nothing to send.
  const buildColumnMapping = (): Record<string, string> | undefined => {
    if (!uploadedHeaders || uploadedHeaders.length === 0) return undefined;
    const out: Record<string, string> = {};
    let hasNonIdentity = false;
    let hasRealMapping = false;
    for (const h of uploadedHeaders) {
      const target = mapping[h] ?? MAPPING_IGNORE;
      if (target === MAPPING_IGNORE) {
        // Skip column: emit a rename to a sentinel the worker will ignore.
        out[h] = '__ignored__';
        hasNonIdentity = true;
      } else {
        out[h] = target;
        hasRealMapping = true;
        if (target !== h) hasNonIdentity = true;
      }
    }
    // Refuse to send a mapping that's entirely "ignore every column" —
    // that would silently throw away every row. Better to send no
    // mapping and let the worker's header normalizer try, so the
    // operator at least gets actionable validation errors instead of
    // 100% silent drops.
    if (!hasRealMapping) return undefined;
    return hasNonIdentity ? out : undefined;
  };

  const requiredFields = (fieldsQuery.data?.data ?? []).filter((f) => f.required);
  const missingRequired = requiredFields
    .filter((f) => !Object.values(mapping).includes(f.field))
    .map((f) => f.label);

  const start = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const uploadRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/assets/upload-csv`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
          body: fd,
          credentials: 'include',
        },
      );
      if (!uploadRes.ok) {
        const text = await uploadRes.text();
        throw new Error(`Upload failed: ${text || uploadRes.statusText}`);
      }
      const upload = (await uploadRes.json()) as { data: { assetId: string } };
      await api.post(`/api/v1/imports`, {
        entityKind,
        sourceAssetId: upload.data.assetId,
        columnMapping: buildColumnMapping(),
      });
      toast.success('Import started');
      onCreated();
      reset();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {step === 'pick' ? 'Start an import' : step === 'map' ? 'Map your columns' : 'Review & start'}
          </DialogTitle>
          <DialogDescription>
            {step === 'pick' &&
              'CSV and XLSX up to 50 MB. Using our template guarantees headers match.'}
            {step === 'map' &&
              'Your CSV headers don’t all match our field names. Tell us which column maps to which field.'}
            {step === 'review' && 'Looks good. Click Start to queue the import.'}
          </DialogDescription>
        </DialogHeader>

        {/* Stepper */}
        <ol className="flex items-center gap-2 text-xs">
          {(['pick', 'map', 'review'] as WizardStep[]).map((s, i) => (
            <li
              key={s}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1',
                step === s ? 'bg-brand-50 text-brand-700 font-medium' : 'text-foreground-subtle',
              )}
            >
              <span className="inline-flex size-5 items-center justify-center rounded-full border border-current text-[10px]">
                {i + 1}
              </span>
              {s === 'pick' ? 'Choose file' : s === 'map' ? 'Map columns' : 'Review'}
            </li>
          ))}
        </ol>

        {step === 'pick' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="entityKind">What are you importing?</Label>
              <Select value={entityKind} onValueChange={(v) => setEntityKind(v as ImportEntityKind)}>
                <SelectTrigger id="entityKind">
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
            <div className="space-y-1.5">
              <Label>File</Label>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-border px-6 py-10 text-center text-sm text-foreground-muted transition-colors hover:border-brand-400 hover:bg-brand-50/30"
              >
                {file ? (
                  <>
                    <CheckCircle2 className="mb-2 size-7 text-emerald-600" />
                    <span className="font-medium text-foreground">{file.name}</span>
                    <span className="mt-1 text-xs text-foreground-subtle">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="mb-2 size-7 text-foreground-subtle" />
                    <span>Click to choose a CSV or XLSX</span>
                  </>
                )}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <p>
                Existing rows are matched by SKU (products), slug (services), or upserted by org
                (business info). FAQs always create a new row — review your file before re-importing.
              </p>
            </div>
          </div>
        )}

        {step === 'map' && uploadedHeaders && (
          <div className="space-y-3">
            <p className="text-xs text-foreground-muted">
              Found {uploadedHeaders.length} column{uploadedHeaders.length === 1 ? '' : 's'} in your file. Set
              each to the matching catalog field, or <em>Ignore</em> to skip it.
            </p>
            <div className="max-h-80 space-y-2 overflow-auto rounded-md border border-border bg-surface-muted/20 p-2">
              {uploadedHeaders.map((h) => (
                <div key={h} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <span className="truncate font-mono text-xs">{h}</span>
                  <span className="text-foreground-subtle">→</span>
                  <Select
                    value={mapping[h] ?? MAPPING_IGNORE}
                    onValueChange={(v) => setMapping({ ...mapping, [h]: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={MAPPING_IGNORE}>— Ignore this column —</SelectItem>
                      {(fieldsQuery.data?.data ?? []).map((f) => (
                        <SelectItem key={f.field} value={f.field}>
                          {f.label}
                          {f.required ? ' (required)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {missingRequired.length > 0 && (
              <div
                role="alert"
                aria-live="polite"
                className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <p>
                  Required fields not yet mapped: <strong>{missingRequired.join(', ')}</strong>. Rows
                  missing these values will fail validation.
                </p>
              </div>
            )}
          </div>
        )}

        {step === 'review' && file && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[120px_1fr] gap-y-1.5">
              <span className="text-foreground-muted">Entity</span>
              <span className="font-medium">{IMPORT_ENTITY_LABELS[entityKind]}</span>
              <span className="text-foreground-muted">File</span>
              <span className="font-mono text-xs">{file.name}</span>
              <span className="text-foreground-muted">Size</span>
              <span>{(file.size / 1024).toFixed(1)} KB</span>
              <span className="text-foreground-muted">Mapping</span>
              <span>
                {buildColumnMapping() ? 'custom — applied to upload' : 'headers already match template'}
              </span>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'pick' && (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={nextFromPick} disabled={!file || fieldsQuery.isFetching}>
                Next
              </Button>
            </>
          )}
          {step === 'map' && (
            <>
              <Button variant="secondary" onClick={() => setStep('pick')}>
                Back
              </Button>
              <Button onClick={() => setStep('review')}>Next</Button>
            </>
          )}
          {step === 'review' && (
            <>
              <Button
                variant="secondary"
                onClick={() => setStep(uploadedHeaders && uploadedHeaders.length > 0 && buildColumnMapping() ? 'map' : 'pick')}
              >
                Back
              </Button>
              <Button onClick={start} loading={busy}>
                Start import
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
