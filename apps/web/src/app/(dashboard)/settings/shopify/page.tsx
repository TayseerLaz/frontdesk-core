'use client';

import type { ShopifyConnectionDto } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, RefreshCw, ShoppingBag, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

const SECTION_LABELS: Record<string, string> = {
  product: 'Products',
  contact: 'Contacts',
  business_info: 'Business info',
  policy: 'Policies',
  faq: 'FAQs',
  location: 'Locations',
};

export default function ShopifySettingsPage() {
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const shopifyOn = !disabledFeatures.includes('shopify');
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['shopify-config'],
    queryFn: () => api.get<{ data: ShopifyConnectionDto }>('/api/v1/shopify'),
    enabled: shopifyOn,
    // Poll while a scrape/import run is in flight so the counts update live.
    refetchInterval: (query) => {
      const st = query.state.data?.data?.latestRun?.status;
      return st === 'pending' || st === 'running' ? 2500 : false;
    },
  });
  const cfg = q.data?.data;

  const [storeDomain, setStoreDomain] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [apiSecret, setApiSecret] = useState('');

  useEffect(() => {
    if (!cfg) return;
    setStoreDomain(cfg.storeDomain ?? '');
  }, [cfg]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/shopify', {
        storeDomain: storeDomain.trim() || undefined,
        ...(accessToken ? { accessToken } : {}),
        ...(apiSecret ? { apiSecret } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shopify-config'] });
      setAccessToken('');
      setApiSecret('');
      toast.success('Saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  // Verify the credentials, then kick off a full scrape into the review queue.
  const connectAndScrape = useMutation({
    mutationFn: async () => {
      await api.post('/api/v1/shopify/verify', {});
      await api.post('/api/v1/shopify/scrape', {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shopify-config'] });
      toast.success('Connected — scraping your store now…');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Connect failed'),
  });

  const rescrape = useMutation({
    mutationFn: () => api.post('/api/v1/shopify/scrape', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shopify-config'] });
      toast.success('Re-scraping your store…');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Scrape failed'),
  });

  const disconnect = useMutation({
    mutationFn: () => api.delete('/api/v1/shopify'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shopify-config'] });
      toast.success('Disconnected');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Failed'),
  });

  if (!shopifyOn) {
    return (
      <>
        <PageHeader title="Shopify" description="Sync your Shopify store into the platform." />
        <Card>
          <CardContent className="py-10 text-center text-sm text-foreground-muted">
            Shopify sync isn’t enabled for your account. Contact ALIGNED to turn it on.
          </CardContent>
        </Card>
      </>
    );
  }

  const runInFlight =
    cfg?.latestRun?.status === 'pending' || cfg?.latestRun?.status === 'running';
  // Total pending items waiting for review across all sections.
  const pendingTotal = cfg
    ? Object.values(cfg.stagedCounts).reduce((sum, byStatus) => sum + (byStatus.pending ?? 0), 0)
    : 0;

  return (
    <>
      <PageHeader
        title="Shopify"
        description="Connect your Shopify store, scrape its catalog & customers, review what comes in, then import."
        actions={
          <Link href="/settings">
            <Button variant="ghost">
              <ArrowLeft className="size-4" /> Settings
            </Button>
          </Link>
        }
      />

      <div className="max-w-2xl space-y-4">
        {/* Connection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingBag className="size-4" /> Connection
              {cfg?.status === 'active' && cfg.shopName ? (
                <Badge variant="success" className="ml-1">
                  <CheckCircle2 className="mr-1 size-3" /> {cfg.shopName}
                </Badge>
              ) : null}
            </CardTitle>
            <CardDescription>
              Enter the three things from your Shopify custom app: the store domain, the Admin API
              access token, and the API secret key.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="s-domain">Store domain</Label>
              <Input
                id="s-domain"
                value={storeDomain}
                onChange={(e) => setStoreDomain(e.target.value)}
                placeholder="your-store.myshopify.com"
              />
            </div>
            <div>
              <Label htmlFor="s-token">
                Admin API access token {cfg?.hasAccessToken ? <SavedTag /> : null}
              </Label>
              <Input
                id="s-token"
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={cfg?.hasAccessToken ? '•••••••• (leave blank to keep)' : 'shpat_…'}
              />
            </div>
            <div>
              <Label htmlFor="s-secret">
                API secret key {cfg?.hasApiSecret ? <SavedTag /> : null}
              </Label>
              <Input
                id="s-secret"
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder={cfg?.hasApiSecret ? '•••••••• (leave blank to keep)' : 'shpss_…'}
              />
              <p className="mt-1 text-xs text-foreground-subtle">
                Used to verify the live-update webhooks Shopify sends us.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => save.mutate()} loading={save.isPending}>
                Save
              </Button>
              <Button
                variant="secondary"
                onClick={() => connectAndScrape.mutate()}
                loading={connectAndScrape.isPending}
                disabled={!cfg?.hasAccessToken || runInFlight}
              >
                Connect &amp; scrape
              </Button>
              {cfg?.connected ? (
                <Button
                  variant="ghost"
                  className="ml-auto text-rose-600"
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: 'Disconnect Shopify?',
                        body: 'This removes the connection and clears the review queue. Already-imported products stay in your catalog.',
                        confirmLabel: 'Disconnect',
                        destructive: true,
                      })
                    ) {
                      disconnect.mutate();
                    }
                  }}
                >
                  <Trash2 className="size-4" /> Disconnect
                </Button>
              ) : null}
            </div>
            {cfg?.lastVerifyStatus && cfg.lastVerifyStatus !== 'ok' ? (
              <p className="text-xs text-rose-600">Last check: {cfg.lastVerifyStatus}</p>
            ) : null}
          </CardContent>
        </Card>

        {/* Review queue */}
        {cfg?.connected ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Review queue
                {runInFlight ? (
                  <Badge variant="info">
                    <RefreshCw className="mr-1 size-3 animate-spin" /> Scraping…
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription>
                Everything we pulled from Shopify lands here for your approval before it goes live.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.keys(SECTION_LABELS).map((sec) => {
                  const counts = cfg.stagedCounts[sec] ?? {};
                  const pending = counts.pending ?? 0;
                  const imported = counts.imported ?? 0;
                  if (!pending && !imported && !counts.approved && !counts.rejected) return null;
                  return (
                    <div key={sec} className="rounded-lg border border-border p-3 text-sm">
                      <div className="font-medium">{SECTION_LABELS[sec]}</div>
                      <div className="mt-1 text-xs text-foreground-muted">
                        {pending} pending · {imported} imported
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href="/settings/shopify/review">
                  <Button disabled={pendingTotal === 0 && !cfg.latestRun}>
                    Review {pendingTotal > 0 ? `${pendingTotal} item${pendingTotal === 1 ? '' : 's'}` : 'items'}
                  </Button>
                </Link>
                <Button
                  variant="ghost"
                  onClick={() => rescrape.mutate()}
                  loading={rescrape.isPending}
                  disabled={runInFlight}
                >
                  <RefreshCw className="size-4" /> Re-scrape
                </Button>
              </div>
              {cfg.latestRun?.errorMessage ? (
                <p className="text-xs text-rose-600">Last run error: {cfg.latestRun.errorMessage}</p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function SavedTag() {
  return (
    <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700">
      saved
    </span>
  );
}
