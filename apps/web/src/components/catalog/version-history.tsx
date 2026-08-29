'use client';

import type { CatalogRevisionDto, CatalogRevisionWithSnapshotDto, RevisionEntityType } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitCommitVertical, History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';

const ACTION_VARIANT: Record<CatalogRevisionDto['action'], 'success' | 'default' | 'danger' | 'warning'> = {
  created: 'success',
  updated: 'default',
  deleted: 'danger',
  restored: 'warning',
};

export function VersionHistory({
  entityType,
  entityId,
  refetchEntity,
}: {
  entityType: RevisionEntityType;
  entityId: string;
  refetchEntity?: () => void;
}) {
  const queryClient = useQueryClient();
  const [previewId, setPreviewId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['revisions', entityType, entityId],
    queryFn: () =>
      api.get<{ data: CatalogRevisionDto[] }>(`/api/v1/revisions/${entityType}/${entityId}`),
  });

  const restore = useMutation({
    mutationFn: (revisionId: string) => api.post(`/api/v1/revisions/${revisionId}/restore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['revisions', entityType, entityId] });
      refetchEntity?.();
      toast.success('Restored');
      setPreviewId(null);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Restore failed'),
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-4 text-foreground-muted" /> Version history
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <ol className="divide-y divide-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-3">
                  <Skeleton className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </li>
              ))}
            </ol>
          ) : (list.data?.data ?? []).length === 0 ? (
            <p className="px-6 py-6 text-center text-xs text-foreground-muted">No revisions yet.</p>
          ) : (
            <ol className="divide-y divide-border">
              {list.data?.data.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setPreviewId(r.id)}
                    className="flex w-full items-start gap-3 text-left hover:opacity-80"
                  >
                    <GitCommitVertical className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={ACTION_VARIANT[r.action]}>{r.action}</Badge>
                        <span className="text-xs font-medium">v{r.versionNumber}</span>
                      </div>
                      {r.summary ? (
                        <p className="mt-1 truncate text-sm">{r.summary}</p>
                      ) : null}
                      <p className="mt-0.5 text-xs text-foreground-subtle">
                        {r.actorName ?? 'system'} · {formatRelative(r.createdAt)}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <RevisionPreview
        revisionId={previewId}
        onClose={() => setPreviewId(null)}
        onRestore={(id) => restore.mutate(id)}
        isRestoring={restore.isPending}
      />
    </>
  );
}

function RevisionPreview({
  revisionId,
  onClose,
  onRestore,
  isRestoring,
}: {
  revisionId: string | null;
  onClose: () => void;
  onRestore: (id: string) => void;
  isRestoring: boolean;
}) {
  const detail = useQuery({
    queryKey: ['revision', revisionId],
    queryFn: () =>
      api.get<{ data: CatalogRevisionWithSnapshotDto }>(`/api/v1/revisions/${revisionId}`),
    enabled: !!revisionId,
  });

  return (
    <Dialog open={!!revisionId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Revision {detail.data ? `v${detail.data.data.versionNumber}` : ''}
          </DialogTitle>
          <DialogDescription>
            {detail.data
              ? `${detail.data.data.action} by ${detail.data.data.actorName ?? 'system'} · ${formatRelative(detail.data.data.createdAt)}`
              : 'Loading snapshot…'}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-96 overflow-auto rounded-md border border-border bg-surface-muted p-3">
          {detail.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-5/6" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">
              {JSON.stringify(detail.data?.data.snapshot ?? null, null, 2)}
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => revisionId && onRestore(revisionId)}
            loading={isRestoring}
            disabled={!revisionId}
          >
            <RotateCcw className="size-4" /> Restore this version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
