'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  Inbox,
  Info,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Phone,
  RotateCcw,
  Send,
  Sparkles,
  Mic,
  StickyNote,
  Tag as TagIcon,
  Trash2,
  UserX,
  UserCheck,
  X,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { CustomerInfoSheet } from '@/components/customer/customer-info-sheet';
import { CannedManager } from '@/components/inbox/canned-manager';
import { InitialsAvatar } from '@/components/inbox/initials-avatar';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ImageLightbox } from '@/components/ui/image-lightbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { connectSse } from '@/lib/sse';
import { cn } from '@/lib/utils';

type ThreadStatus = 'open' | 'pending' | 'resolved' | 'escalated';

// Minimal shape we use from the dynamically-imported opus-recorder
// package. The library doesn't ship TS types of its own, so we keep
// this shim local rather than pulling in a separate @types package.
interface OpusRecorderLike {
  start: () => Promise<void>;
  stop: () => Promise<void> | void;
  ondataavailable?: (data: Uint8Array) => void;
  onstop?: () => void;
  onerror?: (err: unknown) => void;
}
interface OpusRecorderOptions {
  encoderPath: string;
  streamPages?: boolean;
  encoderApplication?: number;
  encoderSampleRate?: number;
  numberOfChannels?: number;
}
type OpusRecorderCtor = new (opts: OpusRecorderOptions) => OpusRecorderLike;

interface Thread {
  id: string;
  // 'whatsapp' | 'messenger' | 'instagram'
  channel?: string;
  // Multi-number: which WhatsApp number this thread belongs to + its label, so
  // the inbox can show a per-number inbox and reply from the right number.
  whatsAppChannelId?: string | null;
  whatsAppChannelLabel?: string | null;
  whatsAppChannelPhone?: string | null;
  customerPhone: string;
  customerName: string | null;
  // Read-only mirror of the customer's WhatsApp profile name from Meta.
  customerWhatsappName: string | null;
  status: ThreadStatus;
  assignedToUserId: string | null;
  assignedToName: string | null;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  inboundCount: number;
  outboundCount: number;
  isChat?: boolean;
  unread?: boolean;
  answered?: boolean;
  tags: string[];
  noteCount: number;
  // Phase 6 — per-thread bot reply-mode override. null = inherit BotConfig.
  botReplyMode: 'text' | 'voice' | 'match_customer' | null;
  // Operator block: true when the customer is blocked. No bot replies + no
  // outbound messages can be sent. Inbound still arrives.
  blocked?: boolean;
  // Customer tapped Unsubscribe / sent STOP — excluded from every broadcast.
  optedOut?: boolean;
  createdAt: string;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  metaMessageId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  messageType: string | null;
  body: string | null;
  receivedAt: string;
  sentBy: 'bot' | 'operator' | null;
  // Phase 8 / 1.5 — for image-type bot messages, the upstream source.
  // Either the greeting image set on /bot, or a product image by SKU.
  imageSource: { kind: 'greeting' | 'product'; productSku: string | null } | null;
  // Signed, directly-loadable URL for image messages so the chat renders
  // the actual photo. Null when not stored / storage unconfigured.
  mediaUrl?: string | null;
  // Quick-reply button labels the bot offered (Messenger / Instagram). Shown
  // as non-interactive pills under the bubble. Null/absent when none.
  quickReplies?: string[] | null;
  // Header media (Wasabi URL) for media-header template messages.
  headerImageUrl?: string | null;
  // 'image' | 'video' | 'document' — how to render headerImageUrl.
  headerMediaType?: string | null;
  // Meta delivery state for outbound messages → WhatsApp-style ticks.
  deliveryStatus?: 'sent' | 'delivered' | 'read' | 'failed' | null;
  // Shared-location (WhatsApp) coordinates so the bubble renders a map link
  // instead of a bare "[location]". Null/absent for non-location messages.
  location?: {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
  } | null;
}

// Phase 8 / 1.3 — shape returned by GET /inbox/messages/:id/provenance.
// Only ALIGNED admins ever fetch this.
interface MessageProvenance {
  messageId: string;
  organizationId: string;
  systemPrompt: { sha256: string; body: string };
  userPrompt: string;
  historyJson: { role: 'user' | 'assistant'; content: string }[];
  candidates: {
    products: { id: string; name: string; sku: string; priceMinor: number | null; currency: string | null }[];
    services: { id: string; name: string; basePriceMinor: number | null; currency: string | null }[];
    faqs: { id: string; question: string; answer: string }[];
    policyKinds: string[];
    businessInfoFields: string[];
  };
  citations:
    | {
        type:
          | 'product'
          | 'service'
          | 'faq'
          | 'policy'
          | 'business_info'
          | 'bot_config'
          | 'customer_profile';
        id: string | null;
        label: string;
        snippet: string;
        confidence: number;
        meta?: Record<string, unknown> | null;
      }[]
    | null;
  hallucinations:
    | {
        type: 'unknown_product' | 'price_drift' | 'unknown_business_info';
        matchedText: string;
        context: string;
        severity: 'critical' | 'warning';
        reason: string;
      }[]
    | null;
  // Phase 8 / 1.7 — operator-recorded decisions on each hallucination
  // flag. Keyed by flagIndex (position in `hallucinations` array).
  flagDecisions?: {
    flagIndex: number;
    decision: 'false_positive' | 'true_positive' | 'skip';
    decidedAt: string;
    note: string | null;
  }[];
  // Phase 13 — per-station pipeline trace from received → sent.
  pipelineTimings?: {
    totalMs: number;
    laps: {
      station: string;
      durationMs: number;
      cumulativeMs: number;
      meta?: Record<string, unknown> | null;
    }[];
  } | null;
  model: string;
  temperature: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt: string;
}

interface Note {
  id: string;
  authorUserId: string | null;
  authorName: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: string;
}

interface CannedResponse {
  id: string;
  shortcut: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: 'Open',
  pending: 'Needs human',
  resolved: 'Resolved',
  escalated: 'Escalated',
};

const STATUS_VARIANT: Record<ThreadStatus, 'default' | 'success' | 'warning' | 'danger' | 'muted'> = {
  open: 'default',
  pending: 'warning',
  resolved: 'success',
  escalated: 'danger',
};

/**
 * The full Inbox UI. Rendered in two shells:
 *  - inside the dashboard (sidebar + top bar) at /inbox, and
 *  - chrome-less and full-height at /inbox-full (opens in its own tab),
 *    for operators who want a distraction-free, bigger workspace.
 *
 * `fullscreen` only changes the OUTER framing (drops the in-page header and
 * claims the whole viewport height). Every feature, query, and permission
 * check below is identical in both shells — and both are gated by the same
 * auth guard + hit the same RBAC/RLS-enforced API, so the bigger view is no
 * less secure than the embedded one.
 */
