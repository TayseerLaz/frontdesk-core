'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';

interface CannedResponse {
  id: string;
  shortcut: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

// Canned-reply management, self-contained (no page chrome) so it can live BOTH
// as the /inbox/canned route and inside a dialog launched from the inbox header.
export function CannedManager() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ['canned-responses'],
    queryFn: () => api.get<{ data: CannedResponse[] }>('/api/v1/canned-responses'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/canned-responses/${id}`),
    onSuccess: () => {
      toast.success('Removed');
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
    },
  });

  const rows = list.data?.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground-muted">
          Quick-reply templates for the reply box. Type <span className="font-mono">/shortcut</span>{' '}
          to insert; use <span className="font-mono">{'{phone}'}</span> for the customer&rsquo;s number.
        </p>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="shrink-0">
          <Plus className="size-4" /> New
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {list.isLoading ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
                <Skeleton className="h-8 w-8 shrink-0" />
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No canned responses yet"
            description="Save your most-used replies as shortcuts. Insert them in the reply box with one click."
            action={
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" /> Create one
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((cr) => (
              <li key={cr.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-brand-600">/{cr.shortcut}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{cr.body}</p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete /${cr.shortcut}`}
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: `Delete /${cr.shortcut}?`,
                        confirmLabel: 'Delete',
                        destructive: true,
                      })
                    ) {
                      remove.mutate(cr.id);
                    }
                  }}
                >
                  <Trash2 className="size-4 text-danger" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateCannedDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreateCannedDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const [shortcut, setShortcut] = useState('');
  const [body, setBody] = useState('');

  const create = useMutation({
    mutationFn: () => api.post('/api/v1/canned-responses', { shortcut, body }),
    onSuccess: () => {
      toast.success('Created');
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
      onOpenChange(false);
      setShortcut('');
      setBody('');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New canned response</DialogTitle>
          <DialogDescription>
            Shortcut is the trigger you remember. Body is what gets inserted (with{' '}
            <span className="font-mono">{'{phone}'}</span> substituted for the customer&rsquo;s number).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cr-shortcut">Shortcut</Label>
            <Input
              id="cr-shortcut"
              placeholder="hours"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value.replace(/^\//, ''))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cr-body">Body</Label>
            <Textarea
              id="cr-body"
              rows={5}
              placeholder={'Thanks for messaging us!\nOur hours are Mon–Fri 9–17.\nFor urgent issues, call {phone}.'}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={create.isPending} onClick={() => create.mutate()} disabled={!shortcut || !body}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
