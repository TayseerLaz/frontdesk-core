'use client';

import type {
  WhatsAppChannelDto,
  WhatsAppTestSendResult,
  WhatsAppVerifyResult,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  ExternalLink,
  History,
  MessageCircle,
  Phone,
  Plus,
  PowerOff,
  Send,
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

interface TemplateOption {
  id: string;
  name: string;
  language: string;
  status: string;
  bodyText?: string;
  // Full Meta-shaped components — the test-send form parses these to
  // figure out which header / URL-button placeholders need input
  // fields. Optional because older synced templates may not have it.
  components?: Record<string, unknown>[] | null;
}

type FormState = {
  label: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  appId: string;
  accessToken: string; // empty = leave alone, '__clear__' sentinel handled below
  appSecret: string;
  greetingMessage: string;
  businessName: string;
  businessAbout: string;
  businessAddress: string;
  businessEmail: string;
  isActive: boolean;
};

function formFromChannel(c: WhatsAppChannelDto): FormState {
  return {
    label: c.label ?? '',
    wabaId: c.wabaId ?? '',
    phoneNumberId: c.phoneNumberId ?? '',
    displayPhoneNumber: c.displayPhoneNumber ?? '',
    appId: c.appId ?? '',
    accessToken: '',
    appSecret: '',
    greetingMessage: c.greetingMessage ?? '',
    businessName: c.businessName ?? '',
    businessAbout: c.businessAbout ?? '',
    businessAddress: c.businessAddress ?? '',
    businessEmail: c.businessEmail ?? '',
    isActive: c.isActive,
  };
}

async function copyToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Couldn't copy — click the field and copy manually.");
  }
}

