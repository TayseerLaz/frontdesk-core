'use client';

import {
  type CreateBroadcastBody,
  type VariableMapping,
  type VariableSource,
} from '@platform/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ChevronLeft, ExternalLink, ImageIcon, Phone, Reply, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CreateTemplateDialog } from '@/app/(dashboard)/whatsapp/templates/page';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { formatMicrosUsd } from '@platform/shared';

import { api, ApiError, getAccessToken } from '@/lib/api';
import { getWalletOverview } from '@/lib/dashboard-api';

interface Template {
  id: string;
  name: string;
  language: string;
  category: string;
  bodyText: string;
  components?: Record<string, unknown>[] | null;
  status: string;
  rejectionReason?: string | null;
}

interface Channel {
  id: string;
  label: string | null;
  displayPhoneNumber: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

type AudienceKind = 'contacts' | 'csv' | 'tags' | 'manual';

const STEPS = ['Basics', 'Audience', 'Personalization', 'Schedule', 'Review'] as const;

// Extract {{1}}, {{2}}, ... from a template body. Returns sorted unique indices.
function extractTemplateParams(body: string): number[] {
  const matches = body.matchAll(/\{\{(\d+)\}\}/g);
  const set = new Set<number>();
  for (const m of matches) set.add(Number(m[1]));
  return [...set].sort((a, b) => a - b);
}

// Every fillable variable in a template — dynamic TEXT header, body {{n}}, and
// dynamic URL-button params — as { key, label } pairs. The key matches what the
// send worker reads (header_text / "1".."n" / button_url_<index>).
function templateVarFields(t: Template | undefined): { key: string; label: string }[] {
  if (!t) return [];
  const fields: { key: string; label: string }[] = [];
  const comps = Array.isArray(t.components) ? t.components : [];
  const hasVar = (s: unknown) => /\{\{\s*1\s*\}\}/.test(String(s ?? ''));
  const header = comps.find(
    (c) =>
      String((c as { type?: string }).type ?? '').toUpperCase() === 'HEADER' &&
      String((c as { format?: string }).format ?? '').toUpperCase() === 'TEXT',
  ) as { text?: string } | undefined;
  if (header && hasVar(header.text)) fields.push({ key: 'header_text', label: 'Header {{1}}' });
  for (const p of extractTemplateParams(t.bodyText)) {
    fields.push({ key: String(p), label: `Body {{${p}}}` });
  }
  const buttons = comps.find(
    (c) => String((c as { type?: string }).type ?? '').toUpperCase() === 'BUTTONS',
  ) as { buttons?: { type?: string; url?: string; text?: string }[] } | undefined;
  (buttons?.buttons ?? []).forEach((b, i) => {
    if (String(b.type ?? '').toUpperCase() === 'URL' && hasVar(b.url)) {
      fields.push({ key: `button_url_${i}`, label: `Button link {{1}} (${b.text || 'URL'})` });
    }
  });
  return fields;
}

export default function NewBroadcastPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  // Step 1 state
  const [name, setName] = useState('');
  // Multi-number: the set of numbers to send from. channelId (derived) is the
  // first selected number; when > 1 selected the server splits recipients
  // round-robin across them.
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const channelId = channelIds[0] ?? null;
  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const [confirmSendOpen, setConfirmSendOpen] = useState(false);
  const [variantATemplateId, setVariantATemplateId] = useState<string | null>(null);
  const [abTest, setAbTest] = useState(false);
  const [variantBTemplateId, setVariantBTemplateId] = useState<string | null>(null);

  // Step 2 state
  const [audienceKind, setAudienceKind] = useState<AudienceKind>('manual');
  const [csvAssetId, setCsvAssetId] = useState<string | null>(null);
  const [csvFilename, setCsvFilename] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  // Tag-based audience: list of tag strings + OR/AND mode.
  const [tagAudience, setTagAudience] = useState<string[]>([]);
  const [tagAudienceMode, setTagAudienceMode] = useState<'any' | 'all'>('any');
  const [manualPhonesRaw, setManualPhonesRaw] = useState('');
  // Contacts audience: pick from the saved contact list (select all, or some).
  const [contactSearch, setContactSearch] = useState('');
  const [selectAllContacts, setSelectAllContacts] = useState(false);
  // id → phone/name, so selections persist across searches and we have the
  // phone to send (resolved to manualPhones on submit).
  const [selectedContacts, setSelectedContacts] = useState<
    Map<string, { phone: string; name: string | null }>
  >(new Map());

  // Step 3 state
  const [variantAVariables, setVariantAVariables] = useState<VariableMapping>({});
  const [variantBVariables, setVariantBVariables] = useState<VariableMapping>({});

  // Step 4 — Schedule & batching
  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  // Batched/throttled send: release `batchSize` recipients every
  // `batchIntervalMinutes` instead of all at once.
  const [batchEnabled, setBatchEnabled] = useState(false);
  const [batchSize, setBatchSize] = useState(300);
  const [batchIntervalMinutes, setBatchIntervalMinutes] = useState(30);
  // Compliance: unsubscribed contacts are ALWAYS excluded (no override).

  // Data
  const channelsQuery = useQuery({
    queryKey: ['whatsapp-numbers'],
    queryFn: async () => {
      await api.get('/api/v1/whatsapp'); // ensure the primary stub exists
      return api.get<{ data: Channel[] }>('/api/v1/whatsapp/numbers');
    },
  });
  const channels = channelsQuery.data?.data ?? [];

  // Default to the primary number once loaded.
  useEffect(() => {
    if (channels.length > 0 && channelIds.length === 0) {
      const primary = channels.find((c) => c.isPrimary) ?? channels[0]!;
      setChannelIds([primary.id]);
    }
  }, [channels, channelIds.length]);

