'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Copy, MessageCircle, Trash2 } from 'lucide-react';
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

interface MessengerChannel {
  pageId: string | null;
  pageName: string | null;
  igAccountId: string | null;
  hasPageAccessToken: boolean;
  hasAppSecret: boolean;
  isActive: boolean;
  webhookVerifyToken: string;
  webhookCallbackUrl: string;
  ready: boolean;
  lastVerifyStatus: string | null;
  updatedAt: string | null;
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} className="font-mono text-xs" />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            toast.success('Copied');
          }}
          aria-label="Copy"
        >
          <Copy className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export default function MessengerSettingsPage() {
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  // Messenger + Instagram share this page. Available while EITHER is enabled.
  const messagingOn =
    !disabledFeatures.includes('messenger') || !disabledFeatures.includes('instagram');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['messenger-config'],
    // provision=true: this is the setup page, so it must have a real verify
    // token to display before any credentials exist. GET /messenger only
    // creates the channel row when asked — plain status reads (e.g. the mobile
    // Settings screen, which polls) leave the DB untouched.
    queryFn: () => api.get<{ data: MessengerChannel }>('/api/v1/messenger?provision=true'),
  });
  const cfg = q.data?.data;

  const [pageId, setPageId] = useState('');
  const [igAccountId, setIgAccountId] = useState('');
  const [pageAccessToken, setPageAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');

  useEffect(() => {
    if (!cfg) return;
    setPageId(cfg.pageId ?? '');
    setIgAccountId(cfg.igAccountId ?? '');
  }, [cfg]);

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/messenger', {
        pageId: pageId.trim() || null,
        igAccountId: igAccountId.trim() || null,
        ...(pageAccessToken ? { pageAccessToken } : {}),
        ...(appSecret ? { appSecret } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messenger-config'] });
      setPageAccessToken('');
      setAppSecret('');
      toast.success('Saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  const connect = useMutation({
    mutationFn: () => api.post('/api/v1/messenger/subscribe', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messenger-config'] });
      toast.success('Connected — validated token + subscribed the Page');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Connect failed'),
  });

  const disconnect = useMutation({
    mutationFn: () => api.delete('/api/v1/messenger'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messenger-config'] });
      setPageId('');
      setIgAccountId('');
      setPageAccessToken('');
      setAppSecret('');
      toast.success('Disconnected — the connection was removed');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Disconnect failed'),
  });

  async function onDisconnect() {
    const confirmed = await confirmDialog({
      title: 'Disconnect Messenger & Instagram?',
      body:
        'This removes the Page connection and deletes the stored credentials. We’ll also tell Meta to stop sending messages here. ' +
        'Your existing conversation history is kept. You can reconnect any time by entering the credentials again.',
      confirmLabel: 'Disconnect & delete',
      destructive: true,
    });
    if (confirmed) disconnect.mutate();
  }

  // Direct-URL guard: when both Messenger AND Instagram are disabled for this
  // tenant, the integration isn't available — don't render the config page.
  if (!messagingOn) {
    return (
      <>
        <PageHeader title="Messenger & Instagram" description="This integration isn't enabled for your account." />
        <Link
          href="/settings"
          className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Back to settings
        </Link>
        <Card>
          <CardContent className="py-10 text-center text-sm text-foreground-muted">
            Facebook Messenger and Instagram aren’t part of your current plan. Contact your account
            manager if you’d like to enable them.
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Facebook Messenger & Instagram"
        description="Let the AI bot answer your Facebook Page (and linked Instagram) DMs — using the same catalog, FAQs, and personality as WhatsApp."
      />
      <Link
        href="/settings"
        className="mb-4 inline-flex items-center gap-1 text-sm text-foreground-muted hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to settings
      </Link>

      <div className="grid max-w-2xl gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="size-4" /> Connection
              {cfg?.isActive ? (
                <Badge variant="success">
                  <CheckCircle2 className="mr-1 size-3" /> active
                </Badge>
              ) : cfg?.ready ? (
                <Badge variant="muted">ready — click Connect</Badge>
              ) : (
                <Badge variant="muted">needs setup</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Create a Meta app with the Messenger product, then paste your Facebook Page
              credentials below. Credentials are encrypted and never shown again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="m-page">Facebook Page ID</Label>
              <Input id="m-page" value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="1234567890" />
              {cfg?.pageName ? (
                <p className="mt-1 text-xs text-foreground-muted">Page: {cfg.pageName}</p>
              ) : null}
            </div>
            <div>
              <Label htmlFor="m-token">
                Page access token {cfg?.hasPageAccessToken && <SavedTag />}
              </Label>
              <Input
                id="m-token"
                type="password"
                value={pageAccessToken}
                onChange={(e) => setPageAccessToken(e.target.value)}
                placeholder={cfg?.hasPageAccessToken ? '•••••••• (leave blank to keep)' : 'EAAB…'}
              />
            </div>
            <div>
              <Label htmlFor="m-secret">App secret {cfg?.hasAppSecret && <SavedTag />}</Label>
              <Input
                id="m-secret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={cfg?.hasAppSecret ? '•••••••• (leave blank to keep)' : 'Meta app secret'}
              />
            </div>
            <div>
              <Label htmlFor="m-ig">Instagram account ID (optional)</Label>
              <Input
                id="m-ig"
                value={igAccountId}
                onChange={(e) => setIgAccountId(e.target.value)}
                placeholder="IG Business account linked to the Page"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={() => save.mutate()} loading={save.isPending}>
                Save
              </Button>
              <Button
                variant="secondary"
                onClick={() => connect.mutate()}
                loading={connect.isPending}
                disabled={!cfg?.hasPageAccessToken}
              >
                Connect &amp; subscribe
              </Button>
            </div>
            {cfg?.lastVerifyStatus ? (
              <p className="text-xs text-foreground-muted">Last check: {cfg.lastVerifyStatus}</p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Webhook (paste into your Meta app)</CardTitle>
            <CardDescription>
              In the Meta app dashboard → Messenger → Webhooks, use this callback URL + verify
              token, and subscribe the <code>messages</code> field. (Or just hit “Connect &amp;
              subscribe” above once the token is saved.)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <CopyField label="Callback URL" value={cfg?.webhookCallbackUrl ?? ''} />
            <CopyField label="Verify token" value={cfg?.webhookVerifyToken ?? ''} />
          </CardContent>
        </Card>

        {cfg && (cfg.pageId || cfg.hasPageAccessToken || cfg.hasAppSecret || cfg.igAccountId || cfg.isActive) ? (
          <Card className="border-red-200">
            <CardHeader>
              <CardTitle className="text-red-700">Disconnect</CardTitle>
              <CardDescription>
                Remove the Facebook Page / Instagram connection and delete the stored credentials.
                We’ll also ask Meta to stop sending messages here. Your existing conversations are
                kept, and you can reconnect later.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="danger" loading={disconnect.isPending} onClick={onDisconnect}>
                <Trash2 className="size-4" /> Disconnect &amp; delete
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}

function SavedTag() {
  return (
    <Badge variant="success" className="ml-2">
      <CheckCircle2 className="mr-1 size-3" /> saved
    </Badge>
  );
}