export default function WhatsAppPage() {
  const queryClient = useQueryClient();
  // Embedded Signup is requireRole('admin') on both API routes, so the entry
  // point is admin-only here too. Same check as members/page.tsx.
  const { session } = useSession();
  const isOrgAdmin = session?.organization.role === 'admin';

  // Multi-number: the full list of the org's WhatsApp numbers. The first call
  // to GET /whatsapp lazily creates the primary stub, so we hit it once to
  // guarantee at least one row exists, then drive everything off the list.
  const numbersQ = useQuery({
    queryKey: ['whatsapp-numbers'],
    queryFn: async () => {
      await api.get<{ data: WhatsAppChannelDto }>('/api/v1/whatsapp'); // ensure primary stub
      return api.get<{ data: WhatsAppChannelDto[] }>('/api/v1/whatsapp/numbers');
    },
  });
  const numbers = numbersQ.data?.data ?? [];
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  // Keep a valid selection: default to the primary, fall back to the first.
  useEffect(() => {
    if (numbers.length === 0) return;
    if (!selectedChannelId || !numbers.some((n) => n.id === selectedChannelId)) {
      setSelectedChannelId((numbers.find((n) => n.isPrimary) ?? numbers[0]!).id);
    }
  }, [numbers, selectedChannelId]);

  // Approved templates — used to populate the test-send dropdown so the
  // operator can pick instead of typing a name/language by hand.
  const templatesQ = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => api.get<{ data: TemplateOption[] }>('/api/v1/whatsapp/templates'),
  });

  const channel = numbers.find((n) => n.id === selectedChannelId) ?? null;

  const [form, setForm] = useState<FormState | null>(null);
  useEffect(() => {
    if (channel) setForm(formFromChannel(channel));
    // Re-seed the form when the selected number changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChannelId, channel?.updatedAt]);

  const invalidateNumbers = () =>
    queryClient.invalidateQueries({ queryKey: ['whatsapp-numbers'] });

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.put<{ data: WhatsAppChannelDto }>(`/api/v1/whatsapp/numbers/${selectedChannelId}`, payload),
    onSuccess: () => {
      invalidateNumbers();
      toast.success('Saved');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Save failed'),
  });

  // Add a new number, then select it so the operator can fill in its creds.
  const addNumber = useMutation({
    mutationFn: () =>
      api.post<{ data: WhatsAppChannelDto }>('/api/v1/whatsapp/numbers', {}),
    onSuccess: async (res) => {
      await invalidateNumbers();
      setSelectedChannelId(res.data.id);
      toast.success('Number added — fill in its credentials');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Add failed'),
  });

  // Make the selected number the org default (primary).
  const promote = useMutation({
    mutationFn: () => api.post(`/api/v1/whatsapp/numbers/${selectedChannelId}/promote`),
    onSuccess: () => {
      invalidateNumbers();
      toast.success('Set as primary number');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Failed'),
  });

  // Remove a non-primary number entirely.
  const removeNumber = useMutation({
    mutationFn: () => api.delete(`/api/v1/whatsapp/numbers/${selectedChannelId}`),
    onSuccess: async () => {
      await invalidateNumbers();
      setSelectedChannelId(null);
      toast.success('Number removed');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Remove failed'),
  });

  const verify = useMutation({
    mutationFn: () =>
      api.post<{ data: WhatsAppVerifyResult }>('/api/v1/whatsapp/verify', {
        channelId: selectedChannelId,
      }),
    onSuccess: (res) => {
      const r = res.data;
      if (r.ok) {
        toast.success(
          `Connected to Meta · ${r.verifiedDisplayPhoneNumber ?? 'phone'}${r.verifiedQualityRating ? ' · ' + r.verifiedQualityRating + ' quality' : ''}`,
        );
      } else {
        toast.error(`Verification failed (${r.status})${r.errorMessage ? ': ' + r.errorMessage : ''}`);
      }
      invalidateNumbers();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Verify failed'),
  });

  const testSend = useMutation({
    mutationFn: (args: {
      to: string;
      templateName: string;
      templateLanguage: string;
      parameters: string[];
      headerTextParam?: string;
      buttonUrlParams?: string[];
    }) =>
      api.post<{ data: WhatsAppTestSendResult }>('/api/v1/whatsapp/test-send', {
        ...args,
        channelId: selectedChannelId,
      }),
    onSuccess: (res, vars) => {
      const r = res.data;
      if (r.ok) toast.success(`${vars.templateName} template sent`);
      else toast.error(r.errorMessage ?? 'Send failed');
      queryClient.invalidateQueries({ queryKey: ['whatsapp-messages'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  // "Disconnect" clears this number's credentials (keeps the row + webhook
  // verify token so it can be reconnected). Removing the row entirely is the
  // separate "Remove number" action (non-primary only).
  const disconnect = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/whatsapp/numbers/${selectedChannelId}`, {
        accessToken: '',
        appSecret: '',
        wabaId: '',
        phoneNumberId: '',
        appId: '',
        isActive: false,
        botEnabled: false,
      }),
    onSuccess: () => {
      invalidateNumbers();
      toast.success('Disconnected');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Disconnect failed'),
  });

  if (!channel || !form) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const credsComplete = channel.hasAccessToken && !!channel.phoneNumberId;
  const verifiedOk = channel.lastVerifyStatus === 'success';
  const verifiedRecently =
    !!channel.lastVerifiedAt &&
    Date.now() - new Date(channel.lastVerifiedAt).getTime() < 7 * 24 * 60 * 60 * 1000;

  // Build the PUT body. Empty string for secrets = clear; non-empty = update;
  // unchanged form value = leave alone (field omitted).
  const buildPayload = (): Record<string, unknown> => {
    const initial = formFromChannel(channel);
    const out: Record<string, unknown> = {};
    const keys = Object.keys(form) as (keyof FormState)[];
    for (const k of keys) {
      if (k === 'accessToken' || k === 'appSecret') {
        // Secrets: omit unless the user typed something.
        if (form[k] !== '') out[k] = form[k];
        continue;
      }
      if (form[k] !== initial[k]) out[k] = form[k];
    }
    return out;
  };

  const statusBadge = (
    <Badge variant={verifiedOk && channel.isActive ? 'success' : 'muted'} className="gap-1">
      {verifiedOk && channel.isActive ? (
        <>
          <CheckCircle2 className="size-3" /> Live
        </>
      ) : verifiedOk ? (
        <>
          <CheckCircle2 className="size-3" /> Connected · paused
        </>
      ) : credsComplete ? (
        <>
          <AlertTriangle className="size-3" /> Not verified
        </>
      ) : (
        'Not configured'
      )}
    </Badge>
  );

  return (
    <>
      <PageHeader
        title="WhatsApp"
        description="Connect your Meta WhatsApp Business number(s) so the bot can receive and reply."
        actions={
          <>
            {/* PLAIN <a>, NOT next/link <Link>. This is load-bearing.
                Cross-Origin-Opener-Policy is a DOCUMENT-LOAD header, relaxed to
                `same-origin-allow-popups` for /whatsapp/connect only, in
                src/middleware.ts. A soft client-side navigation never re-reads
                response headers, so an operator who landed on any other portal
                page first and soft-navigated here would arrive still governed
                by `same-origin` — which severs the FB.login popup's
                window.opener. The popup then opens, the tenant completes the
                flow on their handset, and the callback never fires, with no
                error anywhere.

                basePath ('/app') is NOT applied to a raw <a href> — Next only
                rewrites <Link>, router.push and server redirect() — so '/app'
                is spelled out, the same reason layout.tsx hardcodes
                '/app/manifest.webmanifest'. */}
            {isOrgAdmin ? (
              <Button asChild variant="primary">
                <a href="/app/whatsapp/connect">
                  <MessageCircle className="size-4" /> Connect my WhatsApp number
                </a>
              </Button>
            ) : null}
            {statusBadge}
          </>
        }
      />

      <CoexistenceHistoryCard />

      {/* ---------- Numbers strip + per-number controls ---------- */}
      <Card className="mb-4">
        <CardContent className="space-y-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {numbers.map((n) => {
              const isSel = n.id === selectedChannelId;
              const name = n.label || n.displayPhoneNumber || 'Untitled number';
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelectedChannelId(n.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors',
                    isSel
                      ? 'border-brand-400 bg-brand-50 text-brand-800 dark:bg-brand-400/10'
                      : 'border-border hover:bg-surface-muted',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      n.isActive ? 'bg-success' : 'bg-foreground-subtle/40',
                    )}
                  />
                  <span className="font-medium">{name}</span>
                  {n.isPrimary ? <Star className="size-3.5 text-amber-500" /> : null}
                  {n.botEnabled ? <Bot className="size-3.5 text-emerald-600" /> : null}
                </button>
              );
            })}
            <Button size="sm" variant="ghost" onClick={() => addNumber.mutate()} loading={addNumber.isPending}>
              <Plus className="size-4" /> Add number
            </Button>
          </div>

          {/* Compact per-number action row: name + toggles + primary/remove. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Input
              aria-label="Number name"
              placeholder="Name this number (e.g. Sales, Support)"
              className="h-9 w-full sm:w-56"
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save.mutate({ label: form.label.trim() || null });
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => save.mutate({ label: form.label.trim() || null })}
              loading={save.isPending}
              disabled={(form.label.trim() || null) === (channel.label ?? null)}
            >
              Save
            </Button>
            <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
            <Button
              size="sm"
              variant={channel.botEnabled ? 'primary' : 'secondary'}
              onClick={() => save.mutate({ botEnabled: !channel.botEnabled })}
              loading={save.isPending}
              title="When ON, the AI bot auto-replies to this number (the bot must also be deployed on the Bot page)."
            >
              <Bot className="size-4" /> AI bot {channel.botEnabled ? 'ON' : 'OFF'}
            </Button>
            <Button
              size="sm"
              variant={channel.isActive ? 'primary' : 'secondary'}
              onClick={() => save.mutate({ isActive: !channel.isActive })}
              loading={save.isPending}
              disabled={!verifiedOk}
              title={verifiedOk ? 'Mark this number live' : 'Verify with Meta first'}
            >
              <PowerOff className="size-4" /> Live {channel.isActive ? 'ON' : 'OFF'}
            </Button>
            {!channel.isPrimary ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => promote.mutate()} loading={promote.isPending}>
                  <Star className="size-4" /> Make primary
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-coral-700"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: 'Remove this number?',
                      body: 'The number and its conversations link will be removed. This cannot be undone.',
                      confirmLabel: 'Remove',
                      destructive: true,
                    });
                    if (ok) removeNumber.mutate();
                  }}
                  loading={removeNumber.isPending}
                >
                  <Trash2 className="size-4" /> Remove
                </Button>
              </>
            ) : null}
          </div>

          {/* One-line status chips. */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Chip ok={credsComplete} label={credsComplete ? 'Credentials set' : 'Credentials missing'} />
            <Chip
              ok={verifiedOk}
              warn={!verifiedOk && !!channel.lastVerifyStatus}
              label={verifiedOk ? 'Verified' : `Verify: ${channel.lastVerifyStatus ?? 'never'}`}
            />
            <Chip ok={channel.hasAppSecret} label={channel.hasAppSecret ? 'Inbound ready' : 'App secret missing'} />
            <Chip ok={channel.isActive} label={channel.isActive ? 'Live' : 'Paused'} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ---------- Connection: credentials + webhook ---------- */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Phone className="size-4" /> Connection
            </CardTitle>
            <CardDescription>
              From{' '}
              <a
                href="https://business.facebook.com/"
                target="_blank"
                rel="noreferrer noopener"
                className="text-brand-500 underline"
              >
                Meta Business Settings
              </a>{' '}
              <ExternalLink className="inline size-3" /> → WhatsApp → API Setup. Use a non-expiring
              System User token; the app secret is under app dashboard → Settings → Basic.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wabaId">WABA ID</Label>
                <Input
                  id="wabaId"
                  value={form.wabaId}
                  onChange={(e) => setForm({ ...form, wabaId: e.target.value.trim() })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phoneNumberId">Phone number ID</Label>
                <Input
                  id="phoneNumberId"
                  value={form.phoneNumberId}
                  onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value.trim() })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="displayPhoneNumber">Display number (auto on verify)</Label>
                <Input
                  id="displayPhoneNumber"
                  placeholder="+14155551234"
                  value={form.displayPhoneNumber}
                  onChange={(e) => setForm({ ...form, displayPhoneNumber: e.target.value.trim() })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="appId">Meta App ID</Label>
                <Input
                  id="appId"
                  value={form.appId}
                  onChange={(e) => setForm({ ...form, appId: e.target.value.trim() })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="accessToken">
                  System User access token{' '}
                  {channel.hasAccessToken ? (
                    <span className="ml-1 text-foreground-subtle">
                      (current: <span className="font-mono">{channel.accessTokenMasked}</span>)
                    </span>
                  ) : null}
                </Label>
                <Input
                  id="accessToken"
                  type="password"
                  autoComplete="off"
                  placeholder={channel.hasAccessToken ? 'Leave blank to keep current' : 'EAAxxxxxxxxx…'}
                  value={form.accessToken}
                  onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="appSecret">
                  App secret{' '}
                  {channel.hasAppSecret ? (
                    <span className="ml-1 text-foreground-subtle">
                      (current: <span className="font-mono">{channel.appSecretMasked}</span>)
                    </span>
                  ) : null}
                </Label>
                <Input
                  id="appSecret"
                  type="password"
                  autoComplete="off"
                  placeholder={channel.hasAppSecret ? 'Leave blank to keep current' : '32-char hex from Meta'}
                  value={form.appSecret}
                  onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => save.mutate(buildPayload())} loading={save.isPending}>
                Save credentials
              </Button>
              <Button
                variant="secondary"
                onClick={() => verify.mutate()}
                loading={verify.isPending}
                disabled={!credsComplete}
              >
                <ShieldCheck className="size-4" /> Verify with Meta
              </Button>
              {channel.lastVerifiedAt ? (
                <span className="text-xs text-foreground-subtle">
                  checked {formatRelative(channel.lastVerifiedAt)} ·{' '}
                  <span className={verifiedOk ? 'text-emerald-700' : 'text-red-600'}>
                    {channel.lastVerifyStatus}
                  </span>
                </span>
              ) : null}
            </div>

            {/* Webhook details for Meta — compact, collapsible-feel block. */}
            <div className="space-y-2 rounded-lg border border-border bg-surface-muted/30 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground-muted">
                <ShieldCheck className="size-3.5" /> Webhook for Meta (developers.facebook.com → app
                → WhatsApp → Configuration)
              </p>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={channel.webhookCallbackUrl}
                  className="h-8 font-mono text-xs"
                  aria-label="Callback URL"
                />
                <Button
                  variant="secondary"
                  size="icon"
                  className="size-8"
                  aria-label="Copy callback URL"
                  onClick={() => copyToClipboard(channel.webhookCallbackUrl, 'Callback URL')}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={channel.webhookVerifyToken}
                  className="h-8 font-mono text-xs"
                  aria-label="Verify token"
                />
                <Button
                  variant="secondary"
                  size="icon"
                  className="size-8"
                  aria-label="Copy verify token"
                  onClick={() => copyToClipboard(channel.webhookVerifyToken, 'Verify token')}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <p className="text-[11px] text-foreground-subtle">
                Subscribe the app to the WABA and tick the <span className="font-mono">messages</span>{' '}
                field. Verifying above also auto-subscribes the callback.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ---------- Sidebar: test + disconnect ---------- */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Send className="size-4" /> Send a test
              </CardTitle>
              <CardDescription>
                Sends an approved template (recipient must be a Meta tester until business
                verification).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TestSendForm
                templates={templatesQ.data?.data ?? []}
                onSend={(args) => testSend.mutate(args)}
                loading={testSend.isPending}
                disabled={!verifiedOk}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-red-700">Disconnect</p>
                <p className="text-xs text-foreground-subtle">Clears credentials; webhook stays.</p>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: 'Disconnect WhatsApp?',
                      body: 'Stored credentials will be cleared. The webhook URL + verify token stay the same so you can reconnect later.',
                      confirmLabel: 'Disconnect',
                      destructive: true,
                    })
                  ) {
                    disconnect.mutate();
                  }
                }}
                loading={disconnect.isPending}
                disabled={!channel.hasAccessToken && !channel.hasAppSecret}
              >
                <Trash2 className="size-4" /> Disconnect
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

// Compact status pill used in the numbers strip.
function Chip({ label, ok, warn }: { label: string; ok?: boolean; warn?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300'
          : warn
            ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300'
            : 'border-border bg-surface-muted/40 text-foreground-subtle',
      )}
    >
      {ok ? <CheckCircle2 className="size-3" /> : warn ? <AlertTriangle className="size-3" /> : null}
      {label}
    </span>
  );
}

// Count the highest {{N}} placeholder in a template's body so we know
// how many parameter inputs to render. Returns 0 for static templates.
function countPlaceholders(body: string | undefined | null): number {
  if (!body) return 0;
  const matches = body.match(/{{\s*(\d+)\s*}}/g) ?? [];
  let max = 0;
  for (const m of matches) {
    const n = Number(m.replace(/[^\d]/g, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

interface TestSendArgs {
  to: string;
  templateName: string;
  templateLanguage: string;
  parameters: string[];
  headerTextParam?: string;
  buttonUrlParams?: string[];
}

// Inspect a template's stored components and pull out:
//   - whether the HEADER is TEXT with {{1}}
//   - URL buttons (in order) and whether each contains {{1}}
// Used to decide which extra input fields the test-send form needs to
// render alongside the body-parameter inputs.
function inspectComponents(components: Record<string, unknown>[] | null | undefined): {
  headerTextHasVar: boolean;
  urlButtonsWithVar: { url: string; text: string }[];
} {
  if (!Array.isArray(components)) {
    return { headerTextHasVar: false, urlButtonsWithVar: [] };
  }
  let headerTextHasVar = false;
  const urlButtonsWithVar: { url: string; text: string }[] = [];
  for (const raw of components) {
    const c = raw as {
      type?: string;
      format?: string;
      text?: string;
      buttons?: { type?: string; url?: string; text?: string }[];
    };
    const t = (c.type ?? '').toUpperCase();
    if (t === 'HEADER' && (c.format ?? '').toUpperCase() === 'TEXT') {
      if (/{{\s*1\s*}}/.test(c.text ?? '')) headerTextHasVar = true;
    }
    if (t === 'BUTTONS') {
      for (const b of c.buttons ?? []) {
        if ((b.type ?? '').toUpperCase() !== 'URL') continue;
        if (/{{\s*1\s*}}/.test(b.url ?? '')) {
          urlButtonsWithVar.push({ url: b.url ?? '', text: b.text ?? '' });
        }
      }
    }
  }
  return { headerTextHasVar, urlButtonsWithVar };
}

function TestSendForm({
  templates,
  onSend,
  loading,
  disabled,
}: {
  templates: TemplateOption[];
  onSend: (args: TestSendArgs) => void;
  loading: boolean;
  disabled: boolean;
}) {
  const [to, setTo] = useState('');
  // Approved templates first; fall back to hello_world / en_US so the
  // dropdown is never empty even before the user runs Sync from Meta.
  const approved = templates.filter((t) => t.status === 'approved');
  const options: TemplateOption[] =
    approved.length > 0
      ? approved
      : [{ id: 'hello_world', name: 'hello_world', language: 'en_US', status: 'fallback' }];
  // Each option's value is "name|language" so we can recover both halves
  // on change without an extra lookup.
  const [selected, setSelected] = useState<string>(`${options[0]!.name}|${options[0]!.language}`);
  // Keep the selection in sync if the templates list updates after first render
  // (Sync from Meta, async load).
  useEffect(() => {
    const exists = options.some((o) => `${o.name}|${o.language}` === selected);
    if (!exists && options[0]) {
      setSelected(`${options[0].name}|${options[0].language}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);
  const [name, language] = selected.split('|');
  const selectedTpl = options.find((o) => `${o.name}|${o.language}` === selected);
  const placeholderCount = countPlaceholders(selectedTpl?.bodyText);
  const { headerTextHasVar, urlButtonsWithVar } = inspectComponents(selectedTpl?.components);

  const [params, setParams] = useState<string[]>([]);
  const [headerParam, setHeaderParam] = useState<string>('');
  const [urlParams, setUrlParams] = useState<string[]>([]);

  // Reset all variable-input arrays whenever the picked template changes
  // (different templates have different placeholder shapes).
  useEffect(() => {
    setParams(Array.from({ length: placeholderCount }, () => ''));
    setHeaderParam('');
    setUrlParams(Array.from({ length: urlButtonsWithVar.length }, () => ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, placeholderCount, urlButtonsWithVar.length]);

  const allBodyFilled = params.every((v) => v.trim().length > 0);
  const headerOk = !headerTextHasVar || headerParam.trim().length > 0;
  const urlsOk = urlButtonsWithVar.length === 0 || urlParams.every((v) => v.trim().length > 0);

  return (
    <div className="space-y-2">
      <Input
        placeholder="+14155551234"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={disabled}
        aria-label="Recipient phone"
      />
      <Select value={selected} onValueChange={setSelected} disabled={disabled}>
        <SelectTrigger>
          <SelectValue placeholder="Pick a template…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((t) => (
            <SelectItem key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
              <span className="font-mono">{t.name}</span>{' '}
              <span className="text-foreground-subtle">· {t.language}</span>
              {t.status !== 'approved' && t.status !== 'fallback' ? (
                <span className="ml-2 text-foreground-subtle">({t.status})</span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {approved.length === 0 ? (
        <p className="text-xs text-foreground-subtle">
          No approved templates yet — falling back to <span className="font-mono">hello_world / en_US</span>.
          Use <span className="font-mono">/whatsapp/templates → Sync from Meta</span> to populate.
        </p>
      ) : null}
      {selectedTpl?.bodyText ? (
        <pre className="whitespace-pre-wrap rounded border border-border bg-surface-muted/40 px-3 py-2 text-xs font-mono text-foreground">
          {selectedTpl.bodyText}
        </pre>
      ) : null}

      {/* Header text {{1}} when present */}
      {headerTextHasVar ? (
        <div className="space-y-1.5">
          <p className="text-xs text-foreground-muted">
            This template has a header variable. Fill the value that will replace{' '}
            <span className="font-mono">{'{{1}}'}</span> in the header line.
          </p>
          <Input
            placeholder="value for header {{1}}"
            value={headerParam}
            onChange={(e) => setHeaderParam(e.target.value)}
            disabled={disabled}
            aria-label="Header parameter"
          />
        </div>
      ) : null}

      {/* Body placeholders */}
      {placeholderCount > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs text-foreground-muted">
            This template has {placeholderCount} body variable{placeholderCount === 1 ? '' : 's'}. Fill
            them in order — they bind to <span className="font-mono">{'{{1}}'}</span>,{' '}
            <span className="font-mono">{'{{2}}'}</span>, … in the body above.
          </p>
          {params.map((value, i) => (
            <Input
              key={i}
              placeholder={`value for body {{${i + 1}}}`}
              value={value}
              onChange={(e) => {
                const next = params.slice();
                next[i] = e.target.value;
                setParams(next);
              }}
              disabled={disabled}
              aria-label={`Body parameter ${i + 1}`}
            />
          ))}
        </div>
      ) : null}

      {/* URL button placeholders */}
      {urlButtonsWithVar.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs text-foreground-muted">
            {urlButtonsWithVar.length === 1 ? 'One URL button' : `${urlButtonsWithVar.length} URL buttons`}{' '}
            need a runtime value — Meta interpolates each into the URL where{' '}
            <span className="font-mono">{'{{1}}'}</span> appears.
          </p>
          {urlButtonsWithVar.map((btn, i) => (
            <div key={i} className="space-y-0.5">
              <p className="text-[11px] font-mono text-foreground-subtle">
                {btn.text ? `"${btn.text}" → ` : ''}
                {btn.url}
              </p>
              <Input
                placeholder={`value for URL {{1}} (button ${i + 1})`}
                value={urlParams[i] ?? ''}
                onChange={(e) => {
                  const next = urlParams.slice();
                  next[i] = e.target.value;
                  setUrlParams(next);
                }}
                disabled={disabled}
                aria-label={`URL button parameter ${i + 1}`}
              />
            </div>
          ))}
        </div>
      ) : null}

      <Button
        onClick={() =>
          onSend({
            to,
            templateName: (name ?? '').trim(),
            templateLanguage: (language ?? '').trim(),
            parameters: params.map((p) => p.trim()),
            headerTextParam: headerTextHasVar ? headerParam.trim() : undefined,
            buttonUrlParams: urlButtonsWithVar.length > 0 ? urlParams.map((v) => v.trim()) : undefined,
          })
        }
        loading={loading}
        disabled={
          disabled ||
          to.trim().length < 6 ||
          !name ||
          !language ||
          (placeholderCount > 0 && !allBodyFilled) ||
          !headerOk ||
          !urlsOk
        }
      >
        <Send className="size-4" /> Send {name || 'template'}
      </Button>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Post-connect visibility for coexistence tenants: is the one-shot history
// import still flowing, and until when may Hader learn from conversations.
// Renders NOTHING for orgs with no grant and no history payloads — which is
// most of the fleet — so it costs one silent GET and zero pixels elsewhere.
interface CoexistenceStatus {
  historyOptIn: boolean;
  linkedAt: string | null;
  captureEndsAt: string | null;
  history: {
    received: number;
    processed: number;
    lastReceivedAt: string | null;
    phase: number | null;
    progress: number | null;
    complete: boolean;
  } | null;
}

function CoexistenceHistoryCard() {
  const q = useQuery({
    queryKey: ['whatsapp-coexistence-status'],
    queryFn: () => api.get<{ data: CoexistenceStatus }>('/api/v1/whatsapp/coexistence/status'),
    retry: false,
    staleTime: 60_000,
    // While an import is visibly in flight, poll so the bar actually moves.
    refetchInterval: (query) => {
      const d = query.state.data?.data;
      return d?.history && !d.history.complete ? 30_000 : false;
    },
  });
  const d = q.data?.data;
  if (!d || (!d.historyOptIn && !d.history)) return null;

  // Meta phases: 0 = last day, 1 = first 90 days, 2 = the rest to 180 days.
  const pct = d.history
    ? d.history.complete
      ? 100
      : Math.min(99, Math.round(((d.history.phase ?? 0) * 100 + (d.history.progress ?? 0)) / 3))
    : null;

  return (
    <Card className="mb-4">
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <History className="size-4 text-brand-500" /> Conversation history
        </span>
        {d.history ? (
          <>
            <span className="flex items-center gap-2 text-sm text-foreground-muted">
              {d.history.complete ? (
                <>
                  <CheckCircle2 className="size-4 text-success" /> Import complete
                </>
              ) : (
                <>Importing your past conversations…</>
              )}
            </span>
            {pct !== null && !d.history.complete ? (
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-elevated">
                  <span
                    className="block h-full rounded-full bg-brand-500 transition-[width] duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="font-mono text-xs text-foreground-subtle">{pct}%</span>
              </span>
            ) : null}
            <span className="text-xs text-foreground-subtle">
              {d.history.received} batch{d.history.received === 1 ? '' : 'es'} received
              {d.history.lastReceivedAt ? `, last ${formatRelative(d.history.lastReceivedAt)}` : ''}
            </span>
          </>
        ) : (
          <span className="text-sm text-foreground-muted">
            History sharing is on — waiting for WhatsApp to start sending.
          </span>
        )}
        {d.captureEndsAt ? (
          <span className="ml-auto text-xs text-foreground-subtle">
            Learning window ends {new Date(d.captureEndsAt).toLocaleDateString()}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}