  const templatesQuery = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => api.get<{ data: Template[] }>('/api/v1/whatsapp/templates'),
    // Poll while something is in review so approval lands without a refresh.
    refetchInterval: (q) =>
      (q.state.data?.data ?? []).some((t) => t.status === 'pending') ? 15_000 : false,
  });
  const allTemplates = templatesQuery.data?.data ?? [];
  const pendingTemplates = allTemplates.filter((t) => t.status === 'pending');
  const rejectedTemplates = allTemplates.filter((t) => t.status === 'rejected');
  const approvedTemplates = useMemo(
    () => (templatesQuery.data?.data ?? []).filter((t) => t.status === 'approved'),
    [templatesQuery.data],
  );

  // Tag buckets shown by /api/v1/contacts/tags — `{ tag, count }`.
  const tagBucketsQuery = useQuery({
    queryKey: ['contacts', 'tags'],
    queryFn: () => api.get<{ data: { tag: string; count: number }[] }>('/api/v1/contacts/tags'),
  });

  // Duplicate-number warning: the same person saved under more than one number
  // format could receive this broadcast twice.
  const dupQuery = useQuery({
    queryKey: ['contacts', 'duplicates'],
    queryFn: () => api.get<{ data: { groupCount: number } }>('/api/v1/contacts/duplicates'),
  });
  const dupCount = dupQuery.data?.data.groupCount ?? 0;

  // Prepaid-wallet cost preview (metered tenants only). Shared cache with the
  // /billing page + dashboard widgets.
  const walletQuery = useQuery({
    queryKey: ['billing', 'overview'],
    queryFn: getWalletOverview,
    staleTime: 30_000,
  });
  const wallet = walletQuery.data;

  // Contacts picker — first 100 matching the search box (for "select some").
  const contactsPickerQuery = useQuery({
    queryKey: ['contacts', 'picker', contactSearch],
    queryFn: () =>
      api.get<{ data: { id: string; phoneE164: string; displayName: string | null }[] }>(
        `/api/v1/contacts?limit=100${
          contactSearch.trim() ? `&search=${encodeURIComponent(contactSearch.trim())}` : ''
        }`,
      ),
    enabled: audienceKind === 'contacts',
  });
  const toggleContact = (c: { id: string; phoneE164: string; displayName: string | null }) =>
    setSelectedContacts((prev) => {
      const next = new Map(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, { phone: c.phoneE164, name: c.displayName });
      return next;
    });

  const variantATemplate = approvedTemplates.find((t) => t.id === variantATemplateId);
  const variantBTemplate = approvedTemplates.find((t) => t.id === variantBTemplateId);
  // All fillable fields (header / body / URL buttons), memoized per template.
  const fieldsA = useMemo(() => templateVarFields(variantATemplate), [variantATemplate]);
  const fieldsB = useMemo(() => templateVarFields(variantBTemplate), [variantBTemplate]);

  // Wipe variable mapping if template changes.
  useEffect(() => {
    setVariantAVariables({});
  }, [variantATemplateId]);
  useEffect(() => {
    setVariantBVariables({});
  }, [variantBTemplateId]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      // The "contacts" picker resolves to a manual phone list: either every
      // matching contact ("select all", fetched from /contacts/phones) or just
      // the ticked ones. The backend has no 'contacts' kind, so we send 'manual'.
      let manualPhones: string[] | undefined;
      // 'contacts' is a UI-only audience; it always sends a resolved manual list.
      const effectiveKind: CreateBroadcastBody['audienceKind'] =
        audienceKind === 'contacts' ? 'manual' : audienceKind;
      if (audienceKind === 'manual') {
        manualPhones = manualPhonesRaw
          .split(/[\n,;]/)
          .map((p) => p.trim())
          .filter(Boolean);
      } else if (audienceKind === 'contacts') {
        if (selectAllContacts) {
          const res = await api.get<{ data: string[] }>(
            `/api/v1/contacts/phones${
              contactSearch.trim() ? `?search=${encodeURIComponent(contactSearch.trim())}` : ''
            }`,
          );
          manualPhones = res.data;
        } else {
          // Only real phone numbers — IG/Messenger contacts store a PSID here.
          manualPhones = [...selectedContacts.values()]
            .map((v) => v.phone)
            .filter((p) => p.startsWith('+'));
        }
      }
      const body: CreateBroadcastBody = {
        name,
        channelId: channelId!,
        channelIds,
        audienceKind: effectiveKind,
        csvAssetId: audienceKind === 'csv' ? csvAssetId ?? undefined : undefined,
        audienceTags: audienceKind === 'tags' ? tagAudience : undefined,
        audienceTagsMode: audienceKind === 'tags' ? tagAudienceMode : undefined,
        manualPhones,
        // Always false — unsubscribed contacts are never messaged (no UI toggle).
        includeOptedOut: false,
        abTest,
        variantATemplateId: variantATemplateId!,
        variantBTemplateId: abTest ? variantBTemplateId ?? undefined : undefined,
        variantAVariables,
        variantBVariables: abTest ? variantBVariables : undefined,
        batchSize: batchEnabled ? batchSize : 0,
        batchIntervalMinutes: batchEnabled ? batchIntervalMinutes : 0,
      };
      const created = await api.post<{ data: { id: string } }>('/api/v1/broadcasts', body);
      const sendBody = scheduleLater && scheduleAt
        ? { scheduledFor: new Date(scheduleAt).toISOString() }
        : {};
      await api.post(`/api/v1/broadcasts/${created.data.id}/send`, sendBody);
      return created.data.id;
    },
    onSuccess: (id) => {
      toast.success('Broadcast queued');
      router.push(`/broadcasts/${id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.payload.message : 'Send failed'),
  });

  // ---- Validation per step
  const canAdvance = useMemo(() => {
    if (step === 0) {
      return Boolean(name && channelId && variantATemplateId && (!abTest || variantBTemplateId));
    }
    if (step === 1) {
      if (audienceKind === 'csv') return Boolean(csvAssetId);
      if (audienceKind === 'tags') return tagAudience.length > 0;
      if (audienceKind === 'contacts') return selectAllContacts || selectedContacts.size > 0;
      return manualPhonesRaw.split(/[\n,;]/).filter((p) => p.trim()).length > 0;
    }
    if (step === 2) {
      return (
        fieldsA.every((f) => variantAVariables[f.key]) &&
        (!abTest || fieldsB.every((f) => variantBVariables[f.key]))
      );
    }
    if (step === 3) {
      if (scheduleLater && !scheduleAt) return false;
      if (batchEnabled && (batchSize < 1 || batchIntervalMinutes < 1)) return false;
      return true;
    }
    return true;
  }, [
    step,
    name,
    channelId,
    variantATemplateId,
    abTest,
    variantBTemplateId,
    audienceKind,
    csvAssetId,
    tagAudience,
    manualPhonesRaw,
    selectAllContacts,
    selectedContacts,
    fieldsA,
    fieldsB,
    variantAVariables,
    variantBVariables,
    scheduleLater,
    scheduleAt,
    batchEnabled,
    batchSize,
    batchIntervalMinutes,
  ]);

  // Best-effort recipient count for the batch preview. Manual + a fixed
  // contact selection are known up front; CSV / tags / "select all" resolve at
  // fanout time, so we show a generic preview for those.
  const knownRecipientCount: number | null =
    audienceKind === 'manual'
      ? manualPhonesRaw.split(/[\n,;]/).filter((p) => p.trim()).length
      : audienceKind === 'contacts' && !selectAllContacts
        ? selectedContacts.size
        : null;

  return (
    <>
      <PageHeader
        title="New broadcast"
        description={`Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`}
        actions={
          <Link href="/broadcasts">
            <Button variant="ghost">
              <ChevronLeft className="size-4" /> Back to list
            </Button>
          </Link>
        }
      />

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm">
        {STEPS.map((s, idx) => (
          <div
            key={s}
            className={`flex items-center gap-2 rounded px-3 py-1 ${
              idx === step
                ? 'bg-primary text-primary-foreground'
                : idx < step
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-surface-muted text-foreground-muted'
            }`}
          >
            <span className="font-mono text-xs">{idx + 1}</span> {s}
          </div>
        ))}
      </div>

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Basics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Campaign name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring sale" />
            </div>
            <div>
              <Label>Send from {channels.length > 1 ? 'number(s)' : 'number'}</Label>
              {channels.length <= 1 ? (
                <Input
                  disabled
                  value={
                    channels[0]
                      ? channels[0].label || channels[0].displayPhoneNumber || 'WhatsApp number'
                      : 'Loading…'
                  }
                  className="font-mono text-sm"
                />
              ) : (
                <div className="space-y-1.5 rounded-md border border-border p-2">
                  {channels.map((c) => {
                    const checked = channelIds.includes(c.id);
                    const name = c.label || c.displayPhoneNumber || 'WhatsApp number';
                    return (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-surface-muted"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setChannelIds((prev) =>
                              e.target.checked
                                ? [...prev, c.id]
                                : prev.filter((id) => id !== c.id),
                            )
                          }
                        />
                        <span className="font-medium">{name}</span>
                        {c.isPrimary ? (
                          <span className="text-xs text-foreground-subtle">(primary)</span>
                        ) : null}
                        {!c.isActive ? (
                          <span className="text-xs text-amber-600">· not live</span>
                        ) : null}
                      </label>
                    );
                  })}
                  <p className="px-1.5 pt-1 text-xs text-foreground-subtle">
                    {channelIds.length > 1
                      ? 'Recipients are split round-robin across the selected numbers — each contact is messaged once.'
                      : 'Pick one or more numbers to send from.'}
                  </p>
                </div>
              )}
            </div>
            <div>
              <div className="flex items-center justify-between gap-2">
                <Label>Template (variant A)</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setCreateTemplateOpen(true)}
                >
                  + Create template
                </Button>
              </div>
              <Select value={variantATemplateId ?? ''} onValueChange={(v) => setVariantATemplateId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick an approved template…" />
                </SelectTrigger>
                <SelectContent>
                  {approvedTemplates.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-foreground-muted">
                      No approved templates yet — use “Create template”.
                    </div>
                  ) : null}
                  {approvedTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} <span className="ml-1 text-xs text-foreground-subtle">· {t.language} · {t.category}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {variantATemplate ? (
                <pre className="mt-2 max-h-32 overflow-y-auto rounded bg-surface-muted p-3 text-xs">
                  {variantATemplate.bodyText}
                </pre>
              ) : null}

              {/* Meta verification status. Templates you just created land here
                  while Meta reviews them (usually minutes); the list polls, so
                  an approval appears in the picker without a refresh. */}
              {pendingTemplates.length > 0 || rejectedTemplates.length > 0 ? (
                <div className="mt-3 rounded-lg border border-[#E6DCCB] bg-[#F3ECE0] p-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#7A6F69]">
                    Meta verification
                  </p>
                  <ul className="space-y-1.5">
                    {pendingTemplates.map((t) => (
                      <li key={t.id} className="flex items-center gap-2 text-sm text-[#4A1525]">
                        <span
                          aria-hidden
                          className="size-2 shrink-0 animate-pulse rounded-full bg-amber-500"
                        />
                        <span className="truncate font-medium">{t.name}</span>
                        <span className="text-xs text-[#7A6F69]">· {t.language} · in review</span>
                      </li>
                    ))}
                    {rejectedTemplates.map((t) => (
                      <li key={t.id} className="flex items-start gap-2 text-sm text-[#7A211B]">
                        <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-[#E53E34]" />
                        <span className="min-w-0">
                          <span className="font-medium">{t.name}</span>{' '}
                          <span className="text-xs">· rejected</span>
                          {t.rejectionReason ? (
                            <span className="block text-xs opacity-80">{t.rejectionReason}</span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-[#7A6F69]">
                    Approval usually takes a few minutes. This list refreshes itself — approved
                    templates appear in the picker above.
                  </p>
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <input
                id="abtest"
                type="checkbox"
                checked={abTest}
                onChange={(e) => setAbTest(e.target.checked)}
              />
              <Label htmlFor="abtest" className="cursor-pointer">A/B test (split 50/50)</Label>
            </div>

            {abTest ? (
              <div>
                <Label>Template (variant B)</Label>
                <Select
                  value={variantBTemplateId ?? ''}
                  onValueChange={(v) => setVariantBTemplateId(v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick variant B template…" />
                  </SelectTrigger>
                  <SelectContent>
                    {approvedTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {variantBTemplate ? (
                  <pre className="mt-2 max-h-32 overflow-y-auto rounded bg-surface-muted p-3 text-xs">
                    {variantBTemplate.bodyText}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Audience</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              {(['contacts', 'tags', 'csv', 'manual'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setAudienceKind(k)}
                  className={`flex-1 rounded border px-4 py-3 text-center text-sm ${
                    audienceKind === k
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-surface-muted'
                  }`}
                >
                  <div className="font-medium capitalize">{k}</div>
                  <div className="text-xs text-foreground-muted">
                    {k === 'contacts'
                      ? 'Select from contacts'
                      : k === 'manual'
                        ? 'Paste phone numbers'
                        : k === 'csv'
                          ? 'Upload a CSV'
                          : 'Pick contact tags'}
                  </div>
                </button>
              ))}
            </div>

            {audienceKind === 'contacts' ? (
              <div className="space-y-3">
                <label className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 p-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={selectAllContacts}
                    onChange={(e) => setSelectAllContacts(e.target.checked)}
                  />
                  <span className="font-medium">Select ALL contacts</span>
                  <span className="text-xs text-foreground-muted">
                    {contactSearch.trim()
                      ? '(all contacts matching the search below)'
                      : '(everyone in your contact list)'}
                  </span>
                </label>

                {!selectAllContacts ? (
                  <>
                    <Input
                      placeholder="Search contacts by name or number…"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                    />
                    <div className="max-h-72 overflow-y-auto rounded-md border border-border divide-y divide-border">
                      {contactsPickerQuery.isLoading ? (
                        <div className="space-y-2 p-3">
                          <Skeleton className="h-4 w-3/4" />
                          <Skeleton className="h-4 w-2/3" />
                          <Skeleton className="h-4 w-4/5" />
                        </div>
                      ) : (contactsPickerQuery.data?.data ?? []).filter((c) =>
                          c.phoneE164.startsWith('+'),
                        ).length === 0 ? (
                        <p className="p-3 text-sm italic text-foreground-muted">
                          No contacts with a phone number found. (Instagram/Messenger-only contacts
                          can't receive WhatsApp broadcasts.)
                        </p>
                      ) : (
                        (contactsPickerQuery.data?.data ?? [])
                          .filter((c) => c.phoneE164.startsWith('+'))
                          .map((c) => (
                          <label
                            key={c.id}
                            className="flex cursor-pointer items-center gap-3 p-2.5 text-sm hover:bg-surface-muted/50"
                          >
                            <input
                              type="checkbox"
                              className="size-4"
                              checked={selectedContacts.has(c.id)}
                              onChange={() => toggleContact(c)}
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {c.displayName || c.phoneE164}
                            </span>
                            <span className="font-mono text-xs text-foreground-muted">
                              {c.phoneE164}
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                    <p className="text-xs text-foreground-muted">
                      {selectedContacts.size} contact{selectedContacts.size === 1 ? '' : 's'} selected
                      {contactsPickerQuery.data?.data.length === 100
                        ? ' · showing first 100 — use search to narrow, or pick “Select ALL contacts”.'
                        : ''}
                    </p>
                  </>
                ) : (
                  <p className="rounded-md border border-dashed border-border bg-surface-muted/40 p-3 text-xs text-foreground-muted">
                    Every matching contact will receive this broadcast (opted-out contacts are
                    automatically skipped at send time). You can narrow with a search by unticking
                    “Select ALL contacts”.
                  </p>
                )}
              </div>
            ) : null}

            {audienceKind === 'manual' ? (
              <div>
                <Label>Phone numbers (one per line, E.164)</Label>
                <Textarea
                  rows={8}
                  value={manualPhonesRaw}
                  onChange={(e) => setManualPhonesRaw(e.target.value)}
                  placeholder="+14155551234&#10;+14155555678"
                  className="font-mono text-sm"
                />
                <p className="mt-1 text-xs text-foreground-muted">
                  {manualPhonesRaw.split(/[\n,;]/).filter((p) => p.trim()).length} numbers entered
                </p>
              </div>
            ) : null}

            {audienceKind === 'csv' ? (
              <CsvAudienceStep
                onPicked={(assetId, filename, headers) => {
                  setCsvAssetId(assetId);
                  setCsvFilename(filename);
                  setCsvHeaders(headers);
                }}
                currentFilename={csvFilename}
              />
            ) : null}

            {audienceKind === 'tags' ? (
              <div className="space-y-3">
                <div>
                  <Label>Tags</Label>
                  <p className="mt-0.5 text-xs text-foreground-muted">
                    Send to every contact carrying the selected tag(s). Tags are added in the
                    inbox or on the contact list.
                  </p>
                </div>
                {(tagBucketsQuery.data?.data ?? []).length === 0 ? (
                  <p className="rounded-md border border-dashed border-border bg-surface-muted/40 p-3 text-xs italic text-foreground-muted">
                    No tags yet. Add tags in the inbox or on the contact list, then come back.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {(tagBucketsQuery.data?.data ?? []).map((t) => {
                      const on = tagAudience.includes(t.tag);
                      return (
                        <button
                          key={t.tag}
                          type="button"
                          onClick={() =>
                            setTagAudience((prev) =>
                              on ? prev.filter((x) => x !== t.tag) : [...prev, t.tag],
                            )
                          }
                          className={`rounded-full border px-3 py-1 text-xs ${
                            on
                              ? 'border-brand-400 bg-brand-50 text-brand-700'
                              : 'border-border bg-surface text-foreground hover:bg-surface-muted'
                          }`}
                        >
                          {t.tag}{' '}
                          <span className="opacity-60">({t.count})</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {tagAudience.length > 1 ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs">
                    <span className="font-medium">Match:</span>
                    <button
                      type="button"
                      onClick={() => setTagAudienceMode('any')}
                      className={`rounded px-2 py-1 ${
                        tagAudienceMode === 'any'
                          ? 'bg-brand-50 font-medium text-brand-700'
                          : 'text-foreground-muted hover:text-foreground'
                      }`}
                    >
                      Any of these tags
                    </button>
                    <button
                      type="button"
                      onClick={() => setTagAudienceMode('all')}
                      className={`rounded px-2 py-1 ${
                        tagAudienceMode === 'all'
                          ? 'bg-brand-50 font-medium text-brand-700'
                          : 'text-foreground-muted hover:text-foreground'
                      }`}
                    >
                      All of these tags
                    </button>
                  </div>
                ) : null}
                {tagAudience.length > 0 ? (
                  <p className="text-xs text-foreground-muted">
                    Selected:{' '}
                    <span className="font-mono">{tagAudience.join(', ')}</span>
                    {tagAudience.length > 1 ? (
                      <>
                        {' · matching '}
                        <span className="font-medium">
                          {tagAudienceMode === 'all' ? 'all tags' : 'any tag'}
                        </span>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <CreateTemplateDialog open={createTemplateOpen} onOpenChange={setCreateTemplateOpen} />

      {/* In-app send confirmation (replaces the browser confirm() popup). */}
      <Dialog
        open={confirmSendOpen}
        onOpenChange={(o) => !sendMutation.isPending && setConfirmSendOpen(o)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {scheduleLater ? 'Schedule this broadcast?' : 'Send this broadcast now?'}
            </DialogTitle>
            <DialogDescription>
              {scheduleLater && scheduleAt ? (
                <>
                  “{name || 'Untitled'}” will start sending on{' '}
                  <span className="font-medium text-foreground">
                    {new Date(scheduleAt).toLocaleString()}
                  </span>
                  .
                </>
              ) : (
                <>
                  “{name || 'Untitled'}” will start sending immediately
                  {knownRecipientCount ? (
                    <>
                      {' '}to{' '}
                      <span className="font-medium text-foreground">
                        {knownRecipientCount.toLocaleString()}
                      </span>{' '}
                      recipient{knownRecipientCount === 1 ? '' : 's'}
                    </>
                  ) : null}
                  . Unsubscribed contacts are always excluded.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setConfirmSendOpen(false)}
              disabled={sendMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              loading={sendMutation.isPending}
              onClick={() => {
                setConfirmSendOpen(false);
                sendMutation.mutate();
              }}
            >
              <Send className="size-4" /> {scheduleLater ? 'Schedule' : 'Send now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {step === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>Personalization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {fieldsA.length === 0 ? (
              <p className="text-sm text-foreground-muted">
                Variant A template has no variables. Nothing to map here.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm font-medium">Variant A · {variantATemplate?.name}</p>
                {fieldsA.map((f) => (
                  <VariableRow
                    key={`a-${f.key}`}
                    label={f.label}
                    audienceKind={audienceKind}
                    csvHeaders={csvHeaders}
                    value={variantAVariables[f.key]}
                    onChange={(src) =>
                      setVariantAVariables((prev) => ({ ...prev, [f.key]: src }))
                    }
                  />
                ))}
              </div>
            )}
            <TemplatePreview
              template={variantATemplate}
              variables={variantAVariables}
              caption={abTest ? 'Variant A preview.' : undefined}
            />
            {abTest && variantBTemplate ? (
              <div className="space-y-3 border-t border-border pt-4">
                <p className="text-sm font-medium">Variant B · {variantBTemplate.name}</p>
                {fieldsB.map((f) => (
                  <VariableRow
                    key={`b-${f.key}`}
                    label={f.label}
                    audienceKind={audienceKind}
                    csvHeaders={csvHeaders}
                    value={variantBVariables[f.key]}
                    onChange={(src) =>
                      setVariantBVariables((prev) => ({ ...prev, [f.key]: src }))
                    }
                  />
                ))}
                <TemplatePreview
                  template={variantBTemplate}
                  variables={variantBVariables}
                  caption="Variant B preview."
                />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ----- Schedule & batching (new step, after Personalization) ----- */}
      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>Schedule &amp; batching</CardTitle>
            <CardDescription>
              Choose when to start, and whether to drip the send out in timed waves instead of all
              at once.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Start time */}
            <div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-brand-600"
                  checked={scheduleLater}
                  onChange={(e) => setScheduleLater(e.target.checked)}
                />
                <span className="text-sm font-medium">Schedule the start for later</span>
              </label>
              {scheduleLater ? (
                <Input
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  className="mt-2 max-w-xs"
                />
              ) : (
                <p className="mt-1 text-xs text-foreground-muted">
                  The first batch starts sending immediately.
                </p>
              )}
            </div>

            {/* Batching / throttle */}
            <div className="border-t border-border pt-4">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-brand-600"
                  checked={batchEnabled}
                  onChange={(e) => setBatchEnabled(e.target.checked)}
                />
                <span className="text-sm font-medium">Send in batches (throttle)</span>
              </label>
              <p className="mt-1 text-xs text-foreground-muted">
                Release a fixed number of recipients per wave, spaced by an interval — e.g. 300
                every 30 minutes — instead of everyone at once.
              </p>
              {batchEnabled ? (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-md">
                    <div className="space-y-1">
                      <Label htmlFor="batchSize">Recipients per batch</Label>
                      <Input
                        id="batchSize"
                        type="number"
                        min={1}
                        value={batchSize}
                        onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 0))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="batchInterval">Minutes between batches</Label>
                      <Input
                        id="batchInterval"
                        type="number"
                        min={1}
                        value={batchIntervalMinutes}
                        onChange={(e) =>
                          setBatchIntervalMinutes(Math.max(1, Number(e.target.value) || 0))
                        }
                      />
                    </div>
                  </div>
                  <BatchPreview
                    count={knownRecipientCount}
                    batchSize={batchSize}
                    intervalMinutes={batchIntervalMinutes}
                  />
                </>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <CardHeader>
            <CardTitle>Review &amp; send</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <SummaryRow label="Name" value={name} />
            <SummaryRow
              label="Template"
              value={`${variantATemplate?.name ?? ''} (${variantATemplate?.language ?? ''})`}
            />
            <SummaryRow label="A/B test" value={abTest ? 'Yes — split 50/50' : 'No'} />
            <SummaryRow label="Audience" value={audienceKind} />
            {audienceKind === 'manual' ? (
              <SummaryRow
                label="Recipients"
                value={`${manualPhonesRaw.split(/[\n,;]/).filter((p) => p.trim()).length} numbers`}
              />
            ) : null}
            {audienceKind === 'csv' && csvFilename ? (
              <SummaryRow label="CSV" value={csvFilename} />
            ) : null}
            <SummaryRow
              label="Start"
              value={scheduleLater && scheduleAt ? new Date(scheduleAt).toLocaleString() : 'Now'}
            />
            <SummaryRow
              label="Batching"
              value={
                batchEnabled
                  ? `${batchSize} every ${batchIntervalMinutes} min`
                  : 'Off — send all at once'
              }
            />

            {/* Message preview — exactly how the template renders on WhatsApp. */}
            <div className="border-t border-border pt-4">
              <p className="mb-2 text-sm font-medium">Message preview</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <TemplatePreview
                  template={variantATemplate}
                  variables={variantAVariables}
                  caption={abTest ? 'Variant A.' : undefined}
                />
                {abTest && variantBTemplate ? (
                  <TemplatePreview
                    template={variantBTemplate}
                    variables={variantBVariables}
                    caption="Variant B."
                  />
                ) : null}
              </div>
            </div>

            {/* Prepaid-wallet cost preview (metered tenants only). Does not
                block sending — the API enforces affordability at fanout. */}
            {wallet && wallet.metered ? (
              <BroadcastCostLine
                count={knownRecipientCount}
                pricePerMessageMicros={wallet.pricePerMessageMicros}
                availableMicros={wallet.availableMicros}
                messagesRemaining={wallet.messagesRemaining}
              />
            ) : null}

            {/* Duplicate-number warning — same person under multiple formats. */}
            {dupCount > 0 ? (
              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3">
                  <p className="text-sm text-amber-900">
                    <strong>{dupCount}</strong> duplicate number{dupCount === 1 ? '' : 's'} in your
                    contacts — the same person may receive this broadcast more than once. Fix them
                    first, or send anyway.
                  </p>
                  <Button asChild variant="secondary" size="sm">
                    <a href="/contacts">Fix duplicates</a>
                  </Button>
                </div>
              </div>
            ) : null}

            {/* Unsubscribe compliance note — unsubscribed are ALWAYS excluded. */}
            <div className="border-t border-border pt-4">
              <div className="rounded-md border border-border bg-surface-muted/50 p-3">
                <p className="text-sm text-foreground-muted">
                  Unsubscribed contacts are automatically excluded from every broadcast (WhatsApp
                  compliance). You can still see them in your{' '}
                  <a href="/contacts" className="font-medium text-brand-600 underline">
                    contact list
                  </a>{' '}
                  with an <span className="font-medium">Unsubscribed</span> badge.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Wizard nav */}
      <div className="flex justify-between">
        <Button
          variant="ghost"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          <ArrowLeft className="size-4" /> Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button disabled={!canAdvance} onClick={() => setStep((s) => s + 1)}>
            Next <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button
            disabled={sendMutation.isPending}
            onClick={() => setConfirmSendOpen(true)}
          >
            <Send className="size-4" />{' '}
            {sendMutation.isPending ? 'Submitting…' : scheduleLater ? 'Schedule' : 'Send now'}
          </Button>
        )}
      </div>
    </>
  );
}

// ---------- Variable row -------------------------------------------------
// WhatsApp-style live preview of a template with the current variable mapping.
// Static values render literally; per-recipient sources (CSV column / contact
// attribute / contact field) render as ⟨token⟩ placeholders.
function TemplatePreview({
  template,
  variables,
  caption,
}: {
  template: Template | undefined;
  variables: Record<string, VariableSource | undefined>;
  caption?: string;
}) {
  if (!template) return null;
  const up = (v: unknown) => String(v ?? '').toUpperCase();
  const comps = Array.isArray(template.components)
    ? (template.components as {
        type?: string;
        format?: string;
        text?: string;
        buttons?: { type?: string; text?: string }[];
      }[])
    : [];
  const header = comps.find((c) => up(c.type) === 'HEADER');
  const footer = comps.find((c) => up(c.type) === 'FOOTER');
  const buttons = comps.find((c) => up(c.type) === 'BUTTONS')?.buttons ?? [];
  const resolve = (key: string, raw: string): string => {
    const src = variables[key];
    if (!src) return raw;
    if (src.kind === 'static') return src.value || raw;
    if (src.kind === 'csv') return `⟨${src.column || 'CSV column'}⟩`;
    if (src.kind === 'attribute') return `⟨${src.key || 'attribute'}⟩`;
    return `⟨${String(src.field).replace(/_/g, ' ')}⟩`;
  };
  const body = template.bodyText.replace(/\{\{(\d+)\}\}/g, (m, n: string) => resolve(n, m));
  const headerText =
    header && up(header.format) === 'TEXT'
      ? String(header.text ?? '').replace(/\{\{1\}\}/g, resolve('header_text', '{{1}}'))
      : null;
  const mediaKind =
    header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(up(header.format)) ? up(header.format) : null;
  return (
    <div>
      <div className="rounded-xl bg-[#E5DDD5] p-4 dark:bg-[#0B141A]">
        <div className="max-w-[320px] rounded-lg rounded-tl-none bg-white p-1.5 shadow-sm">
          {mediaKind ? (
            <div className="flex h-28 items-center justify-center gap-2 rounded-md bg-[#E9EDEF] text-[#8696A0]">
              <ImageIcon className="size-5" />
              <span className="text-xs font-medium">{mediaKind.toLowerCase()} header</span>
            </div>
          ) : null}
          {headerText ? (
            <p className="px-1.5 pt-1 text-[13.5px] font-bold text-[#111B21]">{headerText}</p>
          ) : null}
          <p className="whitespace-pre-wrap px-1.5 pt-1 text-[13.5px] leading-[1.45] text-[#111B21]">
            {body}
          </p>
          {footer?.text ? (
            <p className="px-1.5 pb-1 pt-1 text-[11px] text-[#8696A0]">{footer.text}</p>
          ) : null}
          {buttons.length > 0 ? (
            <div className="mt-1.5 border-t border-[#E9EDEF]">
              {buttons.map((b, i) => (
                <div
                  key={i}
                  className="flex items-center justify-center gap-1.5 border-b border-[#E9EDEF] py-2 text-[13.5px] font-medium text-[#00A5F4] last:border-b-0"
                >
                  {up(b.type) === 'URL' ? (
                    <ExternalLink className="size-3.5" />
                  ) : up(b.type) === 'PHONE_NUMBER' ? (
                    <Phone className="size-3.5" />
                  ) : (
                    <Reply className="size-3.5" />
                  )}
                  {b.text}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-foreground-subtle">
        {caption ?? 'How the message will look on WhatsApp.'} ⟨tokens⟩ are filled per
        recipient at send time.
      </p>
    </div>
  );
}

function VariableRow({
  label,
  audienceKind,
  csvHeaders,
  value,
  onChange,
}: {
  label: string;
  audienceKind: AudienceKind;
  csvHeaders: string[];
  value: VariableSource | undefined;
  onChange: (src: VariableSource) => void;
}) {
  const kind = value?.kind ?? 'static';
  return (
    <div className="grid grid-cols-12 items-center gap-2 text-sm">
      <div className="col-span-2 truncate font-mono text-xs text-foreground-muted" title={label}>
        {label}
      </div>
      <div className="col-span-3">
        <Select
          value={kind}
          onValueChange={(v) => {
            if (v === 'static') onChange({ kind: 'static', value: '' });
            else if (v === 'csv') onChange({ kind: 'csv', column: csvHeaders[0] ?? '' });
            else if (v === 'attribute') onChange({ kind: 'attribute', key: '', fallback: '' });
            else if (v === 'field')
              onChange({ kind: 'field', field: 'display_name', fallback: '' });
          }}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="static">Static value</SelectItem>
            {audienceKind === 'csv' ? <SelectItem value="csv">CSV column</SelectItem> : null}
            <SelectItem value="attribute">Contact attribute</SelectItem>
            <SelectItem value="field">Contact field</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="col-span-7">
        {value?.kind === 'static' ? (
          <Input
            value={value.value}
            onChange={(e) => onChange({ kind: 'static', value: e.target.value })}
            placeholder="Hello!"
          />
        ) : value?.kind === 'csv' ? (
          <Select
            value={value.column}
            onValueChange={(v) => onChange({ kind: 'csv', column: v })}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {csvHeaders.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : value?.kind === 'attribute' ? (
          <div className="flex gap-2">
            <Input
              value={value.key}
              onChange={(e) => onChange({ kind: 'attribute', key: e.target.value, fallback: value.fallback })}
              placeholder="attribute key (e.g. first_name)"
            />
            <Input
              value={value.fallback ?? ''}
              onChange={(e) =>
                onChange({ kind: 'attribute', key: value.key, fallback: e.target.value })
              }
              placeholder="fallback (optional)"
              className="w-40"
            />
          </div>
        ) : value?.kind === 'field' ? (
          <Select
            value={value.field}
            onValueChange={(v) =>
              onChange({
                kind: 'field',
                field: v as 'display_name' | 'phone_e164' | 'locale',
                fallback: value.fallback,
              })
            }
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="display_name">Display name</SelectItem>
              <SelectItem value="phone_e164">Phone</SelectItem>
              <SelectItem value="locale">Locale</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </div>
  );
}

// ---------- CSV upload step ------------------------------------------------
function CsvAudienceStep({
  onPicked,
  currentFilename,
}: {
  onPicked: (assetId: string, filename: string, headers: string[]) => void;
  currentFilename: string | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/assets/upload-csv`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` },
          body: fd,
          credentials: 'include',
        },
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { data: { assetId: string; filename: string } };
      // Quick header parse via FileReader (saves a roundtrip).
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result ?? '');
        const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
        const headers = firstLine
          .split(',')
          .map((s) => s.trim().replace(/^"|"$/g, ''))
          .filter(Boolean);
        onPicked(data.data.assetId, data.data.filename, headers);
        toast.success(`Uploaded — ${headers.length} columns detected`);
      };
      reader.readAsText(file.slice(0, 8192));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <Button onClick={submit} disabled={!file || busy}>
        {busy ? 'Uploading…' : 'Upload CSV'}
      </Button>
      {currentFilename ? (
        <p className="text-sm text-foreground-muted">Uploaded: {currentFilename}</p>
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-border py-2 text-sm">
      <span className="text-foreground-muted">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// Estimated prepaid cost of the broadcast for a metered tenant. When the
// audience size is known (manual / picked contacts) we show an exact estimate
// and warn if the balance won't cover everyone. For deferred audiences
// (CSV / tags / select-all) we show the price + balance as guidance only.
function BroadcastCostLine({
  count,
  pricePerMessageMicros,
  availableMicros,
  messagesRemaining,
}: {
  count: number | null;
  pricePerMessageMicros: number;
  availableMicros: number;
  messagesRemaining: number;
}) {
  const priceStr = formatMicrosUsd(pricePerMessageMicros);
  const availStr = formatMicrosUsd(availableMicros);

  if (count == null) {
    return (
      <div className="border-t border-border pt-4">
        <div className="rounded-md border border-brand-200 bg-brand-50/60 p-3 text-sm text-brand-900 dark:border-brand-400/30 dark:bg-brand-400/10 dark:text-brand-200">
          Each message costs <strong>${priceStr}</strong>. Balance:{' '}
          <strong>${availStr}</strong> (~{messagesRemaining.toLocaleString()} messages). Final cost
          depends on your resolved audience size.
        </div>
      </div>
    );
  }

  const estimateMicros = count * pricePerMessageMicros;
  const covered = estimateMicros <= availableMicros;

  return (
    <div className="border-t border-border pt-4 space-y-2">
      <div className="rounded-md border border-brand-200 bg-brand-50/60 p-3 text-sm text-brand-900 dark:border-brand-400/30 dark:bg-brand-400/10 dark:text-brand-200">
        Estimated cost: <strong>${formatMicrosUsd(estimateMicros)}</strong> (
        {count.toLocaleString()} × ${priceStr}). Balance: <strong>${availStr}</strong> (~
        {messagesRemaining.toLocaleString()} messages).
      </div>
      {!covered ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Balance covers ~<strong>{messagesRemaining.toLocaleString()}</strong> of{' '}
          {count.toLocaleString()} — the rest will be skipped until you top up.
        </div>
      ) : null}
    </div>
  );
}

// Live preview of the batched send: number of waves, last-wave size, total span.
function BatchPreview({
  count,
  batchSize,
  intervalMinutes,
}: {
  count: number | null;
  batchSize: number;
  intervalMinutes: number;
}) {
  if (batchSize < 1 || intervalMinutes < 1) return null;
  const fmtSpan = (mins: number) => {
    if (mins <= 0) return 'instantly';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return [h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
  };

  if (count == null) {
    return (
      <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50/50 px-3 py-2.5 text-xs text-brand-800 dark:border-brand-400/30 dark:bg-brand-400/10 dark:text-brand-200">
        Sends <strong>{batchSize}</strong> recipients, then waits{' '}
        <strong>{intervalMinutes} min</strong> before the next wave, until everyone has been sent.
        (Exact wave count depends on your final audience size.)
      </div>
    );
  }

  if (count === 0) {
    return (
      <p className="mt-3 text-xs text-foreground-subtle">No recipients selected yet.</p>
    );
  }

  const waves = Math.ceil(count / batchSize);
  const lastWave = count - (waves - 1) * batchSize;
  const spanMinutes = (waves - 1) * intervalMinutes;
  const sizes: number[] = Array.from({ length: waves }, (_, i) =>
    i === waves - 1 ? lastWave : batchSize,
  );
  const shown = sizes.slice(0, 6).join(', ') + (sizes.length > 6 ? ', …' : '');

  return (
    <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50/50 px-3 py-2.5 text-xs text-brand-800 dark:border-brand-400/30 dark:bg-brand-400/10 dark:text-brand-200">
      <strong>{count.toLocaleString()}</strong> recipients →{' '}
      <strong>{waves}</strong> wave{waves === 1 ? '' : 's'} of {shown}, one every{' '}
      <strong>{intervalMinutes} min</strong>
      {waves > 1 ? (
        <>
          {' '}
          — finishes ~<strong>{fmtSpan(spanMinutes)}</strong> after the start.
        </>
      ) : (
        ' — all in one wave.'
      )}
    </div>
  );
}
