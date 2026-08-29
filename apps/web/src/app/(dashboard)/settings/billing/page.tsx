'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Sparkles,
  Receipt,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  highlights: string[];
  productCap: number | null;
  serviceCap: number | null;
  memberCap: number | null;
  monthlyMessageCap: number | null;
  monthlyBroadcastCap: number | null;
  monthlyImportCap: number | null;
  apiKeyCap: number | null;
  webhookCap: number | null;
  priceMonthlyMinor: number | null;
  priceYearlyMinor: number | null;
  currency: string;
  sortOrder: number;
  hasStripePrice: boolean;
}

interface Subscription {
  id: string;
  planCode: string;
  planName: string;
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'free' | 'paused' | string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  caps: {
    productCap: number | null;
    serviceCap: number | null;
    memberCap: number | null;
    monthlyMessageCap: number | null;
    monthlyBroadcastCap: number | null;
    monthlyImportCap: number | null;
    apiKeyCap: number | null;
    webhookCap: number | null;
  };
  usage: {
    products: number;
    services: number;
    members: number;
    apiKeys: number;
    webhooks: number;
    monthlyMessages: number;
    monthlyBroadcasts: number;
    monthlyImports: number;
  };
  yearMonth: string;
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'muted' | 'default'> = {
  active: 'success',
  trialing: 'default',
  past_due: 'warning',
  free: 'muted',
  cancelled: 'danger',
  paused: 'muted',
};

function money(minor: number | null, currency: string) {
  if (minor == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);
}

export default function BillingPage() {
  const qc = useQueryClient();
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly');

  const subQ = useQuery({
    queryKey: ['billing-sub'],
    queryFn: () => api.get<{ data: Subscription }>('/api/v1/billing/subscription'),
  });
  const plansQ = useQuery({
    queryKey: ['billing-plans'],
    queryFn: () => api.get<{ data: Plan[] }>('/api/v1/billing/plans'),
  });

  const checkout = useMutation({
    mutationFn: (planCode: string) =>
      api.post<{ data: { url: string } }>('/api/v1/billing/checkout', { planCode, interval }),
    onSuccess: (res) => {
      if (res.data.url) window.location.href = res.data.url;
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Checkout failed'),
  });

  const portal = useMutation({
    mutationFn: () => api.post<{ data: { url: string } }>('/api/v1/billing/portal'),
    onSuccess: (res) => {
      if (res.data.url) window.location.href = res.data.url;
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Portal failed'),
  });

  const sub = subQ.data?.data;
  const plans = plansQ.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="Plan"
        description="Your current plan and usage. To change your plan, contact ALIGNED."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/settings">
              <ArrowLeft className="size-4" /> Back to settings
            </Link>
          </Button>
        }
      />

      {sub ? <CurrentPlanCard sub={sub} /> : null}
    </>
  );
}

function CurrentPlanCard({ sub }: { sub: Subscription }) {
  const trialActive = sub.status === 'trialing' && sub.trialEndsAt;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="size-4" /> Current plan: {sub.planName}
            </CardTitle>
            <CardDescription>
              <Badge variant={STATUS_VARIANT[sub.status] ?? 'default'} className="capitalize">
                {sub.status.replace('_', ' ')}
              </Badge>
              {sub.cancelAtPeriodEnd ? (
                <span className="ml-2 inline-flex items-center gap-1 text-xs text-amber-700">
                  <TriangleAlert className="size-3" /> cancels at period end
                </span>
              ) : null}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {trialActive ? (
            <div className="mb-3 rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800">
              Your trial ends {formatRelative(sub.trialEndsAt!)}. Pick a plan below to keep going.
            </div>
          ) : null}
          {sub.currentPeriodEnd ? (
            <p className="text-sm text-foreground-muted">
              Next billing date: {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage this month</CardTitle>
          <CardDescription>{sub.yearMonth} so far</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <UsageBar label="Products" used={sub.usage.products} cap={sub.caps.productCap} />
          <UsageBar label="Services" used={sub.usage.services} cap={sub.caps.serviceCap} />
          <UsageBar label="Members" used={sub.usage.members} cap={sub.caps.memberCap} />
          <UsageBar label="Messages (out)" used={sub.usage.monthlyMessages} cap={sub.caps.monthlyMessageCap} />
          <UsageBar
            label="Broadcasts (mo)"
            used={sub.usage.monthlyBroadcasts}
            cap={sub.caps.monthlyBroadcastCap}
          />
          <UsageBar label="Imports (mo)" used={sub.usage.monthlyImports} cap={sub.caps.monthlyImportCap} />
          <UsageBar label="API keys" used={sub.usage.apiKeys} cap={sub.caps.apiKeyCap} />
          <UsageBar label="Webhooks" used={sub.usage.webhooks} cap={sub.caps.webhookCap} />
        </CardContent>
      </Card>
    </div>
  );
}

function UsageBar({ label, used, cap }: { label: string; used: number; cap: number | null }) {
  const unlimited = cap == null || cap === 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / cap) * 100));
  const tone = pct >= 100 ? 'text-red-700' : pct >= 90 ? 'text-amber-700' : pct >= 75 ? 'text-amber-600' : 'text-foreground';
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-foreground-muted">{label}</span>
        {/* Percentage-first — how close to the limit, not a money figure. */}
        <span className="flex items-baseline gap-1.5">
          <span className={cn('font-semibold tabular-nums', unlimited ? 'text-foreground-subtle' : tone)}>
            {unlimited ? 'Unlimited' : `${pct}%`}
          </span>
          {!unlimited ? (
            <span className="text-[11px] tabular-nums text-foreground-subtle">
              ({used.toLocaleString()}/{cap.toLocaleString()})
            </span>
          ) : null}
        </span>
      </div>
      {!unlimited ? (
        <div
          className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} usage`}
        >
          <div
            className={cn(
              'h-full transition-[width]',
              pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-amber-500' : pct >= 75 ? 'bg-amber-400' : 'bg-brand-500',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
