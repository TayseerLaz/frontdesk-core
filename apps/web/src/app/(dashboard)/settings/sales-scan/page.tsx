'use client';

/**
 * Sales Scan — "Teach the bot with your own data".
 *
 * Renders every state of the feature from one status endpoint:
 *   locked        → the tenant does not have it; show the upgrade prompt
 *   coming soon   → activated, but the capture backend is not deployed yet
 *   idle          → activated + available; show consent + start
 *   capturing     → linked; show days remaining
 *   done          → window closed; show the summary
 *
 * The route IS bounced for tenants without the feature (`sales_scan` lists this href,
 * so isHrefDisabled hides the card and (dashboard)/layout.tsx redirects). Keep the
 * `locked` branch anyway — the bounce is a client-side useEffect that runs AFTER mount,
 * so this page paints once on a direct URL hit. That branch is also the only guard
 * against `data` being undefined: every branch below it dereferences `data` directly,
 * so deleting it turns any failed status fetch into a TypeError.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, GraduationCap, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, getAccessToken } from '@/lib/api';
import { useSession } from '@/lib/session';

type Grant = {
  id: string;
  status: 'pending' | 'linking' | 'active' | 'completed' | 'revoked' | 'expired' | 'failed';
  phoneE164: string | null;
  windowDays: number;
  grantedAt: string;
  grantExpiresAt: string;
  linkedAt: string | null;
  captureEndsAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  messageCount: number;
  consentVersion: string;
  daysRemaining: number | null;
};

type Status = {
  featureEnabled: boolean;
  ingestAvailable: boolean;
  grant: Grant | null;
  qr: string | null;
  /** Operator-only marker. Deliberately NOT surfaced in tenant-facing copy. */
  isPreview?: boolean;
  pairingCode: string | null;
  hasSummary: boolean;
  consent: { version: string; text: string };
  limits: { minWindowDays: number; maxWindowDays: number; defaultWindowDays: number };
};

type Summary = {
  id: string;
  grantId: string;
  status: string;
  messagesAnalyzed: number;
  generatedAt: string;
  payload: {
    headline: string;
    voiceProfile: {
      tone: string;
      formality: string;
      languages: string[];
      greetings: string[];
      signOffs: string[];
      habits: string[];
    };
    topQuestions: { question: string; count: number; bestAnswer: string | null }[];
    stats: {
      messagesAnalyzed: number;
      inbound: number;
      outbound: number;
      conversations: number;
      medianReplyMinutes: number | null;
    };
  };
};

const LIVE: Grant['status'][] = ['pending', 'linking', 'active'];

/**
 * Download the captured corpus as CSV.
 *
 * The endpoint is JWT-authed and admin-only, so it cannot be a plain <a href> — we fetch
 * with the bearer token and hand the blob to a synthetic anchor (same pattern as the
 * import errors CSV). The file contains the tenant's customers' phone numbers and
 * verbatim messages, which is why the button is only rendered for org admins.
 */
