'use client';

// "You just synced a phone — that can still be undone."
//
// WHY THIS EXISTS. Undo was only ever offered inside the sync dialog's finish screen, which
// (a) is destroyed the moment the dialog closes, and (b) is never even reached on a STAGED
// run — those redirect to /contacts after applying. Staging is the common case (any run over
// 50 contacts, or any ticked attestation), so for most real imports there was no undo button
// anywhere, despite the ledger, the revert route and seven days of retention all existing and
// working. GET /contacts/sync-sessions was built for exactly this and had ZERO callers.
//
// The window is stated out loud rather than left to be discovered. The ledger that records
// what to undo is pruned on the same 7-day boundary the revert route enforces, so a button
// offered beyond it could only fail — and a tenant who assumes undo is forever will find out
// at the worst possible moment.
import { CONTACT_SYNC_UNDO_WINDOW_MS, type ContactSyncSession } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Smartphone } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * The clock starts when the contacts LANDED, not when the QR was minted — a staged run can
 * sit in review for days, and counting from the mint told someone with two days left that
 * they had seven. Falls back to createdAt for runs imported before that was recorded.
 */
function clockStart(run: { importedAt: string | null; createdAt: string }): string {
  return run.importedAt ?? run.createdAt;
}

/** Whole days left in the undo window, floored — never rounds UP into a promise. */
function daysLeft(startedAt: string): number {
  const elapsed = Date.now() - new Date(startedAt).getTime();
  return Math.max(0, Math.floor((CONTACT_SYNC_UNDO_WINDOW_MS - elapsed) / 86_400_000));
}

function whenLabel(createdAt: string): string {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function RecentSyncsStrip() {
  const qc = useQueryClient();
  const { session } = useSession();
  // Undo hard-deletes, so the API gates it at 'editor' — matching POST /contacts/merge, the
  // other route in that module that destroys rows. Showing a viewer a button that can only
  // 403 is worse than showing none, so the strip stays informational for them.
  const role = session?.organization.role;
  const canUndo = role === 'admin' || role === 'editor';

  const runs = useQuery({
    queryKey: ['contact-sync', 'recent-runs'],
    queryFn: () =>
      api.get<{ data: ContactSyncSession[] }>('/api/v1/contacts/sync-sessions'),
    staleTime: 30_000,
  });

  const undo = useMutation({
    mutationFn: (id: string) =>
      api.post<{
        data: { removed: number; fieldsReverted: number; kept: number };
      }>(`/api/v1/contacts/sync-sessions/${id}/revert`, {}),
    onSuccess: (res) => {
      void qc.resetQueries({ queryKey: ['contacts'] });
      void qc.invalidateQueries({ queryKey: ['contact-sync', 'recent-runs'] });
      toast.success(
        res.data.removed > 0
          ? `Removed ${res.data.removed} contact${res.data.removed === 1 ? '' : 's'}.` +
              (res.data.kept > 0
                ? ` Kept ${res.data.kept} that have since been messaged, edited, or opted out.`
                : '')
          : 'Nothing was left to remove.',
      );
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not undo that sync.'),
  });

  // Only runs that still have something to remove. A run whose contacts have all since been
  // messaged or deleted is not "undoable" in any useful sense, and offering it would report
  // "removed 0" — technically true, and useless.
  const undoable = (runs.data?.data ?? []).filter(
    (r) => r.revertedAt === null && (r.undoableCount ?? 0) > 0,
  );
  if (undoable.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface-muted p-4">
      <div className="mb-2 flex items-center gap-2">
        <Smartphone className="size-4 text-foreground-muted" aria-hidden />
        <p className="text-sm font-medium">Recent phone syncs</p>
      </div>

      <ul className="space-y-2">
        {undoable.map((run) => {
          const left = daysLeft(clockStart(run));
          return (
            <li
              key={run.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {/* Never substitutes a name when none was typed. */}
                  {run.syncedByLabel ? (
                    <span className="font-medium">{run.syncedByLabel}</span>
                  ) : (
                    <span className="text-foreground-muted">Phone sync</span>
                  )}
                  <span className="text-foreground-muted">
                    {' '}
                    — {run.contactsCreated} added, {whenLabel(clockStart(run))}
                  </span>
                </p>
                <p className="text-xs text-foreground-subtle">
                  {/* Stated, not implied. The ledger recording what to undo is pruned on this
                      exact boundary, so the button cannot outlive the sentence. */}
                  {left > 0
                    ? `Can be undone for ${left} more day${left === 1 ? '' : 's'}.`
                    : 'Can be undone for less than a day.'}
                </p>
              </div>
              {canUndo ? (
                <Button
                  variant="secondary"
                  disabled={undo.isPending}
                  onClick={() => undo.mutate(run.id)}
                >
                  {undo.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  Undo this sync
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-xs text-foreground-subtle">
        Undo removes only the contacts a sync added, and only if nobody has messaged, edited or
        unsubscribed them since.
      </p>
    </div>
  );
}
