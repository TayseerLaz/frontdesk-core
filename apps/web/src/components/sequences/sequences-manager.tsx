'use client';

import type { ContactDto, SequenceDto } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, UserPlus } from 'lucide-react';
import Link from 'next/link';
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
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';

interface Template {
  id: string;
  name: string;
  status: string;
  language: string;
}
interface Channel {
  id: string;
  displayPhoneNumber: string | null;
}

// Reusable sequences management component. Same shape as
// SegmentsManager — mountable both at /sequences (legacy) and inside
// the /broadcasts tab UI. Pass showHeader={false} when embedded.
export default function SequencesManager({ showHeader = true }: { showHeader?: boolean } = {}) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [enrollFor, setEnrollFor] = useState<SequenceDto | null>(null);

  const sequencesQuery = useQuery({
    queryKey: ['sequences'],
    queryFn: () => api.get<{ data: SequenceDto[] }>('/api/v1/sequences'),
    refetchInterval: 5000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/sequences/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sequences'] });
      toast.success('Sequence deleted');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  return (
    <>
      {showHeader ? (
        <PageHeader
          title="Sequences"
          description="Drip campaigns: a series of WhatsApp templates fired at a contact in order with delays between each step."
          actions={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" /> New sequence
            </Button>
          }
        />
      ) : (
        <div className="mb-4 flex justify-end">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New sequence
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{sequencesQuery.data?.data.length ?? 0} sequences</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-6 py-3">Name</th>
                  <th className="px-6 py-3">Steps</th>
                  <th className="px-6 py-3">Active</th>
                  <th className="px-6 py-3">Enrolled</th>
                  <th className="px-6 py-3">Updated</th>
                  <th className="w-32 px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {sequencesQuery.isLoading ? (
                  <tr>
                    <td colSpan={6} className="p-0">
                      <SkeletonRows rows={5} cols={5} />
                    </td>
                  </tr>
                ) : null}
                {sequencesQuery.data?.data.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-foreground-muted">
                      No sequences yet. Create one to start drip campaigns.
                    </td>
                  </tr>
                ) : null}
                {sequencesQuery.data?.data.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="px-6 py-4 font-medium">{s.name}</td>
                    <td className="px-6 py-4 font-mono text-sm">{s.steps.length}</td>
                    <td className="px-6 py-4 text-foreground-muted">{s.isActive ? 'Yes' : 'No'}</td>
                    <td className="px-6 py-4 font-mono text-sm">{s.enrollmentCount ?? 0}</td>
                    <td className="px-6 py-4 text-foreground-muted">{new Date(s.updatedAt).toLocaleDateString()}</td>
                    <td className="px-6 py-4 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEnrollFor(s)}>
                        <UserPlus className="size-4" /> Enroll
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

      <CreateSequenceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => qc.invalidateQueries({ queryKey: ['sequences'] })}
      />
      <EnrollDialog
        sequence={enrollFor}
        onClose={() => setEnrollFor(null)}
        onEnrolled={() => qc.invalidateQueries({ queryKey: ['sequences'] })}
      />
    </>
  );
}

interface StepDraft {
  templateId: string;
  delayHours: number;
}

function CreateSequenceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepDraft[]>([{ templateId: '', delayHours: 0 }]);
  const [busy, setBusy] = useState(false);

  const channelQuery = useQuery({
    queryKey: ['whatsapp-channel'],
    queryFn: () => api.get<{ data: Channel }>('/api/v1/whatsapp'),
    enabled: open,
  });
  const templatesQuery = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => api.get<{ data: Template[] }>('/api/v1/whatsapp/templates'),
    enabled: open,
  });
  const approved = useMemo(
    () => (templatesQuery.data?.data ?? []).filter((t) => t.status === 'approved'),
    [templatesQuery.data],
  );

  useEffect(() => {
    if (channelQuery.data?.data.id && !channelId) setChannelId(channelQuery.data.data.id);
  }, [channelQuery.data, channelId]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/api/v1/sequences', {
        name,
        description: description || null,
        channelId,
        isActive: true,
        steps: steps.map((s) => ({
          templateId: s.templateId,
          delayHours: s.delayHours,
          variables: {},
        })),
      });
      toast.success('Sequence created');
      onOpenChange(false);
      onCreated();
      setName('');
      setDescription('');
      setSteps([{ templateId: '', delayHours: 0 }]);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New sequence</DialogTitle>
          <DialogDescription>Each step fires {steps[0]?.delayHours === 0 ? 'immediately on enroll' : 'after the configured delay'}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Welcome flow" />
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="space-y-2">
            <Label>Steps</Label>
            {steps.map((s, idx) => (
              <div key={idx} className="flex items-center gap-2 rounded border border-border p-3">
                <span className="font-mono text-xs text-foreground-subtle">#{idx + 1}</span>
                <Select
                  value={s.templateId}
                  onValueChange={(v) =>
                    setSteps((prev) => prev.map((p, i) => (i === idx ? { ...p, templateId: v } : p)))
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Template…" />
                  </SelectTrigger>
                  <SelectContent>
                    {approved.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} <span className="ml-1 text-xs text-foreground-subtle">· {t.language}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs">After</span>
                <Input
                  type="number"
                  className="w-20"
                  value={s.delayHours}
                  onChange={(e) =>
                    setSteps((prev) =>
                      prev.map((p, i) =>
                        i === idx ? { ...p, delayHours: Number(e.target.value || 0) } : p,
                      ),
                    )
                  }
                  min={0}
                />
                <span className="text-xs">hours</span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    setSteps((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSteps((prev) => [...prev, { templateId: '', delayHours: 24 }])}
            >
              <Plus className="size-4" /> Add step
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={busy || !name || !channelId || steps.some((s) => !s.templateId)}
            loading={busy}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnrollDialog({
  sequence,
  onClose,
  onEnrolled,
}: {
  sequence: SequenceDto | null;
  onClose: () => void;
  onEnrolled: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const contactsQuery = useQuery({
    queryKey: ['contacts', { search, limit: 200 }],
    queryFn: () =>
      api.get<{ data: ContactDto[] }>(
        `/api/v1/contacts?` + new URLSearchParams({ ...(search ? { search } : {}), limit: '200' }).toString(),
      ),
    enabled: sequence !== null,
  });

  const submit = async () => {
    if (!sequence) return;
    setBusy(true);
    try {
      const res = await api.post<{ data: { enrolled: number } }>(
        `/api/v1/sequences/${sequence.id}/enroll`,
        { contactIds: [...selected] },
      );
      toast.success(`Enrolled ${res.data.enrolled} contact${res.data.enrolled === 1 ? '' : 's'}`);
      onEnrolled();
      onClose();
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof ApiError ? err.payload.message : 'Enroll failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={sequence !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Enroll contacts in &quot;{sequence?.name}&quot;</DialogTitle>
          <DialogDescription>
            Pick the contacts to enroll. Opted-out contacts are silently skipped.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" />
          <div className="max-h-80 overflow-y-auto rounded border border-border">
            {(contactsQuery.data?.data ?? []).map((c) => {
              const checked = selected.has(c.id);
              return (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-border p-2 last:border-0 hover:bg-surface-muted"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = new Set(selected);
                      if (checked) next.delete(c.id);
                      else next.add(c.id);
                      setSelected(next);
                    }}
                  />
                  <span className="font-mono text-xs">{c.phoneE164}</span>
                  <span className="text-foreground-muted">{c.displayName ?? '—'}</span>
                </label>
              );
            })}
          </div>
          <p className="text-xs text-foreground-subtle">{selected.size} selected</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={selected.size === 0 || busy}>
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
