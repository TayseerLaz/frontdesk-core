'use client';

// Phase 8 / 1.4 — super-admin cross-tenant provenance browser.
//
// Lists every persisted bot-reply provenance row across all tenants.
// Filters: organization, flagged-only toggle, date range, cursor
// pagination. Click a row to inline-expand the full 4-tab panel using
// the same component that powers /inbox.

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Filter, MessageCircle, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

interface ProvenanceRow {
  provenanceId: string;
  messageId: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  messageBody: string | null;
  messageType: string | null;
  threadId: string | null;
  createdAt: string;
  hallucinationCount: number;
  citationCount: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
}

// Detail payload — same shape as the /inbox endpoint serves.
interface MessageProvenance {
  messageId: string;
  organizationId: string;
  systemPrompt: { sha256: string; body: string };
  userPrompt: string;
  historyJson: { role: 'user' | 'assistant'; content: string }[];
  candidates: {
    products: { id: string; name: string; sku: string; priceMinor: number | null; currency: string | null }[];
    services: { id: string; name: string; basePriceMinor: number | null; currency: string | null }[];
    faqs: { id: string; question: string; answer: string }[];
    policyKinds: string[];
    businessInfoFields: string[];
  };
  citations:
    | {
        type:
          | 'product'
          | 'service'
          | 'faq'
          | 'policy'
          | 'business_info'
          | 'bot_config'
          | 'customer_profile';
        id: string | null;
        label: string;
        snippet: string;
        confidence: number;
        meta?: Record<string, unknown> | null;
      }[]
    | null;
  hallucinations:
    | {
        type: 'unknown_product' | 'price_drift' | 'unknown_business_info';
        matchedText: string;
        context: string;
        severity: 'critical' | 'warning';
        reason: string;
      }[]
    | null;
  model: string;
  temperature: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  createdAt: string;
}

