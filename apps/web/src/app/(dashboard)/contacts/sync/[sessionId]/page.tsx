'use client';

// Review a sync before it lands.
//
// Deliberately a page, not part of the sync dialog: the dialog is sm:max-w-lg and wipes
// all state when it closes, so a 1,200-row queue could not live there and would be lost
// the moment the tenant clicked away.
//
// The default is INCLUDED. This is a review, not an approval queue — the tenant already
// chose to send these contacts from their own phone, so the burden belongs on deselecting
// what they do not want, not on hand-approving what they asked for.
import {
  CONTACT_SYNC_LABEL_MAX_CHARS,
  type ContactSyncSession,
  type ContactSyncStagedItem,
  type ContactSyncStagedSummary,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Loader2, Pencil, Search, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';

export default function ContactSyncReviewPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const router = useRouter();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const PAGE = 200;
  const [pages, setPages] = useState(1);
  // Reset paging when the search changes, or "Load more" would append page 2 of the new
  // query onto page 1 of the old one.
  useEffect(() => setPages(1), [debounced]);

  const q = useQuery({
    queryKey: ['contact-sync', 'staged', sessionId, debounced, pages],
    queryFn: () =>
      api.get<{ data: ContactSyncStagedItem[]; nextCursor: string | null }>(
        `/api/v1/contacts/sync-sessions/${sessionId}/staged?` +
          new URLSearchParams({
            ...(debounced ? { q: debounced } : {}),
            limit: String(PAGE * pages),
          }).toString(),
      ),
  });
  const items = useMemo(() => q.data?.data ?? [], [q.data]);
  const hasMore = q.data?.nextCursor != null;

  /**
   * Counts come from the SERVER, over the whole queue — never from `items`.
   *
   * Deriving them from the loaded page is what made the button read "Add 500 contacts" while
   * apply imported 1,200, and made a search for "ali" label the button "Add 2 contacts" while
   * it still imported everything included. The button must state what the button will DO.
   */
  const summary = useQuery({
    queryKey: ['contact-sync', 'staged-summary', sessionId],
    queryFn: () =>
      api.get<{ data: ContactSyncStagedSummary }>(
        `/api/v1/contacts/sync-sessions/${sessionId}/staged/summary`,
      ),
  });
  const includedCount = summary.data?.data.included ?? 0;
  const knownCount = summary.data?.data.alreadyKnown ?? 0;
  const totalCount = summary.data?.data.total ?? 0;

  // The run itself, for the provenance label. This screen is the first time anyone SEES the
  // queue, so it is the first moment "whose phone is this?" can be checked against reality —
  // and the last, because applying stamps the label onto every contact as a tag.
  const run = useQuery({
    queryKey: ['contact-sync', 'session', sessionId],
    queryFn: () =>
      api.get<{ data: ContactSyncSession }>(`/api/v1/contacts/sync-sessions/${sessionId}`),
  });
  const syncedByLabel = run.data?.data.syncedByLabel ?? null;
  /**
   * The WhatsApp number that actually linked — the ONE piece of provenance that is measured
   * rather than typed, and the only thing this feature ever learns that a tenant cannot get
   * wrong. It reached the session and was then rendered nowhere a WhatsApp run ever goes: the
   * only reader was the dialog's finish screen, which a staged run skips entirely by
   * redirecting here. Since a real WhatsApp harvest is hundreds of contacts, it ALWAYS
   * stages — so the path with hard evidence displayed strictly less than the two anonymous
   * ones, and this card said "Not recorded" while the verified number sat in the response.
   *
   * Trimmed, because linkedPhone is `.nullish()` on the wire and can arrive as ''.
   */
  const waPhone = run.data?.data.waPhone?.trim() || null;
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  // null draft = not editing. Deliberately NOT seeded from the server value on every render,
  // which would clobber what the operator is mid-way through typing.
  const editingLabel = labelDraft !== null;

  const saveLabel = useMutation({
    mutationFn: (value: string | null) =>
      api.patch<{ data: ContactSyncSession }>(
        `/api/v1/contacts/sync-sessions/${sessionId}/label`,
        { syncedByLabel: value },
      ),
    onSuccess: () => {
      setLabelDraft(null);
      void qc.invalidateQueries({ queryKey: ['contact-sync', 'session', sessionId] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not save that.'),
  });

  const decide = useMutation({
    mutationFn: (body: {
      action: 'include' | 'exclude';
      ids?: string[];
      scope?: 'all' | 'existing' | 'no_name';
    }) => api.post(`/api/v1/contacts/sync-sessions/${sessionId}/staged/decide`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contact-sync', 'staged', sessionId] });
      // The button's number lives in the summary, so a selection change must refresh it —
      // otherwise ticking a row leaves the count stale and the button lies again.
      void qc.invalidateQueries({ queryKey: ['contact-sync', 'staged-summary', sessionId] });
    },
    onError: () => toast.error('Could not update that selection.'),
  });

  const apply = useMutation({
    mutationFn: () =>
      api.post<{ data: { created: number; updated: number; skipped: number } }>(
        `/api/v1/contacts/sync-sessions/${sessionId}/apply`,
        {},
      ),
    onSuccess: (res) => {
      void qc.resetQueries({ queryKey: ['contacts'] });
      // So the undo strip on /contacts is already populated when we land there, rather than
      // appearing a beat later — this run is the whole reason the tenant is being redirected.
      void qc.invalidateQueries({ queryKey: ['contact-sync', 'recent-runs'] });
      toast.success(`${res.data.created} contacts added. You can undo this for 7 days.`);
      router.push('/contacts');
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not import those.'),
  });

  const discard = useMutation({
    mutationFn: () => api.delete(`/api/v1/contacts/sync-sessions/${sessionId}/staged`),
    onSuccess: () => {
      toast.success('Discarded. Nothing was imported.');
      router.push('/contacts');
    },
    onError: () => toast.error('Could not discard that.'),
  });

  return (
    <>
      <PageHeader
        title="Review contacts before adding"
        description="These came from your phone. Everything is selected — untick anything you don't want, then add them."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => discard.mutate()} disabled={discard.isPending}>
              <Trash2 className="size-4" /> Discard
            </Button>
            {/* FLUSH THE LABEL FIRST. The label card has its own Save button, and this one
                sits in the page header far away from it — so the natural sequence (type the
                label, then press the big primary button) silently threw the typing away and
                imported everything with no provenance at all. Worse, it is then permanent:
                PATCH .../label is guarded to status 'review', and this click makes the run
                'completed', so the correction 409s forever. mutateAsync so the write lands
                BEFORE apply reads the row. */}
            <Button
              onClick={async () => {
                if (labelDraft !== null) {
                  try {
                    await saveLabel.mutateAsync((labelDraft ?? '').trim() || null);
                  } catch {
                    // saveLabel surfaces its own toast. Stop rather than import 1,400
                    // contacts under a label the tenant believes they set.
                    return;
                  }
                }
                apply.mutate();
              }}
              disabled={apply.isPending || saveLabel.isPending || includedCount === 0}
            >
              {apply.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Add {includedCount} contact{includedCount === 1 ? '' : 's'}
            </Button>
          </div>
        }
      />

      <div className="mb-4">
        <Link
          href="/contacts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to contacts
        </Link>
      </div>

      {/* Shown ALWAYS, including when blank. Everywhere else provenance is read back it is
          one contact among thousands; here it is the whole run, it is still changeable, and
          "Not recorded" is the sentence that prompts someone to fix it before it is fixed
          forever. Never falls back to the signed-in member's name. */}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Whose phone this came from</p>
            {editingLabel ? (
              <Input
                autoFocus
                value={labelDraft ?? ''}
                maxLength={CONTACT_SYNC_LABEL_MAX_CHARS}
                placeholder="Rita's iPhone, Shop counter phone…"
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveLabel.mutate((labelDraft ?? '').trim() || null);
                  if (e.key === 'Escape') setLabelDraft(null);
                }}
                className="mt-1 max-w-xs"
              />
            ) : (
              <>
                <p className="mt-0.5 truncate text-sm font-medium">
                  {syncedByLabel ?? (
                    <span className="font-normal text-muted-foreground">Not recorded</span>
                  )}
                </p>
                {/* Shown SEPARATELY from the typed label, never merged into it. One is a fact
                    WhatsApp gave us; the other is a claim a person typed. Fusing them would
                    make the two indistinguishable afterwards. */}
                {waPhone ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Linked WhatsApp account <span className="tabular-nums">+{waPhone}</span> —
                    confirmed by WhatsApp, not typed.
                  </p>
                ) : null}
              </>
            )}
          </div>
          {editingLabel ? (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setLabelDraft(null)}>
                Cancel
              </Button>
              <Button
                disabled={saveLabel.isPending}
                onClick={() => saveLabel.mutate((labelDraft ?? '').trim() || null)}
              >
                {saveLabel.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Save
              </Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setLabelDraft(syncedByLabel ?? '')}>
              <Pencil className="size-4" /> {syncedByLabel ? 'Change' : 'Add'}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or number…"
                className="pl-9"
              />
            </div>
            <Button variant="secondary" onClick={() => decide.mutate({ action: 'include', scope: 'all' })}>
              Select all
            </Button>
            <Button variant="secondary" onClick={() => decide.mutate({ action: 'exclude', scope: 'all' })}>
              Select none
            </Button>
            {knownCount > 0 ? (
              <Button
                variant="secondary"
                onClick={() => decide.mutate({ action: 'exclude', scope: 'existing' })}
              >
                Untick {knownCount} already saved
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => decide.mutate({ action: 'exclude', scope: 'no_name' })}
            >
              Untick unnamed
            </Button>
          </div>

          {q.isLoading ? (
            <SkeletonRows rows={8} />
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {debounced ? 'Nothing matches that search.' : 'This review queue is empty.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="w-10 py-2" />
                    <th className="py-2">Name</th>
                    <th className="py-2">Number</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} className="border-b border-border/60">
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={it.included}
                          aria-label={`Include ${it.displayName ?? it.phoneE164}`}
                          onChange={(e) =>
                            decide.mutate({
                              action: e.target.checked ? 'include' : 'exclude',
                              ids: [it.id],
                            })
                          }
                          className="size-4"
                        />
                      </td>
                      <td className="py-2">
                        {it.displayName ?? <span className="text-muted-foreground">No name</span>}
                      </td>
                      <td className="py-2 font-mono text-xs tabular-nums">{it.phoneE164}</td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {it.alreadyKnown ? 'Already saved' : 'New'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Say what is on screen versus what is in the queue. Silence here is what let
              700 unseen contacts get imported by a button labelled with the number 500. */}
          {items.length > 0 ? (
            <div className="flex flex-col items-center gap-2 pt-2">
              <p className="text-xs text-muted-foreground">
                {debounced
                  ? `Showing ${items.length} matching contact${items.length === 1 ? '' : 's'}.`
                  : `Showing ${items.length} of ${totalCount}.`}
              </p>
              {hasMore ? (
                <Button variant="secondary" onClick={() => setPages((p) => p + 1)}>
                  {q.isFetching ? <Loader2 className="size-4 animate-spin" /> : null}
                  Show more
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
