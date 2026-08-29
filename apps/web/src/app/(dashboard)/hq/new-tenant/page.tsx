'use client';

import { ORG_FEATURES, ORG_FEATURE_DEFAULT_DISABLED } from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCheck, Copy } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

interface CreatedTenant {
  organization: { id: string; slug: string; name: string };
  admin: { email: string };
  generatedPassword: string | null;
  welcomeEmailSent: boolean;
}

type PlanCode = 'free' | 'starter' | 'growth' | 'enterprise';
type AiPlan = 'basic' | 'middle' | 'max' | 'ultra';

// Shape returned by GET /billing/plans (subset we render here).
interface BillingPlan {
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
}

const PLAN_ORDER: PlanCode[] = ['free', 'starter', 'growth', 'enterprise'];

// Fallback copy shown while /billing/plans is loading or if a code is missing
// from the API response (keeps the cards from looking empty).
const PLAN_FALLBACK: Record<PlanCode, { name: string; description: string }> = {
  free: { name: 'Free', description: 'For trials and tiny catalogs.' },
  starter: { name: 'Starter', description: 'Small businesses getting going.' },
  growth: { name: 'Growth', description: 'Scaling teams and catalogs.' },
  enterprise: { name: 'Enterprise', description: 'High volume + dedicated support.' },
};

const AI_PLAN_ORDER: AiPlan[] = ['basic', 'middle', 'max', 'ultra'];

const AI_PLAN_META: Record<AiPlan, { label: string; description: string }> = {
  basic: {
    label: 'Basic',
    description: 'Groq Llama 3.3 70B + GPT-4o-mini fallback. Cheap and fast.',
  },
  middle: {
    label: 'Middle',
    description: 'OpenAI GPT-4o. Premium quality at moderate cost.',
  },
  max: {
    label: 'Max',
    description: 'Anthropic Claude Sonnet 4.6. Top-tier reasoning, highest cost.',
  },
  ultra: {
    label: 'Ultra',
    description:
      'Flagship: Claude Haiku 4.5 for intent + per-customer persona memory, Claude Sonnet 4.6 for the grounded reply. Fast, best reasoning, lowest hallucination.',
  },
};

// Format a nullable cap: null = Unlimited, otherwise thousands-separated.
const cap = (n: number | null | undefined) =>
  n == null ? 'Unlimited' : n.toLocaleString();

