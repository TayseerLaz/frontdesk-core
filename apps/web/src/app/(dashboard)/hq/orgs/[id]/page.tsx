'use client';

import {
  DEFAULT_EXPORT_SECTIONS,
  EXPORT_FORMATS,
  EXPORT_LAYOUTS,
  EXPORT_SECTIONS,
  EXPORT_SECTION_KEYS,
  formatMicrosUsd,
  MICROS_PER_USD,
  ORG_FEATURES,
} from '@platform/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRightToLine,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  Info,
  KeyRound,
  Lock,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Play,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { TenantCostOverview } from '@/components/admin/tenant-cost-overview';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

type AiPlan = 'basic' | 'middle' | 'max' | 'ultra';
const AI_PLANS: AiPlan[] = ['basic', 'middle', 'max', 'ultra'];
const AI_PLAN_LABEL: Record<AiPlan, string> = { basic: 'Basic', middle: 'Middle', max: 'Max', ultra: 'Ultra' };
// What each AI plan includes — model + capabilities. Single source for the
// admin plan picker + the AI-tab overview. Mirrors lib/openai.ts routing:
// basic→Groq Llama, middle→GPT-4o, max→Claude Sonnet, ultra→Sonnet+Haiku+memory.
interface AiPlanMeta {
  label: string;
  model: string;
  provider: string;
  tagline: string;
  features: string[];
}
const AI_PLAN_META: Record<AiPlan, AiPlanMeta> = {
  basic: {
    label: 'Basic',
    model: 'Llama 3.3 70B',
    provider: 'Groq · GPT-4o-mini fallback',
    tagline: 'Fast & economical everyday replies',
    features: [
      'Groq Llama 3.3 70B (OpenAI GPT-4o-mini fallback)',
      'Grounded in the tenant’s catalog, services & FAQs',
      'Great for menus and simple Q&A',
      'Lowest cost per message',
    ],
  },
  middle: {
    label: 'Middle',
    model: 'GPT-4o',
    provider: 'OpenAI',
    tagline: 'Stronger reasoning & multilingual',
    features: [
      'OpenAI GPT-4o',
      'Better instruction-following & Arabic dialects',
      'More reliable orders & bookings handling',
      'Balanced quality vs cost',
    ],
  },
  max: {
    label: 'Max',
    model: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    tagline: 'Top-tier accuracy & faithfulness',
    features: [
      'Anthropic Claude Sonnet 4.6',
      'Best on complex, nuanced conversations',
      'Strongest scope-lock & anti-hallucination',
      'Recommended for premium / brand-critical bots',
    ],
  },
  ultra: {
    label: 'Ultra',
    model: 'Claude Sonnet 4.6 + Haiku 4.5',
    provider: 'Anthropic · hybrid',
    tagline: 'Flagship — Sonnet reply + per-customer memory',
    features: [
      'Claude Sonnet 4.6 writes every reply',
      'Claude Haiku 4.5 handles intent + persona passes',
      'Per-customer memory (remembers each contact)',
      'Highest quality, highest cost',
    ],
  },
};

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
  aiPlan: AiPlan;
  disabledFeatures: string[];
  memberCount: number;
  lastActivityAt: string | null;
}

interface OrgDetails {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  members: Array<{
    userId: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    isActive: boolean;
    emailVerified: boolean;
    totpEnabled: boolean;
    lastLoginAt: string | null;
  }>;
  whatsappChannel: { displayPhoneNumber: string | null; isActive: boolean; isPrimary: boolean } | null;
  counts: { products: number; services: number; faqs: number; apiKeys: number; webhooks: number };
  recentAuditLog: Array<{ action: string; actorEmail: string | null; createdAt: string }>;
}

interface AiUsage {
  aiPlan: AiPlan;
  aiMessages: { used: number; cap: number | null; unlimited: boolean; percentUsed: number };
  // tokens = inputTokens + outputTokens (understanding + sending). Both are
  // billed and both are counted here; the split is shown in the admin cost card.
  today: { tokens: number; inputTokens: number; outputTokens: number; usd: number; replies: number };
  thisMonth: { tokens: number; inputTokens: number; outputTokens: number; usd: number; replies: number };
}

interface OrgBroadcasts {
  totals: { broadcasts: number; recipients: number; sent: number };
  broadcasts: {
    id: string;
    name: string;
    status: string;
    totalRecipients: number;
    sentCount: number;
    deliveredCount: number;
    readCount: number;
    createdAt: string;
  }[];
}

