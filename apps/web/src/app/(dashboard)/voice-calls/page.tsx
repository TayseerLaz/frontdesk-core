'use client';

import { useQuery } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDuration, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

type Outcome = 'in_progress' | 'completed' | 'handoff' | 'dropped';

interface VoiceCall {
  id: string;
  callUuid: string;
  callerId: string | null;
  dialedExten: string | null;
  outcome: Outcome;
  handoffReason: string | null;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
}

interface VoiceTurn {
  id: string;
  role: 'caller' | 'assistant';
  text: string;
  at: string;
}

interface VoiceCallDetail extends Omit<VoiceCall, 'turnCount'> {
  turns: VoiceTurn[];
}

const OUTCOME_VARIANT: Record<Outcome, 'muted' | 'success' | 'warning' | 'danger'> = {
  in_progress: 'warning',
  completed: 'success',
  handoff: 'muted',
  dropped: 'danger',
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  handoff: 'To human',
  dropped: 'Dropped',
};

// Wall-clock duration of a finished call. null while the call is still live.
function callDuration(c: { startedAt: string; endedAt: string | null }): string {
  if (!c.endedAt) return '—';
  const seconds = (new Date(c.endedAt).getTime() - new Date(c.startedAt).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return formatDuration(seconds);
}

export default function VoiceCallsPage() {
  // Cursor "load more" — accumulate pages as the operator pages down. Mirrors
  // the carts list cadence (no auto-poll; the list is historical).
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<VoiceCall[][]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const page = useQuery({
    queryKey: ['voice-calls', cursor],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (cursor) params.set('cursor', cursor);
      return api.get<{ data: VoiceCall[]; nextCursor: string | null }>(
        `/api/v1/voice/calls?${params.toString()}`,
      );
    },
  });

  // Fold each freshly-loaded page into the accumulator. Keyed by cursor so a
  // given page is only appended once even across re-renders.
  useEffect(() => {
    if (!page.data) return;
    setPages((prev) => {
      // The first page (cursor === null) resets the list.
      if (cursor === null) return [page.data!.data];
      // Avoid double-appending the same page object on re-render.
      if (prev.length > 0 && prev[prev.length - 1] === page.data!.data) return prev;
      return [...prev, page.data!.data];
    });
    setNextCursor(page.data.nextCursor);
  }, [page.data, cursor]);

  const rows = pages.flat();
  const isFirstLoad = page.isLoading && rows.length === 0;

  return (
    <>
      <PageHeader
        title="Voice calls"
        description="Calls answered by your AI voicebot. Click any call to read its full transcript. Configure phone lines on Settings → Phone integration."
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <PhoneCall className="size-4 text-brand-600" />
            {rows.length} {rows.length === 1 ? 'call' : 'calls'}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isFirstLoad ? (
            <div className="py-2">
              <SkeletonRows rows={6} cols={5} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={PhoneCall}
              title="No voice calls yet"
              description="When a caller reaches your AI voicebot, the call and its transcript appear here."
            />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-4 py-3 sm:px-6">Started</th>
                  <th className="px-6 py-3">Caller</th>
                  <th className="px-6 py-3">Outcome</th>
                  <th className="hidden px-6 py-3 text-right sm:table-cell">Duration</th>
                  <th className="hidden px-6 py-3 text-right sm:table-cell">Turns</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setOpenId(c.id)}
                    className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-surface-muted/40"
                  >
                    <td className="whitespace-nowrap px-4 py-4 text-xs text-foreground-muted sm:px-6">
                      {new Date(c.startedAt).toLocaleString()}
                      <div className="text-[10px] text-foreground-subtle">
                        {formatRelative(c.startedAt)}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-mono text-sm">{c.callerId ?? 'unknown'}</div>
                      {c.dialedExten ? (
                        <div className="text-[11px] text-foreground-subtle">
                          dialed {c.dialedExten}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant={OUTCOME_VARIANT[c.outcome]}>{OUTCOME_LABEL[c.outcome]}</Badge>
                      {c.handoffReason ? (
                        <div className="mt-0.5 text-[11px] text-foreground-subtle">
                          {c.handoffReason}
                        </div>
                      ) : null}
                    </td>
                    <td className="hidden whitespace-nowrap px-6 py-4 text-right font-mono text-sm sm:table-cell">
                      {callDuration(c)}
                    </td>
                    <td className="hidden px-6 py-4 text-right font-mono text-sm sm:table-cell">{c.turnCount}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </CardContent>
      </Card>

      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            loading={page.isFetching}
            onClick={() => setCursor(nextCursor)}
          >
            Load more
          </Button>
        </div>
      ) : null}

      <CallTranscriptDialog callId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function CallTranscriptDialog({
  callId,
  onClose,
}: {
  callId: string | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    enabled: !!callId,
    queryKey: ['voice-call', callId],
    queryFn: () => api.get<{ data: VoiceCallDetail }>(`/api/v1/voice/calls/${callId}`),
  });

  const call = detail.data?.data ?? null;

  return (
    <Dialog open={!!callId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PhoneCall className="size-4 text-brand-600" />
            {call?.callerId ?? 'Call transcript'}
          </DialogTitle>
          <DialogDescription>
            {call ? (
              <>
                {new Date(call.startedAt).toLocaleString()} · {callDuration(call)} ·{' '}
                {call.turns.length} {call.turns.length === 1 ? 'turn' : 'turns'}
                {call.outcome ? ` · ${OUTCOME_LABEL[call.outcome]}` : ''}
              </>
            ) : (
              'Loading transcript…'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {detail.isLoading ? (
            <SkeletonRows rows={5} cols={1} className="px-1 py-1" />
          ) : !call || call.turns.length === 0 ? (
            <p className="py-8 text-center text-sm text-foreground-muted">
              No transcript was captured for this call.
            </p>
          ) : (
            call.turns.map((t) => <TranscriptBubble key={t.id} turn={t} />)
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Caller vs assistant bubbles — mirrors the /inbox message styling (assistant
// right-aligned in brand, caller left-aligned muted).
function TranscriptBubble({ turn }: { turn: VoiceTurn }) {
  const isAssistant = turn.role === 'assistant';
  return (
    <div className={cn('flex flex-col', isAssistant ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed shadow-sm',
          isAssistant ? 'bg-brand-500 text-on-brand' : 'bg-surface-muted text-foreground',
        )}
      >
        <p
          className={cn(
            'mb-1 text-[10px] font-semibold uppercase tracking-wide',
            isAssistant ? 'text-white/80' : 'text-foreground-subtle',
          )}
        >
          {isAssistant ? 'Assistant' : 'Caller'}
        </p>
        <p className="whitespace-pre-wrap break-words">{turn.text}</p>
        <div
          className={cn(
            'mt-1.5 text-[11px]',
            isAssistant ? 'text-white/80' : 'text-foreground-subtle',
          )}
        >
          {formatRelative(turn.at)}
        </div>
      </div>
    </div>
  );
}
