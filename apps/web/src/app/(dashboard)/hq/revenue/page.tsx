'use client';

import { formatMicrosUsd } from '@platform/shared';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle, TrendingDown, TrendingUp, Users } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

interface Revenue {
  tenantsTotal: number;
  mrrMinor: number;
  mrrCurrency: string;
  byStatus: Record<string, number>;
  byPlan: { planCode: string; tenantCount: number; mrrMinor: number; currency: string }[];
  churnLast30d: { cancelled: number; churnRate: number };
}

interface WaMargin {
  totals: { messages: number; revenueMicros: number; metaCostMicros: number; profitMicros: number };
  tenants: {
    orgId: string;
    name: string;
    slug: string;
    messages: number;
    revenueMicros: number;
    metaCostMicros: number;
    profitMicros: number;
  }[];
}

function money(minor: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

export default function RevenuePage() {
  const q = useQuery({
    queryKey: ['admin-revenue'],
    queryFn: () => api.get<{ data: Revenue }>('/api/v1/hq/revenue'),
    refetchInterval: 60_000,
  });
  const r = q.data?.data;
  const waQ = useQuery({
    queryKey: ['admin-wa-margin'],
    queryFn: () => api.get<{ data: WaMargin }>('/api/v1/hq/whatsapp-margin'),
    refetchInterval: 60_000,
  });
  const wa = waQ.data?.data;

  return (
    <>
      <PageHeader
        backHref="/hq"
        backLabel="Tenants"
        title="Revenue"
        description="MRR, plan distribution, churn over the last 30 days. Reads live from Stripe-mirrored subscription state."
      />
      {!r ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="size-4" /> MRR
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{money(r.mrrMinor, r.mrrCurrency)}</p>
                <p className="mt-1 text-xs text-foreground-muted">Active subscriptions only.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="size-4" /> Tenants
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{r.tenantsTotal}</p>
                <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                  {Object.entries(r.byStatus).map(([s, c]) => (
                    <Badge key={s} variant="muted">
                      {s}: {c}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingDown className="size-4" /> Churn (30 d)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">
                  {(r.churnLast30d.churnRate * 100).toFixed(1)}%
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  {r.churnLast30d.cancelled} cancelled in last 30 days.
                </p>
              </CardContent>
            </Card>
          </div>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Plan distribution</CardTitle>
              <CardDescription>How tenants split across plans + MRR contribution.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-foreground-subtle">
                    <th className="py-2">Plan</th>
                    <th className="hidden sm:table-cell">Tenants</th>
                    <th>MRR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {r.byPlan.map((p) => (
                    <tr key={p.planCode}>
                      <td className="py-2 capitalize">{p.planCode}</td>
                      <td className="hidden sm:table-cell">{p.tenantCount}</td>
                      <td className="font-mono">{money(p.mrrMinor, p.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </CardContent>
          </Card>
        </>
      )}

      {/* WhatsApp messaging profit — what tenants paid per message vs our Meta
          cost. This is the per-message margin business, separate from plan MRR. */}
      <div className="mt-8">
        <div className="mb-3 flex items-center gap-2">
          <MessageCircle className="size-4 text-brand-500" />
          <h2 className="text-lg font-semibold">WhatsApp messaging profit</h2>
        </div>
        {!wa ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <WaStat label="Messages billed" value={wa.totals.messages.toLocaleString()} />
              <WaStat label="Revenue (tenants paid)" value={`$${formatMicrosUsd(wa.totals.revenueMicros)}`} />
              <WaStat label="Meta cost (ours)" value={`$${formatMicrosUsd(wa.totals.metaCostMicros)}`} />
              <WaStat
                label="Profit"
                value={`$${formatMicrosUsd(wa.totals.profitMicros)}`}
                accent
              />
            </div>
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>By tenant</CardTitle>
                <CardDescription>
                  Per-message billing so far (each message: tenant price − $0.0375 Meta cost = profit).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-foreground-subtle">
                        <th className="py-2">Tenant</th>
                        <th className="text-right">Messages</th>
                        <th className="hidden text-right sm:table-cell">Revenue</th>
                        <th className="hidden text-right sm:table-cell">Meta cost</th>
                        <th className="text-right">Profit</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {wa.tenants.filter((t) => t.messages > 0).length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-6 text-center text-foreground-muted">
                            No billed messages yet — profit shows here as tenants send.
                          </td>
                        </tr>
                      ) : (
                        wa.tenants
                          .filter((t) => t.messages > 0)
                          .map((t) => (
                            <tr key={t.orgId}>
                              <td className="py-2 font-medium">{t.name}</td>
                              <td className="text-right tabular-nums">{t.messages.toLocaleString()}</td>
                              <td className="hidden text-right font-mono tabular-nums sm:table-cell">
                                ${formatMicrosUsd(t.revenueMicros)}
                              </td>
                              <td className="hidden text-right font-mono tabular-nums text-foreground-muted sm:table-cell">
                                ${formatMicrosUsd(t.metaCostMicros)}
                              </td>
                              <td className="text-right font-mono font-semibold tabular-nums text-emerald-700">
                                ${formatMicrosUsd(t.profitMicros)}
                              </td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}

function WaStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-[11px] uppercase tracking-wide text-foreground-subtle">{label}</p>
        <p className={`mt-1 text-2xl font-bold tabular-nums ${accent ? 'text-emerald-700' : ''}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
