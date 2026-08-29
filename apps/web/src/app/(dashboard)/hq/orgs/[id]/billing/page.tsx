'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Cpu, HardDrive, Mic, Send, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Overview {
  org: {
    id: string;
    name: string;
    slug: string;
    status: string;
    aiPlan: string;
    monthlyPaidUsd: number | null;
    createdAt: string;
    disabledFeatures: string[];
  };
  range: { from: string; to: string };
  ai: { tokens: number; costUsd: number; byModel: { model: string; tokens: number; usd: number }[] };
  transcription: { enabled: boolean; count: number; voiceNotesTotal: number; costUsd: number };
  storage: { totalBytes: number; objectCount: number; addedBytes: number; monthlyCostUsd: number };
  whatsapp: {
    numbers: number;
    broadcasts: number;
    broadcastMessages: number;
    billableConversations: number;
    outboundMessages: number;
    inboundMessages: number;
    costUsd: number;
  };
  counts: { members: number; products: number; services: number; contacts: number };
  totals: { estimatedCostUsd: number; monthlyPaidUsd: number | null };
}

type RangePreset = 'day' | 'week' | 'month' | 'custom';

function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function bytesHuman(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

export default function OrgBillingPage() {
  const { id } = useParams<{ id: string }>();
  const { session } = useSession();
  const queryClient = useQueryClient();

  const [preset, setPreset] = useState<RangePreset>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Resolve the preset into ISO from/to. day/week/month are rolling windows.
  const { from, to } = useMemo(() => {
    const now = new Date();
    if (preset === 'custom' && customFrom && customTo) {
      return {
        from: new Date(`${customFrom}T00:00:00`).toISOString(),
        to: new Date(`${customTo}T23:59:59`).toISOString(),
      };
    }
    const days = preset === 'day' ? 1 : preset === 'week' ? 7 : 30;
    return { from: new Date(now.getTime() - days * 86400000).toISOString(), to: now.toISOString() };
  }, [preset, customFrom, customTo]);

  const overviewQ = useQuery({
    queryKey: ['admin-overview', id, from, to],
    queryFn: () => {
      const p = new URLSearchParams({ from, to });
      return api.get<{ data: Overview }>(`/api/v1/hq/orgs/${id}/overview?${p}`).then((r) => r.data);
    },
    enabled: !!id && !!session?.user.isSuperAdmin,
    placeholderData: (prev) => prev,
  });
  const o = overviewQ.data;

  const [amount, setAmount] = useState<string | null>(null);
  const savePay = useMutation({
    mutationFn: (v: number | null) =>
      api.patch(`/api/v1/hq/orgs/${id}/billing`, { monthlyPaidUsd: v }),
    onSuccess: () => {
      toast.success('Monthly payment saved');
      queryClient.invalidateQueries({ queryKey: ['admin-overview', id] });
      queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
    },
    onError: () => toast.error('Could not save'),
  });

  if (!session?.user.isSuperAdmin) {
    return <div className="p-6 text-foreground-muted">Super-admins only.</div>;
  }

  const payValue = amount ?? (o?.org.monthlyPaidUsd != null ? String(o.org.monthlyPaidUsd) : '');
  const rangeLabel = o
    ? `${new Date(o.range.from).toLocaleDateString()} – ${new Date(o.range.to).toLocaleDateString()}`
    : '';

  return (
    <>
      <PageHeader
        title={o ? `Billing & overview — ${o.org.name}` : 'Billing & overview'}
        description="Everything this tenant costs us, for the selected period."
      />
      <div className="space-y-5 p-1">
        <Link
          href="/hq"
          className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to all tenants
        </Link>

        {/* Time-range selector */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            {(
              [
                ['day', 'Day'],
                ['week', 'Week'],
                ['month', 'Month'],
                ['custom', 'Custom'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setPreset(v)}
                className={`rounded px-3 py-1 text-sm ${
                  preset === v
                    ? 'bg-primary text-primary-foreground'
                    : 'text-foreground-muted hover:bg-surface-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {preset === 'custom' ? (
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 w-auto text-sm"
              />
              <span className="text-foreground-subtle">→</span>
              <Input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 w-auto text-sm"
              />
            </div>
          ) : (
            <span className="text-sm text-foreground-subtle">{rangeLabel}</span>
          )}
        </div>

        {overviewQ.isLoading || !o ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        ) : (
          <>
            {/* Headline: estimated cost vs what they pay */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                icon={<Wallet className="size-4" />}
                label="Estimated cost (this period)"
                value={usd(o.totals.estimatedCostUsd)}
                hint="AI + transcription + WhatsApp + storage/mo"
                accent
              />
              <StatCard
                icon={<Cpu className="size-4" />}
                label="AI cost"
                value={usd(o.ai.costUsd)}
                hint={`${o.ai.tokens.toLocaleString()} tokens`}
              />
              <StatCard
                icon={<Send className="size-4" />}
                label="WhatsApp messaging"
                value={usd(o.whatsapp.costUsd)}
                hint={`${o.whatsapp.billableConversations.toLocaleString()} billable conversations (24h)`}
              />
              <StatCard
                icon={<HardDrive className="size-4" />}
                label="Storage / month"
                value={usd(o.storage.monthlyCostUsd)}
                hint={`${bytesHuman(o.storage.totalBytes)} • ${o.storage.objectCount.toLocaleString()} files`}
              />
            </div>

            {/* Monthly payment editor */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">What this tenant pays</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="mb-1 block text-xs text-foreground-muted">
                    Monthly payment (USD)
                  </label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="e.g. 50"
                    value={payValue}
                    onChange={(e) => setAmount(e.target.value)}
                    className="h-9 w-40"
                  />
                </div>
                <Button
                  onClick={() => savePay.mutate(payValue === '' ? null : Number(payValue))}
                  disabled={savePay.isPending}
                >
                  Save
                </Button>
                <div className="ml-auto text-sm text-foreground-muted">
                  Plan: <span className="font-medium capitalize">{o.org.aiPlan}</span>
                  {' · '}
                  Member since {new Date(o.org.createdAt).toLocaleDateString()}
                </div>
              </CardContent>
            </Card>

            {/* AI cost by model */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Cpu className="size-4" /> AI usage by model
                </CardTitle>
              </CardHeader>
              <CardContent>
                {o.ai.byModel.length === 0 ? (
                  <p className="text-sm text-foreground-subtle">No AI activity in this period.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-foreground-subtle">
                        <th className="pb-1 font-medium">Model</th>
                        <th className="pb-1 text-right font-medium">Tokens</th>
                        <th className="pb-1 text-right font-medium">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.ai.byModel.map((m) => (
                        <tr key={m.model} className="border-t border-border/50">
                          <td className="py-1 font-mono text-xs">{m.model}</td>
                          <td className="py-1 text-right tabular-nums">{m.tokens.toLocaleString()}</td>
                          <td className="py-1 text-right tabular-nums">{usd(m.usd)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-border font-medium">
                        <td className="py-1">Total</td>
                        <td className="py-1 text-right tabular-nums">{o.ai.tokens.toLocaleString()}</td>
                        <td className="py-1 text-right tabular-nums">{usd(o.ai.costUsd)}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* Voice transcription + WhatsApp + counts */}
            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Mic className="size-4" /> Voice transcription
                    {o.transcription.enabled ? (
                      <Badge variant="success" className="text-[11px]">On</Badge>
                    ) : (
                      <Badge variant="muted" className="text-[11px]">Off</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  <Row label="Transcribed notes" value={o.transcription.count.toLocaleString()} />
                  <Row label="Voice notes total" value={o.transcription.voiceNotesTotal.toLocaleString()} />
                  <Row label="Est. cost" value={usd(o.transcription.costUsd)} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Send className="size-4" /> WhatsApp & broadcasts
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  <Row label="Connected numbers" value={String(o.whatsapp.numbers)} />
                  <Row label="Broadcasts sent" value={o.whatsapp.broadcasts.toLocaleString()} />
                  <Row label="Template messages" value={o.whatsapp.broadcastMessages.toLocaleString()} />
                  <Row
                    label="Billable conversations (24h)"
                    value={o.whatsapp.billableConversations.toLocaleString()}
                  />
                  <Row label="Outbound (free)" value={o.whatsapp.outboundMessages.toLocaleString()} />
                  <Row label="Inbound (free)" value={o.whatsapp.inboundMessages.toLocaleString()} />
                  <Row label="Est. messaging cost" value={usd(o.whatsapp.costUsd)} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Account</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-sm">
                  <Row label="Members" value={String(o.counts.members)} />
                  <Row label="Products" value={o.counts.products.toLocaleString()} />
                  <Row label="Services" value={o.counts.services.toLocaleString()} />
                  <Row label="Contacts" value={o.counts.contacts.toLocaleString()} />
                  <Row label="Storage added (period)" value={bytesHuman(o.storage.addedBytes)} />
                </CardContent>
              </Card>
            </div>

            <p className="text-xs text-foreground-subtle">
              AI cost is exact (per-model token pricing). WhatsApp cost follows Meta&apos;s
              conversation model: a template opens a 24-hour conversation per user (billed once);
              every message inside that window and all inbound messages are free — so we price the
              count of billable conversations, not raw message volume. Transcription, WhatsApp and
              storage use configured estimate rates. Storage cost is monthly (a snapshot of all
              files), not period-scoped.
            </p>
          </>
        )}
      </div>
    </>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card className={accent ? 'border-primary/40 bg-primary/5' : undefined}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-foreground-muted">
          {icon}
          {label}
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {hint ? <div className="mt-0.5 text-xs text-foreground-subtle">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 py-1 last:border-0">
      <span className="text-foreground-subtle">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
