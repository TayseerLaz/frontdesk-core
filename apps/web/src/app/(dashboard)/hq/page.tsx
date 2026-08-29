'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeftToLine,
  ArrowRightToLine,
  Building2,
  Eye,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { api, ApiError, setAccessToken } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';

export type AiPlan = 'basic' | 'middle' | 'max' | 'ultra';

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  productCount: number;
  serviceCount: number;
  broadcastMessages: number;
  billableConversations: number;
  broadcastCostUsd: number;
  aiTokens: number;
  aiCostUsd: number;
  aiCostBreakdown: { model: string; tokens: number; usd: number }[];
  monthlyPaidUsd: number | null;
  lastActivityAt: string | null;
  aiPlan: AiPlan;
  disabledFeatures: string[];
  // Login "firewall": locked when a member is locked out (too many failed logins).
  locked: boolean;
  lockedMembers: number;
}

export const AI_PLAN_LABEL: Record<AiPlan, string> = {
  basic: 'Basic',
  middle: 'Middle',
  max: 'Max',
  ultra: 'Ultra',
};

export const AI_PLAN_DESCRIPTION: Record<AiPlan, string> = {
  basic: 'Groq Llama 3.3 70B + GPT-4o-mini fallback. Cheap and fast.',
  middle: 'OpenAI GPT-4o. Premium quality at moderate cost.',
  max: 'Anthropic Claude Sonnet 4.6. Top-tier reasoning, highest cost.',
  ultra:
    'Flagship: Claude Haiku 4.5 for intent + per-customer persona memory, Claude Sonnet 4.6 for the grounded reply. Fast, best reasoning, lowest hallucination.',
};

interface SystemHealth {
  orgs: { active: number; suspended: number; deleted: number };
  users: { total: number; pending: number; disabled: number };
  queues: {
    import: { waiting: number; active: number; failed: number };
    sync: { waiting: number; active: number; failed: number };
    webhook: { waiting: number; active: number; failed: number };
  };
  redis: { connected: boolean; opsPerSec: number | null };
}

