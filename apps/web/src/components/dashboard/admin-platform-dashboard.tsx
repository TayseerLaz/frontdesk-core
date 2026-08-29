'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRightToLine,
  Building2,
  Boxes,
  Cpu,
  Database,
  MessageCircle,
  Server,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';

// The ALIGNED-HQ dashboard. The normal per-org widget dashboard answers
// "how healthy is MY catalog"; this answers "how is Hader doing, and how are
// my tenants doing". It reuses the same two admin endpoints that power
// /hq (no new API surface): the system snapshot + the orgs list.

type AiPlan = 'basic' | 'middle' | 'max' | 'ultra';

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'deleted';
  memberCount: number;
  productCount: number;
  serviceCount: number;
  broadcastMessages: number;
  aiTokens: number;
  aiCostUsd: number;
  aiCostBreakdown: { model: string; tokens: number; usd: number }[];
  lastActivityAt: string | null;
  aiPlan: AiPlan;
  disabledFeatures: string[];
  whatsappNumber: string | null;
}

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

const PLAN_LABEL: Record<AiPlan, string> = {
  basic: 'Basic',
  middle: 'Middle',
  max: 'Max',
  ultra: 'Ultra',
};

export function AdminPlatformDashboard({ greeting }: { greeting: string }) {
  const system = useQuery({
    queryKey: ['admin-system'],
    queryFn: () => api.get<{ data: SystemHealth }>('/api/v1/hq/system'),
    refetchInterval: 15_000,
  });
  const orgs = useQuery({
    queryKey: ['admin-orgs', ''],
    queryFn: () => api.get<{ data: OrgRow[] }>('/api/v1/hq/orgs'),
  });

  const router = useRouter();
  const sys = system.data?.data;
  const rows = orgs.data?.data ?? [];

  // "Tenants" = every org we manage. (HQ shows up here too, but it carries no
  // products/services, so the catalog sums stay meaningful.)
  const totalProducts = rows.reduce((s, o) => s + o.productCount, 0);
  const totalServices = rows.reduce((s, o) => s + o.serviceCount, 0);
  const totalQueueDepth = sys
    ? sys.queues.import.waiting + sys.queues.sync.waiting + sys.queues.webhook.waiting
    : 0;
  const totalFailed = sys
    ? sys.queues.import.failed + sys.queues.sync.failed + sys.queues.webhook.failed
    : 0;

  // Most-recently-active tenants first; nulls last.
  const ranked = [...rows].sort((a, b) => {
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return tb - ta;
  });

  return (
    <>
      <PageHeader
        title={greeting ? `Welcome back, ${greeting}` : 'ALIGNED HQ'}
        description="Platform overview for Hader and all of its tenants."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild>
              <Link href="/hq">
                <Building2 className="size-4" /> Manage tenants
              </Link>
            </Button>
          </div>
        }
      />

      <div className="space-y-6">
        {/* Platform KPIs */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={Building2}
            label="Active tenants"
            value={sys ? sys.orgs.active : '—'}
            hint={sys && sys.orgs.suspended > 0 ? `${sys.orgs.suspended} suspended` : 'all active'}
          />
          <StatCard
            icon={Users}
            label="Total users"
            value={sys ? sys.users.total : '—'}
            hint={sys ? `${sys.users.pending} pending verify` : undefined}
            onClick={() => router.push('/hq/users')}
          />
          <StatCard
            icon={Boxes}
            label="Catalog items"
            value={orgs.isLoading ? '—' : (totalProducts + totalServices).toLocaleString()}
            hint={`${totalProducts.toLocaleString()} products · ${totalServices.toLocaleString()} services`}
          />
          <StatCard
            icon={Activity}
            label="Queue depth"
            value={sys ? totalQueueDepth : '—'}
            hint={totalFailed > 0 ? `${totalFailed} failed jobs` : 'no failures'}
            accent={totalFailed > 0 ? 'red' : undefined}
          />
        </div>

        {/* Tenants & their WhatsApp numbers */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageCircle className="size-4 text-brand-500" /> Tenants &amp; WhatsApp numbers
            </CardTitle>
            <span className="text-xs text-foreground-subtle">{rows.length} tenants</span>
          </CardHeader>
          <CardContent className="p-0">
            {orgs.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-foreground-muted">No tenants yet.</p>
            ) : (
              <div className="max-h-[28rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-surface">
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-subtle">
                      <th className="px-4 py-2.5 font-medium">Tenant</th>
                      <th className="px-4 py-2.5 font-medium">WhatsApp number</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((o) => (
                        <tr
                          key={o.id}
                          className="border-b border-border last:border-0 hover:bg-surface-muted/40"
                        >
                          <td className="px-4 py-2.5">
                            <Link
                              href={`/hq/orgs/${o.id}`}
                              className="font-medium text-foreground hover:text-brand-600 hover:underline"
                            >
                              {o.name}
                            </Link>
                            <span className="ml-2 font-mono text-[11px] text-foreground-subtle">
                              {o.slug}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            {o.whatsappNumber ? (
                              <span className="font-mono tabular-nums text-foreground">
                                {o.whatsappNumber}
                              </span>
                            ) : (
                              <span className="text-xs text-foreground-subtle">— not connected</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* System health */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Server className="size-4" /> System health
            </CardTitle>
            <Badge variant={sys?.redis.connected ? 'success' : 'warning'}>
              {sys?.redis.connected ? 'Operational' : 'Degraded'}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <HealthStat
                icon={Database}
                label="Redis"
                value={sys?.redis.connected ? `${sys.redis.opsPerSec ?? 0} ops/s` : 'down'}
              />
              <HealthStat
                icon={Activity}
                label="Import queue"
                value={`${sys?.queues.import.waiting ?? '—'} waiting`}
                sub={sys ? `${sys.queues.import.failed} failed` : undefined}
                danger={(sys?.queues.import.failed ?? 0) > 0}
              />
              <HealthStat
                icon={Activity}
                label="Sync queue"
                value={`${sys?.queues.sync.waiting ?? '—'} waiting`}
                sub={sys ? `${sys.queues.sync.failed} failed` : undefined}
                danger={(sys?.queues.sync.failed ?? 0) > 0}
              />
              <HealthStat
                icon={Activity}
                label="Webhook queue"
                value={`${sys?.queues.webhook.waiting ?? '—'} waiting`}
                sub={sys ? `${sys.queues.webhook.failed} failed` : undefined}
                danger={(sys?.queues.webhook.failed ?? 0) > 0}
              />
            </div>
          </CardContent>
        </Card>

        {/* Tenants overview */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Tenants</CardTitle>
            <Button asChild size="sm" variant="ghost">
              <Link href="/hq">
                View all <ArrowRightToLine className="size-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {orgs.isLoading ? (
              <ul className="divide-y divide-border">
                {Array.from({ length: 5 }).map((_, i) => (
                  <li key={i} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="space-y-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="hidden h-4 w-12 sm:block" />
                    <Skeleton className="h-4 w-24" />
                  </li>
                ))}
              </ul>
            ) : ranked.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-foreground-muted">No tenants yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-surface-muted text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    <tr>
                      <th className="px-4 py-3">Tenant</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">AI plan</th>
                      <th className="px-4 py-3 text-right">Members</th>
                      <th className="px-4 py-3 text-right">Broadcast msgs</th>
                      <th className="px-4 py-3 text-right">AI tokens</th>
                      <th className="px-4 py-3 text-right">AI cost</th>
                      <th className="px-4 py-3">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((o) => (
                      <tr key={o.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3">
                          <p className="font-medium">{o.name}</p>
                          <p className="font-mono text-xs text-foreground-subtle">{o.slug}</p>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              o.status === 'active'
                                ? 'success'
                                : o.status === 'suspended'
                                  ? 'warning'
                                  : 'muted'
                            }
                          >
                            {o.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1 text-xs text-foreground-muted">
                            <Cpu className="size-3" />
                            {o.disabledFeatures.includes('ai') ? 'AI off' : PLAN_LABEL[o.aiPlan]}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{o.memberCount}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {o.broadcastMessages.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {o.aiTokens.toLocaleString()}
                        </td>
                        <td
                          className="cursor-help px-4 py-3 text-right tabular-nums underline decoration-dotted underline-offset-2"
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
                        <td className="px-4 py-3 text-foreground-muted">
                          {o.lastActivityAt ? formatRelative(o.lastActivityAt) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

    </>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  accent,
  onClick,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  hint?: string;
  accent?: 'red';
  onClick?: () => void;
}) {
  return (
    <Card
      onClick={onClick}
      className={
        onClick
          ? 'cursor-pointer transition-colors hover:border-brand-300 hover:bg-surface-muted/40'
          : undefined
      }
    >
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-foreground-subtle">{label}</p>
          <Icon className="size-4 text-foreground-subtle" />
        </div>
        <p
          className={`mt-1 text-2xl font-semibold tabular-nums ${accent === 'red' ? 'text-red-600' : ''}`}
        >
          {value}
        </p>
        {hint ? <p className="mt-0.5 text-xs text-foreground-subtle">{hint}</p> : null}
        {onClick ? (
          <p className="mt-0.5 text-[11px] font-medium text-brand-600">View all →</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function HealthStat({
  icon: Icon,
  label,
  value,
  sub,
  danger,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-foreground-subtle">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="mt-1 font-semibold tabular-nums">{value}</p>
      {sub ? (
        <p className={`text-xs ${danger ? 'font-medium text-red-600' : 'text-foreground-subtle'}`}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}