export default function PlatformAdminProvenancePage() {
  const { session } = useSession();
  const [organizationId, setOrganizationId] = useState<string | 'all'>('all');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [since, setSince] = useState<string>('');
  const [until, setUntil] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const orgsQ = useQuery({
    queryKey: ['hq-orgs-min'],
    queryFn: () =>
      api.get<{ data: OrgRow[] }>('/api/v1/hq/orgs?status=active'),
    enabled: session?.user.isSuperAdmin === true,
    staleTime: 60_000,
  });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (organizationId !== 'all') p.set('organizationId', organizationId);
    if (flaggedOnly) p.set('flagged', 'true');
    if (since) p.set('since', new Date(since).toISOString());
    if (until) p.set('until', new Date(until).toISOString());
    p.set('take', '50');
    return p;
  }, [organizationId, flaggedOnly, since, until]);

  const provQ = useQuery({
    queryKey: ['hq-provenance', params.toString()],
    queryFn: () =>
      api.get<{ data: ProvenanceRow[]; nextCursor: string | null }>(
        `/api/v1/hq/provenance?${params.toString()}`,
      ),
    enabled: session?.user.isSuperAdmin === true,
    refetchInterval: 30_000,
  });

  if (!session?.user.isSuperAdmin) {
    return (
      <>
        <PageHeader backHref="/hq" backLabel="Tenants" title="AI provenance" />
        <Card>
          <CardContent className="p-6 text-sm text-foreground-muted">
            Super-admin role required.
          </CardContent>
        </Card>
      </>
    );
  }

  const rows = provQ.data?.data ?? [];
  const orgs = orgsQ.data?.data ?? [];

  return (
    <>
      <PageHeader
        backHref="/hq"
        backLabel="Tenants"
        title="AI provenance"
        description="Every persisted bot reply, across all tenants. Click a row to inline-expand its full audit trail."
      />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="size-4" /> Filters
          </CardTitle>
          <CardDescription className="text-xs">
            Drill into a specific tenant, time window, or just the flagged replies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Tenant
              </label>
              <Select value={organizationId} onValueChange={(v) => setOrganizationId(v)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="All tenants" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tenants</SelectItem>
                  {orgs.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Flag state
              </label>
              <Button
                type="button"
                variant={flaggedOnly ? 'danger' : 'secondary'}
                size="sm"
                className="h-8 w-full justify-start gap-2"
                onClick={() => setFlaggedOnly((v) => !v)}
              >
                <AlertTriangle className="size-3.5" />
                {flaggedOnly ? 'Flagged only' : 'All replies'}
              </Button>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Since
              </label>
              <Input
                type="datetime-local"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                Until
              </label>
              <Input
                type="datetime-local"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="size-4" />
            {provQ.isLoading ? (
              <Skeleton className="h-4 w-24" />
            ) : (
              `${rows.length} repl${rows.length === 1 ? 'y' : 'ies'}`
            )}
            {provQ.data?.nextCursor ? (
              <Badge variant="muted" className="text-[10px]">
                more available
              </Badge>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {provQ.error ? (
            <p className="text-sm text-rose-700">
              {provQ.error instanceof ApiError
                ? provQ.error.payload.message
                : 'Failed to load.'}
            </p>
          ) : rows.length === 0 && !provQ.isLoading ? (
            <p className="text-sm text-foreground-muted">
              No provenance rows match these filters yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => (
                <ProvenanceRowItem
                  key={r.provenanceId}
                  row={r}
                  expanded={expandedId === r.provenanceId}
                  onToggle={() =>
                    setExpandedId((v) => (v === r.provenanceId ? null : r.provenanceId))
                  }
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ProvenanceRowItem({
  row,
  expanded,
  onToggle,
}: {
  row: ProvenanceRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const flagged = row.hallucinationCount > 0;
  const detailQ = useQuery({
    queryKey: ['provenance', row.messageId],
    queryFn: () =>
      api.get<{ data: MessageProvenance }>(
        `/api/v1/inbox/messages/${row.messageId}/provenance`,
      ),
    enabled: expanded,
    staleTime: 60_000,
  });
  return (
    <li
      className={
        'rounded-md border ' +
        (flagged ? 'border-rose-200 bg-rose-50/40' : 'border-border bg-surface')
      }
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-col items-stretch gap-1 px-3 py-2 text-left hover:bg-surface-muted/40"
      >
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="flex items-center gap-2">
            <Badge variant="muted" className="text-[10px]">
              {row.organizationName}
            </Badge>
            {flagged ? (
              <Badge variant="danger" className="gap-1 text-[10px]">
                <AlertTriangle className="size-3" /> {row.hallucinationCount}
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Sparkles className="size-3" /> {row.citationCount} cites
              </Badge>
            )}
            <span className="text-foreground-subtle">
              {row.model} · {row.promptTokens + row.completionTokens} tok · {row.latencyMs} ms
            </span>
          </span>
          <span className="whitespace-nowrap text-[10px] text-foreground-subtle">
            {new Date(row.createdAt).toLocaleString()}
          </span>
        </div>
        <p className="line-clamp-2 break-words text-sm text-foreground">
          {row.messageBody ?? (
            <em className="text-foreground-subtle">[{row.messageType ?? 'media'}]</em>
          )}
        </p>
        {row.threadId ? (
          <Link
            href={`/inbox?thread=${row.threadId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-brand-600 hover:underline"
          >
            View thread →
          </Link>
        ) : null}
      </button>
      {expanded ? (
        <div className="border-t border-border bg-surface-muted/30 px-3 py-2 text-xs">
          {detailQ.isLoading ? (
            <div className="space-y-2 py-1">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          ) : detailQ.error || !detailQ.data?.data ? (
            <p className="text-foreground-muted">Could not load details.</p>
          ) : (
            <InlineProvenanceDetail p={detailQ.data.data} />
          )}
        </div>
      ) : null}
    </li>
  );
}

// Compact rendering of the same data /inbox shows in its 4-tab drawer. We
// inline it here (rather than reusing the /inbox component) so the admin
// browser can render multiple expansions side-by-side without prop drilling.
function InlineProvenanceDetail({ p }: { p: MessageProvenance }) {
  const cits = p.citations ?? [];
  const hals = p.hallucinations ?? [];
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Section title={`Sources (${cits.length})`}>
        {cits.length === 0 ? (
          <p className="text-foreground-muted">No source matched the reply text.</p>
        ) : (
          <ul className="space-y-1.5">
            {cits.slice(0, 8).map((c, i) => (
              <li key={i} className="rounded border border-border bg-surface px-2 py-1">
                <div className="font-medium">
                  <SourceTypeBadge t={c.type} /> {c.label}
                </div>
                <p className="mt-0.5 text-[11px] italic text-foreground-muted">
                  "{c.snippet}"
                </p>
              </li>
            ))}
            {cits.length > 8 ? (
              <li className="text-[10px] text-foreground-subtle">
                +{cits.length - 8} more
              </li>
            ) : null}
          </ul>
        )}
      </Section>
      <Section title={`Hallucinations (${hals.length})`} accent={hals.length > 0 ? 'rose' : undefined}>
        {hals.length === 0 ? (
          <p className="text-emerald-700">✓ Nothing flagged.</p>
        ) : (
          <ul className="space-y-1.5">
            {hals.map((h, i) => (
              <li
                key={i}
                className={
                  'rounded border px-2 py-1 ' +
                  (h.severity === 'critical'
                    ? 'border-rose-300 bg-rose-50'
                    : 'border-amber-300 bg-amber-50')
                }
              >
                <div className="font-medium">
                  <span
                    className={
                      'mr-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white ' +
                      (h.severity === 'critical' ? 'bg-rose-500' : 'bg-amber-500')
                    }
                  >
                    {h.severity}
                  </span>
                  {h.matchedText}
                </div>
                <p className="mt-0.5 text-[11px] italic text-foreground-muted">
                  "{h.context}"
                </p>
                <p className="mt-0.5 text-[11px] text-foreground">{h.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
  accent,
}: {
  title: string;
  children: React.ReactNode;
  accent?: 'rose';
}) {
  return (
    <div
      className={
        'rounded-md border bg-surface px-3 py-2 ' +
        (accent === 'rose' ? 'border-rose-300' : 'border-border')
      }
    >
      <h4
        className={
          'mb-1.5 text-[11px] font-semibold uppercase tracking-wide ' +
          (accent === 'rose' ? 'text-rose-700' : 'text-foreground-muted')
        }
      >
        {title}
      </h4>
      {children}
    </div>
  );
}

function SourceTypeBadge({
  t,
}: {
  t:
    | 'product'
    | 'service'
    | 'faq'
    | 'policy'
    | 'business_info'
    | 'bot_config'
    | 'customer_profile';
}) {
  const colours: Record<typeof t, string> = {
    product: 'bg-emerald-100 text-emerald-700',
    service: 'bg-sky-100 text-sky-700',
    faq: 'bg-violet-100 text-violet-700',
    policy: 'bg-amber-100 text-amber-700',
    business_info: 'bg-slate-100 text-slate-700',
    bot_config: 'bg-fuchsia-100 text-fuchsia-700',
    customer_profile: 'bg-indigo-100 text-indigo-700',
  };
  return (
    <span
      className={
        'mr-1 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ' +
        colours[t]
      }
    >
      {t}
    </span>
  );
}