export default function PlatformAdminPage() {
  const { session, switchOrg } = useSession();
  // The admin's own org(s) are protected: access/suspend/delete are disabled so
  // an admin can't lock themselves out of (or restrict) their own admin account.
  const ownOrgIds = new Set<string>(
    [session?.organization?.id, ...(session?.availableOrganizations?.map((o) => o.id) ?? [])].filter(
      (x): x is string => !!x,
    ),
  );
  // The admin's REAL account org(s) = their memberships (NOT a tenant they're
  // currently controlling). Used to pin + highlight the admin-account row.
  const adminOrgIds = new Set<string>((session?.availableOrganizations ?? []).map((o) => o.id));
  // "Controlling" a tenant: an platform admin whose ACTIVE org isn't one of their
  // memberships (impersonation mints a no-membership session for the tenant).
  const isControlling =
    !!session?.user.isSuperAdmin &&
    !!session?.organization &&
    !adminOrgIds.has(session.organization.id);
  const homeAdminOrgId = session?.availableOrganizations?.[0]?.id ?? null;
  const [switchingBack, setSwitchingBack] = useState(false);
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const orgs = useQuery({
    queryKey: ['admin-orgs', debouncedSearch],
    queryFn: () =>
      api.get<{ data: OrgRow[] }>(
        `/api/v1/hq/orgs${debouncedSearch ? `?q=${encodeURIComponent(debouncedSearch)}` : ''}`,
      ),
  });

  const system = useQuery({
    queryKey: ['admin-system'],
    queryFn: () => api.get<{ data: SystemHealth }>('/api/v1/hq/system'),
    refetchInterval: 10_000,
  });

  const update = useMutation({
    mutationFn: (vars: { id: string; status: 'active' | 'suspended' }) =>
      api.patch(`/api/v1/hq/orgs/${vars.id}`, { status: vars.status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
      toast.success('Updated');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Update failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/hq/orgs/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
      toast.success('Organisation deleted');
    },
  });

  // Clear the failed-login lockout ("security firewall") for a tenant so its
  // members can sign in again.
  const unlock = useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { unlocked: number } }>(`/api/v1/hq/orgs/${id}/unlock`, {}),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
      toast.success(
        res.data.unlocked > 0
          ? `Unlocked — ${res.data.unlocked} account${res.data.unlocked === 1 ? '' : 's'} can sign in now`
          : 'No locked accounts to clear',
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Unlock failed'),
  });

  // Control: mint a session for the target org and land in their
  // dashboard. The session switch is silent (no nav until tokens are
  // in place) so the next request carries the new org-id JWT.
  const router = useRouter();
  const { refresh } = useSession();
  const controlOrg = useMutation({
    mutationFn: (o: OrgRow) =>
      api.post<{
        data: {
          accessToken: string;
          expiresAt: string;
          organizationId: string;
          organizationSlug: string;
          organizationName: string;
        };
      }>(`/api/v1/hq/orgs/${o.id}/impersonate`, {}),
    onSuccess: async (res, vars) => {
      setAccessToken(res.data.accessToken, res.data.expiresAt);
      await refresh();
      // Drop every cached query so we don't show admin-org data
      // inside the impersonated org's dashboard.
      queryClient.clear();
      toast.success(`Controlling ${vars.name} — you're now in their workspace.`);
      router.push('/dashboard');
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not open this org.'),
  });

  // Exit "control" mode: switch the session back to the admin's own account.
  async function backToAdmin() {
    if (!homeAdminOrgId) return;
    setSwitchingBack(true);
    try {
      await switchOrg(homeAdminOrgId);
      queryClient.clear();
      toast.success('Back to your admin account.');
      router.push('/hq');
    } catch {
      toast.error('Could not switch back to your admin account.');
    } finally {
      setSwitchingBack(false);
    }
  }

  if (!session?.user.isSuperAdmin) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-foreground-muted">Super-admin role required.</p>
        </CardContent>
      </Card>
    );
  }

  const sys = system.data?.data;
  const orgRows = orgs.data?.data ?? [];
  // Pin the admin's own account row(s) to the top, preserving order otherwise.
  const sortedRows = [
    ...orgRows.filter((o) => adminOrgIds.has(o.id)),
    ...orgRows.filter((o) => !adminOrgIds.has(o.id)),
  ];

  return (
    <>
      <PageHeader
        title="Platform admin"
        description="Cross-tenant operations and system health."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild>
              <Link href="/hq/new-tenant">
                <Plus className="size-4" /> New tenant
              </Link>
            </Button>
          </div>
        }
      />

      {/* Queue depth / Redis ops / Queues moved out — they live on the System
          health page. This page is focused on tenants. */}
      <div className="grid grid-cols-2 gap-4 sm:max-w-md">
        <StatCard
          icon={Building2}
          label="Organisations"
          value={sys ? sys.orgs.active + sys.orgs.suspended : '—'}
          hint={sys ? `${sys.orgs.suspended} suspended` : undefined}
        />
        <StatCard
          icon={Users}
          label="Users"
          value={sys?.users.total ?? '—'}
          hint={sys ? `${sys.users.pending} pending verify` : undefined}
        />
      </div>

      {/* Cost tables — broadcast (WhatsApp) + AI, ranked by spend. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <CostTable
          title="Broadcast costs"
          subtitle="Billable WhatsApp conversations (24h) × rate, all-time"
          rows={orgRows
            .map((o) => ({
              id: o.id,
              name: o.name,
              metric: o.billableConversations,
              metricLabel: o.billableConversations.toLocaleString(),
              cost: o.broadcastCostUsd,
            }))
            .filter((r) => r.cost > 0 || r.metric > 0)
            .sort((a, b) => b.cost - a.cost)}
          metricHeader="Conversations"
          loading={orgs.isLoading}
        />
        <CostTable
          title="AI costs"
          subtitle="Per-model token spend, all-time"
          rows={orgRows
            .map((o) => ({
              id: o.id,
              name: o.name,
              metric: o.aiTokens,
              metricLabel: o.aiTokens.toLocaleString(),
              cost: o.aiCostUsd,
            }))
            .filter((r) => r.cost > 0 || r.metric > 0)
            .sort((a, b) => b.cost - a.cost)}
          metricHeader="Tokens"
          loading={orgs.isLoading}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Organisations</CardTitle>
          <div className="flex items-center gap-2">
            {isControlling && (
              <Button
                variant="secondary"
                onClick={() => void backToAdmin()}
                disabled={switchingBack || !homeAdminOrgId}
                title="Stop controlling this tenant and return to your admin account"
              >
                <ArrowLeftToLine className="size-4" />
                {switchingBack ? 'Switching…' : 'Back to admin'}
              </Button>
            )}
            <div className="relative w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
              <Input
                className="pl-9"
                placeholder="Search by name or slug…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {orgs.isLoading ? (
            <SkeletonRows rows={6} cols={5} className="px-3 py-2" />
          ) : orgRows.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-foreground-muted">No organisations.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  <tr>
                    <th className="px-4 py-3">Org</th>
                    <th className="hidden px-4 py-3 sm:table-cell">Status</th>
                    <th className="hidden px-4 py-3 md:table-cell">AI plan</th>
                    <th className="hidden px-4 py-3 text-right lg:table-cell">Members</th>
                    <th className="hidden px-4 py-3 text-right lg:table-cell">Broadcast msgs</th>
                    <th className="hidden px-4 py-3 text-right lg:table-cell">AI tokens</th>
                    <th className="hidden px-4 py-3 text-right md:table-cell">AI cost</th>
                    <th className="hidden px-4 py-3 text-right lg:table-cell">Paid / mo</th>
                    <th className="hidden px-4 py-3 md:table-cell">Last activity</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((o) => {
                    const isAdminAccount = adminOrgIds.has(o.id);
                    return (
                    <tr
                      key={o.id}
                      className={`border-b border-border last:border-0${
                        isAdminAccount ? ' bg-brand-50/60 hover:bg-brand-50' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <Link href={`/hq/orgs/${o.id}`} className="group block">
                          <p className="flex items-center gap-2 font-medium text-foreground group-hover:text-brand-600 group-hover:underline">
                            {o.name}
                            {isAdminAccount && (
                              <Badge variant="info" className="gap-1">
                                <ShieldCheck className="size-3" /> Admin account
                              </Badge>
                            )}
                            {o.locked && (
                              <Badge
                                variant="danger"
                                className="animate-pulse gap-1 shadow-[0_0_10px_rgba(220,38,38,0.7)] ring-1 ring-danger/50"
                                title={`${o.lockedMembers} member${o.lockedMembers === 1 ? '' : 's'} locked out by the failed-login firewall. Use Unlock to let them sign in.`}
                              >
                                <Lock className="size-3" /> Locked
                              </Badge>
                            )}
                          </p>
                          <p className="font-mono text-xs text-foreground-subtle">{o.slug}</p>
                        </Link>
                      </td>
                      <td className="hidden px-4 py-3 sm:table-cell">
                        <Badge
                          variant={
                            o.status === 'active' ? 'success' : o.status === 'suspended' ? 'warning' : 'muted'
                          }
                        >
                          {o.status}
                        </Badge>
                      </td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        <Badge
                          variant={o.aiPlan === 'max' ? 'coral' : o.aiPlan === 'middle' ? 'info' : 'muted'}
                          title={AI_PLAN_DESCRIPTION[o.aiPlan]}
                        >
                          {AI_PLAN_LABEL[o.aiPlan]}
                        </Badge>
                      </td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">{o.memberCount}</td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                        {o.broadcastMessages.toLocaleString()}
                      </td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                        {o.aiTokens.toLocaleString()}
                      </td>
                      <td
                        className="hidden cursor-help px-4 py-3 text-right tabular-nums underline decoration-dotted underline-offset-2 md:table-cell"
                        title={
                          o.aiCostBreakdown.length
                            ? o.aiCostBreakdown
                                .map(
                                  (b) =>
                                    `${b.model}: $${b.usd.toFixed(2)} (${b.tokens.toLocaleString()} tokens)`,
                                )
                                .join('\n')
                            : 'No AI usage yet'
                        }
                      >
                        ${o.aiCostUsd.toFixed(2)}
                      </td>
                      <td className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                        {o.monthlyPaidUsd != null ? `$${o.monthlyPaidUsd.toFixed(2)}` : '—'}
                      </td>
                      <td className="hidden px-4 py-3 text-foreground-muted md:table-cell">
                        {o.lastActivityAt ? formatRelative(o.lastActivityAt) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" aria-label={`Actions for ${o.name}`}>
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-52">
                            <DropdownMenuItem asChild>
                              <Link href={`/hq/orgs/${o.id}`}>
                                <Eye className="size-4" /> Open details
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => controlOrg.mutate(o)}
                              disabled={controlOrg.isPending || o.status !== 'active'}
                            >
                              <ArrowRightToLine className="size-4" /> Control workspace
                            </DropdownMenuItem>
                            {o.locked ? (
                              <DropdownMenuItem
                                onSelect={() => unlock.mutate(o.id)}
                                disabled={unlock.isPending}
                                className="text-danger focus:text-danger"
                              >
                                <LockOpen className="size-4" /> Unlock login ({o.lockedMembers})
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuSeparator />
                            {o.status === 'active' ? (
                              <DropdownMenuItem
                                disabled={ownOrgIds.has(o.id)}
                                onSelect={async () => {
                                  if (
                                    await confirmDialog({
                                      title: `Suspend "${o.name}"?`,
                                      body: "Members won't be able to sign in until you reactivate the organisation. Their data stays intact.",
                                      confirmLabel: 'Suspend',
                                      destructive: true,
                                    })
                                  ) {
                                    update.mutate({ id: o.id, status: 'suspended' });
                                  }
                                }}
                              >
                                <Pause className="size-4" /> Suspend
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onSelect={() => update.mutate({ id: o.id, status: 'active' })}>
                                <Play className="size-4" /> Reactivate
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              disabled={ownOrgIds.has(o.id)}
                              className="text-danger focus:text-danger"
                              onSelect={async () => {
                                if (
                                  await confirmDialog({
                                    title: `Permanently delete "${o.name}"?`,
                                    body: 'Members, products, services, FAQs, API keys and webhooks for this organisation will all be removed. This cannot be undone.',
                                    confirmLabel: 'Delete everything',
                                    destructive: true,
                                  })
                                ) {
                                  remove.mutate(o.id);
                                }
                              }}
                            >
                              <Trash2 className="size-4" /> Delete organisation
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</p>
          <Icon className="size-4 text-foreground-subtle" />
        </div>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="mt-0.5 text-xs text-foreground-subtle">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

// Ranked per-tenant cost table for the admin dashboard (broadcast / AI).
function CostTable({
  title,
  subtitle,
  rows,
  metricHeader,
  loading,
}: {
  title: string;
  subtitle: string;
  rows: { id: string; name: string; metric: number; metricLabel: string; cost: number }[];
  metricHeader: string;
  loading: boolean;
}) {
  const total = rows.reduce((s, r) => s + r.cost, 0);
  const top = rows.slice(0, 20);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-baseline justify-between text-base">
          <span>{title}</span>
          <span className="tabular-nums text-primary">${total.toFixed(2)}</span>
        </CardTitle>
        <p className="text-xs text-foreground-subtle">{subtitle}</p>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <SkeletonRows rows={5} cols={3} className="px-3 py-2" />
        ) : rows.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-foreground-muted">No spend yet.</p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                <tr>
                  <th className="px-4 py-2">Tenant</th>
                  <th className="px-4 py-2 text-right">{metricHeader}</th>
                  <th className="px-4 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {top.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-surface-muted/50">
                    <td className="px-4 py-2">
                      <Link
                        href={`/hq/orgs/${r.id}/billing`}
                        className="hover:text-primary hover:underline"
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-foreground-muted">
                      {r.metricLabel}
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      ${r.cost.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > top.length ? (
              <p className="px-4 py-2 text-xs text-foreground-subtle">
                + {rows.length - top.length} more tenants
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