export function InboxScreen({ fullscreen = false }: { fullscreen?: boolean }) {
  const queryClient = useQueryClient();
  const { session } = useSession();
  // Honour ?thread=<uuid> on initial mount so /hq/provenance's
  // "View thread →" link lands the operator on the right conversation.
  // SearchParams is read once at mount; subsequent thread clicks just
  // update `activeId` without touching the URL.
  const searchParams = useSearchParams();
  const initialThreadId = searchParams?.get('thread') ?? null;
  const [activeId, setActiveId] = useState<string | null>(initialThreadId);
  // Phase 7 — filters initialise FROM the URL so a refresh, a shared link, or a
  // deep link like /inbox?status=escalated (from the top-bar status strip)
  // preserves them; they sync back to the URL as they change (effect below).
  const [filterQ, setFilterQ] = useState(searchParams?.get('q') ?? '');
  // View filter: all | mine (assigned to me) | unassigned (waiting for a
  // human) | chats | unread | unanswered | answered.
  type ViewTab = 'all' | 'mine' | 'unassigned' | 'chats' | 'unread' | 'unanswered' | 'answered';
  const [filterView, setFilterView] = useState<ViewTab>(
    (searchParams?.get('view') as ViewTab) ?? 'all',
  );
  // Channel filter. Platform values ('whatsapp'|'messenger'|'instagram') OR a
  // per-number value 'wa:<channelId>' so the operator can pick a single
  // WhatsApp number's inbox. Reconstructed from the URL's channel +
  // whatsAppChannelId params.
  // Multi-select channel chips. Empty = all channels. Values are platform
  // tokens ('whatsapp' | 'messenger' | 'instagram') or 'wa:<channelId>'.
  const [filterChannels, setFilterChannels] = useState<string[]>(() => {
    const multi = searchParams?.get('channels');
    const waIds = searchParams?.get('whatsAppChannelIds');
    const list = [
      ...(multi ? multi.split(',').filter(Boolean) : []),
      ...(waIds ? waIds.split(',').filter(Boolean).map((id) => `wa:${id}`) : []),
    ];
    if (list.length) return list;
    // Legacy single-value URLs still restore.
    const ch = searchParams?.get('channel');
    const waId = searchParams?.get('whatsAppChannelId');
    if (waId) return [`wa:${waId}`];
    return ch && ch !== 'all' ? [ch] : [];
  });
  const waSelected = filterChannels.filter((v) => v.startsWith('wa:')).map((v) => v.slice(3));
  const platformsSelected = filterChannels.filter((v) => !v.startsWith('wa:'));
  // Canned-reply management now lives in the inbox itself (a dialog), not a
  // separate sidebar page.
  const [cannedOpen, setCannedOpen] = useState(false);

  // The org's WhatsApp numbers — drives the per-number entries in the channel
  // filter and the "replying from" labels.
  const numbersQ = useQuery({
    queryKey: ['whatsapp-numbers'],
    queryFn: () =>
      api.get<{ data: { id: string; label: string | null; displayPhoneNumber: string | null; isPrimary: boolean }[] }>(
        '/api/v1/whatsapp/numbers',
      ),
    staleTime: 60_000,
  });
  const waNumbers = numbersQ.data?.data ?? [];
  const waNumberName = (n: { label: string | null; displayPhoneNumber: string | null }): string =>
    n.label || n.displayPhoneNumber || 'WhatsApp number';

  const params = new URLSearchParams();
  if (filterQ.trim()) params.set('q', filterQ.trim());
  // 'mine' is a client-side alias — the server filters by assignee id.
  if (filterView === 'mine') {
    if (session?.user.id) params.set('assignee', session.user.id);
  } else if (filterView !== 'all') {
    params.set('view', filterView);
  }
  if (waSelected.length) params.set('whatsAppChannelIds', waSelected.join(','));
  if (platformsSelected.length) params.set('channels', platformsSelected.join(','));

  // Tab badges for Mine / Unassigned (F7). Same key as the sidebar badge
  // query -> shared cache, no extra request; extra fields are additive.
  const countsQ = useQuery({
    queryKey: ['sidebar-inbox-counts'],
    queryFn: () =>
      api.get<{ data: { escalated: number; pending: number; open: number; mine: number; unassigned: number } }>(
        '/api/v1/inbox/counts',
      ),
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const inboxCounts = countsQ.data?.data;

  const threadsQ = useInfiniteQuery({
    queryKey: ['inbox-threads', filterQ, filterChannels.join(','), filterView, filterView === 'mine' ? session?.user.id ?? '' : ''],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      if (pageParam) p.set('cursor', pageParam);
      return api.get<{ data: Thread[]; nextCursor: string | null; total?: number }>(
        `/api/v1/inbox/threads?${p.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // 30 s background poll as a fallback. The SSE hook below invalidates
    // on every server tick so the perceived freshness is sub-2s.
    refetchInterval: 30_000,
  });

  // Phase 8 / 1.3 — per-thread hallucination counts for the red-dot.
  // Only fetched for ALIGNED admins. One round-trip across all threads.
  const isAdmin = session?.user.isSuperAdmin === true;
  // Per-channel access control — hide Messenger/Instagram from the channel
  // filter when ALIGNED-admin turned them off for this workspace.
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  // Roadmap features are opt-in (owner directive 2026-08-29): hide the
  // teamwork tabs until HQ enables inbox_teamwork for this org.
  const teamworkOn = !disabledFeatures.includes('inbox_teamwork');
  useEffect(() => {
    if (!teamworkOn && (filterView === 'mine' || filterView === 'unassigned')) setFilterView('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamworkOn, filterView]);
  const flaggedQ = useQuery({
    queryKey: ['inbox-flagged-summary'],
    queryFn: () =>
      api.get<{ data: { threadId: string; flaggedCount: number }[] }>(
        '/api/v1/inbox/threads/flagged-summary',
      ),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });
  const flaggedByThread = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of flaggedQ.data?.data ?? []) m.set(r.threadId, r.flaggedCount);
    return m;
  }, [flaggedQ.data]);

  // SSE realtime: every 2s tick from the server invalidates the thread
  // queries so they refetch. Cheap for the server (one timer per
  // connected client, no per-event fan-out yet) and works fine through
  // Caddy's HTTP/2 reverse proxy.
  useInboxSSE();

  const threads = useMemo(
    () => threadsQ.data?.pages.flatMap((p) => p.data) ?? [],
    [threadsQ.data],
  );
  // Real total for the current filter (not just how many are loaded).
  const totalThreads = threadsQ.data?.pages[0]?.total ?? threads.length;

  // Fetch the OPEN thread by id as a stable fallback. During a broadcast every
  // recipient's thread bumps to the top of the (last-message-ordered) list,
  // which pushes the conversation the operator is viewing down and off the
  // loaded/refetched pages — then `threads.find` returns null and the detail
  // pane empties ("it takes me out of the convo"). Fetching it by id keeps it
  // open + fresh regardless of the list churn. Shares the ['inbox-thread', id]
  // key prefix so the existing onChanged / SSE invalidations refresh it too.
  const activeThreadQ = useQuery({
    queryKey: ['inbox-thread', activeId, 'row'],
    queryFn: () => api.get<{ data: Thread }>(`/api/v1/inbox/threads/${activeId}`),
    enabled: !!activeId,
    staleTime: 5_000,
  });
  const active =
    threads.find((t) => t.id === activeId) ??
    (activeThreadQ.data?.data.id === activeId ? activeThreadQ.data.data : null);

  // Auto-select the first thread ONLY on desktop (the two-pane lg+ layout always
  // wants a conversation showing). On mobile this must NOT run: the master-detail
  // view starts on the list, and re-selecting here would instantly undo the
  // header "back" button (which clears activeId to return to the list).
  useEffect(() => {
    if (
      !activeId &&
      threads.length > 0 &&
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 1024px)').matches
    ) {
      setActiveId(threads[0]!.id);
    }
  }, [activeId, threads]);

  // Phase 7 — keep the URL in sync with filters + the open thread (refresh-safe,
  // shareable). replaceState avoids a Next navigation (the inbox is heavy).
  useEffect(() => {
    const sp = new URLSearchParams();
    if (filterQ.trim()) sp.set('q', filterQ.trim());
    if (filterView !== 'all') sp.set('view', filterView);
    if (waSelected.length) sp.set('whatsAppChannelIds', waSelected.join(','));
    if (platformsSelected.length) sp.set('channels', platformsSelected.join(','));
    if (activeId) sp.set('thread', activeId);
    const qs = sp.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [filterQ, filterView, filterChannels, activeId]);

  // Phase 7 — arrow-key / j-k thread navigation (operators live here, keyboard-
  // first). Ignored while typing in a field or with a modifier held. Scrolls the
  // newly-active row into view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const down = e.key === 'ArrowDown' || e.key === 'j';
      const up = e.key === 'ArrowUp' || e.key === 'k';
      if ((!down && !up) || threads.length === 0) return;
      e.preventDefault();
      const idx = threads.findIndex((t) => t.id === activeId);
      const next = idx < 0 ? 0 : Math.min(Math.max(idx + (down ? 1 : -1), 0), threads.length - 1);
      const id = threads[next]!.id;
      setActiveId(id);
      requestAnimationFrame(() =>
        document.querySelector(`[data-thread-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }),
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threads, activeId]);

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        // Full-screen tab claims the whole viewport (no top bar to offset
        // against); embedded view subtracts the 4rem dashboard top bar.
        fullscreen ? 'h-dvh' : 'h-[calc(100dvh-4rem)]',
      )}
    >
      {fullscreen ? (
        // Chrome-less mode: a single slim strip instead of the full page
        // header. Hidden on phones — the chat needs every pixel there; desktop
        // keeps the brand + count strip + canned-replies shortcut.
        <div className="hidden shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2.5 lg:flex">
          <Inbox className="size-4 text-brand-600" />
          <span className="text-sm font-semibold text-foreground">Inbox</span>
          <Badge variant="muted" className="gap-1">
            <MessageCircle className="size-3" />{' '}
            {threads.length < totalThreads
              ? `${threads.length} of ${totalThreads} threads`
              : `${totalThreads} thread${totalThreads === 1 ? '' : 's'}`}
          </Badge>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setCannedOpen(true)}>
            <FileText className="size-4" /> Canned replies
          </Button>
        </div>
      ) : (
        <PageHeader
          title="Inbox"
          description="Every WhatsApp conversation. Status, tags, assignment, internal notes — all here."
          actions={
            <>
              <Badge variant="muted" className="gap-1">
                <MessageCircle className="size-3" />{' '}
                {threads.length < totalThreads
                  ? `${threads.length} of ${totalThreads} threads`
                  : `${totalThreads} thread${totalThreads === 1 ? '' : 's'}`}
              </Badge>
              <Button variant="secondary" size="sm" onClick={() => setCannedOpen(true)}>
                <FileText className="size-4" /> Canned replies
              </Button>
            </>
          }
        />
      )}

      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden border border-[#E3DBCE] bg-[#FCFBFA] lg:grid-cols-[25rem_1fr]',
          // Rounded card only makes sense embedded; full-screen goes edge-to-edge.
          fullscreen ? '' : 'rounded-lg',
        )}
      >
        {/* Mobile master-detail: show the thread LIST when nothing is selected,
            and the CONVERSATION when a thread is open. Both panes show side-by-
            side from lg up. */}
        <div
          className={cn(
            'min-h-0 flex-col border-r border-[#E3DBCE] bg-[#FBF8F3] lg:flex',
            activeId ? 'hidden lg:flex' : 'flex',
          )}
        >
          {/* Filters pinned to the top of the thread-list column so the
              conversation pane on the right gets the full vertical space. */}
          <div className="grid shrink-0 grid-cols-1 gap-1.5 border-b border-[#E3DBCE] bg-[#FBF8F3] px-2.5 py-2 sm:gap-2 sm:px-3 sm:py-3">
            {/* Thread count — shown on phones (desktop has it in the top strip). */}
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted lg:hidden">
              <MessageCircle className="size-3.5 text-brand-600" />
              {threads.length < totalThreads
                ? `${threads.length} of ${totalThreads} threads`
                : `${totalThreads} thread${totalThreads === 1 ? '' : 's'}`}
            </div>
            <Input
              placeholder="Search by phone, name, or message…"
              value={filterQ}
              onChange={(e) => setFilterQ(e.target.value)}
              aria-label="Search conversations"
              className="h-9 text-sm"
            />
            {/* View filter — All / Chats (real convos) / Unread / Read / Answered. */}
            <div className="flex items-center gap-1 overflow-x-auto rounded-lg bg-[#F3ECE0] p-[3px] text-xs [scrollbar-width:none]">
              {(
                [
                  ['all', 'All'],
                  ['mine', inboxCounts && inboxCounts.mine > 0 ? `Mine (${inboxCounts.mine})` : 'Mine'],
                  [
                    'unassigned',
                    inboxCounts && inboxCounts.unassigned > 0
                      ? `Unassigned (${inboxCounts.unassigned})`
                      : 'Unassigned',
                  ],
                  ['chats', 'Chats'],
                  ['unread', 'Unread'],
                  ['unanswered', 'Unanswered'],
                  ['answered', 'Answered'],
                ] as [ViewTab, string][]
              )
                .filter(([v]) => teamworkOn || (v !== 'mine' && v !== 'unassigned'))
                .map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setFilterView(v)}
                  className={`flex-1 whitespace-nowrap rounded-md px-2 py-1 font-medium ${
                    filterView === v
                      ? 'bg-[#360516] text-[#FCFBFA]'
                      : 'text-[#6C625C] hover:bg-[#E6DCCB]/60'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {/* Channel chips (mockup style). Click toggles; no active chip =
                all channels. One chip per WhatsApp number when there are
                several so each number keeps its own inbox. */}
            <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
              {(waNumbers.length <= 1
                ? [{ v: 'whatsapp', label: 'WhatsApp', dot: 'bg-[#3B6D11]' }]
                : waNumbers.map((n) => ({
                    v: `wa:${n.id}`,
                    label: waNumberName(n),
                    dot: 'bg-[#3B6D11]',
                  }))
              )
                .concat(
                  disabledFeatures.includes('messenger')
                    ? []
                    : [{ v: 'messenger', label: 'Facebook', dot: 'bg-[#185FA5]' }],
                )
                .concat(
                  disabledFeatures.includes('instagram')
                    ? []
                    : [{ v: 'instagram', label: 'Instagram', dot: 'bg-[#993556]' }],
                )
                .map((c) => (
                  <button
                    key={c.v}
                    type="button"
                    aria-pressed={filterChannels.includes(c.v)}
                    onClick={() =>
                      setFilterChannels((prev) =>
                        prev.includes(c.v) ? prev.filter((x) => x !== c.v) : [...prev, c.v],
                      )
                    }
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                      filterChannels.includes(c.v)
                        ? 'border-[#4A1525] bg-[#4A1525] text-[#FCFBFA]'
                        : 'border-[#D6C9B4] bg-white text-[#6C625C] hover:bg-[#F3ECE0]',
                    )}
                  >
                    <span aria-hidden className={cn('size-1.5 rounded-full', c.dot)} />
                    {c.label}
                  </button>
                ))}
            </div>
          </div>
          <ThreadList
            threads={threads}
            activeId={activeId}
            onSelect={setActiveId}
            loading={threadsQ.isLoading}
            flaggedByThread={flaggedByThread}
            hasMore={threadsQ.hasNextPage}
            loadingMore={threadsQ.isFetchingNextPage}
            onLoadMore={() => void threadsQ.fetchNextPage()}
          />
        </div>
        <div
          className={cn(
            'min-h-0 min-w-0 flex-col lg:flex',
            activeId ? 'flex' : 'hidden lg:flex',
          )}
        >
          <ThreadView
            thread={active}
            onBack={() => setActiveId(null)}
            onChanged={() => {
              queryClient.invalidateQueries({ queryKey: ['inbox-threads'] });
              if (active) queryClient.invalidateQueries({ queryKey: ['inbox-thread', active.id] });
              // Inbox-counts drives the red Inbox badge in the sidebar.
              // Any thread change (status flip, assign, tag, etc.) can
              // shift the counts so we invalidate eagerly — the actual
              // refetch is gated by staleTime on the sidebar query.
              queryClient.invalidateQueries({ queryKey: ['sidebar-inbox-counts'] });
            }}
            onDeleted={() => setActiveId(null)}
            currentUserId={session?.user.id ?? null}
          />
        </div>
      </div>

      {/* Canned-reply management — now a feature inside the inbox (was a separate
          sidebar page). Insertion into the reply box still happens in ReplyBox. */}
      <Dialog open={cannedOpen} onOpenChange={setCannedOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Canned replies</DialogTitle>
            <DialogDescription>
              Manage quick-reply templates. Insert them in the reply box by typing{' '}
              <span className="font-mono">/shortcut</span>.
            </DialogDescription>
          </DialogHeader>
          <CannedManager />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ThreadList({
  threads,
  activeId,
  onSelect,
  loading,
  flaggedByThread,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  threads: Thread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  // Phase 8 / 1.3 — ALIGNED-admin only: map of threadId → hallucination
  // count. Renders a red dot on flagged threads. Empty map when the user
  // isn't an admin (the parent never fetches the summary).
  flaggedByThread: Map<string, number>;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto overscroll-none" aria-label="Conversations">
      {loading ? (
        // Skeleton that mirrors the real row layout → no shift when data lands.
        Array.from({ length: 7 }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 border-b border-border px-3 py-3">
            <div className="size-9 shrink-0 animate-pulse rounded-full bg-surface-elevated" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-1/2 animate-pulse rounded bg-surface-elevated" />
              <div className="h-3 w-3/4 animate-pulse rounded bg-surface-elevated" />
            </div>
          </li>
        ))
      ) : threads.length === 0 ? (
        <li>
          <EmptyState
            icon={Inbox}
            title="No conversations"
            description="Inbound WhatsApp messages will land here once Meta starts posting."
          />
        </li>
      ) : (
        threads.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              data-thread-id={t.id}
              onClick={() => onSelect(t.id)}
              aria-current={activeId === t.id}
              className={cn(
                'flex w-full items-start gap-3 border-b border-[#EFE8DC] border-l-[3px] border-l-transparent px-3 py-3 text-left transition-colors hover:bg-[#F3ECE0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E53E34]/50',
                // Escalated "needs human" threads get a tint (no banned left
                // stripe) — the Escalated badge + the coral dot carry the signal.
                t.status === 'escalated' && 'bg-coral-50/70 hover:bg-coral-50',
                activeId === t.id && t.status !== 'escalated' && 'border-l-[#E53E34] bg-white hover:bg-white',
                activeId === t.id && t.status === 'escalated' && 'border-l-[#E53E34] bg-coral-100/70',
              )}
            >
              {/* Avatar — initials on a stable per-contact color, with the
                  channel badge pinned to the corner (mockup style). */}
              <span className="relative shrink-0">
                <InitialsAvatar
                  name={t.customerName ?? t.customerWhatsappName ?? t.customerPhone}
                  ai={!t.assignedToName && t.status === 'open'}
                />
                <ChannelBadge channel={t.channel} />
              </span>
              <div className="min-w-0 flex-1">
                {/* Line 1 — name + time */}
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-[#360516]">
                    {/* Unread mark — a new customer message we haven't opened. */}
                    {t.unread ? (
                      <span
                        className="inline-flex size-2.5 shrink-0 rounded-full bg-[#E53E34]"
                        title="Unread — new customer message"
                      />
                    ) : null}
                    <span className={cn('truncate', t.unread && 'font-bold')}>
                      {t.customerName ?? t.customerWhatsappName ?? t.customerPhone}
                    </span>
                    {/* ALIGNED-admin only — red dot for flagged bot replies. */}
                    {(flaggedByThread.get(t.id) ?? 0) > 0 ? (
                      <span
                        className="inline-flex size-2 shrink-0 rounded-full bg-rose-500"
                        title={`${flaggedByThread.get(t.id)} flagged bot reply${(flaggedByThread.get(t.id) ?? 0) > 1 ? 'ies' : ''}`}
                      />
                    ) : null}
                  </span>
                  <span className="whitespace-nowrap text-xs text-[#7A6F69]">
                    {shortTime(t.lastMessageAt)}
                  </span>
                </div>
                {/* Line 2 — last message preview */}
                <p className="mt-0.5 truncate text-sm text-foreground-muted">
                  {t.lastMessagePreview ?? <em className="text-foreground-subtle">no preview</em>}
                </p>
                {/* Line 3 — clean mockup tags: who's handling + only-notable
                    status + needs-reply + contact tags. No count clutter. */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {!t.assignedToName && t.status === 'open' ? (
                    <span className="rounded-[5px] bg-[#360516] px-1.5 py-px text-[10.5px] font-medium text-[#FCFBFA]">
                      AI replying
                    </span>
                  ) : null}
                  {t.assignedToName ? (
                    <span className="flex items-center gap-1 rounded-[5px] border border-[#E6DCCB] bg-[#F3ECE0] px-1.5 py-px text-[10.5px] font-medium text-[#4A1525]">
                      <UserCheck className="size-3" /> {t.assignedToName.split(' ')[0]}
                    </span>
                  ) : null}
                  {t.status !== 'open' ? (
                    <Badge variant={STATUS_VARIANT[t.status]} className="text-[11px]">
                      {STATUS_LABEL[t.status]}
                    </Badge>
                  ) : null}
                  {t.isChat && !t.answered ? (
                    <span className="rounded-[5px] border border-[#E53E34]/30 bg-[#E53E34]/10 px-1.5 py-px text-[10.5px] font-medium text-[#A32D2D]">
                      Needs reply
                    </span>
                  ) : null}
                  {t.optedOut ? (
                    <span className="rounded-[5px] border border-amber-300 bg-amber-50 px-1.5 py-px text-[10.5px] font-medium text-amber-800">
                      Unsubscribed
                    </span>
                  ) : null}
                  {t.tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-[5px] border border-[#E6DCCB] bg-[#F3ECE0] px-1.5 py-px text-[10.5px] font-medium text-[#4A1525]"
                    >
                      {tag}
                    </span>
                  ))}
                  {t.tags.length > 2 ? (
                    <span className="text-[11px] text-[#7A6F69]">+{t.tags.length - 2}</span>
                  ) : null}
                </div>
              </div>
            </button>
          </li>
        ))
      )}
      {!loading && hasMore ? (
        <li className="border-t border-border p-2">
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={onLoadMore}
            loading={loadingMore}
          >
            Load more conversations
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

function ThreadView({
  thread,
  onChanged,
  onDeleted,
  onBack,
  currentUserId,
}: {
  thread: Thread | null;
  onChanged: () => void;
  // Fires after a successful hard-delete so the parent can clear the
  // selection and remove the now-gone thread from the right pane.
  onDeleted: () => void;
  // Mobile: go back to the thread list (deselect).
  onBack: () => void;
  currentUserId: string | null;
}) {
  const queryClient = useQueryClient();
  // Phase 8 / 1.3 — only ALIGNED admins see the AI provenance affordance
  // on bot bubbles. Regular org users get a clean chat surface.
  const { session } = useSession();
  const isSuperAdmin = session?.user.isSuperAdmin === true;
  // Customer-info slide-over (profile + memory + orders + bookings + tags).
  const [infoOpen, setInfoOpen] = useState(false);

  // Whether the AI bot is deployed at the org level. This + an
  // unassigned thread are the two preconditions for auto-reply; the
  // inbox surfaces both so the operator knows why a thread is or
  // isn't getting bot answers.
  const botCfg = useQuery({
    queryKey: ['bot-config-deployment'],
    queryFn: () =>
      api.get<{ data: { deployedAt: string | null } }>('/api/v1/bot/config'),
    staleTime: 30_000,
  });
  const botDeployed = !!botCfg.data?.data?.deployedAt;
  // When the tenant has the 'ai' feature disabled (ALIGNED-admin toggle), this
  // is a manual-only social-media handler: the bot never replies, so hide ALL
  // AI affordances in the inbox (the "deploy on /bot" banner + the per-thread
  // AI toggle) — surfacing them would be misleading for a tenant without AI.
  const aiEnabled = !(session?.organization?.disabledFeatures ?? []).includes('ai');
  // F3/F4 — org admins (and ALIGNED admins) may assign anyone / take over
  // a teammate's thread; editors only claim/release their own (the API
  // enforces the same matrix — this just shapes the UI).
  const paneTeamworkOn = !(session?.organization?.disabledFeatures ?? []).includes('inbox_teamwork');
  const canManageAssignees =
    paneTeamworkOn &&
    (session?.organization?.role === 'admin' || session?.user.isSuperAdmin === true);
  const membersQ = useQuery({
    queryKey: ['inbox-assignees'],
    queryFn: () =>
      api.get<{
        data: { userId: string; firstName: string | null; lastName: string | null; email: string; isActive: boolean }[];
      }>('/api/v1/members?limit=200'),
    enabled: canManageAssignees,
    staleTime: 60_000,
  });
  const assignableMembers = (membersQ.data?.data ?? [])
    .filter((m) => m.isActive)
    .map((m) => ({
      userId: m.userId,
      name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email.split('@')[0]!,
    }));
  // Voice-note transcription toggle — when off, the inbox hides the "Transcribe"
  // button (the server already skips generating transcripts for this tenant).
  const transcriptionEnabled = !(session?.organization?.disabledFeatures ?? []).includes(
    'voice_transcription',
  );

  const messagesQ = useQuery({
    queryKey: ['inbox-thread', thread?.id, 'messages'],
    queryFn: () =>
      thread
        ? api.get<{ data: Message[]; nextCursor: string | null }>(
            `/api/v1/inbox/threads/${thread.id}/messages`,
          )
        : Promise.resolve({ data: [] as Message[], nextCursor: null }),
    enabled: !!thread,
    refetchInterval: 5_000,
  });

  // "Load earlier messages" pagination. The query above returns the most
  // recent page; this pages back through older history so the FULL chat is
  // viewable no matter how many messages it has. Reset when the thread changes.
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    setOlderMessages([]);
    setOlderCursor(undefined);
  }, [thread?.id]);
  // undefined = not paged yet (use the recent page's cursor); null = exhausted.
  const effectiveOlderCursor =
    olderCursor === undefined ? (messagesQ.data?.nextCursor ?? null) : olderCursor;
  const loadEarlier = async () => {
    if (!thread || loadingOlder || !effectiveOlderCursor) return;
    setLoadingOlder(true);
    try {
      const res = await api.get<{ data: Message[]; nextCursor: string | null }>(
        `/api/v1/inbox/threads/${thread.id}/messages?before=${encodeURIComponent(effectiveOlderCursor)}`,
      );
      setOlderMessages((prev) => [...res.data, ...prev]);
      setOlderCursor(res.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  };

  const notesQ = useQuery({
    queryKey: ['inbox-thread', thread?.id, 'notes'],
    queryFn: () =>
      thread
        ? api.get<{ data: Note[] }>(`/api/v1/inbox/threads/${thread.id}/notes`)
        : Promise.resolve({ data: [] as Note[] }),
    enabled: !!thread,
    refetchInterval: 10_000,
  });

  const cannedQ = useQuery({
    queryKey: ['canned-responses'],
    queryFn: () => api.get<{ data: CannedResponse[] }>('/api/v1/canned-responses'),
  });

  const sendReply = useMutation({
    mutationFn: ({ to, body }: { to: string; body: string }) => {
      // Channel-aware send: Messenger/Instagram threads go through the inbox
      // reply endpoint (Page Send API); WhatsApp keeps using /whatsapp/send.
      if (thread && thread.channel && thread.channel !== 'whatsapp') {
        return api
          .post(`/api/v1/inbox/threads/${thread.id}/reply`, { body })
          .then(() => ({ data: { ok: true as const, errorMessage: null } }));
      }
      // Pass threadId so the reply is sent FROM the number this thread belongs
      // to (multi-number routing); the API falls back to the primary if unset.
      return api.post<{ data: { ok: boolean; errorMessage: string | null } }>(
        '/api/v1/whatsapp/send',
        { to, body, ...(thread ? { threadId: thread.id } : {}) },
      );
    },
    onSuccess: (res) => {
      if (res.data.ok) {
        toast.success('Reply sent');
        if (thread) {
          queryClient.invalidateQueries({ queryKey: ['inbox-thread', thread.id, 'messages'] });
          onChanged();
        }
      } else {
        toast.error(res.data.errorMessage ?? 'Send failed');
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  const addNote = useMutation({
    mutationFn: (body: string) =>
      thread
        ? api.post(`/api/v1/inbox/threads/${thread.id}/notes`, { body })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Note added');
      if (thread) queryClient.invalidateQueries({ queryKey: ['inbox-thread', thread.id, 'notes'] });
      onChanged();
    },
  });

  const setStatus = useMutation({
    mutationFn: (status: ThreadStatus) =>
      thread
        ? api.patch(`/api/v1/inbox/threads/${thread.id}`, { status })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => onChanged(),
  });

  const setAssignee = useMutation({
    mutationFn: (assignedToUserId: string | null) =>
      thread
        ? api.patch(`/api/v1/inbox/threads/${thread.id}`, { assignedToUserId })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Assigned');
      onChanged();
    },
  });

  // Phase 6 — per-thread bot reply-mode override. NULL clears the
  // override and inherits BotConfig.replyMode again.
  const setBotReplyMode = useMutation({
    mutationFn: (botReplyMode: 'text' | 'voice' | 'match_customer' | null) =>
      thread
        ? api.patch(`/api/v1/inbox/threads/${thread.id}`, { botReplyMode })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Bot reply mode updated');
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  // Rename the customer's display name. Backend mirrors the change to
  // Contact.displayName so /contacts stays in sync automatically.
  const renameContact = useMutation({
    mutationFn: (customerName: string | null) =>
      thread
        ? api.patch(`/api/v1/inbox/threads/${thread.id}`, { customerName })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Saved');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Rename failed'),
  });

  const addTag = useMutation({
    mutationFn: (tag: string) =>
      thread
        ? api.post(`/api/v1/inbox/threads/${thread.id}/tags`, { tag })
        : Promise.reject(new Error('no thread')),
    onSuccess: () => onChanged(),
  });

  const removeTag = useMutation({
    mutationFn: (tag: string) =>
      thread
        ? api.delete(`/api/v1/inbox/threads/${thread.id}/tags/${encodeURIComponent(tag)}`)
        : Promise.reject(new Error('no thread')),
    onSuccess: () => onChanged(),
  });

  const handoff = useMutation({
    mutationFn: () =>
      thread
        ? api.post(`/api/v1/inbox/threads/${thread.id}/handoff`, {})
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Handed off — status set to Pending');
      onChanged();
    },
  });

  // Block / unblock the customer. Blocking stops the bot AND prevents any
  // outbound message (the API rejects /whatsapp/send to a blocked contact).
  const toggleBlock = useMutation({
    mutationFn: (blocked: boolean) =>
      thread
        ? api.post(`/api/v1/inbox/threads/${thread.id}/block`, { blocked })
        : Promise.reject(new Error('no thread')),
    onSuccess: (_res, blocked) => {
      toast.success(blocked ? 'Customer blocked' : 'Customer unblocked');
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not update block'),
  });

  // Hard-delete this thread + every message in it. The customer drops out
  // of the inbox immediately and only reappears when they send a new
  // WhatsApp message (the webhook upsert creates a fresh thread row).
  const deleteThread = useMutation({
    mutationFn: () =>
      thread
        ? api.delete(`/api/v1/inbox/threads/${thread.id}`)
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Conversation deleted');
      onDeleted();
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  // Purge: delete the contact from /contacts AND the whole conversation AND the
  // AI's memory of them — everything about this person.
  const purgeContact = useMutation({
    mutationFn: () =>
      thread
        ? api.delete(`/api/v1/inbox/threads/${thread.id}/purge`)
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Contact and conversation deleted');
      onDeleted();
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Delete failed'),
  });

  // Wipe the message history but keep the thread row + customer name +
  // assignment. Acts as a "start fresh" reset that doesn't lose the
  // operator's rename or tags.
  const resetThread = useMutation({
    mutationFn: () =>
      thread
        ? api.post(`/api/v1/inbox/threads/${thread.id}/reset`, {})
        : Promise.reject(new Error('no thread')),
    onSuccess: () => {
      toast.success('Conversation reset — chat cleared');
      // The thread row stays but its message history is gone — invalidate
      // the messages query so the right pane redraws empty.
      if (thread) {
        queryClient.invalidateQueries({ queryKey: ['inbox-thread', thread.id, 'messages'] });
      }
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Reset failed'),
  });

  // IMPORTANT: hooks must be called in the same order every render. The
  // early `return` for the null-thread case must come AFTER every hook
  // call in this component, otherwise the moment a thread arrives the
  // render count of hooks changes and React throws #310 "Rendered more
  // hooks than during the previous render."
  const messages = [...olderMessages, ...(messagesQ.data?.data ?? [])];
  const canLoadEarlier = effectiveOlderCursor != null;
  const notes = notesQ.data?.data ?? [];
  // Interleave messages + notes by time.
  const timeline = useMemo(() => {
    const items = [
      ...messages.map((m) => ({ kind: 'msg' as const, at: m.receivedAt, msg: m })),
      ...notes.map((n) => ({ kind: 'note' as const, at: n.createdAt, note: n })),
    ];
    items.sort((a, b) => (a.at < b.at ? -1 : 1));
    return items;
  }, [messages, notes]);

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-foreground-muted">
        Select a conversation to view it.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ThreadHeader
        thread={thread}
        onBack={onBack}
        aiEnabled={aiEnabled}
        onStatusChange={(s) => setStatus.mutate(s)}
        onAssignSelf={() => currentUserId && setAssignee.mutate(currentUserId)}
        onUnassign={() => setAssignee.mutate(null)}
        onAssignTo={(userId) => setAssignee.mutate(userId)}
        currentUserId={currentUserId}
        canManageAssignees={canManageAssignees}
        teamworkOn={paneTeamworkOn}
        members={assignableMembers}
        onHandoff={() => handoff.mutate()}
        onRename={(name) => renameContact.mutate(name)}
        renameSaving={renameContact.isPending}
        onBotReplyModeChange={(m) => setBotReplyMode.mutate(m)}
        onShowInfo={() => setInfoOpen(true)}
        onDelete={() => deleteThread.mutate()}
        onReset={() => resetThread.mutate()}
        onPurge={() => purgeContact.mutate()}
        onToggleBlock={(b) => toggleBlock.mutate(b)}
        deletePending={deleteThread.isPending}
        resetPending={resetThread.isPending}
        purgePending={purgeContact.isPending}
        blockPending={toggleBlock.isPending}
      />
      <TagBar thread={thread} onAdd={(t) => addTag.mutate(t)} onRemove={(t) => removeTag.mutate(t)} />
      {aiEnabled && <AiStatusBanner thread={thread} botDeployed={botDeployed} />}
      <MessageScroller
        threadId={thread.id}
        timelineLength={timeline.length}
        latestTimestamp={
          timeline.length > 0 ? timeline[timeline.length - 1]!.at : null
        }
      >
        {messagesQ.isLoading ? (
          <div className="space-y-3 px-2 py-3" aria-label="Loading messages">
            <div className="ml-auto h-10 w-2/3 animate-pulse rounded-lg bg-surface-elevated" />
            <div className="h-12 w-3/4 animate-pulse rounded-lg bg-surface-elevated" />
            <div className="ml-auto h-8 w-1/2 animate-pulse rounded-lg bg-surface-elevated" />
            <div className="h-10 w-2/3 animate-pulse rounded-lg bg-surface-elevated" />
          </div>
        ) : timeline.length === 0 ? (
          <p className="text-center text-sm text-foreground-muted">No messages yet.</p>
        ) : (
          <>
            {canLoadEarlier ? (
              <div className="flex justify-center pb-2">
                <button
                  type="button"
                  onClick={loadEarlier}
                  disabled={loadingOlder}
                  className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-foreground-muted transition hover:bg-brand-50 disabled:opacity-60"
                >
                  {loadingOlder ? 'Loading…' : 'Load earlier messages'}
                </button>
              </div>
            ) : null}
            {timeline.map((item) =>
              item.kind === 'msg' ? (
                <Bubble
                  key={item.msg.id}
                  message={item.msg}
                  isSuperAdmin={isSuperAdmin}
                  transcriptionEnabled={transcriptionEnabled}
                />
              ) : (
                <NoteBubble key={item.note.id} note={item.note} />
              ),
            )}
          </>
        )}
      </MessageScroller>
      <div className="shrink-0">
        {thread.blocked ? (
          <div className="flex items-center justify-between gap-3 border-t border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">
            <span className="inline-flex items-center gap-1.5">
              <Ban className="size-3.5 shrink-0" /> This customer is blocked — the bot won&rsquo;t reply
              and no messages can be sent.
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 shrink-0 text-rose-700 hover:bg-rose-100"
              onClick={() => toggleBlock.mutate(false)}
              loading={toggleBlock.isPending}
            >
              Unblock
            </Button>
          </div>
        ) : null}
        <ReplyBox
          to={thread.customerPhone}
          cannedResponses={cannedQ.data?.data ?? []}
          loading={sendReply.isPending}
          onSend={(body) => sendReply.mutate({ to: thread.customerPhone, body })}
          onAddNote={(body) => addNote.mutate(body)}
          addingNote={addNote.isPending}
        />
      </div>
      <CustomerInfoSheet
        phone={thread.customerPhone}
        fallbackName={thread.customerName ?? thread.customerWhatsappName}
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
      />
    </div>
  );
}

function ThreadHeader({
  thread,
  aiEnabled,
  onBack,
  onStatusChange,
  onAssignSelf,
  onUnassign,
  onAssignTo,
  currentUserId,
  canManageAssignees,
  teamworkOn,
  members,
  onHandoff,
  onRename,
  renameSaving,
  onBotReplyModeChange,
  onShowInfo,
  onDelete,
  onReset,
  onPurge,
  onToggleBlock,
  deletePending,
  resetPending,
  purgePending,
  blockPending,
}: {
  thread: Thread;
  aiEnabled: boolean;
  onBack: () => void;
  onStatusChange: (s: ThreadStatus) => void;
  onAssignSelf: () => void;
  onUnassign: () => void;
  onAssignTo: (userId: string) => void;
  currentUserId: string | null;
  canManageAssignees: boolean;
  teamworkOn: boolean;
  members: { userId: string; name: string }[];
  onHandoff: () => void;
  onRename: (name: string | null) => void;
  renameSaving: boolean;
  onBotReplyModeChange: (m: 'text' | 'voice' | 'match_customer' | null) => void;
  onShowInfo: () => void;
  // Destructive actions on the thread. All are confirmed via dialog before
  // firing because they wipe message history (and, for purge, the contact).
  onDelete: () => void;
  onReset: () => void;
  // Purge: delete the contact + the whole conversation + AI memory.
  onPurge: () => void;
  // Block / unblock the customer (stops the bot + all outbound sends).
  onToggleBlock: (blocked: boolean) => void;
  deletePending: boolean;
  resetPending: boolean;
  purgePending: boolean;
  blockPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.customerName ?? '');
  // Confirmation modal state for the two destructive actions. Separate
  // booleans (not a single enum) so the modal type can't get out of sync
  // with which button was clicked.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  useEffect(() => {
    setDraft(thread.customerName ?? '');
    setEditing(false);
  }, [thread.id, thread.customerName]);

  const save = () => {
    const trimmed = draft.trim();
    const next = trimmed.length > 0 ? trimmed : null;
    if (next === (thread.customerName ?? null)) {
      setEditing(false);
      return;
    }
    onRename(next);
    setEditing(false);
  };

  // Tightened layout:
  //   Row 1 (always visible):  avatar circle + customer name (clickable
  //                            to rename) + status pill + assignee chip.
  //                            On the right: Take / AI / Handoff (the
  //                            three ownership actions, grouped).
  //   Row 2 (always visible):  phone (mono) + WhatsApp nickname.
  //                            Quiet — these are reference info, not
  //                            actions.
  // No more layout shifts on rename: secondary line is unconditional.

  return (
    <div className="flex flex-col gap-1.5 border-b border-[#E3DBCE] bg-[#FCFBFA] px-3 py-2 sm:gap-2 sm:px-4 sm:py-2.5">
      {/* Row 1 — identity + actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* Mobile-only: back to the thread list (master-detail). */}
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-full text-foreground-muted transition hover:bg-surface-muted hover:text-foreground lg:hidden"
          >
            <ArrowLeft className="size-5" />
          </button>
          {/* Avatar — initials on the contact's stable color + channel badge */}
          <span className="relative shrink-0">
            <InitialsAvatar
              name={thread.customerName ?? thread.customerWhatsappName ?? thread.customerPhone}
              ai={!thread.assignedToUserId && thread.status === 'open'}
            />
            <ChannelBadge channel={thread.channel} />
          </span>
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="flex items-center gap-1.5">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save();
                    if (e.key === 'Escape') {
                      setDraft(thread.customerName ?? '');
                      setEditing(false);
                    }
                  }}
                  placeholder="Customer name"
                  autoFocus
                  className="h-7 max-w-[14rem] text-sm"
                  aria-label="Customer name"
                />
                <Button size="sm" onClick={save} loading={renameSaving}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(thread.customerName ?? '');
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="group inline-flex max-w-full items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
                title="Click to rename"
              >
                <span className="truncate text-sm font-semibold text-foreground">
                  {thread.customerName ?? thread.customerWhatsappName ?? thread.customerPhone}
                </span>
                <span className="text-[10px] font-normal text-foreground-subtle opacity-0 group-hover:opacity-100">
                  ✎ rename
                </span>
              </button>
            )}
            {thread.blocked ? (
              <span
                className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700"
                title="This customer is blocked — the bot won't reply and no messages can be sent"
              >
                <Ban className="size-3" /> Blocked
              </span>
            ) : null}
            {thread.optedOut ? (
              <span
                className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                title="This customer unsubscribed — they are excluded from every broadcast. You can still reply here."
              >
                <Ban className="size-3" /> Unsubscribed
              </span>
            ) : null}
          </div>
          {/* Open the full customer profile (info, memory, orders, tags). */}
          <Button
            size="sm"
            variant="ghost"
            onClick={onShowInfo}
            className="shrink-0 gap-1 border border-border"
            title="Customer info"
          >
            <Info className="size-4" /> <span className="hidden sm:inline">Info</span>
          </Button>
        </div>

        {/* Right cluster: status pill + assignee chip + action group.
            Status comes first so it reads top-left to bottom-right:
            who is this, what state, who owns it, what can I do. */}
        <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] sm:flex-wrap sm:gap-1.5">
          {thread.status !== 'open' ? (
            <Badge variant={STATUS_VARIANT[thread.status]} className="shrink-0 text-[11px]">
              {STATUS_LABEL[thread.status]}
            </Badge>
          ) : null}
          {/* Mockup actions: Tag / Resolve / Take over (toggles to AI reply). */}
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 border border-[#D6C9B4] bg-white text-[#360516] hover:bg-[#F3ECE0]"
            onClick={onShowInfo}
            title="Add or edit tags (opens the customer panel)"
          >
            <TagIcon className="size-3.5" /> <span className="hidden sm:inline">Tag</span>
          </Button>
          {thread.status === 'resolved' ? (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 border border-[#D6C9B4] bg-white text-[#360516] hover:bg-[#F3ECE0]"
              onClick={() => onStatusChange('open')}
              title="Reopen this conversation"
            >
              <RotateCcw className="size-3.5" /> <span className="hidden sm:inline">Reopen</span>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 border border-[#D6C9B4] bg-white text-[#360516] hover:bg-[#F3ECE0]"
              onClick={() => onStatusChange('resolved')}
              title="Mark this conversation resolved"
            >
              <CheckCircle2 className="size-3.5" /> <span className="hidden sm:inline">Resolve</span>
            </Button>
          )}
          {thread.assignedToUserId &&
          (!teamworkOn || (currentUserId && thread.assignedToUserId === currentUserId)) ? (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 gap-1 border border-[#360516] bg-[#360516] text-[#F3ECE0] hover:bg-[#4A1525] hover:text-[#F3ECE0]"
              onClick={onUnassign}
              title={
                aiEnabled
                  ? 'Hand the conversation back to the AI'
                  : 'Unassign this conversation'
              }
            >
              <Sparkles className="size-3.5" /> {aiEnabled ? 'AI reply' : 'Unassign'}
            </Button>
          ) : thread.assignedToUserId ? (
            // Assigned to a teammate. Admins can take it over (the API's
            // permission matrix blocks editors from stealing, so the button
            // only renders when it would succeed).
            canManageAssignees ? (
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 gap-1 border border-[#E53E34] bg-[#E53E34] text-white hover:bg-[#A32D2D] hover:text-white"
                onClick={onAssignSelf}
                title={`Take over this conversation from ${thread.assignedToName ?? 'its current assignee'}`}
              >
                <UserCheck className="size-3.5" /> Take over
              </Button>
            ) : null
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 gap-1 border border-[#E53E34] bg-[#E53E34] text-white hover:bg-[#A32D2D] hover:text-white"
              onClick={onAssignSelf}
              title="Take this thread (you become the assignee; the AI pauses)"
            >
              <UserCheck className="size-3.5" /> Take over
            </Button>
          )}
          {/* Secondary actions tucked into one overflow menu so the header
              stays calm: per-thread bot reply mode + the two destructive
              actions (reset clears the chat in place; delete removes it). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="shrink-0 border border-border" aria-label="More actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={onHandoff}>
                <AlertTriangle className="size-4" /> Handoff to team
              </DropdownMenuItem>
              {thread.status !== 'escalated' ? (
                <DropdownMenuItem onClick={() => onStatusChange('escalated')}>
                  <AlertTriangle className="size-4 opacity-0" /> Mark escalated
                </DropdownMenuItem>
              ) : null}
              {canManageAssignees && members.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Assign to…</DropdownMenuLabel>
                  {members.slice(0, 20).map((m) => (
                    <DropdownMenuItem
                      key={m.userId}
                      onClick={() => onAssignTo(m.userId)}
                      disabled={thread.assignedToUserId === m.userId}
                    >
                      <UserCheck
                        className={cn(
                          'size-4',
                          thread.assignedToUserId === m.userId ? 'opacity-100' : 'opacity-30',
                        )}
                      />
                      {m.name}
                    </DropdownMenuItem>
                  ))}
                  {thread.assignedToUserId ? (
                    <DropdownMenuItem onClick={onUnassign}>
                      <Sparkles className="size-4" /> {aiEnabled ? 'Return to AI (unassign)' : 'Unassign'}
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Bot reply mode · this chat</DropdownMenuLabel>
              {(
                [
                  [null, 'Default (org-wide)'],
                  ['text', 'Always text'],
                  ['voice', 'Always voice'],
                  ['match_customer', 'Match customer'],
                ] as [('text' | 'voice' | 'match_customer' | null), string][]
              ).map(([value, label]) => (
                <DropdownMenuItem key={label} onClick={() => onBotReplyModeChange(value)}>
                  <Check
                    className={cn('size-4', (thread.botReplyMode ?? null) === value ? 'opacity-100' : 'opacity-0')}
                  />
                  {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onToggleBlock(!thread.blocked)}
                disabled={blockPending}
                className={
                  thread.blocked ? undefined : 'text-rose-600 focus:bg-rose-50 focus:text-rose-700'
                }
              >
                <Ban className="size-4" /> {thread.blocked ? 'Unblock customer' : 'Block customer'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setConfirmReset(true)}>
                <RotateCcw className="size-4" /> Reset conversation
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setConfirmDelete(true)}
                className="text-rose-600 focus:bg-rose-50 focus:text-rose-700"
              >
                <Trash2 className="size-4" /> Delete conversation
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setConfirmPurge(true)}
                className="text-rose-600 focus:bg-rose-50 focus:text-rose-700"
              >
                <UserX className="size-4" /> Delete from contacts
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Row 2 — one quiet meta line (mockup style):
          channel · phone · last message · owner. */}
      <div className="hidden flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-12 text-xs text-[#6C625C] sm:flex">
        <span className="capitalize">
          {thread.channel && thread.channel !== 'whatsapp' ? thread.channel : 'WhatsApp'}
        </span>
        <span aria-hidden>·</span>
        <span className="font-mono">{thread.customerPhone}</span>
        <span aria-hidden>·</span>
        <span>last message {formatRelative(thread.lastMessageAt)}</span>
        {thread.assignedToName ? (
          <>
            <span aria-hidden>·</span>
            <span className="font-medium">with {thread.assignedToName.split(' ')[0]}</span>
          </>
        ) : null}
      </div>

      <Dialog open={confirmReset} onOpenChange={(open) => !resetPending && setConfirmReset(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset this conversation?</DialogTitle>
            <DialogDescription>
              All messages with{' '}
              <span className="font-semibold text-foreground">
                {thread.customerName ?? thread.customerWhatsappName ?? thread.customerPhone}
              </span>{' '}
              will be permanently deleted. The contact stays in the inbox and keeps their name +
              tags, so you can start a fresh conversation with them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmReset(false)} disabled={resetPending}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onReset();
                setConfirmReset(false);
              }}
              loading={resetPending}
            >
              Reset conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={(open) => !deletePending && setConfirmDelete(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this conversation?</DialogTitle>
            <DialogDescription>
              The chat with{' '}
              <span className="font-semibold text-foreground">
                {thread.customerName ?? thread.customerWhatsappName ?? thread.customerPhone}
              </span>{' '}
              will be removed from the inbox along with every message, note, and tag. If they send a
              new WhatsApp message later, a fresh conversation will appear here automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deletePending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
              loading={deletePending}
            >
              Delete conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmPurge} onOpenChange={(open) => !purgePending && setConfirmPurge(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this contact and everything?</DialogTitle>
            <DialogDescription>
              This permanently removes{' '}
              <span className="font-semibold text-foreground">
                {thread.customerName ?? thread.customerWhatsappName ?? thread.customerPhone}
              </span>{' '}
              from your Contacts, deletes the entire conversation (every message, note and tag), and
              wipes the AI&apos;s memory of them. Past orders and bookings are kept as records. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmPurge(false)} disabled={purgePending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                onPurge();
                setConfirmPurge(false);
              }}
              loading={purgePending}
            >
              Delete contact + chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TagBar({
  thread,
  onAdd,
  onRemove,
}: {
  thread: Thread;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [input, setInput] = useState('');
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2">
      <TagIcon className="size-3.5 shrink-0 text-foreground-muted" />
      {thread.tags.map((t) => (
        <Badge key={t} variant="outline" className="gap-1 text-xs">
          {t}
          <button
            type="button"
            onClick={() => onRemove(t)}
            aria-label={`Remove tag ${t}`}
            className="rounded hover:bg-surface-muted"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && input.trim()) {
            e.preventDefault();
            onAdd(input.trim());
            setInput('');
          }
        }}
        placeholder="+ tag"
        aria-label="Add tag"
        className="h-7 w-32 rounded border border-border bg-surface px-2 text-xs placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      />
    </div>
  );
}

// Scroll container that auto-pins the conversation to the bottom on
// thread open and whenever a new message arrives. Respects operator
// intent: if they've scrolled up to read older history (more than
// ~80px from the bottom), we don't yank them back — but the moment
// they scroll near the bottom again we resume sticking.
function MessageScroller({
  threadId,
  timelineLength,
  latestTimestamp,
  children,
}: {
  threadId: string;
  timelineLength: number;
  latestTimestamp: string | null;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Tracks whether the operator is "stuck to the bottom" — true means
  // any new message scrolls them down; false means they're reading
  // older messages and we leave them alone.
  const stuckRef = useRef(true);

  // Jump (instant, no animation) to the bottom whenever the thread
  // changes — different conversation, different reading position.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
  }, [threadId]);

  // Jump straight to the bottom whenever a new message lands AND the
  // operator is currently near the bottom. Instant (no smooth animation)
  // so the latest message is simply shown, never animated into view.
  // Triggered by either a timeline count change OR the most recent
  // message's timestamp changing (covers in-place edits).
  useEffect(() => {
    const el = ref.current;
    if (!el || !stuckRef.current) return;
    // Defer one frame so the DOM has rendered the new message before
    // we measure scrollHeight.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [timelineLength, latestTimestamp]);

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckRef.current = distanceFromBottom < 80;
  };

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-none bg-[#FCFBFA] p-5"
    >
      {children}
    </div>
  );
}

// Tiny banner just under the thread header that tells the operator
// whether the AI is actively replying to this thread. Three cases:
//   - bot deployed + thread unassigned → AI is auto-replying
//   - bot deployed + thread assigned   → AI paused (human owns it)
//   - bot not deployed                 → AI off platform-wide, click
//                                        through to /bot to deploy
function AiStatusBanner({ thread, botDeployed }: { thread: Thread; botDeployed: boolean }) {
  if (!botDeployed) {
    return (
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50/60 px-4 py-1.5 text-xs text-amber-900">
        <Sparkles className="size-3.5" />
        <span>
          AI auto-reply is OFF — bot isn't deployed yet.{' '}
          <a href="/bot" className="font-medium underline">
            Deploy it on /bot
          </a>{' '}
          first.
        </span>
      </div>
    );
  }
  if (thread.assignedToUserId) {
    return (
      <div className="mx-3 mt-2.5 flex items-center gap-2.5 rounded-lg border border-[#E6DCCB] bg-[#F3ECE0] px-3.5 py-2 text-xs text-[#4A1525] sm:mx-4">
        <UserCheck className="size-3.5 shrink-0" />
        <span>
          AI paused — this thread is assigned to a human ({thread.assignedToName ?? 'operator'}).
          Click <span className="font-semibold">AI</span> above to give it back to the bot.
        </span>
      </div>
    );
  }
  return (
    <div className="mx-2.5 mt-2 flex items-center gap-2 truncate rounded-md border border-[#E6DCCB] bg-[#F3ECE0] px-3 py-1.5 text-[11px] text-[#4A1525] sm:mx-4 sm:mt-2.5 sm:gap-2.5 sm:rounded-lg sm:px-3.5 sm:py-2 sm:text-xs">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-[#E53E34]" aria-hidden />
      <span className="truncate">
        <span className="font-semibold">AI Agent is replying</span>
        <span className="hidden sm:inline"> — answers come from your catalog and business info.</span>{' '}
        <span className="font-semibold">Take over</span> any time.
      </span>
    </div>
  );
}

// Compact relative time for list rows (mockup style: 2m / 1h / 4d / 12 Jul).
function shortTime(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Per-message image-URL cache. The API returns a fresh *signed* Wasabi URL on
// every poll (the signature changes), which would otherwise make the <img>
// re-download + flicker every few seconds. We pin the first URL we see for a
// given message id (valid 24h) so the src stays stable across polls.
const imageUrlCache = new Map<string, string>();

function Bubble({
  message,
  isSuperAdmin,
  transcriptionEnabled,
}: {
  message: Message;
  isSuperAdmin: boolean;
  transcriptionEnabled: boolean;
}) {
  const isOut = message.direction === 'outbound';
  // Phase 8 / 1.3 — ALIGNED-admin only: click any bot bubble to inline
  // the message provenance panel underneath. Regular users see nothing.
  const isBotMessage = isOut && message.sentBy === 'bot';
  // Phase 8 / 1.5 — image bubbles have no LLM provenance row, but we
  // still surface their upstream source inline (greeting image on /bot
  // vs product image keyed by SKU). Visible to ALIGNED admins only.
  const hasImageSource =
    isSuperAdmin && isBotMessage && message.imageSource != null;
  // Image bubbles never call the LLM, so the "AI source" button +
  // 4-tab panel are nonsense for them — clicking would just return a
  // 404 and confuse the operator. The inline image-source attribution
  // below the bubble IS the provenance for image messages.
  // Stickers are webp images — render them inline like photos.
  const isImage = ['image', 'sticker'].includes((message.messageType ?? '').toLowerCase());
  const canAudit = isSuperAdmin && isBotMessage && !isImage;
  const [open, setOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const provQ = useQuery({
    queryKey: ['provenance', message.id],
    queryFn: () =>
      api.get<{ data: MessageProvenance }>(
        `/api/v1/inbox/messages/${message.id}/provenance`,
      ),
    enabled: open && canAudit,
    staleTime: 60_000,
  });
  // Detect button/interactive replies and surface them visually. The
  // body text is already the button's label (via extractInboundBody on
  // the API side) — but a customer tapping "INTERESTED" looks
  // identical to one TYPING "INTERESTED" without an annotation. The
  // little 🔘 label tells the operator it was a button press, not
  // typed.
  const mt = (message.messageType ?? '').toLowerCase();
  const isButtonReply = mt === 'button' || mt === 'interactive';
  // Same idea for media types — show a small "📷 image" / "🎙 voice" /
  // "📄 document" tag when the message is a media type, regardless of
  // whether a caption is also present.
  const MEDIA_TAGS: Record<string, string> = {
    image: '📷 Image',
    video: '🎥 Video',
    audio: '🎙 Voice note',
    voice: '🎙 Voice note',
    document: '📄 Document',
    sticker: '🌟 Sticker',
    location: '📍 Location',
    // 'contacts' intentionally omitted — the body already renders the shared
    // contact's name + number ("📇 Shared contact: …"), so a tag would be redundant.
  };
  const mediaTag = MEDIA_TAGS[mt];
  // Inline image rendering. Pin the first signed URL we see (see cache above).
  if (message.mediaUrl && !imageUrlCache.has(message.id)) {
    imageUrlCache.set(message.id, message.mediaUrl);
  }
  const imgSrc = imageUrlCache.get(message.id) ?? message.mediaUrl ?? null;
  const showImage = isImage && !!imgSrc;
  // Inbound videos play inline; documents get a download link.
  const isVideo = mt === 'video';
  const showVideo = isVideo && !!imgSrc;
  const isDocument = mt === 'document';
  const showDocument = isDocument && !!imgSrc;
  // Voice notes: play the actual audio + reveal the AI transcript on demand.
  const isAudio = mt === 'audio' || mt === 'voice';
  const showAudio = isAudio && !!imgSrc;
  // The transcript is stored as the message body, prefixed with 🎙.
  const rawTranscript = isAudio ? (message.body ?? '').replace(/^🎙\s*/, '').trim() : '';
  // Only a REAL transcript counts: hide the Transcribe button when the tenant has
  // voice transcription turned off, or when the body is just the "Voice note"
  // placeholder (a note that wasn't transcribed). The audio still plays.
  const audioTranscript =
    transcriptionEnabled && rawTranscript && rawTranscript !== 'Voice note' ? rawTranscript : '';
  // For image bubbles the body is usually a bland "[image]" / "[image] Name"
  // placeholder — hide it when we render the real picture; keep genuine
  // customer captions.
  const bodyIsImagePlaceholder =
    (isImage && (!message.body || /^\[image\]/i.test(message.body.trim()))) ||
    (isVideo && (!message.body || /^\[video\]/i.test(message.body.trim()))) ||
    isDocument;
  // Shared-location message → render an interactive map card (name/address +
  // "Open in Google Maps") instead of the bare "[location]" placeholder. The
  // card links out because the portal CSP blocks external map-tile images.
  const loc = message.location ?? null;
  const showLocation = mt === 'location' && !!loc;
  const bodyIsLocationPlaceholder =
    mt === 'location' && (!message.body || /^\[location\]/i.test(message.body.trim()));
  const mapUrl = loc
    ? `https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`
    : null;
  const flaggedCount = provQ.data?.data?.hallucinations?.length ?? 0;
  return (
    <div className={cn('flex flex-col', isOut ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5 text-base leading-relaxed shadow-sm sm:max-w-[78%] sm:text-[15px]',
          // Three roles (mockup palette): customer = white card, human agent =
          // maroon, AI = coral with an "AI" tag so takeovers are legible.
          isOut
            ? isBotMessage
              ? 'rounded-br-sm bg-[#E53E34] text-white'
              : 'rounded-br-sm bg-[#360516] text-[#F3ECE0]'
            : 'rounded-bl-sm border border-[#E3DBCE] bg-white text-[#360516]',
          // Subtle red ring when the scanner flagged hallucinations.
          canAudit && flaggedCount > 0 ? 'ring-2 ring-rose-400/70' : '',
        )}
      >
        {isBotMessage ? (
          <span className="mb-1 inline-block rounded bg-white/25 px-1.5 py-px text-[9.5px] font-bold tracking-widest">
            AI
          </span>
        ) : null}
        {isButtonReply ? (
          <p
            className={cn(
              'mb-1 text-[10px] font-semibold uppercase tracking-wide',
              isOut ? 'text-white/80' : 'text-[#E53E34]',
            )}
          >
            🔘 Button tapped
          </p>
        ) : mediaTag && !showImage && !showVideo && !showDocument && !showLocation ? (
          <p
            className={cn(
              'mb-1 text-[10px] font-semibold uppercase tracking-wide',
              isOut ? 'text-white/80' : 'text-foreground-subtle',
            )}
          >
            {mediaTag}
          </p>
        ) : null}
        {showImage ? (
          // Click to pop the full-resolution image up in a lightbox.
          <button
            type="button"
            onClick={() => setLightbox(imgSrc!)}
            className="block cursor-zoom-in"
            title="Click to view"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgSrc!}
              alt={message.body?.replace(/^\[image\]\s*/i, '') || 'Image'}
              loading="lazy"
              className="max-h-80 w-auto max-w-full rounded-lg object-contain"
            />
          </button>
        ) : null}
        {showVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            controls
            preload="metadata"
            playsInline
            src={imgSrc!}
            className="max-h-80 w-full max-w-full rounded-lg bg-black object-contain"
          />
        ) : null}
        {showDocument ? (
          <a
            href={imgSrc!}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium underline-offset-2 hover:underline',
              isOut ? 'border-white/30 text-white' : 'border-[#D6C9B4] text-[#360516]',
            )}
          >
            <FileText className="size-4 shrink-0" />
            <span className="truncate">
              {message.body?.replace(/^\[document\]\s*/i, '') || 'Open document'}
            </span>
          </a>
        ) : null}
        <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />
        {showAudio ? (
          <div className="space-y-1.5">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls preload="none" src={imgSrc!} className="max-w-full" />
            {audioTranscript ? (
              <div>
                <button
                  type="button"
                  onClick={() => setShowTranscript((v) => !v)}
                  className={cn(
                    'inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline',
                    isOut ? 'text-white/80' : 'text-[#E53E34]',
                  )}
                >
                  <Sparkles className="size-3" />
                  {showTranscript ? 'Hide transcription' : 'Transcribe'}
                </button>
                {showTranscript ? (
                  <p
                    className={cn(
                      'mt-1 whitespace-pre-wrap break-words text-sm',
                      isOut ? 'text-white/90' : 'text-foreground',
                    )}
                  >
                    {audioTranscript}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {/* Shared-location card. Renders the sender's pin as a clickable card
            (name / address / coordinates) that opens the exact spot in Google
            Maps in a new tab — CSP blocks embedding an external map tile, so a
            link is the reliable way to actually SEE the location. */}
        {showLocation && loc && mapUrl ? (
          <a
            href={mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Google Maps"
            className={cn(
              'group flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors',
              isOut
                ? 'border-white/30 hover:bg-white/10'
                : 'border-border bg-surface hover:bg-surface-muted',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                isOut ? 'bg-white/20 text-white' : 'bg-[#F3ECE0] text-[#E53E34]',
              )}
            >
              <MapPin className="size-4" />
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  'block text-sm font-semibold',
                  isOut ? 'text-white' : 'text-foreground',
                )}
              >
                {loc.name || 'Shared location'}
              </span>
              {loc.address ? (
                <span
                  className={cn(
                    'mt-0.5 block break-words text-xs',
                    isOut ? 'text-white/80' : 'text-foreground-subtle',
                  )}
                >
                  {loc.address}
                </span>
              ) : null}
              <span
                className={cn(
                  'mt-1 block text-[11px] font-medium underline-offset-2 group-hover:underline',
                  isOut ? 'text-white/90' : 'text-[#E53E34]',
                )}
              >
                {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)} · Open in Maps ↗
              </span>
            </span>
          </a>
        ) : null}
        {/* Template header media (broadcast / test-send) — the image / video /
            document the customer received, above the rendered body text. */}
        {message.headerImageUrl ? (
          message.headerMediaType === 'video' ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              controls
              preload="metadata"
              src={message.headerImageUrl}
              className="mb-1.5 max-h-64 w-auto max-w-full rounded-lg"
            />
          ) : message.headerMediaType === 'document' ? (
            <a
              href={message.headerImageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'mb-1.5 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium',
                isOut ? 'border-white/30 text-white' : 'border-border text-foreground',
              )}
            >
              <FileText className="size-4" /> View document
            </a>
          ) : (
            <button
              type="button"
              onClick={() => setLightbox(message.headerImageUrl!)}
              className="mb-1.5 block cursor-zoom-in"
              title="Click to view"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={message.headerImageUrl}
                alt="Template header"
                loading="lazy"
                className="max-h-64 w-auto max-w-full rounded-lg object-contain"
              />
            </button>
          )
        ) : null}
        {bodyIsImagePlaceholder || showAudio || (showLocation && bodyIsLocationPlaceholder) ? null : (
          <p
            className={cn(
              'whitespace-pre-wrap break-words',
              (showImage || showVideo || showLocation) && 'mt-1.5',
            )}
          >
            {message.body ?? <em className="opacity-70">[{message.messageType ?? 'media'}]</em>}
          </p>
        )}
        {/* Buttons shown under the bubble as non-interactive pills: quick-reply
            options the bot offered (Messenger / Instagram) and the buttons on a
            sent WhatsApp template, so the operator sees exactly what the
            customer received. */}
        {message.quickReplies && message.quickReplies.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.quickReplies.map((label, i) => (
              <span
                key={`${label}-${i}`}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium',
                  isOut
                    ? 'border-white/30 text-white/90'
                    : 'border-[#D6C9B4] text-[#4A1525]',
                )}
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}
        <div
          className={cn(
            'mt-1.5 flex items-center gap-2 text-[11px]',
            isOut ? 'text-white/80' : 'text-foreground-subtle',
          )}
        >
          {/* Who sent it — Bot vs a human operator (outbound only). */}
          {isOut && message.sentBy ? (
            <span className="font-semibold">
              {message.sentBy === 'bot' ? 'Bot' : 'You'}
            </span>
          ) : null}
          <span>{formatRelative(message.receivedAt)}</span>
          {/* WhatsApp-style delivery ticks (outbound only): ✓ sent, ✓✓ delivered
              (grey), ✓✓ read (blue), ⚠ failed. */}
          {isOut && message.deliveryStatus ? (
            <span
              title={
                message.deliveryStatus === 'read'
                  ? 'Read'
                  : message.deliveryStatus === 'delivered'
                    ? 'Delivered'
                    : message.deliveryStatus === 'failed'
                      ? 'Failed to send'
                      : 'Sent'
              }
              className={cn(
                'font-semibold leading-none tracking-tighter',
                message.deliveryStatus === 'read'
                  ? 'text-sky-300'
                  : message.deliveryStatus === 'failed'
                    ? 'text-red-200'
                    : 'text-white/70',
              )}
            >
              {message.deliveryStatus === 'failed'
                ? '⚠'
                : message.deliveryStatus === 'sent'
                  ? '✓'
                  : '✓✓'}
            </span>
          ) : null}
          {canAudit ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors',
                isOut
                  ? 'bg-white/10 hover:bg-white/20'
                  : 'bg-foreground/10 hover:bg-foreground/20',
              )}
              title="Hader admin — view AI provenance"
            >
              {open ? 'Hide' : 'AI source'}
              {flaggedCount > 0 ? (
                <span className="ml-1 rounded-full bg-rose-500 px-1.5 text-[9px] font-bold text-white">
                  {flaggedCount}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
      </div>
      {canAudit && open ? (
        <div className={cn('mt-1 w-full max-w-[80%]', isOut ? 'self-end' : 'self-start')}>
          <ProvenancePanel query={provQ} />
        </div>
      ) : null}
      {hasImageSource ? (
        <div
          className={cn(
            'mt-1 max-w-[80%] rounded-md border border-border bg-surface-muted/40 px-2 py-1 text-[11px] text-foreground-muted',
            isOut ? 'self-end' : 'self-start',
          )}
        >
          <ImageSourceAttribution source={message.imageSource!} />
        </div>
      ) : null}
    </div>
  );
}

// Phase 8 / 1.5 — inline attribution shown under image bubbles for
// ALIGNED admins. Tells the admin EXACTLY which catalog row or config
// field the image came from + links straight to the editor.
function ImageSourceAttribution({
  source,
}: {
  source: { kind: 'greeting' | 'product'; productSku: string | null };
}) {
  if (source.kind === 'greeting') {
    return (
      <span className="flex items-center gap-1">
        <span className="font-semibold">Image source:</span>
        <span>Greeting image uploaded on</span>
        <a href="/bot" className="font-medium text-brand-600 hover:underline">
          /bot
        </a>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 flex-wrap">
      <span className="font-semibold">Image source:</span>
      <span>Product image for SKU</span>
      <code className="rounded bg-surface px-1 py-0.5 text-[10px] font-mono">
        {source.productSku ?? '(unknown)'}
      </code>
      <span>—</span>
      <a href="/products" className="font-medium text-brand-600 hover:underline">
        find it on /products
      </a>
    </span>
  );
}

// Phase 8 / 1.3 — inline provenance panel rendered under a bot bubble in
// /inbox when an ALIGNED admin clicks "AI source". Four tabs:
//   • Sources         — citations + dereferenced rows
//   • Hallucinations  — flagged phrases
//   • LLM call        — model / tokens / latency
//   • Raw I/O         — full system prompt + history
function ProvenancePanel({
  query,
}: {
  query: ReturnType<typeof useQuery<{ data: MessageProvenance }>>;
}) {
  const [tab, setTab] = useState<'sources' | 'hallucinations' | 'timing'>('sources');
  if (query.isLoading) {
    return (
      <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-foreground-muted">
        Loading provenance…
      </div>
    );
  }
  if (query.error || !query.data?.data) {
    const status =
      query.error instanceof ApiError && query.error.status === 404
        ? 'No provenance recorded for this message yet.'
        : 'Could not load provenance.';
    return (
      <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-foreground-muted">
        {status}
      </div>
    );
  }
  const p = query.data.data;
  const cits = p.citations ?? [];
  const hals = p.hallucinations ?? [];
  return (
    <div className="rounded-md border border-border bg-surface-muted/30 text-xs">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <ProvTab
          active={tab === 'sources'}
          onClick={() => setTab('sources')}
          label={`Sources (${cits.length})`}
        />
        <ProvTab
          active={tab === 'hallucinations'}
          onClick={() => setTab('hallucinations')}
          label={`Hallucinations (${hals.length})`}
          accent={hals.length > 0 ? 'rose' : undefined}
        />
        {p.pipelineTimings ? (
          <ProvTab
            active={tab === 'timing'}
            onClick={() => setTab('timing')}
            label={`Timing (${(p.pipelineTimings.totalMs / 1000).toFixed(2)} s)`}
          />
        ) : null}
      </div>
      <div className="max-h-72 overflow-auto px-3 py-2 leading-relaxed">
        {tab === 'sources' ? <ProvSources p={p} /> : null}
        {tab === 'hallucinations' ? <ProvHallucinations p={p} /> : null}
        {tab === 'timing' ? <ProvTiming p={p} /> : null}
      </div>
    </div>
  );
}

function ProvTab({
  active,
  onClick,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent?: 'rose';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
        active
          ? accent === 'rose'
            ? 'bg-rose-500 text-white'
            : 'bg-brand-500 text-on-brand'
          : accent === 'rose'
            ? 'text-rose-700 hover:bg-rose-100'
            : 'text-foreground-muted hover:bg-surface-muted',
      )}
    >
      {label}
    </button>
  );
}

function ProvSources({ p }: { p: MessageProvenance }) {
  const cits = p.citations ?? [];
  if (cits.length === 0) {
    return (
      <p className="text-foreground-muted">
        No source matched the reply text. The bot might have replied with conversational
        filler only.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {cits.map((c, i) => (
        <SourceCitationRow key={i} c={c} />
      ))}
    </ul>
  );
}

// Phase 8 / 1.5 — type-specific rendering of a single citation. Shows:
// - product/service: name + SKU + DB price + cited price (with ✓ or ⚠
//   if they differ) + a clickable /products link
// - bot_config greeting: "Configured greeting on /bot"
// - business_info menuUrl: "Menu link · set on /business-info"
// - faq: question + matched n-gram snippet + link to /faqs
// - policy: kind + title
// Goal: when the admin opens this panel they can see at a glance EXACTLY
// where the bot pulled each fragment from, in the operator's own terms.
function SourceCitationRow({
  c,
}: {
  c: MessageProvenance['citations'] extends Array<infer U> | null ? U : never;
}) {
  const sourceUrl = sourcePageForCitation(c);
  return (
    <li className="rounded border border-border bg-surface px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          <ProvTypeBadge type={c.type} /> {c.label}
        </span>
        <span className="text-[10px] text-foreground-subtle">
          {(c.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <p className="mt-1 text-[11px] italic text-foreground-muted">"{c.snippet}"</p>
      <CitationDetail c={c} />
      {sourceUrl ? (
        <p className="mt-1 text-[10px]">
          <a href={sourceUrl.href} className="text-brand-600 hover:underline">
            {sourceUrl.label} →
          </a>
        </p>
      ) : null}
    </li>
  );
}

function CitationDetail({
  c,
}: {
  c: MessageProvenance['citations'] extends Array<infer U> | null ? U : never;
}) {
  if (c.type === 'product' || c.type === 'service') {
    const meta = (c.meta ?? {}) as {
      sku?: string;
      catalogPriceMinor?: number | null;
      citedPrice?: string;
      citedPriceMinor?: number;
      priceMatchesDb?: boolean;
    };
    return (
      <>
        <p className="mt-1 text-[11px] text-foreground-muted">
          Taken from the <span className="font-medium">{c.type === 'product' ? 'Products' : 'Services'}</span>{' '}
          page (catalog row).
        </p>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
          {meta.sku ? (
            <>
              <dt className="text-foreground-subtle">SKU</dt>
              <dd>
                <code className="rounded bg-surface-muted px-1 font-mono">{meta.sku}</code>
              </dd>
            </>
          ) : null}
          {typeof meta.catalogPriceMinor === 'number' ? (
            <>
              <dt className="text-foreground-subtle">Catalog price</dt>
              <dd className="font-mono">{(meta.catalogPriceMinor / 1000).toFixed(3)}</dd>
            </>
          ) : null}
          {meta.citedPrice ? (
            <>
              <dt className="text-foreground-subtle">Cited in reply</dt>
              <dd className="font-mono">
                {meta.citedPrice}{' '}
                {meta.priceMatchesDb === true ? (
                  <span className="text-emerald-700">✓ matches</span>
                ) : meta.priceMatchesDb === false ? (
                  <span className="text-rose-700">⚠ differs from catalog</span>
                ) : null}
              </dd>
            </>
          ) : null}
        </dl>
      </>
    );
  }
  if (c.type === 'bot_config' && c.label === 'greeting') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Taken from the <span className="font-medium">Greeting</span> you wrote on the Bot
        page.
      </p>
    );
  }
  if (c.type === 'business_info' && c.label === 'menuUrl') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Taken from the <span className="font-medium">Menu link</span> field on the
        Business info page.
      </p>
    );
  }
  if (c.type === 'business_info' && c.label === 'legalName') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Taken from the <span className="font-medium">Business name</span> field on the
        Business info page.
      </p>
    );
  }
  if (c.type === 'business_info' && c.label === 'websiteUrl') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Taken from the <span className="font-medium">Website</span> field on the
        Business info page.
      </p>
    );
  }
  if (c.type === 'business_info' && c.label === 'operatingHours') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Taken from the <span className="font-medium">Opening hours</span> on the
        Business info page.
      </p>
    );
  }
  if (c.type === 'business_info') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Business info field: <code className="font-mono">{c.label}</code>
      </p>
    );
  }
  if (c.type === 'customer_profile') {
    const meta = (c.meta ?? {}) as { sourceDescription?: string };
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        {meta.sourceDescription ??
          "Customer's WhatsApp profile (Meta-provided, not editable)"}
        .
      </p>
    );
  }
  if (c.type === 'faq') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Taken from your <span className="font-medium">FAQs</span> on the Business info
        page.
      </p>
    );
  }
  if (c.type === 'policy') {
    return (
      <p className="mt-1 text-[11px] text-foreground-muted">
        Taken from your <span className="font-medium">Policies</span> on the Business info
        page.
      </p>
    );
  }
  return null;
}

function sourcePageForCitation(c: {
  type:
    | 'product'
    | 'service'
    | 'faq'
    | 'policy'
    | 'business_info'
    | 'bot_config'
    | 'customer_profile';
  id: string | null;
  label: string;
}): { href: string; label: string } | null {
  switch (c.type) {
    case 'product':
      return c.id
        ? { href: `/products/${c.id}`, label: 'Open in /products' }
        : { href: '/products', label: 'Open /products' };
    case 'service':
      return c.id
        ? { href: `/services/${c.id}`, label: 'Open in /services' }
        : { href: '/services', label: 'Open /services' };
    case 'faq':
      return { href: '/business-info', label: 'Edit FAQs on /business-info' };
    case 'policy':
      return { href: '/business-info', label: 'Edit policies on /business-info' };
    case 'business_info':
      return { href: '/business-info', label: 'Edit on /business-info' };
    case 'bot_config':
      return { href: '/bot', label: 'Edit on /bot' };
    case 'customer_profile':
      // No operator-editable page — the source is the customer's WhatsApp
      // profile, set on their phone. We could deep-link to the thread,
      // but the field itself is not editable from our portal.
      return null;
    default:
      return null;
  }
}

// Phase 13 — per-station pipeline timing breakdown for one bot reply.
// Visualises every station the message went through from received →
// sent, with both per-station duration + a horizontal bar showing
// each station's share of the total wall-clock time. The big number
// at the top is the total elapsed time the customer waited.
function ProvTiming({ p }: { p: MessageProvenance }) {
  const t = p.pipelineTimings;
  if (!t || t.laps.length === 0) {
    return (
      <p className="text-foreground-muted">
        No timing trace for this message (pre-Phase-13 reply, or stopwatch failed).
      </p>
    );
  }
  // Each bar is sized relative to the SLOWEST station so a tiny step
  // doesn't render at 0 px. Color-codes by relative cost so the
  // operator can spot the hot stations at a glance.
  const slowest = Math.max(1, ...t.laps.map((l) => l.durationMs));
  const colourFor = (ms: number) => {
    const ratio = ms / slowest;
    if (ratio > 0.5) return 'bg-rose-400';
    if (ratio > 0.25) return 'bg-amber-400';
    if (ratio > 0.1) return 'bg-sky-400';
    return 'bg-emerald-400';
  };
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] text-foreground-muted">
          From received → sent: customer waited {' '}
          <span className="text-base font-semibold text-foreground">
            {(t.totalMs / 1000).toFixed(2)} s
          </span>
        </p>
        <p className="text-[10px] text-foreground-subtle">
          {t.laps.length} stations
        </p>
      </div>
      <ul className="space-y-1.5">
        {t.laps.map((lap, i) => (
          <li key={i} className="text-[11px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-foreground">{lap.station}</span>
              <span className="whitespace-nowrap font-mono text-foreground-subtle">
                {lap.durationMs.toLocaleString()} ms
              </span>
            </div>
            <div className="mt-0.5 h-1.5 w-full rounded bg-surface-muted">
              <div
                className={cn('h-full rounded', colourFor(lap.durationMs))}
                style={{
                  width: `${Math.max(2, (lap.durationMs / slowest) * 100)}%`,
                }}
              />
            </div>
            {lap.meta ? (
              <p className="mt-0.5 text-[10px] text-foreground-subtle">
                {Object.entries(lap.meta)
                  .map(([k, v]) => `${k}: ${String(v)}`)
                  .join(' · ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProvHallucinations({ p }: { p: MessageProvenance }) {
  const hals = p.hallucinations ?? [];
  if (hals.length === 0) {
    return (
      <p className="text-emerald-700">
        ✓ Nothing flagged. Every product, price, and business-info phrase the bot used was
        present in the candidate catalog.
      </p>
    );
  }
  const decisionsByIndex = new Map(
    (p.flagDecisions ?? []).map((d) => [d.flagIndex, d] as const),
  );
  return (
    <ul className="space-y-2">
      {hals.map((h, i) => (
        <HallucinationRow
          key={i}
          h={h}
          flagIndex={i}
          messageId={p.messageId}
          existingDecision={decisionsByIndex.get(i)?.decision ?? null}
        />
      ))}
    </ul>
  );
}

// Phase 8 / 1.7 — single hallucination row with feedback buttons.
// Clicking "Not a problem" marks it as a false positive (and auto-adds
// the phrase to this org's suppression list — the scanner will skip
// future matches automatically). "Yes wrong" confirms it's a real
// hallucination (powers the precision metric). "Skip" defers.
function HallucinationRow({
  h,
  flagIndex,
  messageId,
  existingDecision,
}: {
  h: NonNullable<MessageProvenance['hallucinations']>[number];
  flagIndex: number;
  messageId: string;
  existingDecision: 'false_positive' | 'true_positive' | 'skip' | null;
}) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: 'false_positive' | 'true_positive' | 'skip') =>
      api.post(`/api/v1/inbox/messages/${messageId}/flags/${flagIndex}/decide`, {
        decision,
      }),
    onSuccess: (_data, decision) => {
      toast.success(
        decision === 'false_positive'
          ? 'Marked as not a problem. Future replies with this phrase will not be flagged.'
          : decision === 'true_positive'
            ? 'Confirmed as wrong. Recorded for the metrics.'
            : 'Skipped.',
      );
      queryClient.invalidateQueries({ queryKey: ['provenance', messageId] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not record decision.'),
  });
  return (
    <li
      className={cn(
        'rounded border px-2 py-1.5',
        h.severity === 'critical'
          ? 'border-rose-300 bg-rose-50'
          : 'border-amber-300 bg-amber-50',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          <span
            className={cn(
              'mr-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white',
              h.severity === 'critical' ? 'bg-rose-500' : 'bg-amber-500',
            )}
          >
            {h.severity}
          </span>
          {h.matchedText}
        </span>
        <span className="text-[10px] text-foreground-subtle">{h.type}</span>
      </div>
      <p className="mt-1 text-[11px] italic text-foreground-muted">"{h.context}"</p>
      <p className="mt-1 text-[11px] text-foreground">{h.reason}</p>
      <div className="mt-2 flex items-center gap-1.5">
        {existingDecision === 'false_positive' ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            ✓ Marked as not a problem · future replies suppressed
          </span>
        ) : existingDecision === 'true_positive' ? (
          <span className="rounded bg-rose-100 px-2 py-0.5 text-[10px] font-medium text-rose-700">
            ⚠ Confirmed wrong
          </span>
        ) : existingDecision === 'skip' ? (
          <span className="rounded bg-foreground/10 px-2 py-0.5 text-[10px] font-medium text-foreground-muted">
            Skipped
          </span>
        ) : null}
        <FlagButton
          icon="✓"
          label="Not a problem"
          variant="ok"
          disabled={decide.isPending}
          onClick={() => decide.mutate('false_positive')}
        />
        <FlagButton
          icon="⚠"
          label="Yes, wrong"
          variant="bad"
          disabled={decide.isPending}
          onClick={() => decide.mutate('true_positive')}
        />
        <FlagButton
          icon="🤷"
          label="Skip"
          variant="skip"
          disabled={decide.isPending}
          onClick={() => decide.mutate('skip')}
        />
      </div>
    </li>
  );
}

function FlagButton({
  icon,
  label,
  variant,
  onClick,
  disabled,
}: {
  icon: string;
  label: string;
  variant: 'ok' | 'bad' | 'skip';
  onClick: () => void;
  disabled?: boolean;
}) {
  const styles: Record<typeof variant, string> = {
    ok: 'border-emerald-300 text-emerald-700 hover:bg-emerald-100',
    bad: 'border-rose-300 text-rose-700 hover:bg-rose-100',
    skip: 'border-border text-foreground-muted hover:bg-surface-muted',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded border bg-surface px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50',
        styles[variant],
      )}
    >
      <span className="mr-1">{icon}</span>
      {label}
    </button>
  );
}

function ProvTypeBadge({
  type,
}: {
  type:
    | 'product'
    | 'service'
    | 'faq'
    | 'policy'
    | 'business_info'
    | 'bot_config'
    | 'customer_profile';
}) {
  const colours: Record<typeof type, string> = {
    product: 'bg-emerald-100 text-emerald-700',
    service: 'bg-sky-100 text-sky-700',
    faq: 'bg-violet-100 text-violet-700',
    policy: 'bg-amber-100 text-amber-700',
    business_info: 'bg-slate-100 text-slate-700',
    bot_config: 'bg-fuchsia-100 text-fuchsia-700',
    customer_profile: 'bg-indigo-100 text-indigo-700',
  };
  return (
    <span
      className={cn(
        'mr-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide',
        colours[type],
      )}
    >
      {type}
    </span>
  );
}

function NoteBubble({ note }: { note: Note }) {
  // System breadcrumbs (cart captured, escalations, booking ids…) arrive by
  // the dozen in long threads — render them as one quiet truncated line.
  // Human-authored notes keep the full card.
  if (!note.authorName && !note.authorEmail) {
    return (
      <div className="flex justify-center">
        <p
          className="max-w-[92%] truncate text-center text-[11px] leading-5 text-[#7A6F69]"
          title={note.body}
        >
          <StickyNote className="mr-1 inline size-3 align-[-2px]" />
          {note.body} · {shortTime(note.createdAt)}
        </p>
      </div>
    );
  }
  return (
    <div className="flex justify-center">
      <div className="max-w-[80%] rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-900">
        <div className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide">
          <StickyNote className="size-3" /> Internal note · {note.authorName ?? note.authorEmail ?? 'system'}
        </div>
        <p className="whitespace-pre-wrap break-words">{note.body}</p>
        <p className="mt-1 text-[10px] text-amber-700/80">{formatRelative(note.createdAt)}</p>
      </div>
    </div>
  );
}

function ReplyBox({
  to,
  cannedResponses,
  loading,
  onSend,
  onAddNote,
  addingNote,
}: {
  to: string;
  cannedResponses: CannedResponse[];
  loading: boolean;
  onSend: (body: string) => void;
  onAddNote: (body: string) => void;
  addingNote: boolean;
}) {
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [showCanned, setShowCanned] = useState(false);
  // Template-send dialog state. The Template button next to Canned opens
  // a picker that lists approved WhatsApp templates + lets the operator
  // fill any {{1}}, {{2}}… body variables before sending. Reuses the
  // existing /whatsapp/test-send endpoint that the channel-config page
  // uses for test sends — it already persists the rendered template to
  // the thread + bumps the inbox counters.
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [attaching, setAttaching] = useState(false);
  // Pending attachment — uploaded to Wasabi but NOT yet sent to Meta.
  // Operator picks file → it uploads in the background → we keep the
  // assetId here. Send happens when the operator clicks Send, with the
  // current body field used as caption.
  const [pendingAttachment, setPendingAttachment] = useState<{
    assetId: string;
    mediaType: 'image' | 'document' | 'audio';
    filename: string;
    durationSec?: number;
  } | null>(null);
  const [sendingMedia, setSendingMedia] = useState(false);
  // Voice recording state. We prefer opus-recorder (canonical OGG/Opus
  // — passes Meta's strict media validator and lands as a real
  // WhatsApp voice bubble). MediaRecorder is the fallback for older
  // browsers; its output gets degraded to a document on the server.
  const [recording, setRecording] = useState(false);
  const [recordedSec, setRecordedSec] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // opus-recorder is dynamically imported so the 80-100kB worker
  // doesn't ship to non-voice users on initial bundle.
  const opusRecorderRef = useRef<OpusRecorderLike | null>(null);
  const opusBytesRef = useRef<Uint8Array | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef<number>(0);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const insertCanned = (cr: CannedResponse) => {
    // {first_name}, {phone} substitution — first_name is left empty for the
    // operator to fill (we don't have a name → first_name mapping yet).
    const filled = cr.body.replace(/\{phone\}/g, to);
    setBody((prev) => (prev ? `${prev}\n${filled}` : filled));
    setShowCanned(false);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // Two-tier voice recording strategy:
  //
  //   1) Prefer opus-recorder — a JS lib that produces a canonical
  //      OGG/Opus container (the exact format WhatsApp uses for native
  //      voice notes). Meta's strict async validator accepts it, so
  //      the customer sees a real voice bubble with the play button.
  //   2) Fallback: native MediaRecorder. Its MP4/WebM output passes
  //      Meta's /media upload but fails the deeper delivery validation
  //      with error 131053 — the server then degrades it to a document
  //      so the customer still receives the audio, just as a file.
  async function startOpusRecording(): Promise<boolean> {
    try {
      // @ts-expect-error — opus-recorder ships no TS types
      const mod = await import('opus-recorder');
      const RecorderCtor = (mod as { default: OpusRecorderCtor }).default;
      if (!RecorderCtor) return false;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      const rec = new RecorderCtor({
        encoderPath: '/opus/encoderWorker.min.js',
        // streamPages:false → ondataavailable fires ONCE at stop with
        // the entire OGG file as a Uint8Array. We just collect it
        // into opusBytesRef and build a File in stopRecording.
        streamPages: false,
        encoderApplication: 2048, // VOIP — what WhatsApp / phone calls use
        encoderSampleRate: 16_000, // matches WhatsApp voice notes
        numberOfChannels: 1,
      });
      rec.ondataavailable = (typedArray: Uint8Array) => {
        opusBytesRef.current = typedArray;
      };
      rec.onstop = () => {
        // Tear down the mic so the OS recording indicator clears.
        recordStreamRef.current?.getTracks().forEach((t) => t.stop());
        recordStreamRef.current = null;
      };
      rec.onerror = (err: unknown) => {
        console.warn('[voice] opus-recorder error', err);
      };
      opusBytesRef.current = null;
      await rec.start();
      opusRecorderRef.current = rec;
      return true;
    } catch (err) {
      console.warn('[voice] opus-recorder failed to start, falling back to MediaRecorder', err);
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
      return false;
    }
  }

  function pickRecorderMime(): string | null {
    if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return null;
    const candidates = ['audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/webm;codecs=opus'];
    for (const mime of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(mime)) return mime;
      } catch {
        /* some browsers throw */
      }
    }
    return null;
  }
  const canRecord = typeof window !== 'undefined' && pickRecorderMime() !== null;

  async function startRecording() {
    if (recording) return;
    // Tier 1: try opus-recorder first.
    const opusOk = await startOpusRecording();
    if (opusOk) {
      recordStartRef.current = Date.now();
      setRecording(true);
      setRecordedSec(0);
      recordTimerRef.current = setInterval(() => {
        setRecordedSec(Math.round((Date.now() - recordStartRef.current) / 1000));
      }, 250);
      return;
    }
    // Tier 2: MediaRecorder fallback.
    const mime = pickRecorderMime();
    if (!mime) {
      toast.error('Voice recording not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType: mime });
      recordChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        // Tear down the mic stream before uploading so the OS-level
        // recording indicator stops immediately.
        recordStreamRef.current?.getTracks().forEach((t) => t.stop());
        recordStreamRef.current = null;
        if (recordTimerRef.current) {
          clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        const durationSec = Math.round((Date.now() - recordStartRef.current) / 1000);
        const blob = new Blob(recordChunksRef.current, { type: mime });
        if (blob.size < 500) {
          toast.error('Recording too short — try again.');
          setRecording(false);
          setRecordedSec(0);
          return;
        }
        // Upload as a document-kind asset — the server doesn't gate
        // MIME on documents, and /whatsapp/send-media reads the
        // stored content-type when posting to Meta.
        const ext = mime.startsWith('audio/ogg') ? 'ogg' : mime.startsWith('audio/mp4') ? 'm4a' : 'webm';
        const filename = `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        const file = new File([blob], filename, { type: mime });
        setAttaching(true);
        try {
          const { uploadFile } = await import('@/lib/upload');
          const { assetId } = await uploadFile(file, 'document');
          // Voice notes auto-send the moment the recording stops —
          // every messenger app behaves this way and operators
          // expect the same. Files / images keep the explicit
          // staging UI because they often want a caption.
          setAttaching(false);
          setRecording(false);
          setRecordedSec(0);
          setSendingMedia(true);
          try {
            const res = await api.post<{ data: { ok: boolean; errorMessage: string | null } }>(
              '/api/v1/whatsapp/send-media',
              { to, assetId, mediaType: 'audio' },
            );
            if (res.data.ok) {
              toast.success(`Voice note (${durationSec}s) sent`);
              qc.invalidateQueries({ queryKey: ['inbox-thread'] });
              qc.invalidateQueries({ queryKey: ['inbox-threads'] });
            } else {
              toast.error(res.data.errorMessage ?? 'Voice send failed');
            }
          } catch (sendErr) {
            toast.error(sendErr instanceof Error ? sendErr.message : 'Voice send failed');
          } finally {
            setSendingMedia(false);
          }
          return;
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Upload failed');
        } finally {
          setAttaching(false);
          setRecording(false);
          setRecordedSec(0);
        }
      };
      recorderRef.current = mr;
      recordStartRef.current = Date.now();
      mr.start();
      setRecording(true);
      setRecordedSec(0);
      recordTimerRef.current = setInterval(() => {
        setRecordedSec(Math.round((Date.now() - recordStartRef.current) / 1000));
      }, 250);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Mic permission denied');
    }
  }

  async function finishOpusRecording(durationSec: number) {
    // ondataavailable fires synchronously during rec.stop(); give the
    // worker a tick to post back if we got here too fast.
    if (!opusBytesRef.current) await new Promise((r) => setTimeout(r, 50));
    const bytes = opusBytesRef.current;
    opusBytesRef.current = null;
    opusRecorderRef.current = null;
    if (!bytes || bytes.byteLength < 500) {
      toast.error('Recording too short — try again.');
      return;
    }
    const filename = `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.ogg`;
    const file = new File([bytes as BlobPart], filename, { type: 'audio/ogg' });
    setAttaching(true);
    try {
      const { uploadFile } = await import('@/lib/upload');
      const { assetId } = await uploadFile(file, 'document');
      setAttaching(false);
      setSendingMedia(true);
      try {
        const res = await api.post<{ data: { ok: boolean; errorMessage: string | null } }>(
          '/api/v1/whatsapp/send-media',
          { to, assetId, mediaType: 'audio' },
        );
        if (res.data.ok) {
          toast.success(`Voice note (${durationSec}s) sent`);
          qc.invalidateQueries({ queryKey: ['inbox-thread'] });
          qc.invalidateQueries({ queryKey: ['inbox-threads'] });
        } else {
          toast.error(res.data.errorMessage ?? 'Voice send failed');
        }
      } catch (sendErr) {
        toast.error(sendErr instanceof Error ? sendErr.message : 'Voice send failed');
      } finally {
        setSendingMedia(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setAttaching(false);
    }
  }

  function stopRecording() {
    if (!recording) return;
    if (opusRecorderRef.current) {
      const durationSec = Math.round((Date.now() - recordStartRef.current) / 1000);
      try {
        opusRecorderRef.current.stop();
      } catch {
        /* already stopped */
      }
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setRecording(false);
      setRecordedSec(0);
      void finishOpusRecording(durationSec);
      return;
    }
    if (recorderRef.current) {
      try {
        recorderRef.current.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  function cancelRecording() {
    if (!recording) return;
    // Opus path: discard the worker output before stopping.
    if (opusRecorderRef.current) {
      opusBytesRef.current = null;
      try {
        opusRecorderRef.current.stop();
      } catch {
        /* */
      }
      opusRecorderRef.current = null;
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
      if (recordTimerRef.current) {
        clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setRecording(false);
      setRecordedSec(0);
      return;
    }
    // MediaRecorder path: discard chunks before stopping so onstop
    // doesn't upload them.
    recordChunksRef.current = [];
    recorderRef.current?.stop();
    recordStreamRef.current?.getTracks().forEach((t) => t.stop());
    recordStreamRef.current = null;
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    setRecordedSec(0);
  }

  // Cleanup if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    };
  }, []);

  // Stage the attachment: upload to Wasabi but DO NOT call /send-media
  // yet. The Send button below handles the actual transmission.
  async function stageAttachment(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      toast.error('Files must be under 16 MB.');
      return;
    }
    setAttaching(true);
    try {
      const isImage = file.type.startsWith('image/');
      const { uploadFile } = await import('@/lib/upload');
      const { assetId } = await uploadFile(file, isImage ? 'image' : 'document');
      setPendingAttachment({
        assetId,
        mediaType: isImage ? 'image' : 'document',
        filename: file.name,
      });
      toast.success('Attached — click Send to deliver');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function sendMediaNow() {
    if (!pendingAttachment) return;
    setSendingMedia(true);
    try {
      const res = await api.post<{ data: { ok: boolean; errorMessage: string | null } }>(
        '/api/v1/whatsapp/send-media',
        {
          to,
          assetId: pendingAttachment.assetId,
          mediaType: pendingAttachment.mediaType,
          caption: body.trim() || undefined,
        },
      );
      if (res.data.ok) {
        toast.success('Media sent');
        setBody('');
        setPendingAttachment(null);
        qc.invalidateQueries({ queryKey: ['inbox-thread'] });
        qc.invalidateQueries({ queryKey: ['inbox-threads'] });
      } else {
        toast.error(res.data.errorMessage ?? 'Send failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSendingMedia(false);
    }
  }

  const submit = () => {
    // If a file is attached, sending the message means transmitting the
    // media (with current text as caption). Otherwise, plain text reply
    // or note.
    if (mode === 'reply' && pendingAttachment) {
      void sendMediaNow();
      return;
    }
    const v = body.trim();
    if (!v) return;
    if (mode === 'reply') onSend(v);
    else onAddNote(v);
    setBody('');
  };

  return (
    <div className="border-t border-[#E3DBCE] bg-[#FCFBFA]">
      <div className="flex items-center gap-3 border-b border-[#E3DBCE] px-3 py-1">
        <button
          type="button"
          onClick={() => setMode('reply')}
          aria-pressed={mode === 'reply'}
          className={cn(
            'border-b-2 px-0.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E53E34]/50',
            mode === 'reply'
              ? 'border-[#E53E34] text-[#360516]'
              : 'border-transparent text-[#6C625C] hover:text-[#360516]',
          )}
        >
          Reply
        </button>
        <button
          type="button"
          onClick={() => setMode('note')}
          aria-pressed={mode === 'note'}
          className={cn(
            'border-b-2 px-0.5 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E53E34]/50',
            mode === 'note'
              ? 'border-[#E53E34] text-[#360516]'
              : 'border-transparent text-[#6C625C] hover:text-[#360516]',
          )}
        >
          <StickyNote className="mr-1 inline size-3" /> Internal note
        </button>
        <div className="relative ml-auto flex items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            className="hidden"
            onChange={stageAttachment}
          />
          {recording ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="bg-red-50 text-red-700 hover:bg-red-100"
                onClick={stopRecording}
                aria-label="Stop recording"
              >
                <Mic className="size-3.5" /> Stop · {recordedSec}s
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelRecording} aria-label="Cancel recording">
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <>
              {/* Composer tools — always visible; icon-only on phones so
                  Attach/Voice/Canned/Template all fit next to Send. */}
              <div className="flex items-center gap-0.5 sm:gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  disabled={mode === 'note' || attaching || !!pendingAttachment}
                  loading={attaching}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach file"
                >
                  <Paperclip className="size-3.5" /> <span className="hidden sm:inline">Attach</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  disabled={mode === 'note' || attaching || !!pendingAttachment || !canRecord}
                  onClick={startRecording}
                  aria-label="Record voice note"
                  title={
                    canRecord
                      ? 'Record a voice note (sent as a WhatsApp voice message)'
                      : "This browser doesn't support voice recording — try Chrome/Safari"
                  }
                >
                  <Mic className="size-3.5" /> <span className="hidden sm:inline">Voice</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowCanned((v) => !v)}
                  disabled={mode === 'note'}
                  aria-haspopup="true"
                  aria-expanded={showCanned}
                >
                  <Clock className="size-3.5" /> <span className="hidden sm:inline">Canned</span>{' '}
                  <ChevronDown className="size-3" />
                </Button>
                {mode === 'reply' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => setTemplateDialogOpen(true)}
                    aria-haspopup="dialog"
                    title="Send an approved WhatsApp template"
                  >
                    <FileText className="size-3.5" /> <span className="hidden sm:inline">Template</span>
                  </Button>
                ) : null}
              </div>
            </>
          )}
          {/* Shared canned popover — anchored to the cluster so it works from
              both the desktop inline button and the mobile ⋯ menu. */}
          {showCanned ? (
            <div className="absolute right-0 top-full z-10 mt-1 w-64 max-w-[82vw] rounded-md border border-border bg-surface shadow-lg">
              {cannedResponses.length === 0 ? (
                <p className="px-3 py-2 text-xs text-foreground-muted">
                  No canned responses yet. Manage in Settings.
                </p>
              ) : (
                cannedResponses.map((cr) => (
                  <button
                    key={cr.id}
                    type="button"
                    onClick={() => insertCanned(cr)}
                    className="block w-full border-b border-border px-3 py-2 text-left text-xs hover:bg-surface-muted last:border-b-0 focus-visible:outline-none focus-visible:bg-surface-muted"
                  >
                    <span className="font-mono text-[#E53E34]">/{cr.shortcut}</span>{' '}
                    <span className="truncate text-foreground-muted">{cr.body.slice(0, 60)}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        {/* Send / Add-note lives in the toolbar row (far right) — the composer
            footer was removed so the chat keeps maximum height. */}
        <Button
          type="button"
          size="sm"
          className="gap-1 bg-[#E53E34] text-white hover:bg-[#A32D2D]"
          loading={
            mode === 'reply' ? (pendingAttachment ? sendingMedia : loading) : addingNote
          }
          disabled={
            mode === 'reply'
              ? pendingAttachment
                ? sendingMedia
                : body.trim().length === 0
              : body.trim().length === 0
          }
          onClick={submit}
        >
          {mode === 'reply' ? (
            <>
              <Send className="size-3.5" /> Send
            </>
          ) : (
            <>
              <CheckCircle2 className="size-3.5" /> Add note
            </>
          )}
        </Button>
      </div>
      <div className="p-3">
        {pendingAttachment ? (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs">
            {pendingAttachment.mediaType === 'audio' ? (
              <Mic className="size-3.5 text-foreground-muted" />
            ) : (
              <Paperclip className="size-3.5 text-foreground-muted" />
            )}
            <span className="flex-1 truncate font-mono">
              {pendingAttachment.mediaType === 'audio' && pendingAttachment.durationSec != null
                ? `Voice note · ${pendingAttachment.durationSec}s`
                : pendingAttachment.filename}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              Not sent yet
            </span>
            <button
              type="button"
              onClick={() => setPendingAttachment(null)}
              className="rounded p-0.5 text-foreground-muted hover:bg-surface-muted hover:text-foreground"
              aria-label="Remove attachment"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ) : null}
        <Textarea
          ref={taRef}
          rows={3}
          className="rounded-xl border-[#D6C9B4] bg-white text-[#360516] placeholder:text-[#7A6F69] focus-visible:ring-[#E53E34]/25"
          placeholder={
            mode === 'reply'
              ? pendingAttachment
                ? 'Optional caption…'
                : `Reply to ${to}…  (must be inside Meta's 24-hour customer-session window)`
              : 'Internal note — visible to your team, not sent to the customer.'
          }
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline. Pointer-coarse (touch)
            // devices keep Enter as a newline so the on-screen keyboard's return
            // key doesn't fire-and-send mid-typing.
            const isTouch =
              typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label={mode === 'reply' ? 'Reply message' : 'Internal note'}
        />
      </div>
      {/* Template-send dialog. Mounted inside ReplyBox so it has the
          right `to` in scope. Closes itself on a successful send + the
          thread refresh happens via React Query invalidation inside the
          dialog. */}
      <TemplateSendDialog
        open={templateDialogOpen}
        onOpenChange={setTemplateDialogOpen}
        to={to}
      />
    </div>
  );
}

// Small channel dot pinned to the avatar corner (mockup style): green W for
// WhatsApp, blue F for Messenger, magenta I for Instagram.
function ChannelBadge({ channel }: { channel?: string }) {
  const kind = channel === 'messenger' ? 'fb' : channel === 'instagram' ? 'ig' : 'wa';
  const style =
    kind === 'fb' ? 'bg-[#185FA5]' : kind === 'ig' ? 'bg-[#993556]' : 'bg-[#3B6D11]';
  const letter = kind === 'fb' ? 'F' : kind === 'ig' ? 'I' : 'W';
  return (
    <span
      aria-hidden
      className={cn(
        'absolute -bottom-0.5 -right-0.5 flex size-[15px] items-center justify-center rounded-full border-2 border-[#FBF8F3] text-[8px] font-bold text-white',
        style,
      )}
    >
      {letter}
    </span>
  );
}

interface TemplateOption {
  id: string;
  name: string;
  language: string;
  status: string;
  bodyText?: string | null;
  components?: Record<string, unknown>[] | null;
}

// Parse the `{{n}}` placeholders out of a template's body text and
// return them as a sorted unique list. Used to render exactly the
// right number of variable inputs in the dialog.
function placeholdersIn(body: string | null | undefined): number[] {
  if (!body) return [];
  const set = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

function TemplateSendDialog({
  open,
  onOpenChange,
  to,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  to: string;
}) {
  const qc = useQueryClient();
  const templatesQ = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => api.get<{ data: TemplateOption[] }>('/api/v1/whatsapp/templates'),
    // Don't refetch while the dialog is open — gives the operator a
    // stable list to pick from. They can reload by reopening.
    enabled: open,
    staleTime: 60_000,
  });
  const [selectedId, setSelectedId] = useState<string>('');
  const [vars, setVars] = useState<string[]>([]);

  // Approved-only templates surface in the picker. Anything else (pending,
  // rejected, disabled) won't actually deliver via Meta, so we hide them
  // rather than letting the operator pick + then fail at send time.
  const templates = (templatesQ.data?.data ?? []).filter((t) => t.status === 'approved');
  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const placeholders = useMemo(() => placeholdersIn(selected?.bodyText), [selected]);

  // Reset state when the dialog opens / the picked template changes.
  useEffect(() => {
    if (!open) return;
    setSelectedId('');
    setVars([]);
  }, [open]);
  useEffect(() => {
    setVars(new Array(placeholders.length).fill(''));
  }, [selectedId, placeholders.length]);

  const send = useMutation({
    mutationFn: () => {
      if (!selected) return Promise.reject(new Error('Pick a template first'));
      return api.post<{ data: { ok: boolean; metaMessageId: string | null; errorMessage: string | null } }>(
        '/api/v1/whatsapp/test-send',
        {
          to,
          templateName: selected.name,
          templateLanguage: selected.language,
          parameters: vars.map((v) => v.trim()),
        },
      );
    },
    onSuccess: (res) => {
      if (res.data.ok) {
        toast.success('Template sent');
        qc.invalidateQueries({ queryKey: ['inbox-thread'] });
        qc.invalidateQueries({ queryKey: ['inbox-threads'] });
        onOpenChange(false);
      } else {
        toast.error(res.data.errorMessage ?? 'Send failed — Meta rejected the template.');
      }
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  // Preview the body with the operator's filled values substituted in.
  // Shown beneath the form so they can see exactly what the customer
  // will receive before clicking Send.
  const preview = useMemo(() => {
    if (!selected?.bodyText) return '';
    return selected.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_full, idx: string) => {
      const i = Number(idx) - 1;
      return vars[i]?.trim() ? vars[i].trim() : `{{${idx}}}`;
    });
  }, [selected, vars]);

  const canSend = Boolean(selected) && vars.every((v) => v.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send a template</DialogTitle>
          <DialogDescription>
            Approved WhatsApp template message. Sends to {to} immediately; works inside or
            outside Meta&apos;s 24-hour session window.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-pick">Template</Label>
            {templatesQ.isLoading ? (
              <div className="h-9 w-full animate-pulse rounded-md bg-surface-elevated" />
            ) : templates.length === 0 ? (
              <p className="text-xs text-foreground-muted">
                No approved templates yet. Create + submit one on{' '}
                <a href="/whatsapp/templates" className="underline">
                  /whatsapp/templates
                </a>{' '}
                — Meta&apos;s approval usually takes a few minutes.
              </p>
            ) : (
              <Select value={selectedId} onValueChange={setSelectedId}>
                <SelectTrigger id="tpl-pick">
                  <SelectValue placeholder="Pick an approved template…" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} ({t.language})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {placeholders.length > 0 ? (
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-foreground-subtle">
                Variables
              </Label>
              {placeholders.map((n, i) => (
                <div key={n} className="space-y-1">
                  <Label htmlFor={`tpl-var-${n}`} className="text-xs">
                    {`{{${n}}}`}
                  </Label>
                  <Input
                    id={`tpl-var-${n}`}
                    value={vars[i] ?? ''}
                    onChange={(e) => {
                      const next = [...vars];
                      next[i] = e.target.value;
                      setVars(next);
                    }}
                    placeholder={`Value for {{${n}}}`}
                  />
                </div>
              ))}
            </div>
          ) : null}

          {selected ? (
            <div className="rounded-md border border-border bg-surface-muted/60 p-3 text-xs">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
                Preview
              </p>
              <p className="whitespace-pre-wrap text-sm">{preview || '(no body)'}</p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => send.mutate()} disabled={!canSend} loading={send.isPending}>
            <Send className="size-3.5" /> Send template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- SSE realtime hook ---------------------------------------------
// Auth happens via a single-use nonce exchanged for the active session;
// `connectSse` owns the lifecycle (nonce → connect → reconnect-with-backoff).
function useInboxSSE() {
  const qc = useQueryClient();
  useEffect(() => {
    if (!getAccessToken()) return;
    const dispose = connectSse('/api/v1/inbox/sse', {
      onTick: () => {
        qc.invalidateQueries({ queryKey: ['inbox-threads'] });
        qc.invalidateQueries({ queryKey: ['inbox-thread'] });
        // Drive the sidebar Inbox badge in real time. When the bot
        // escalates a chat or the operator un-escalates one, the count
        // should flip without waiting for the 10s sidebar poll.
        qc.invalidateQueries({ queryKey: ['sidebar-inbox-counts'] });
      },
    });
    return dispose;
  }, [qc]);
}