async function downloadCsv() {
  const url = `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/sales-scan/export.csv`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
    credentials: 'include',
  });
  if (!res.ok) {
    toast.error(`Download failed (${res.status})`);
    return;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sales-scan-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-muted/30 p-3">
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-xs text-foreground-muted">{label}</p>
    </div>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="text-xs font-medium text-foreground-muted">{label}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {items.map((t, i) => (
          <span key={i} className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function SalesScanPage() {
  const qc = useQueryClient();
  const { session } = useSession();
  // The export carries third-party phone numbers, so the API gates it at admin. Mirror
  // that here rather than showing every seat a button that 403s.
  const isOrgAdmin = session?.organization?.role === 'admin';
  const [authority, setAuthority] = useState(false);
  const [banRisk, setBanRisk] = useState(false);
  const [controllerDuty, setControllerDuty] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['sales-scan', 'status'],
    queryFn: () => api.get<{ data: Status }>('/api/v1/sales-scan/status').then((r) => r.data),
    // While a QR is on screen it rotates every ~20s, so poll briskly then back off.
    refetchInterval: (q) => {
      const s = q.state.data as Status | undefined;
      if (!s?.grant) return false;
      if (s.grant.status === 'linking' || s.grant.status === 'pending') return 3_000;
      if (s.grant.status === 'active') return 60_000;
      return false;
    },
  });

  const connect = useMutation({
    mutationFn: () =>
      api.post('/api/v1/sales-scan/connect', {
        windowDays: data?.limits.defaultWindowDays ?? 7,
        consentVersion: data?.consent.version,
        acknowledgedAuthority: true,
        acknowledgedBanRisk: true,
        acknowledgedControllerDuty: true,
      }),
    onSuccess: () => {
      toast.success('Scan started. Scan the code with the phone that owns the number.');
      void qc.invalidateQueries({ queryKey: ['sales-scan'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not start the scan.'),
  });

  const stop = useMutation({
    mutationFn: () => api.delete('/api/v1/sales-scan/grant'),
    onSuccess: () => {
      toast.success('Capture stopped.');
      void qc.invalidateQueries({ queryKey: ['sales-scan'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not stop the scan.'),
  });

  const wipe = useMutation({
    mutationFn: () => api.delete<{ data: { deleted: number } }>('/api/v1/sales-scan/messages'),
    onSuccess: (res) => {
      toast.success(`Deleted ${res.data.deleted} captured message(s).`);
      void qc.invalidateQueries({ queryKey: ['sales-scan'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.payload.message : 'Could not delete the data.'),
  });

  async function confirmStop() {
    const ok = await confirmDialog({
      title: 'Stop capturing?',
      body:
        'We will disconnect from your WhatsApp number and stop reading new messages. ' +
        'This does NOT delete what we already captured — use "Delete captured data" for that.',
      confirmLabel: 'Stop capturing',
    });
    if (ok) stop.mutate();
  }

  async function confirmWipe() {
    const ok = await confirmDialog({
      title: 'Delete everything we captured?',
      body:
        'Every message captured from your sales number will be deleted from our live systems immediately. ' +
        'Encrypted backups age out within 30 days. This cannot be undone.',
      confirmLabel: 'Delete captured data',
      destructive: true,
      requireText: 'delete',
    });
    if (ok) wipe.mutate();
  }

  const grant = data?.grant ?? null;
  const isLive = !!grant && LIVE.includes(grant.status);
  const consentComplete = authority && banRisk && controllerDuty;

  // Only offered when there is actually something to download, so a first-time tenant
  // isn't handed an empty file.
  const csvButton =
    isOrgAdmin && (grant?.messageCount ?? 0) > 0 ? (
      <Button variant="outline" onClick={() => void downloadCsv()}>
        <Download className="size-4" /> Download CSV
      </Button>
    ) : null;

  // Only fetched once a window has actually produced a report.
  const { data: summary } = useQuery({
    queryKey: ['sales-scan', 'summary'],
    queryFn: () =>
      api.get<{ data: Summary }>('/api/v1/sales-scan/summary').then((r) => r.data),
    enabled: !!data?.hasSummary && !isLive,
  });

  return (
    <>
      <PageHeader
        title="Teach the bot with your own data"
        description="Connect the sales number you already use. We read one week of your real conversations, then show you a summary and how your team talks."
      />

      {isLoading ? (
        <Card>
          <CardContent className="space-y-3 py-6">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
      ) : !data?.featureEnabled ? (
        /* LOCKED — the pre-bounce paint on a direct URL hit, and the `data === undefined`
           fallback when the status fetch fails. Not normally reachable via the UI. */
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4" /> Not enabled for your account
            </CardTitle>
            <CardDescription>
              This feature is offered separately from your plan.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-foreground-muted">
            <p>
              Once enabled, you can connect the WhatsApp number your team already uses for sales. We
              read one week of those conversations and give you back a summary of what customers keep
              asking, plus an analysis of how your team writes — so the bot can sound like you.
            </p>
            <p className="font-medium text-foreground">Contact admin to upgrade this feature.</p>
          </CardContent>
        </Card>
      ) : !data.ingestAvailable ? (
        /* Activated, but the capture service is not deployed. Never show a QR that
           cannot appear — say so plainly instead. */
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-brand-500" /> Activated — scanning goes live soon
            </CardTitle>
            <CardDescription>Your account has this feature switched on.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-foreground-muted">
            WhatsApp scanning is being finished off. We&apos;ll let you know the moment you can
            connect your number — nothing is needed from you yet.
          </CardContent>
        </Card>
      ) : isLive ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-brand-500" />
              {grant!.status === 'active' ? 'Recording your messages' : 'Waiting for you to scan'}
            </CardTitle>
            <CardDescription>
              {grant!.status === 'active'
                ? `Recording messages for ${grant!.windowDays} days — ${grant!.daysRemaining ?? 0} day(s) remaining. We'll show your summary when the week is up.`
                : 'Open WhatsApp on the phone that owns this number → Settings → Linked devices → Link a device.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.qr ? (
              <div className="flex flex-col items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={data.qr} alt="WhatsApp linking QR code" className="size-64 rounded-lg border border-border" />
                <p className="text-xs text-foreground-muted">This code refreshes every few seconds.</p>
              </div>
            ) : data.pairingCode ? (
              <p className="text-center font-mono text-2xl tracking-widest">{data.pairingCode}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={confirmStop} disabled={stop.isPending}>
                Stop capturing
              </Button>
              <Button variant="outline" onClick={confirmWipe} disabled={wipe.isPending}>
                Delete captured data
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : summary ? (
        /* DONE — the report this feature exists to produce. */
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GraduationCap className="size-4 text-brand-500" /> What we learned
              </CardTitle>
              <CardDescription>
                From {summary.messagesAnalyzed.toLocaleString()} message(s) ·{' '}
                {new Date(summary.generatedAt).toLocaleDateString()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm">{summary.payload.headline}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Conversations" value={summary.payload.stats.conversations.toLocaleString()} />
                <Stat label="They received" value={summary.payload.stats.inbound.toLocaleString()} />
                <Stat label="They sent" value={summary.payload.stats.outbound.toLocaleString()} />
                <Stat
                  label="Median reply"
                  value={
                    summary.payload.stats.medianReplyMinutes === null
                      ? '—'
                      : `${summary.payload.stats.medianReplyMinutes} min`
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>How your team talks</CardTitle>
              <CardDescription>Drawn from your own replies, not your customers&apos; messages.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium text-foreground-muted">Tone</p>
                  <p>{summary.payload.voiceProfile.tone}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-foreground-muted">Formality</p>
                  <p>{summary.payload.voiceProfile.formality}</p>
                </div>
              </div>
              <Chips label="Languages" items={summary.payload.voiceProfile.languages} />
              <Chips label="Typical greetings" items={summary.payload.voiceProfile.greetings} />
              <Chips label="Typical sign-offs" items={summary.payload.voiceProfile.signOffs} />
              {summary.payload.voiceProfile.habits?.length ? (
                <div>
                  <p className="text-xs font-medium text-foreground-muted">Habits we noticed</p>
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-foreground-muted">
                    {summary.payload.voiceProfile.habits.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What customers keep asking</CardTitle>
              <CardDescription>Most frequent first, with your own best answer.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {summary.payload.topQuestions.length === 0 ? (
                <p className="text-sm text-foreground-muted">No recurring questions stood out.</p>
              ) : (
                summary.payload.topQuestions.map((q, i) => (
                  <div key={i} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium">{q.question}</p>
                      <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-500">
                        ×{q.count}
                      </span>
                    </div>
                    {q.bestAnswer ? (
                      <p className="mt-1.5 text-xs text-foreground-muted">
                        <span className="font-medium">You usually say:</span> {q.bestAnswer}
                      </p>
                    ) : null}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
              Scan again
            </Button>
            {csvButton}
            <Button variant="outline" onClick={confirmWipe} disabled={wipe.isPending}>
              Delete captured data
            </Button>
          </div>
        </div>
      ) : (
        /* IDLE — consent gate. All three boxes are required and separate on purpose. */
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GraduationCap className="size-4" /> Start a {data.limits.defaultWindowDays}-day scan
            </CardTitle>
            <CardDescription>Please read this before connecting your number.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-muted/40 p-3 text-xs leading-relaxed text-foreground-muted">
              {data.consent.text}
            </pre>

            <div className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                WhatsApp allows only <strong>4 linked devices</strong> per account. If your team already
                uses WhatsApp Web or Desktop, connecting may use your last free slot — or ask you to
                remove a device someone is currently using.
              </span>
            </div>

            <div className="space-y-2 text-sm">
              {[
                { s: authority, set: setAuthority, label: 'I am authorised to connect this business number.' },
                { s: banRisk, set: setBanRisk, label: 'I understand this uses an unofficial WhatsApp client and the number could be restricted or banned.' },
                {
                  s: controllerDuty,
                  set: setControllerDuty,
                  label:
                    'I confirm my business has a lawful basis for these conversations, and that my customer privacy notice permits a service provider to process them on my behalf.',
                },
              ].map((c, i) => (
                <label key={i} className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={c.s}
                    onChange={(e) => c.set(e.target.checked)}
                    className="mt-0.5 size-4 shrink-0 rounded border-border"
                  />
                  <span className="text-foreground-muted">{c.label}</span>
                </label>
              ))}
            </div>

            <Button
              onClick={() => connect.mutate()}
              disabled={!consentComplete || connect.isPending}
            >
              {connect.isPending ? 'Starting…' : `Connect my sales number`}
            </Button>

            {grant && !isLive ? (
              <div className="space-y-2">
                <p className="text-xs text-foreground-muted">
                  Last scan ended {grant.endedAt ? new Date(grant.endedAt).toLocaleDateString() : '—'}
                  {grant.endReason ? ` (${grant.endReason.replace(/_/g, ' ')})` : ''} ·{' '}
                  {grant.messageCount} message(s) captured.
                </p>
                {csvButton ? (
                  <div className="space-y-1">
                    {csvButton}
                    <p className="text-xs text-foreground-muted">
                      One row per message, with the real sender and receiver. It contains your
                      customers&apos; phone numbers and messages — handle it like any other customer
                      list.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </>
  );
}
