'use client';

// Phase 3 §5.1.4 — GDPR data portability UI. Admins can request a fresh
// export and download the most recent finished one. We don't surface the
// signed download URL on the list response (it would persist in the React
// Query cache past its TTL); the Download button mints a new short-lived
// URL on demand.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Download, Loader2, RefreshCw, XCircle } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';

interface DataExport {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  storageKey: string | null;
  fileSizeBytes: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function DataExportPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['exports'],
    queryFn: () => api.get<{ data: DataExport[] }>('/api/v1/exports'),
    refetchInterval: (q) => {
      const inflight = q.state.data?.data.some((x) => x.status === 'pending' || x.status === 'running');
      return inflight ? 3000 : false;
    },
  });
  const rows = list.data?.data ?? [];
  const inflight = rows.some((r) => r.status === 'pending' || r.status === 'running');

  const create = useMutation({
    mutationFn: () => api.post<{ data: DataExport }>('/api/v1/exports'),
    onSuccess: () => {
      toast.success('Export started — we\'ll email you when it\'s ready.');
      qc.invalidateQueries({ queryKey: ['exports'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Could not start export'),
  });

  async function downloadOne(id: string) {
    try {
      const res = await api.get<{ data: { url: string; expiresInSeconds: number } }>(
        `/api/v1/exports/${id}/download`,
      );
      window.location.href = res.data.url;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not generate download link');
    }
  }

  return (
    <>
      <PageHeader
        title="Data export"
        description="Download a .zip of CSV files — your products, services, conversations, bot config, and audit log."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/settings">
              <ArrowLeft className="size-4" /> Back to settings
            </Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="size-4" /> Export everything
          </CardTitle>
          <CardDescription>
            Spec: §5.1.4 — GDPR data portability. We bundle products, services, categories, business
            info, FAQs, policies, WhatsApp threads + messages + notes, bot config + KB, and the last
            5,000 audit entries into a .zip of CSV files (one per data type). Large orgs may take a
            minute or two.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={inflight}>
            <RefreshCw className="size-4" /> {inflight ? 'Export in progress…' : 'Start a new export'}
          </Button>

          <ul className="divide-y divide-border rounded-md border border-border bg-surface">
            {rows.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-foreground-muted">
                No exports yet. Click <strong>Start a new export</strong> above.
              </li>
            ) : (
              rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={r.status} />
                      <span className="text-xs text-foreground-subtle">
                        {new Date(r.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {r.status === 'succeeded' ? (
                      <p className="mt-1 text-xs text-foreground-muted">
                        {formatBytes(r.fileSizeBytes)} · finished{' '}
                        {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : ''}
                      </p>
                    ) : null}
                    {r.status === 'failed' && r.errorMessage ? (
                      <p className="mt-1 text-xs text-amber-700">{r.errorMessage}</p>
                    ) : null}
                  </div>
                  {r.status === 'succeeded' ? (
                    <Button size="sm" variant="secondary" onClick={() => downloadOne(r.id)}>
                      <Download className="size-3.5" /> Download
                    </Button>
                  ) : null}
                </li>
              ))
            )}
          </ul>

          <p className="text-xs text-foreground-subtle">
            Download links are short-lived (15 min) — click <strong>Download</strong> to mint a fresh
            one any time.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function StatusBadge({ status }: { status: DataExport['status'] }) {
  if (status === 'succeeded') {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="size-3" /> Ready
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge variant="danger" className="gap-1">
        <XCircle className="size-3" /> Failed
      </Badge>
    );
  }
  return (
    <Badge variant="muted" className="gap-1">
      <Loader2 className="size-3 animate-spin" /> {status}
    </Badge>
  );
}