// Parse a money text field ("" or non-numeric → undefined) so we can send
// undefined for blank optional wallet amounts.
const parseMoney = (s: string): number | undefined => {
  const t = s.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

export default function NewTenantPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { session } = useSession();

  // ----- Organization -----
  const [organizationName, setOrgName] = useState('');
  const [organizationSlug, setOrgSlug] = useState('');
  // Tracks whether the operator has hand-edited the slug; until then we
  // auto-suggest it from the org name.
  const [slugTouched, setSlugTouched] = useState(false);

  // ----- Primary admin -----
  const [adminFirstName, setFirst] = useState('');
  const [adminLastName, setLast] = useState('');
  const [adminEmail, setEmail] = useState('');
  const [adminPassword, setPwd] = useState('');
  const [sendWelcomeEmail, setSendEmail] = useState(true);

  // ----- Subscription plan -----
  const [planCode, setPlanCode] = useState<PlanCode>('free');

  // ----- AI -----
  const [aiPlan, setAiPlan] = useState<AiPlan>('basic');
  // Monthly AI-message allowance (1 message = 1 bot reply / voice turn). Blank =
  // column default (2000). "Unlimited" checkbox sends null.
  const [aiMsgCap, setAiMsgCap] = useState('2000');
  const [aiUnlimited, setAiUnlimited] = useState(false);

  // ----- Features -----
  // Features start enabled; toggling one OFF adds its key here. Opt-in features
  // (e.g. Shopify) start DISABLED so new tenants don't get them by default.
  const [disabledFeatures, setDisabledFeatures] = useState<string[]>([
    ...ORG_FEATURE_DEFAULT_DISABLED,
  ]);

  // ----- WhatsApp wallet -----
  const [walletMeteringEnabled, setWalletMetering] = useState(false);
  const [walletPricePerMessageUsd, setWalletPrice] = useState('0.08');
  const [walletInitialTopUpUsd, setWalletTopUp] = useState('');

  const [created, setCreated] = useState<CreatedTenant | null>(null);

  // Real plan caps for the plan cards (falls back to static copy while loading).
  const plansQ = useQuery({
    queryKey: ['admin-billing-plans'],
    queryFn: () => api.get<{ data: BillingPlan[] }>('/api/v1/billing/plans'),
    staleTime: 5 * 60_000,
  });
  const plansByCode = new Map<string, BillingPlan>(
    (plansQ.data?.data ?? []).map((p) => [p.code, p]),
  );

  function applySlugFromName(name: string) {
    if (slugTouched) return;
    const suggested = name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    setOrgSlug(suggested);
  }

  const create = useMutation({
    mutationFn: () =>
      api.post<{ data: CreatedTenant }>('/api/v1/hq/orgs', {
        organizationName: organizationName.trim(),
        organizationSlug: organizationSlug.trim() || undefined,
        planCode,
        adminFirstName: adminFirstName.trim(),
        adminLastName: adminLastName.trim(),
        adminEmail: adminEmail.trim().toLowerCase(),
        adminPassword: adminPassword.trim() || undefined,
        sendWelcomeEmail,
        disabledFeatures,
        aiPlan,
        // null = Unlimited; blank → null-of-blank sends null too, but the
        // backend treats *omitted* as "column default (2000)". To keep the
        // "blank = default 2000" contract we send undefined when the field is
        // left empty (and not Unlimited).
        monthlyAiMessageCap: aiUnlimited
          ? null
          : aiMsgCap.trim() === ''
            ? undefined
            : Math.max(0, Math.floor(Number(aiMsgCap) || 0)),
        walletMeteringEnabled,
        walletPricePerMessageUsd: parseMoney(walletPricePerMessageUsd),
        walletInitialTopUpUsd: parseMoney(walletInitialTopUpUsd),
      }),
    onSuccess: (res) => {
      setCreated(res.data);
      qc.invalidateQueries({ queryKey: ['admin-orgs'] });
      toast.success(`Created ${res.data.organization.name}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Create failed'),
  });

  // Block render if the operator somehow lands here without admin role.
  // Backend still gates the API; this is just to avoid showing a form
  // that's guaranteed to 403.
  if (!session?.user.isSuperAdmin) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-foreground-muted">Super-admin role required.</p>
        </CardContent>
      </Card>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!organizationName.trim()) return toast.error('Organization name is required.');
    if (!adminFirstName.trim()) return toast.error('First name is required.');
    if (!adminEmail.trim()) return toast.error('Email is required.');
    if (adminPassword.trim() && adminPassword.trim().length < 12) {
      return toast.error('If set, password must be at least 12 characters.');
    }
    const price = parseMoney(walletPricePerMessageUsd);
    if (price != null && price < 0.0375) {
      return toast.error('Per-message price must be at least $0.0375.');
    }
    const topUp = parseMoney(walletInitialTopUpUsd);
    if (topUp != null && topUp < 0) {
      return toast.error('Initial balance cannot be negative.');
    }
    create.mutate();
  };

  return (
    <>
      <PageHeader
        title="New tenant"
        description="Provision an organization on behalf of a customer. Pre-verified — they can log in immediately."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/hq">
              <ArrowLeft className="size-4" /> Back to tenants
            </Link>
          </Button>
        }
      />

      <form onSubmit={submit} className="space-y-6">
        {/* ========== 1. Organization ========== */}
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
            <CardDescription>The workspace your customer will operate.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="org-name">Company name</Label>
              <Input
                id="org-name"
                value={organizationName}
                onChange={(e) => {
                  setOrgName(e.target.value);
                  applySlugFromName(e.target.value);
                }}
                placeholder="Acme Trading LLC"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="org-slug">URL slug</Label>
              <Input
                id="org-slug"
                value={organizationSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  // Server regex only accepts [a-z0-9-]. Sanitize as the
                  // operator types so an upper-case letter / space /
                  // underscore / unicode char can't survive to submit
                  // and trigger a 400 validation error.
                  const cleaned = e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]+/g, '-')
                    .replace(/-{2,}/g, '-');
                  setOrgSlug(cleaned);
                }}
                placeholder="acme-trading-llc"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-foreground-subtle">
                Auto-suggested from the name. Lowercase letters, digits, hyphens. Used as the tenant
                identifier internally.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ========== 2. Primary admin ========== */}
        <Card>
          <CardHeader>
            <CardTitle>Primary admin</CardTitle>
            <CardDescription>
              The login account we&apos;ll create. Email skips verification — they can sign in
              immediately.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="first-name">First name</Label>
              <Input
                id="first-name"
                value={adminFirstName}
                onChange={(e) => setFirst(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="last-name">Last name (optional)</Label>
              <Input id="last-name" value={adminLastName} onChange={(e) => setLast(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={adminEmail}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@acme-trading.com"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password (optional)</Label>
              <Input
                id="password"
                type="text"
                value={adminPassword}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="Leave blank to auto-generate"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-foreground-subtle">
                If blank, we generate a strong 16-character temporary password. The customer is
                emailed it and prompted to change on first login.
              </p>
            </div>
            <div className="lg:col-span-2">
              <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
                <Switch checked={sendWelcomeEmail} onCheckedChange={setSendEmail} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="font-medium">Send welcome email</span>
                  <span className="mt-0.5 block text-xs text-foreground-muted">
                    Delivers the login URL + email + password (if generated) to the customer&apos;s
                    inbox. Turn off only for silent QA imports.
                  </span>
                </span>
              </label>
            </div>
          </CardContent>
        </Card>

        {/* ========== 3. Subscription plan ========== */}
        <Card>
          <CardHeader>
            <CardTitle>Subscription plan</CardTitle>
            <CardDescription>
              Bootstraps a trialing subscription on this plan. Sets the tenant&apos;s hard caps
              (products, services, messages, broadcasts, members, and more).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {PLAN_ORDER.map((code) => {
              const p = plansByCode.get(code);
              const meta = PLAN_FALLBACK[code];
              const selected = planCode === code;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => setPlanCode(code)}
                  aria-pressed={selected}
                  className={cn(
                    'flex flex-col rounded-lg border p-4 text-left transition',
                    selected
                      ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-500 dark:bg-brand-500/10'
                      : 'border-border bg-surface hover:border-brand-300 hover:bg-surface-muted',
                  )}
                >
                  <div className="text-sm font-semibold">{p?.name ?? meta.name}</div>
                  <p className="mt-1 text-[11px] leading-snug text-foreground-muted">
                    {p?.description ?? meta.description}
                  </p>
                  <dl className="mt-3 space-y-1 text-[11px] text-foreground-subtle">
                    <PlanLine label="Products" value={cap(p?.productCap)} />
                    <PlanLine label="Services" value={cap(p?.serviceCap)} />
                    <PlanLine label="Messages / mo" value={cap(p?.monthlyMessageCap)} />
                    <PlanLine label="Broadcasts / mo" value={cap(p?.monthlyBroadcastCap)} />
                    <PlanLine label="Imports / mo" value={cap(p?.monthlyImportCap)} />
                    <PlanLine label="Members" value={cap(p?.memberCap)} />
                    <PlanLine label="API keys" value={cap(p?.apiKeyCap)} />
                    <PlanLine label="Webhooks" value={cap(p?.webhookCap)} />
                  </dl>
                </button>
              );
            })}
          </CardContent>
        </Card>

        {/* ========== 4. AI ========== */}
        <Card>
          <CardHeader>
            <CardTitle>AI</CardTitle>
            <CardDescription>
              Choose the model tier for the bot&apos;s replies. Higher tiers reason better and
              hallucinate less, but cost more per message.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {AI_PLAN_ORDER.map((tier) => {
                const meta = AI_PLAN_META[tier];
                const selected = aiPlan === tier;
                return (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => setAiPlan(tier)}
                    aria-pressed={selected}
                    className={cn(
                      'flex flex-col rounded-lg border p-4 text-left transition',
                      selected
                        ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-500 dark:bg-brand-500/10'
                        : 'border-border bg-surface hover:border-brand-300 hover:bg-surface-muted',
                    )}
                  >
                    <div className="text-sm font-semibold">{meta.label}</div>
                    <p className="mt-1 text-[11px] leading-snug text-foreground-muted">
                      {meta.description}
                    </p>
                  </button>
                );
              })}
            </div>

            <div className="rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="ai-msg-cap">Monthly AI messages</Label>
                  <Input
                    id="ai-msg-cap"
                    type="number"
                    min={0}
                    value={aiMsgCap}
                    onChange={(e) => setAiMsgCap(e.target.value)}
                    placeholder="2000"
                    disabled={aiUnlimited}
                    className="w-40"
                  />
                </div>
                <label className="flex h-10 items-center gap-2 text-sm">
                  <Switch checked={aiUnlimited} onCheckedChange={setAiUnlimited} />
                  <span className="font-medium">Unlimited</span>
                </label>
              </div>
              <p className="mt-2 text-[11px] text-foreground-subtle">
                1 AI message = 1 bot reply or voice turn. Blank uses the default of 2,000. When the
                allowance is used up, the bot pauses until the 1st of next month.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ========== 5. Features ========== */}
        <Card>
          <CardHeader>
            <CardTitle>Features</CardTitle>
            <CardDescription>
              ON = the tenant has access. Opt-in features (e.g. Shopify) start OFF. You can change
              any of these later from the tenant&apos;s detail page.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {ORG_FEATURES.map((f) => {
              const enabled = !disabledFeatures.includes(f.key);
              return (
                <div
                  key={f.key}
                  className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"
                >
                  <Switch
                    checked={enabled}
                    onCheckedChange={(on) =>
                      setDisabledFeatures((prev) =>
                        on
                          ? prev.filter((k) => k !== f.key)
                          : [...new Set([...prev, f.key])],
                      )
                    }
                    className="mt-0.5"
                    aria-label={f.label}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{f.label}</span>
                    <span className="mt-0.5 block text-xs text-foreground-muted">
                      {f.description}
                    </span>
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* ========== 6. WhatsApp wallet ========== */}
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp wallet</CardTitle>
            <CardDescription>
              Metered billing charges the tenant per WhatsApp message sent. Off by default so sends
              aren&apos;t gated.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
              <Switch
                checked={walletMeteringEnabled}
                onCheckedChange={setWalletMetering}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="font-medium">Enable metered billing</span>
                <span className="mt-0.5 block text-xs text-foreground-muted">
                  When ON, each WhatsApp message the tenant sends draws down their wallet balance at
                  the per-message price below.
                </span>
              </span>
            </label>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wallet-price">Per-message price (USD)</Label>
                <Input
                  id="wallet-price"
                  type="text"
                  inputMode="decimal"
                  value={walletPricePerMessageUsd}
                  onChange={(e) => setWalletPrice(e.target.value)}
                  placeholder="0.08"
                  className="font-mono"
                />
                <p className="text-[11px] text-foreground-subtle">
                  Charged per message sent. Minimum $0.0375. Default $0.08.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wallet-topup">Initial balance / top-up (USD, optional)</Label>
                <Input
                  id="wallet-topup"
                  type="text"
                  inputMode="decimal"
                  value={walletInitialTopUpUsd}
                  onChange={(e) => setWalletTopUp(e.target.value)}
                  placeholder="0.00"
                  className="font-mono"
                />
                <p className="text-[11px] text-foreground-subtle">
                  Adding a starting balance turns metering ON automatically.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" asChild>
            <Link href="/hq">Cancel</Link>
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create tenant
          </Button>
        </div>
      </form>

      {/* Once the tenant exists we show this modal with the generated
          password so the operator can copy it (the welcome email already
          has it, but a copy in the UI is friendlier for verbal handoff). */}
      <Dialog
        open={Boolean(created)}
        onOpenChange={(open) => {
          if (!open) {
            const slug = created?.organization.slug;
            setCreated(null);
            // Reset form state. Navigating back to the admin list is the
            // usual next step.
            setOrgName('');
            setOrgSlug('');
            setSlugTouched(false);
            setFirst('');
            setLast('');
            setEmail('');
            setPwd('');
            setSendEmail(true);
            setPlanCode('free');
            setAiPlan('basic');
            setAiMsgCap('2000');
            setAiUnlimited(false);
            setDisabledFeatures([...ORG_FEATURE_DEFAULT_DISABLED]);
            setWalletMetering(false);
            setWalletPrice('0.08');
            setWalletTopUp('');
            if (slug) router.push('/hq');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Tenant ready</DialogTitle>
          </DialogHeader>
          {created ? (
            <div className="space-y-3 text-sm">
              <p>
                <strong>{created.organization.name}</strong> is live. Slug:{' '}
                <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                  {created.organization.slug}
                </code>
              </p>
              <div className="rounded-lg border border-border bg-surface-muted px-3 py-2.5 font-mono text-xs">
                <div>
                  <span className="text-foreground-muted">Email:</span> {created.admin.email}
                </div>
                {created.generatedPassword ? (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-foreground-muted">Pass:</span>
                    <code className="break-all">{created.generatedPassword}</code>
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label="Copy password"
                      onClick={() => {
                        navigator.clipboard.writeText(created.generatedPassword ?? '');
                        toast.success('Password copied');
                      }}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="mt-1 text-foreground-muted">
                    Password: <em>set by you above</em>
                  </div>
                )}
              </div>
              {created.welcomeEmailSent ? (
                <p className="flex items-center gap-1.5 text-[12px] text-emerald-600">
                  <ClipboardCheck className="size-3.5" /> Welcome email sent to{' '}
                  {created.admin.email}.
                </p>
              ) : (
                <p className="text-[12px] text-amber-600">
                  Welcome email skipped — share the credentials manually.
                </p>
              )}
              <p className="text-[11px] text-foreground-subtle">
                This password is shown <strong>once</strong>. After closing this dialog you can
                still reset it from the tenant&apos;s detail page if needed.
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

// A single "Label: value" row inside a plan card.
function PlanLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="tabular-nums font-medium text-foreground">{value}</dd>
    </div>
  );
}