interface ExportRow {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  fileSizeBytes: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface WalletDto {
  organizationId: string;
  meteringEnabled: boolean;
  availableMicros: number;
  heldMicros: number;
  pricePerMessageMicros: number;
  metaCostMicros: number;
  lowBalanceThresholdMicros: number;
  lifetimeToppedUpMicros: number;
  lifetimeSpentMicros: number;
  lifetimeMessages: number;
  marginPerMessageMicros: number;
  marginPct: number;
  lifetimeMarginMicros: number;
  alertThresholds: number[];
  pctUsed: number;
  alertLevel: 'ok' | 'alert' | 'empty';
}

type WalletLedgerKind = 'topup' | 'adjust' | 'settle' | 'release' | 'hold';

interface WalletLedgerRow {
  id: string;
  kind: WalletLedgerKind;
  amountMicros: number;
  availableAfterMicros: number;
  heldAfterMicros: number;
  broadcastId: string | null;
  note: string | null;
  actorName: string | null;
  createdAt: string;
}

interface WalletLedgerPage {
  data: WalletLedgerRow[];
  nextCursor: string | null;
}

const WALLET_KIND_LABEL: Record<WalletLedgerKind, string> = {
  topup: 'Top-up',
  settle: 'Message charge',
  adjust: 'Adjustment',
  release: 'Refund',
  hold: 'Hold',
};

// Lean grouping for the Features tab so the toggle grid reads as tidy sections
// (Channels / Catalog / Comms / Advanced) instead of a wall of switches. Any
// feature key not mapped here falls into "Advanced".
type FeatureGroup = 'Channels' | 'Catalog' | 'Comms' | 'Advanced';
const FEATURE_GROUPS: FeatureGroup[] = ['Channels', 'Catalog', 'Comms', 'Advanced'];
const FEATURE_GROUP: Record<string, FeatureGroup> = {
  messenger: 'Channels',
  instagram: 'Channels',
  phone: 'Channels',
  inbox: 'Channels',
  catalog: 'Catalog',
  shopify: 'Catalog',
  orders: 'Catalog',
  bookings: 'Catalog',
  broadcasts: 'Comms',
  contacts: 'Comms',
  ai: 'Comms',
  voice_transcription: 'Comms',
  analytics: 'Advanced',
  exports: 'Advanced',
};

export default function OrgDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, refresh } = useSession();
  const isOwnOrg =
    !!session && [session.organization?.id, ...(session.availableOrganizations?.map((o) => o.id) ?? [])].includes(id);

  // Base row (for plan + disabledFeatures) — shares the list cache.
  const orgsQ = useQuery({
    queryKey: ['admin-orgs', ''],
    queryFn: () => api.get<{ data: OrgRow[] }>('/api/v1/hq/orgs'),
  });
  const org = orgsQ.data?.data.find((o) => o.id === id) ?? null;

  const detailsQ = useQuery({
    queryKey: ['admin-org-details', id],
    queryFn: () => api.get<{ data: OrgDetails }>(`/api/v1/hq/orgs/${id}/details`),
  });
  const usageQ = useQuery({
    queryKey: ['admin-org-usage', id],
    queryFn: () => api.get<{ data: AiUsage }>(`/api/v1/hq/orgs/${id}/ai-usage`),
    refetchInterval: 30_000,
  });
  const broadcastsQ = useQuery({
    queryKey: ['admin-org-broadcasts', id],
    queryFn: () => api.get<{ data: OrgBroadcasts }>(`/api/v1/hq/orgs/${id}/broadcasts`),
  });
  const d = detailsQ.data?.data;
  const usage = usageQ.data?.data;
  const broadcasts = broadcastsQ.data?.data;
  const currentPlan = usage?.aiPlan ?? org?.aiPlan ?? 'basic';
  const status = d?.status ?? org?.status ?? 'active';

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
    queryClient.invalidateQueries({ queryKey: ['admin-org-details', id] });
  };

  const setStatus = useMutation({
    mutationFn: (s: 'active' | 'suspended') => api.patch(`/api/v1/hq/orgs/${id}`, { status: s }),
    onSuccess: () => {
      toast.success('Status updated');
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  // Invite a member into this tenant (email + role) from the admin panel.
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'editor' | 'viewer'>('editor');
  const inviteMember = useMutation({
    mutationFn: (body: { email: string; role: string }) =>
      api.post(`/api/v1/hq/orgs/${id}/members`, body),
    onSuccess: () => {
      toast.success('Invitation sent');
      setInviteEmail('');
      queryClient.invalidateQueries({ queryKey: ['admin-org-details', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not invite member'),
  });

  // Per-member management: change email + reset password.
  const [emailDialog, setEmailDialog] = useState<{ userId: string; email: string } | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [resetResult, setResetResult] = useState<{ email: string; password: string } | null>(null);
  const changeEmail = useMutation({
    mutationFn: (v: { userId: string; email: string }) =>
      api.patch(`/api/v1/hq/orgs/${id}/members/${v.userId}/email`, { email: v.email }),
    onSuccess: () => {
      toast.success('Email changed');
      setEmailDialog(null);
      queryClient.invalidateQueries({ queryKey: ['admin-org-details', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not change email'),
  });
  const resetPassword = useMutation({
    mutationFn: (userId: string) =>
      api.post<{ data: { userId: string; password: string } }>(
        `/api/v1/hq/orgs/${id}/members/${userId}/reset-password`,
      ),
    onSuccess: (res, userId) => {
      const m = d?.members.find((x) => x.userId === userId);
      setResetResult({ email: m?.email ?? '', password: res.data.password });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not reset password'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/api/v1/hq/orgs/${id}`),
    onSuccess: () => {
      toast.success('Organisation deleted');
      router.push('/hq');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Delete failed'),
  });

  const setPlan = useMutation({
    mutationFn: (next: AiPlan) =>
      api.put<{ data: { aiPlan: AiPlan } }>(`/api/v1/hq/orgs/${id}/ai-plan`, { aiPlan: next }),
    onSuccess: (res) => {
      toast.success(`Plan changed to ${AI_PLAN_LABEL[res.data.aiPlan]}`);
      queryClient.invalidateQueries({ queryKey: ['admin-org-usage', id] });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Plan change failed'),
  });

  const setAiMessageCap = useMutation({
    mutationFn: (cap: number | null) =>
      api.put<{ data: { monthlyAiMessageCap: number | null } }>(
        `/api/v1/hq/orgs/${id}/ai-message-cap`,
        { cap },
      ),
    onSuccess: () => {
      toast.success('Monthly AI messages updated');
      queryClient.invalidateQueries({ queryKey: ['admin-org-usage', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const control = useMutation({
    mutationFn: () =>
      api.post<{ data: { accessToken: string; expiresAt: string } }>(
        `/api/v1/hq/orgs/${id}/impersonate`,
        {},
      ),
    onSuccess: async (res) => {
      setAccessToken(res.data.accessToken, res.data.expiresAt);
      queryClient.clear();
      // Refresh the in-memory session so org name, role, and (critically)
      // disabledFeatures reflect the controlled workspace — otherwise feature
      // gating (e.g. hidden booking/shop tabs) would keep using the admin's
      // own org features.
      await refresh();
      toast.success('Now controlling this workspace.');
      router.push('/dashboard');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not control workspace'),
  });

  // Access (disabled features) — local edit state, saved on demand.
  const [disabled, setDisabled] = useState<string[]>([]);
  useEffect(() => {
    if (org) setDisabled(org.disabledFeatures ?? []);
  }, [org]);
  const saveAccess = useMutation({
    mutationFn: () => api.put(`/api/v1/hq/orgs/${id}/features`, { disabledFeatures: disabled }),
    onSuccess: () => {
      toast.success('Access updated');
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  // Data export (super-admin can export any org, even if the tenant's own
  // self-service export feature is turned off). Poll while one is in flight.
  const exportsQ = useQuery({
    queryKey: ['admin-org-exports', id],
    queryFn: () => api.get<{ data: ExportRow[] }>(`/api/v1/hq/orgs/${id}/exports`),
    refetchInterval: (q) => {
      const rows = q.state.data?.data ?? [];
      return rows.some((e) => e.status === 'pending' || e.status === 'running') ? 3000 : false;
    },
  });
  const exports = exportsQ.data?.data ?? [];
  const exportInflight = exports.some((e) => e.status === 'pending' || e.status === 'running');

  const triggerExport = useMutation({
    mutationFn: (vars: { sections: string[]; format: string; layout: string }) =>
      api.post(`/api/v1/hq/orgs/${id}/export`, vars),
    onSuccess: () => {
      toast.success('Export started — it will appear below when ready.');
      setExportDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['admin-org-exports', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Could not start export'),
  });

  // Export selection dialog — the operator ticks which datasets go in the file,
  // then picks the format (CSV / formal PDF) and layout (one combined / separate).
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportSel, setExportSel] = useState<Set<string>>(() => new Set(DEFAULT_EXPORT_SECTIONS));
  const [exportFormat, setExportFormat] = useState<'csv' | 'pdf'>('csv');
  const [exportLayout, setExportLayout] = useState<'combined' | 'separate'>('combined');

  // ---- WhatsApp wallet & metered billing (super-admin only) ----
  const walletQ = useQuery({
    queryKey: ['admin-org-wallet', id],
    queryFn: () => api.get<{ data: WalletDto }>(`/api/v1/hq/orgs/${id}/wallet`),
    refetchInterval: 30_000,
  });
  const wallet = walletQ.data?.data;
  const invalidateWallet = () =>
    queryClient.invalidateQueries({ queryKey: ['admin-org-wallet', id] });

  const setMetering = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<{ data: WalletDto }>(`/api/v1/hq/orgs/${id}/wallet/metering`, { enabled }),
    onSuccess: (res) => {
      toast.success(res.data.meteringEnabled ? 'Metering enabled' : 'Metering disabled');
      invalidateWallet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const setPrice = useMutation({
    mutationFn: (priceUsd: number) =>
      api.put<{ data: WalletDto }>(`/api/v1/hq/orgs/${id}/wallet/price`, { priceUsd }),
    onSuccess: () => {
      toast.success('Per-message price updated');
      invalidateWallet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const topUp = useMutation({
    mutationFn: (body: { amountUsd: number; note?: string }) =>
      api.post<{ data: WalletDto }>(`/api/v1/hq/orgs/${id}/wallet/topup`, body),
    onSuccess: () => {
      toast.success('Balance topped up');
      invalidateWallet();
      queryClient.invalidateQueries({ queryKey: ['admin-org-wallet-ledger', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Top-up failed'),
  });

  const adjust = useMutation({
    mutationFn: (body: { amountUsd: number; note?: string }) =>
      api.post<{ data: WalletDto }>(`/api/v1/hq/orgs/${id}/wallet/adjust`, body),
    onSuccess: () => {
      toast.success('Balance adjusted');
      invalidateWallet();
      queryClient.invalidateQueries({ queryKey: ['admin-org-wallet-ledger', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Adjustment failed'),
  });

  const setThreshold = useMutation({
    mutationFn: (lowBalanceUsd: number) =>
      api.put<{ data: WalletDto }>(`/api/v1/hq/orgs/${id}/wallet/threshold`, {
        lowBalanceUsd,
      }),
    onSuccess: () => {
      toast.success('Low-balance threshold updated');
      invalidateWallet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const setAlertThresholds = useMutation({
    mutationFn: (thresholds: number[]) =>
      api.put<{ data: WalletDto }>(`/api/v1/hq/orgs/${id}/wallet/alert-thresholds`, {
        thresholds,
      }),
    onSuccess: () => {
      toast.success('Balance alerts updated');
      invalidateWallet();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Update failed'),
  });

  const downloadExport = async (exportId: string) => {
    try {
      const res = await api.get<{ data: { url: string } }>(
        `/api/v1/hq/orgs/${id}/exports/${exportId}/download`,
      );
      window.open(res.data.url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.payload.message : 'Download failed');
    }
  };

  const name = d?.name ?? org?.name ?? 'Organisation';

  // Open the tab named in ?tab= when it's a valid one, else fall back to overview.
  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window === 'undefined') return 'overview';
    const tab = new URLSearchParams(window.location.search).get('tab');
    return tab && ['overview', 'billing', 'ai', 'features', 'members', 'activity'].includes(tab)
      ? tab
      : 'overview';
  });

  // ── AI section: the tenant's live compiled system prompt + the admin-only
  // addendum. The compiled prompt is fetched only when the AI tab is open (it
  // gathers the tenant's whole bot dataset). It's assembled by the REAL bot
  // engine (compileOnly, no LLM), so any code change to the prompt shows here.
  const aiPromptQ = useQuery({
    queryKey: ['admin-ai-prompt', id],
    queryFn: () =>
      api.get<{
        data: {
          compiledPrompt: string;
          adminSystemPromptAppend: string | null;
          promptChars: number;
          productCount: number;
          serviceCount: number;
          faqCount: number;
          hasBotConfig: boolean;
          deployed: boolean;
        };
      }>(`/api/v1/hq/orgs/${id}/ai-compiled-prompt`),
    enabled: activeTab === 'ai',
  });
  const aiPrompt = aiPromptQ.data?.data;
  const [appendDraft, setAppendDraft] = useState('');
  const [appendInit, setAppendInit] = useState(false);
  useEffect(() => {
    if (aiPrompt && !appendInit) {
      setAppendDraft(aiPrompt.adminSystemPromptAppend ?? '');
      setAppendInit(true);
    }
  }, [aiPrompt, appendInit]);
  const savePrompt = useMutation({
    mutationFn: (value: string) =>
      api.put(`/api/v1/hq/orgs/${id}/ai-prompt-append`, {
        adminSystemPromptAppend: value.trim() ? value : null,
      }),
    onSuccess: () => {
      toast.success('Saved — this modification now affects the bot');
      // Refetch the compiled prompt so the preview visibly includes the change.
      queryClient.invalidateQueries({ queryKey: ['admin-ai-prompt', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.payload.message : 'Save failed'),
  });
  const appendDirty = appendInit && appendDraft.trim() !== (aiPrompt?.adminSystemPromptAppend ?? '').trim();

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Tenants', href: '/hq' }, { label: name }]}
        title={name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {org ? <span className="font-mono text-xs">{org.slug}</span> : null}
            <Badge variant={status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'muted'}>
              {status}
            </Badge>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary">
                  <Download className="size-4" /> Export data
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuItem
                  disabled={exportInflight || triggerExport.isPending}
                  onSelect={(ev) => {
                    ev.preventDefault();
                    setExportDialogOpen(true);
                  }}
                >
                  <Download className="size-4" />
                  {exportInflight ? 'Export in progress…' : 'New export — choose data…'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Recent exports</DropdownMenuLabel>
                {exportsQ.isLoading ? (
                  <div className="px-2 py-1.5 text-xs text-foreground-muted">Loading…</div>
                ) : exports.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-foreground-muted">No exports yet.</div>
                ) : (
                  exports.slice(0, 8).map((e) => (
                    <DropdownMenuItem
                      key={e.id}
                      disabled={e.status !== 'succeeded'}
                      onSelect={(ev) => {
                        ev.preventDefault();
                        if (e.status === 'succeeded') downloadExport(e.id);
                      }}
                    >
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="truncate">{formatRelative(e.createdAt)}</span>
                        <span className="shrink-0 text-xs text-foreground-muted">
                          {e.status === 'succeeded' ? 'Download' : e.status}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Pick-what-you-want export dialog. */}
            <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Export data — choose what to include</DialogTitle>
                  <DialogDescription>
                    Tick the datasets to put in the report. You get one CSV per data type in a
                    .zip. Nothing you leave unticked is included.
                  </DialogDescription>
                </DialogHeader>

                {/* Presets + select all / none */}
                <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3 text-xs">
                  <span className="text-foreground-subtle">Quick pick:</span>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted"
                    onClick={() => setExportSel(new Set(EXPORT_SECTION_KEYS))}
                  >
                    Everything
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted"
                    onClick={() => setExportSel(new Set(DEFAULT_EXPORT_SECTIONS))}
                  >
                    Recommended
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted"
                    onClick={() =>
                      setExportSel(
                        new Set(
                          EXPORT_SECTIONS.filter((s) => s.group === 'Business').map((s) => s.key),
                        ),
                      )
                    }
                  >
                    Business only
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted"
                    onClick={() =>
                      setExportSel(
                        new Set(EXPORT_SECTIONS.filter((s) => s.group === 'Clients').map((s) => s.key)),
                      )
                    }
                  >
                    Clients only
                  </button>
                  <button
                    type="button"
                    className="ml-auto rounded-md px-2 py-1 text-foreground-subtle hover:text-foreground"
                    onClick={() => setExportSel(new Set())}
                  >
                    Clear all
                  </button>
                </div>

                {/* Grouped checklist */}
                <div className="max-h-[24rem] space-y-4 overflow-auto pr-1">
                  {Array.from(new Set(EXPORT_SECTIONS.map((s) => s.group))).map((group) => (
                    <div key={group}>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
                        {group}
                      </p>
                      <div className="space-y-1">
                        {EXPORT_SECTIONS.filter((s) => s.group === group).map((s) => {
                          const on = exportSel.has(s.key);
                          return (
                            <label
                              key={s.key}
                              className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-muted"
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() =>
                                  setExportSel((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(s.key)) next.delete(s.key);
                                    else next.add(s.key);
                                    return next;
                                  })
                                }
                                className="mt-0.5 size-4 shrink-0 accent-brand-500"
                              />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium text-foreground">
                                  {s.label}
                                </span>
                                <span className="block text-xs text-foreground-subtle">
                                  {s.description}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Format + layout */}
                <div className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
                      Format
                    </p>
                    <div className="space-y-1">
                      {EXPORT_FORMATS.map((f) => (
                        <label
                          key={f.key}
                          className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-muted"
                        >
                          <input
                            type="radio"
                            name="export-format"
                            checked={exportFormat === f.key}
                            onChange={() => setExportFormat(f.key)}
                            className="mt-0.5 size-4 shrink-0 accent-brand-500"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-foreground">{f.label}</span>
                            <span className="block text-xs text-foreground-subtle">{f.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
                      Layout {exportFormat === 'csv' ? <span className="font-normal normal-case">(PDF only)</span> : null}
                    </p>
                    <div className="space-y-1">
                      {EXPORT_LAYOUTS.map((l) => (
                        <label
                          key={l.key}
                          className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${
                            exportFormat === 'csv'
                              ? 'cursor-not-allowed opacity-50'
                              : 'cursor-pointer hover:bg-surface-muted'
                          }`}
                        >
                          <input
                            type="radio"
                            name="export-layout"
                            disabled={exportFormat === 'csv'}
                            checked={exportLayout === l.key}
                            onChange={() => setExportLayout(l.key)}
                            className="mt-0.5 size-4 shrink-0 accent-brand-500"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-foreground">{l.label}</span>
                            <span className="block text-xs text-foreground-subtle">{l.description}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <DialogFooter className="items-center">
                  <span className="mr-auto text-xs text-foreground-subtle">
                    {exportSel.size} of {EXPORT_SECTION_KEYS.length} selected
                  </span>
                  <Button variant="secondary" onClick={() => setExportDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    loading={triggerExport.isPending}
                    disabled={exportSel.size === 0 || exportInflight}
                    onClick={() =>
                      triggerExport.mutate({
                        sections: Array.from(exportSel),
                        format: exportFormat,
                        layout: exportFormat === 'csv' ? 'combined' : exportLayout,
                      })
                    }
                  >
                    <Download className="size-4" /> Start export
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Button
              variant="secondary"
              loading={control.isPending}
              disabled={status !== 'active'}
              onClick={() => control.mutate()}
            >
              <ArrowRightToLine className="size-4" /> Control workspace
            </Button>
            {status === 'active' ? (
              <Button
                variant="secondary"
                disabled={isOwnOrg}
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: `Suspend "${name}"?`,
                      body: "Members can't sign in until reactivated. Data is kept.",
                      confirmLabel: 'Suspend',
                      destructive: true,
                    })
                  )
                    setStatus.mutate('suspended');
                }}
              >
                <Pause className="size-4" /> Suspend
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setStatus.mutate('active')}>
                <Play className="size-4" /> Reactivate
              </Button>
            )}
            <Button
              variant="danger"
              disabled={isOwnOrg}
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: `Permanently delete "${name}"?`,
                    body: 'Everything for this organisation will be removed. This cannot be undone.',
                    confirmLabel: 'Delete everything',
                    destructive: true,
                  })
                )
                  remove.mutate();
              }}
            >
              <Trash2 className="size-4" /> Delete
            </Button>
          </div>
        }
      >
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
            <TabsTrigger value="ai">AI</TabsTrigger>
            <TabsTrigger value="features">Features</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
        </Tabs>
      </PageHeader>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        {/* ── Overview ─────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 min-[520px]:grid-cols-3 lg:grid-cols-6">
            <Metric label="Products" value={d?.counts.products} />
            <Metric label="Services" value={d?.counts.services} />
            <Metric label="FAQs" value={d?.counts.faqs} />
            <Metric label="Members" value={d?.members.length ?? org?.memberCount} />
            <Metric label="API keys" value={d?.counts.apiKeys} />
            <Metric label="Webhooks" value={d?.counts.webhooks} />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Meta strip */}
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="size-4 text-brand-500" /> Summary
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Row label="Status">
                  <Badge variant={status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'muted'}>
                    {status}
                  </Badge>
                </Row>
                <Row label="Created">
                  {d ? formatRelative(d.createdAt) : <Skeleton className="h-4 w-20" />}
                </Row>
                <Row label="Last activity">
                  {org?.lastActivityAt ? formatRelative(org.lastActivityAt) : '—'}
                </Row>
              </CardContent>
            </Card>

            {/* WhatsApp one-liner */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <MessageCircle className="size-4 text-brand-500" /> WhatsApp
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {detailsQ.isLoading ? (
                  <Skeleton className="h-4 w-40" />
                ) : d?.whatsappChannel ? (
                  <div className="flex items-center gap-2">
                    <span className="font-mono">{d.whatsappChannel.displayPhoneNumber ?? '—'}</span>
                    <Badge variant={d.whatsappChannel.isActive ? 'success' : 'muted'}>
                      {d.whatsappChannel.isActive ? 'active' : 'inactive'}
                    </Badge>
                  </div>
                ) : (
                  <p className="text-foreground-muted">No channel connected.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Billing ──────────────────────────────────────────────── */}
        <TabsContent value="billing" className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* AI plan + usage */}
            {org?.disabledFeatures?.includes('ai') ? null : (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Cpu className="size-4 text-brand-500" /> AI plan &amp; usage
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-foreground">
                    Plan <span className="text-foreground-subtle">— click to change</span>
                  </p>
                  <div className="grid grid-cols-1 gap-2">
                    {AI_PLANS.map((p) => {
                      const meta = AI_PLAN_META[p];
                      const selected = p === currentPlan;
                      return (
                        <button
                          key={p}
                          type="button"
                          disabled={setPlan.isPending}
                          onClick={() => {
                            if (!selected) setPlan.mutate(p);
                          }}
                          className={cn(
                            'rounded-lg border p-3 text-left transition-colors',
                            selected
                              ? 'border-brand-500 bg-brand-50/70 ring-1 ring-brand-500'
                              : 'border-border hover:border-brand-300 hover:bg-surface-muted/40',
                            setPlan.isPending && 'cursor-wait opacity-60',
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                              {meta.label}
                              {selected && (
                                <Badge variant="brand" className="gap-1">
                                  <Check className="size-3" /> Current
                                </Badge>
                              )}
                            </span>
                            <span className="shrink-0 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground-muted">
                              {meta.model}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-foreground-muted">{meta.tagline}</p>
                          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-foreground-subtle">
                            {meta.provider}
                          </p>
                          <ul className="mt-2 space-y-0.5">
                            {meta.features.map((f) => (
                              <li
                                key={f}
                                className="flex items-start gap-1.5 text-[11px] text-foreground-muted"
                              >
                                <Check
                                  className={cn(
                                    'mt-0.5 size-3 shrink-0',
                                    selected ? 'text-brand-500' : 'text-foreground-subtle',
                                  )}
                                />
                                {f}
                              </li>
                            ))}
                          </ul>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="space-y-1.5 border-t border-border pt-3">
                  <p className="text-xs font-medium text-foreground">Monthly AI messages (allowance)</p>
                  {usage?.aiMessages ? (
                    <AiMessageCapEditor
                      key={`${usage.aiMessages.cap}-${usage.aiMessages.unlimited}`}
                      used={usage.aiMessages.used}
                      cap={usage.aiMessages.cap}
                      unlimited={usage.aiMessages.unlimited}
                      saving={setAiMessageCap.isPending}
                      onSave={(c) => setAiMessageCap.mutate(c)}
                    />
                  ) : (
                    <span className="text-xs text-foreground-muted">—</span>
                  )}
                </div>
                <div className="space-y-2 border-t border-border pt-3">
                  <p className="text-[10px] uppercase tracking-wider text-foreground-subtle">
                    Cost (admin-only)
                  </p>
                  <p className="text-[11px] leading-snug text-foreground-muted">
                    Tokens count <span className="font-medium text-foreground">both</span> the bot
                    understanding the message (input) and writing the reply (output) — both are
                    billed. USD includes both.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <p className="col-span-2 -mb-1 text-[10px] font-medium text-foreground-subtle">
                      Today
                    </p>
                    <Metric label="Understanding (in)" value={usage?.today.inputTokens} mono />
                    <Metric label="Reply (out)" value={usage?.today.outputTokens} mono />
                    <Metric label="Total tokens" value={usage?.today.tokens} mono />
                    <Metric
                      label="USD today"
                      value={usage ? `$${usage.today.usd.toFixed(2)}` : undefined}
                      mono
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2 border-t border-border/60 pt-2">
                    <p className="col-span-2 -mb-1 text-[10px] font-medium text-foreground-subtle">
                      This month
                    </p>
                    <Metric label="Understanding (in)" value={usage?.thisMonth.inputTokens} mono />
                    <Metric label="Reply (out)" value={usage?.thisMonth.outputTokens} mono />
                    <Metric label="Total tokens" value={usage?.thisMonth.tokens} mono />
                    <Metric
                      label="USD / month"
                      value={usage ? `$${usage.thisMonth.usd.toFixed(2)}` : undefined}
                      mono
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
            )}

            {/* WhatsApp wallet & metered billing */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Wallet className="size-4 text-brand-500" /> WhatsApp wallet &amp; billing
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                {walletQ.isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-40" />
                    <Skeleton className="h-4 w-full" />
                  </div>
                ) : !wallet ? (
                  <p className="text-foreground-muted">No wallet for this organisation.</p>
                ) : (
                  <WalletBilling
                    wallet={wallet}
                    orgId={id}
                    onSetMetering={(enabled) => setMetering.mutate(enabled)}
                    meteringSaving={setMetering.isPending}
                    onSetPrice={(usd) => setPrice.mutate(usd)}
                    priceSaving={setPrice.isPending}
                    onTopUp={(body) => topUp.mutate(body)}
                    topUpSaving={topUp.isPending}
                    onAdjust={(body) => adjust.mutate(body)}
                    adjustSaving={adjust.isPending}
                    onSetThreshold={(usd) => setThreshold.mutate(usd)}
                    thresholdSaving={setThreshold.isPending}
                    onSaveAlertThresholds={(thresholds) => setAlertThresholds.mutate(thresholds)}
                    alertThresholdsSaving={setAlertThresholds.isPending}
                  />
                )}
              </CardContent>
            </Card>
          </div>

          {/* Message economics — what a WhatsApp message costs us (Meta), what
              we charge the tenant, the per-message profit, and the profit to date. */}
          {wallet ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Wallet className="size-4 text-brand-500" /> Message economics &amp; profit
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                      Costs us (Meta)
                    </p>
                    <p className="mt-0.5 text-xl font-semibold tabular-nums">
                      ${formatMicrosUsd(wallet.metaCostMicros)}
                    </p>
                    <p className="text-xs text-foreground-muted">per message</p>
                  </div>
                  <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">
                      We charge them
                    </p>
                    <p className="mt-0.5 text-xl font-semibold tabular-nums">
                      ${formatMicrosUsd(wallet.pricePerMessageMicros)}
                    </p>
                    <p className="text-xs text-foreground-muted">per message</p>
                  </div>
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                    <p className="text-[11px] uppercase tracking-wide text-emerald-700">Profit</p>
                    <p className="mt-0.5 text-xl font-semibold tabular-nums text-emerald-700">
                      ${formatMicrosUsd(wallet.marginPerMessageMicros)}
                    </p>
                    <p className="text-xs text-emerald-700/80">
                      per message ({wallet.marginPct.toFixed(1)}%)
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-4">
                  <Metric label="Messages billed" value={wallet.lifetimeMessages} />
                  <Metric label="Charged (revenue)" value={`$${formatMicrosUsd(wallet.lifetimeSpentMicros)}`} />
                  <Metric
                    label="Meta cost (ours)"
                    value={`$${formatMicrosUsd(wallet.lifetimeMessages * wallet.metaCostMicros)}`}
                  />
                  <Metric label="Profit so far" value={`$${formatMicrosUsd(wallet.lifetimeMarginMicros)}`} />
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* Full cost & usage breakdown (consolidated from the standalone page) */}
          <div>
            <h3 className="mb-3 text-sm font-medium text-foreground">Cost &amp; usage</h3>
            <TenantCostOverview orgId={id} />
          </div>
        </TabsContent>

        {/* ── AI ───────────────────────────────────────────────────── */}
        <TabsContent value="ai" className="space-y-4">
          {org?.disabledFeatures?.includes('ai') ? (
            <Card>
              <CardContent className="py-6 text-sm text-foreground-muted">
                AI is disabled for this tenant (manual inbox only). Enable the “ai” feature in
                the Features tab to configure the bot.
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Plan & model overview (edit plan/limits in Billing). */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Cpu className="size-4 text-brand-500" /> AI plan &amp; model
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <Row label="Plan">
                    <Badge variant="muted">{AI_PLAN_LABEL[currentPlan as AiPlan]}</Badge>
                  </Row>
                  <Row label="Model">
                    <span className="font-mono text-xs">
                      {AI_PLAN_META[currentPlan as AiPlan]?.model ?? currentPlan}
                    </span>
                  </Row>
                  <div className="rounded-md border border-border bg-surface-muted/30 p-2.5">
                    <p className="text-xs font-medium text-foreground">
                      {AI_PLAN_META[currentPlan as AiPlan]?.tagline}
                    </p>
                    <ul className="mt-1.5 space-y-0.5">
                      {AI_PLAN_META[currentPlan as AiPlan]?.features.map((f) => (
                        <li
                          key={f}
                          className="flex items-start gap-1.5 text-[11px] text-foreground-muted"
                        >
                          <Check className="mt-0.5 size-3 shrink-0 text-brand-500" /> {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Row label="Monthly AI messages">
                    {usage?.aiMessages ? (
                      usage.aiMessages.unlimited ? (
                        <span>{usage.aiMessages.used.toLocaleString()} used · Unlimited</span>
                      ) : (
                        <span>
                          {usage.aiMessages.used.toLocaleString()} /{' '}
                          {usage.aiMessages.cap?.toLocaleString() ?? '—'}
                        </span>
                      )
                    ) : (
                      '—'
                    )}
                  </Row>
                  <Row label="Bot deployed">
                    <Badge variant={aiPrompt?.deployed ? 'success' : 'muted'}>
                      {aiPrompt?.deployed ? 'live' : 'not deployed'}
                    </Badge>
                  </Row>
                  <p className="text-xs text-foreground-subtle">
                    Change the plan &amp; monthly allowance in the{' '}
                    <button
                      type="button"
                      onClick={() => setActiveTab('billing')}
                      className="underline hover:text-foreground"
                    >
                      Billing
                    </button>{' '}
                    tab.
                  </p>
                </CardContent>
              </Card>

              {/* Admin-only prompt modification — injected into the live prompt. */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Cpu className="size-4 text-brand-500" /> Bot prompt modification
                    <Badge variant="warning" className="ml-1">admin-only</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-xs text-foreground-muted">
                    Custom instructions injected VERBATIM into this tenant’s bot system prompt on
                    every reply (chat + voice), right after the core rules. The tenant can’t see or
                    edit this. It can’t override the safety scope-lock. Save to apply immediately.
                  </p>
                  <Textarea
                    value={appendDraft}
                    onChange={(e) => setAppendDraft(e.target.value)}
                    rows={6}
                    maxLength={8000}
                    placeholder="e.g. Always mention free delivery over $25. Keep a formal tone. Never promise same-day delivery."
                    className="font-mono text-xs"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-foreground-subtle">
                      {appendDraft.length.toLocaleString()} / 8,000
                    </span>
                    <div className="flex gap-2">
                      {appendDirty ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAppendDraft(aiPrompt?.adminSystemPromptAppend ?? '')}
                        >
                          Reset
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        onClick={() => savePrompt.mutate(appendDraft)}
                        loading={savePrompt.isPending}
                        disabled={!appendDirty}
                      >
                        Save modification
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Live compiled system prompt — the exact string the bot sends. */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <MessageCircle className="size-4 text-brand-500" /> Live system prompt
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => aiPromptQ.refetch()}
                      loading={aiPromptQ.isFetching}
                    >
                      Refresh
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <p className="text-xs text-foreground-muted">
                    The exact prompt the bot sends the model — assembled by the live engine (no LLM
                    call). Reflects every code-level rule, this tenant’s data, and your modification
                    above. Previewed for the WhatsApp channel.
                  </p>
                  {aiPromptQ.isLoading ? (
                    <Skeleton className="h-64 w-full" />
                  ) : aiPromptQ.isError ? (
                    <p className="text-xs text-danger">Couldn’t compile the prompt.</p>
                  ) : aiPrompt ? (
                    <>
                      <div className="flex flex-wrap gap-3 text-[11px] text-foreground-subtle">
                        <span>{aiPrompt.promptChars.toLocaleString()} chars</span>
                        <span>{aiPrompt.productCount} products</span>
                        <span>{aiPrompt.serviceCount} services</span>
                        <span>{aiPrompt.faqCount} FAQs</span>
                        {!aiPrompt.hasBotConfig ? <span>· no bot config yet</span> : null}
                      </div>
                      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
                        {aiPrompt.compiledPrompt}
                      </pre>
                    </>
                  ) : null}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ── Features ─────────────────────────────────────────────── */}
        <TabsContent value="features">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Lock className="size-4 text-brand-500" /> Access &amp; features
              </CardTitle>
              <Button
                size="sm"
                loading={saveAccess.isPending}
                disabled={isOwnOrg}
                onClick={() => saveAccess.mutate()}
              >
                Save access
              </Button>
            </CardHeader>
            <CardContent>
              {isOwnOrg ? (
                <p className="text-sm text-foreground-muted">
                  This is your own admin account — its access is locked.
                </p>
              ) : (
                <div className="space-y-5">
                  {FEATURE_GROUPS.map((group) => {
                    const items = ORG_FEATURES.filter(
                      (f) => (FEATURE_GROUP[f.key] ?? 'Advanced') === group,
                    );
                    if (items.length === 0) return null;
                    return (
                      <div key={group} className="space-y-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
                          {group}
                        </p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {items.map((f) => {
                            const enabled = !disabled.includes(f.key);
                            return (
                              <div
                                key={f.key}
                                className="flex items-center gap-3 rounded-lg border border-border bg-surface-muted/30 px-3 py-2.5 text-sm"
                              >
                                <Switch
                                  checked={enabled}
                                  onCheckedChange={(next) =>
                                    setDisabled((prev) =>
                                      next
                                        ? prev.filter((k) => k !== f.key)
                                        : [...new Set([...prev, f.key])],
                                    )
                                  }
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-1 font-medium">
                                    <span className="truncate">{f.label}</span>
                                    <span title={f.description} className="inline-flex shrink-0 cursor-help">
                                      <Info className="size-3.5 text-foreground-subtle" />
                                    </span>
                                  </span>
                                  <span className="mt-0.5 block truncate text-xs text-foreground-muted">
                                    {f.description}
                                  </span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Members ──────────────────────────────────────────────── */}
        <TabsContent value="members" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Users className="size-4 text-brand-500" /> Members
              </CardTitle>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const email = inviteEmail.trim();
                  if (!email) {
                    toast.error('Enter an email to invite');
                    return;
                  }
                  inviteMember.mutate({ email, role: inviteRole });
                }}
              >
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@email.com"
                  className="h-8 w-52 rounded-md border border-border bg-surface px-2 text-sm"
                />
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as 'admin' | 'editor' | 'viewer')}>
                  <SelectTrigger className="h-8 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="editor">Editor</SelectItem>
                    <SelectItem value="viewer">Viewer</SelectItem>
                  </SelectContent>
                </Select>
                <Button type="submit" size="sm" loading={inviteMember.isPending}>
                  Invite
                </Button>
              </form>
            </CardHeader>
            <CardContent className="p-0">
              {detailsQ.isLoading ? (
                <div className="space-y-2 p-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : (d?.members.length ?? 0) === 0 ? (
                <p className="px-6 py-6 text-center text-sm text-foreground-muted">No members.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border bg-surface-muted/60 text-[11px] uppercase tracking-wide text-foreground-subtle">
                      <tr>
                        <th className="px-4 py-2">Email</th>
                        <th className="px-4 py-2">Role</th>
                        <th className="hidden px-4 py-2 sm:table-cell">2FA</th>
                        <th className="hidden px-4 py-2 md:table-cell">Last login</th>
                        <th className="px-4 py-2 text-right">Manage</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {d?.members.map((m) => (
                        <tr key={m.userId}>
                          <td className="px-4 py-2">
                            <span className="font-medium">{[m.firstName, m.lastName].filter(Boolean).join(' ') || '—'}</span>
                            <span className="ml-2 text-foreground-subtle">{m.email}</span>
                            {!m.emailVerified ? <Badge variant="warning" className="ml-2">unverified</Badge> : null}
                            {!m.isActive ? <Badge variant="muted" className="ml-2">inactive</Badge> : null}
                          </td>
                          <td className="px-4 py-2"><Badge variant="muted">{m.role}</Badge></td>
                          <td className="hidden px-4 py-2 sm:table-cell">{m.totpEnabled ? 'On' : '—'}</td>
                          <td className="hidden px-4 py-2 text-foreground-muted md:table-cell">
                            {m.lastLoginAt ? formatRelative(m.lastLoginAt) : 'never'}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="icon" variant="ghost" aria-label={`Manage ${m.email}`}>
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setEmailDraft(m.email);
                                    setEmailDialog({ userId: m.userId, email: m.email });
                                  }}
                                >
                                  <Mail className="size-4" /> Change email
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={async () => {
                                    if (
                                      await confirmDialog({
                                        title: `Reset ${m.email}'s password?`,
                                        body: 'Generates a new temporary password and signs them out of every session.',
                                        confirmLabel: 'Reset password',
                                      })
                                    )
                                      resetPassword.mutate(m.userId);
                                  }}
                                >
                                  <KeyRound className="size-4" /> Reset password
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* WhatsApp channel detail */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <MessageCircle className="size-4 text-brand-500" /> WhatsApp channel
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {detailsQ.isLoading ? (
                <Skeleton className="h-4 w-40" />
              ) : d?.whatsappChannel ? (
                <div className="space-y-2">
                  <Row label="Number">
                    <span className="font-mono">{d.whatsappChannel.displayPhoneNumber ?? '—'}</span>
                  </Row>
                  <Row label="Status">
                    <Badge variant={d.whatsappChannel.isActive ? 'success' : 'muted'}>
                      {d.whatsappChannel.isActive ? 'active' : 'inactive'}
                    </Badge>
                  </Row>
                </div>
              ) : (
                <p className="text-foreground-muted">No WhatsApp channel connected.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Activity ─────────────────────────────────────────────── */}
        <TabsContent value="activity" className="space-y-4">
          {/* WhatsApp spending — how much this tenant has spent and on how
              many billed messages (per-message charges live in the wallet
              ledger on the Billing tab). */}
          {wallet ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Wallet className="size-4 text-brand-500" /> WhatsApp spending
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="Spent" value={`$${formatMicrosUsd(wallet.lifetimeSpentMicros)}`} />
                  <Metric label="Messages billed" value={wallet.lifetimeMessages} />
                  <Metric label="Balance" value={`$${formatMicrosUsd(wallet.availableMicros)}`} />
                  <Metric label="Topped up" value={`$${formatMicrosUsd(wallet.lifetimeToppedUpMicros)}`} />
                </div>
                <p className="mt-3 text-xs text-foreground-subtle">
                  Each WhatsApp message sent deducts ${formatMicrosUsd(wallet.pricePerMessageMicros)} and is
                  itemised in the wallet ledger (Billing tab).
                </p>
              </CardContent>
            </Card>
          ) : null}

          {/* Broadcasts */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <MessageCircle className="size-4 text-brand-500" /> Broadcasts
                </span>
                {broadcasts ? (
                  <span className="text-xs font-normal text-foreground-muted">
                    {broadcasts.totals.broadcasts} campaigns · {broadcasts.totals.sent.toLocaleString()} sent ·{' '}
                    {broadcasts.totals.recipients.toLocaleString()} recipients
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!broadcasts || broadcasts.broadcasts.length === 0 ? (
                <p className="px-6 py-6 text-center text-sm text-foreground-muted">
                  No broadcasts sent yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border bg-surface-muted text-xs uppercase tracking-wide text-foreground-subtle">
                      <tr>
                        <th className="px-4 py-2">Campaign</th>
                        <th className="hidden px-4 py-2 sm:table-cell">Status</th>
                        <th className="hidden px-4 py-2 text-right md:table-cell">Recipients</th>
                        <th className="px-4 py-2 text-right">Sent</th>
                        <th className="hidden px-4 py-2 text-right lg:table-cell">Delivered</th>
                        <th className="hidden px-4 py-2 text-right lg:table-cell">Read</th>
                        <th className="hidden px-4 py-2 md:table-cell">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {broadcasts.broadcasts.map((b) => (
                        <tr key={b.id} className="border-b border-border last:border-0">
                          <td className="px-4 py-2 font-medium text-foreground">{b.name}</td>
                          <td className="hidden px-4 py-2 text-foreground-muted sm:table-cell">{b.status}</td>
                          <td className="hidden px-4 py-2 text-right tabular-nums md:table-cell">{b.totalRecipients.toLocaleString()}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{b.sentCount.toLocaleString()}</td>
                          <td className="hidden px-4 py-2 text-right tabular-nums lg:table-cell">{b.deliveredCount.toLocaleString()}</td>
                          <td className="hidden px-4 py-2 text-right tabular-nums lg:table-cell">{b.readCount.toLocaleString()}</td>
                          <td className="hidden px-4 py-2 text-foreground-muted md:table-cell">
                            {new Date(b.createdAt).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent activity */}
          <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Activity className="size-4 text-brand-500" /> Recent activity
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {detailsQ.isLoading ? (
                  <div className="space-y-2 p-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-7 w-full" />
                    ))}
                  </div>
                ) : (d?.recentAuditLog.length ?? 0) === 0 ? (
                  <p className="px-6 py-6 text-center text-sm text-foreground-muted">No recent activity.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {d?.recentAuditLog.map((a, i) => (
                      <li key={i} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                        <span className="font-mono text-xs">{a.action}</span>
                        <span className="text-foreground-subtle">
                          {a.actorEmail ?? 'system'} · {formatRelative(a.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Change-email dialog */}
      <Dialog open={!!emailDialog} onOpenChange={(v) => !v && setEmailDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change member email</DialogTitle>
            <DialogDescription>
              Updates the login email and signs the member out of every session. The new address
              stays verified.
            </DialogDescription>
          </DialogHeader>
          <Input
            type="email"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            placeholder="new@email.com"
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEmailDialog(null)}>
              Cancel
            </Button>
            <Button
              loading={changeEmail.isPending}
              onClick={() => {
                const email = emailDraft.trim().toLowerCase();
                if (!email) return;
                if (emailDialog) changeEmail.mutate({ userId: emailDialog.userId, email });
              }}
            >
              Save email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset-password result dialog (shown once) */}
      <Dialog open={!!resetResult} onOpenChange={(v) => !v && setResetResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New temporary password</DialogTitle>
            <DialogDescription>
              Share this with {resetResult?.email || 'the member'} — it won&rsquo;t be shown again.
              They can change it later in Settings.
            </DialogDescription>
          </DialogHeader>
          <div className="select-all rounded-md border border-border bg-surface-muted p-3 text-center font-mono text-sm">
            {resetResult?.password}
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(resetResult?.password ?? '');
                toast.success('Copied');
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setResetResult(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground-muted">{label}</span>
      <span className="text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

function Metric({ label, value, mono }: { label: string; value?: number | string | null; mono?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted/40 p-2.5">
      <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">{label}</p>
      <p className={mono ? 'mt-0.5 font-mono tabular-nums text-sm' : 'mt-0.5 text-sm font-semibold'}>
        {value ?? '—'}
      </p>
    </div>
  );
}

// Per-tenant monthly AI-message allowance editor (admin). Self-seeds from props;
// remounted via `key` when the server value changes after a save.
function AiMessageCapEditor({
  used,
  cap,
  unlimited,
  saving,
  onSave,
}: {
  used: number;
  cap: number | null;
  unlimited: boolean;
  saving: boolean;
  onSave: (cap: number | null) => void;
}) {
  const [val, setVal] = useState(cap != null ? String(cap) : '');
  const [unl, setUnl] = useState(unlimited);
  const pct = unlimited || !cap ? 0 : Math.min(100, Math.round((used / cap) * 100));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <input type="checkbox" checked={unl} onChange={(e) => setUnl(e.target.checked)} />
          Unlimited
        </label>
        {!unl && (
          <input
            type="number"
            min={0}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="h-8 w-32 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            placeholder="messages / mo"
          />
        )}
        <Button
          size="sm"
          loading={saving}
          onClick={() => onSave(unl ? null : Math.max(0, Math.floor(Number(val) || 0)))}
        >
          Save
        </Button>
      </div>
      <p className="text-xs text-foreground-muted">
        {unlimited
          ? 'Unlimited — no metering this month.'
          : `${used.toLocaleString()} / ${(cap ?? 0).toLocaleString()} used this month (${pct}%).`}
      </p>
    </div>
  );
}

// Full admin wallet control: balance, metering toggle, per-message price +
// margin, top-up, adjust, low-balance threshold, lifetime figures, and a
// collapsible ledger. Amounts are entered in dollars; the API converts.
function WalletBilling({
  wallet,
  orgId,
  onSetMetering,
  meteringSaving,
  onSetPrice,
  priceSaving,
  onTopUp,
  topUpSaving,
  onAdjust,
  adjustSaving,
  onSetThreshold,
  thresholdSaving,
  onSaveAlertThresholds,
  alertThresholdsSaving,
}: {
  wallet: WalletDto;
  orgId: string;
  onSetMetering: (enabled: boolean) => void;
  meteringSaving: boolean;
  onSetPrice: (priceUsd: number) => void;
  priceSaving: boolean;
  onTopUp: (body: { amountUsd: number; note?: string }) => void;
  topUpSaving: boolean;
  onAdjust: (body: { amountUsd: number; note?: string }) => void;
  adjustSaving: boolean;
  onSetThreshold: (lowBalanceUsd: number) => void;
  thresholdSaving: boolean;
  onSaveAlertThresholds: (thresholds: number[]) => void;
  alertThresholdsSaving: boolean;
}) {
  const [priceStr, setPriceStr] = useState(
    (wallet.pricePerMessageMicros / MICROS_PER_USD).toString(),
  );
  const [topUpStr, setTopUpStr] = useState('');
  const [topUpNote, setTopUpNote] = useState('');
  const [adjustStr, setAdjustStr] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [thresholdStr, setThresholdStr] = useState(
    (wallet.lowBalanceThresholdMicros / MICROS_PER_USD).toString(),
  );

  // Balance-alert %s: local selection seeded from the wallet, saved on demand.
  const savedAlerts = wallet.alertThresholds ?? [];
  const [alerts, setAlerts] = useState<number[]>(savedAlerts);
  useEffect(() => {
    setAlerts(wallet.alertThresholds ?? []);
    // Re-seed when the saved value changes after a save/refetch.
  }, [wallet.alertThresholds]);
  const alertsDirty =
    alerts.length !== savedAlerts.length ||
    [...alerts].sort((a, b) => a - b).join(',') !== [...savedAlerts].sort((a, b) => a - b).join(',');

  return (
    <div className="space-y-5">
      {/* Balance + metering */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">Balance</p>
          <p className="mt-0.5 text-3xl font-semibold tabular-nums">
            ${formatMicrosUsd(wallet.availableMicros)}
          </p>
          {wallet.heldMicros > 0 ? (
            <p className="mt-0.5 text-xs text-foreground-muted">
              ${formatMicrosUsd(wallet.heldMicros)} held (in-flight sends)
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={wallet.meteringEnabled ? 'success' : 'muted'}>
            Metering {wallet.meteringEnabled ? 'ON' : 'OFF'}
          </Badge>
          <Button
            size="sm"
            variant="secondary"
            loading={meteringSaving}
            onClick={() => onSetMetering(!wallet.meteringEnabled)}
          >
            {wallet.meteringEnabled ? 'Turn off' : 'Turn on'}
          </Button>
        </div>
      </div>

      {/* Price + margin */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-xs font-medium text-foreground">Per-message price</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="text-sm text-foreground-muted">$</span>
            <input
              type="number"
              min={0.0375}
              step={0.0001}
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            />
          </div>
          <Button
            size="sm"
            loading={priceSaving}
            onClick={() => {
              const v = Number(priceStr);
              if (!Number.isFinite(v) || v < 0.0375) {
                toast.error('Price must be at least $0.0375');
                return;
              }
              onSetPrice(v);
            }}
          >
            Save price
          </Button>
        </div>
        <p className="text-xs text-foreground-muted">
          Meta cost ${formatMicrosUsd(wallet.metaCostMicros)}, your price $
          {formatMicrosUsd(wallet.pricePerMessageMicros)} → margin $
          {formatMicrosUsd(wallet.marginPerMessageMicros)} ({wallet.marginPct.toFixed(1)}%)
        </p>
      </div>

      {/* Top-up + adjust */}
      <div className="grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Top up</p>
          <div className="flex items-center gap-1">
            <span className="text-sm text-foreground-muted">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={topUpStr}
              onChange={(e) => setTopUpStr(e.target.value)}
              placeholder="0.00"
              className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            />
          </div>
          <input
            type="text"
            value={topUpNote}
            onChange={(e) => setTopUpNote(e.target.value)}
            placeholder="Note (optional)"
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm"
          />
          <Button
            size="sm"
            loading={topUpSaving}
            onClick={() => {
              const v = Number(topUpStr);
              if (Number.isFinite(v) && v < 0) {
                toast.error('To deduct, use "Manual adjustment" with a negative amount (e.g. -500).');
                return;
              }
              if (!Number.isFinite(v) || v <= 0) {
                toast.error('Enter an amount greater than $0');
                return;
              }
              onTopUp({ amountUsd: v, note: topUpNote.trim() || undefined });
              setTopUpStr('');
              setTopUpNote('');
            }}
          >
            Add balance
          </Button>
          <p className="text-[11px] text-foreground-subtle">Adds funds (a payment). Positive only.</p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Manual adjustment</p>
          <div className="flex items-center gap-1">
            <span className="text-sm text-foreground-muted">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={adjustStr}
              onChange={(e) => setAdjustStr(e.target.value)}
              placeholder="e.g. -5.00"
              className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            />
          </div>
          <input
            type="text"
            value={adjustNote}
            onChange={(e) => setAdjustNote(e.target.value)}
            placeholder="Reason (optional)"
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm"
          />
          <Button
            size="sm"
            variant="secondary"
            loading={adjustSaving}
            onClick={() => {
              const v = Number(adjustStr);
              if (!Number.isFinite(v) || v === 0) {
                toast.error('Enter a non-zero amount (negative to debit)');
                return;
              }
              onAdjust({ amountUsd: v, note: adjustNote.trim() || undefined });
              setAdjustStr('');
              setAdjustNote('');
            }}
          >
            Apply adjustment
          </Button>
          <p className="text-[11px] text-foreground-subtle">
            Correction — negative to deduct (e.g. -500), positive to add.
          </p>
        </div>
      </div>

      {/* Threshold */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-xs font-medium text-foreground">Low-balance alert threshold</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="text-sm text-foreground-muted">$</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={thresholdStr}
              onChange={(e) => setThresholdStr(e.target.value)}
              className="h-8 w-28 rounded-md border border-border bg-surface px-2 text-sm tabular-nums"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={thresholdSaving}
            onClick={() => {
              const v = Number(thresholdStr);
              if (!Number.isFinite(v) || v < 0) {
                toast.error('Threshold must be $0 or more');
                return;
              }
              onSetThreshold(v);
            }}
          >
            Save threshold
          </Button>
        </div>
        <p className="text-xs text-foreground-muted">
          The tenant sees a &ldquo;running low&rdquo; warning when the balance drops to this amount.
        </p>
      </div>

      {/* Balance alerts */}
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-xs font-medium text-foreground">Balance alerts</p>
        <div className="flex flex-wrap items-center gap-2">
          {[50, 75, 80, 90, 100].map((v) => {
            const on = alerts.includes(v);
            return (
              <Button
                key={v}
                type="button"
                size="sm"
                variant={on ? 'primary' : 'secondary'}
                onClick={() =>
                  setAlerts((prev) =>
                    prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
                  )
                }
              >
                {v}%
              </Button>
            );
          })}
          <Button
            size="sm"
            loading={alertThresholdsSaving}
            disabled={!alertsDirty}
            onClick={() => onSaveAlertThresholds([...alerts].sort((a, b) => a - b))}
          >
            Save
          </Button>
        </div>
        <p className="text-xs text-foreground-muted">
          Notify the tenant + you when the balance is this % used (100% = empty).
        </p>
        <p className="text-xs text-foreground-muted">
          {wallet.pctUsed}% of balance used
        </p>
      </div>

      {/* Lifetime */}
      <div className="grid grid-cols-2 gap-2 border-t border-border pt-4 min-[520px]:grid-cols-4">
        <Metric label="Messages" value={wallet.lifetimeMessages.toLocaleString()} mono />
        <Metric label="Spent" value={`$${formatMicrosUsd(wallet.lifetimeSpentMicros)}`} mono />
        <Metric label="Topped up" value={`$${formatMicrosUsd(wallet.lifetimeToppedUpMicros)}`} mono />
        <Metric label="Our margin" value={`$${formatMicrosUsd(wallet.lifetimeMarginMicros)}`} mono />
      </div>

      {/* Ledger */}
      <WalletLedger orgId={orgId} />
    </div>
  );
}

// Collapsible admin wallet ledger with cursor pagination.
function WalletLedger({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const ledgerQ = useInfiniteQuery({
    queryKey: ['admin-org-wallet-ledger', orgId],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      api.get<WalletLedgerPage>(
        `/api/v1/hq/orgs/${orgId}/wallet/ledger?limit=50${
          pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''
        }`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
  });
  const rows = ledgerQ.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-brand-600"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        Ledger
      </button>
      {open ? (
        <div className="mt-3">
          {ledgerQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-foreground-muted">No wallet activity yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-surface-muted/60 text-[11px] uppercase tracking-wide text-foreground-subtle">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="hidden px-3 py-2 text-right sm:table-cell">Available</th>
                    <th className="hidden px-3 py-2 md:table-cell">Actor</th>
                    <th className="hidden px-3 py-2 lg:table-cell">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => {
                    const positive = r.amountMicros >= 0;
                    return (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap px-3 py-2 text-foreground-muted">
                          {formatRelative(r.createdAt)}
                        </td>
                        <td className="px-3 py-2">{WALLET_KIND_LABEL[r.kind] ?? r.kind}</td>
                        <td
                          className={
                            'px-3 py-2 text-right font-medium tabular-nums ' +
                            (positive ? 'text-emerald-700' : 'text-red-700')
                          }
                        >
                          {positive ? '+' : '−'}${formatMicrosUsd(Math.abs(r.amountMicros))}
                        </td>
                        <td className="hidden px-3 py-2 text-right tabular-nums text-foreground-muted sm:table-cell">
                          ${formatMicrosUsd(r.availableAfterMicros)}
                        </td>
                        <td className="hidden px-3 py-2 text-foreground-muted md:table-cell">
                          {r.actorName ?? 'system'}
                        </td>
                        <td className="hidden px-3 py-2 text-foreground-muted lg:table-cell">
                          {r.note ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {ledgerQ.hasNextPage ? (
            <div className="mt-3 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                loading={ledgerQ.isFetchingNextPage}
                onClick={() => ledgerQ.fetchNextPage()}
              >
                Load older
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
