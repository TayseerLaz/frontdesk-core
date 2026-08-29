'use client';

import {
  CONTACT_SYNC_ATTESTATION_TEXT,
  CONTACT_SYNC_LABEL_MAX_CHARS,
  CONTACT_SYNC_WA_NOTICE_TEXT,
  summarizeContactSync,
  type ContactSyncDeviceKind,
  type ContactSyncSession,
} from '@platform/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Apple, Check, Loader2, MessageCircle, RefreshCw, Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { api } from '@/lib/api';

interface CreatedSession extends ContactSyncSession {
  token: string;
  url: string | null;
}

type Step = 'device' | 'options' | 'qr' | 'done';

/**
 * Per-path instructions. These differ because the underlying mechanism differs.
 *
 * android/ios: the QR opens a web page, and the phone's own OS decides what is shared.
 * whatsapp: the QR is a WhatsApp pairing code scanned from inside WhatsApp itself, so
 * there is no web page at all — which is why its steps name a completely different app.
 */
const STEPS: Record<ContactSyncDeviceKind, string[]> = {
  android: [
    'Open the Camera app and point it at this QR code.',
    'Tap the link that appears — open it in Chrome if your phone offers a choice.',
    'Follow the steps on your phone — pick contacts, or export the whole list.',
    'Tap Share — they will appear here automatically.',
  ],
  ios: [
    'Open the Camera app and point it at this QR code.',
    'Tap the banner that appears to open it in Safari.',
    'Follow the on-screen steps to export your contacts file.',
    'Pick that file on the page — they will appear here automatically.',
  ],
  whatsapp: [
    'Open WhatsApp on your phone.',
    'Tap Settings, then Linked devices.',
    'Tap "Link a device" and point it at this QR code.',
    'Your contacts copy over, then we unlink automatically.',
  ],
};

const DEVICE_LABEL: Record<ContactSyncDeviceKind, string> = {
  android: 'Android',
  ios: 'iPhone',
  whatsapp: 'WhatsApp',
};

export function PhoneSyncDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [step, setStep] = useState<Step>('device');
  const [device, setDevice] = useState<ContactSyncDeviceKind | null>(null);
  const [dialCode, setDialCode] = useState('961');
  const [attested, setAttested] = useState(false);
  const [session, setSession] = useState<CreatedSession | null>(null);

  // "Whose phone is this?" — the one provenance value that works on ALL three paths. The
  // android/ios phone is unauthenticated and never identifies itself, so nothing but this
  // can say where a contact came from once the session and its ledger are pruned at 7 days.
  //
  // NOT PREFILLED, and that is the whole point. The first version seeded this with the
  // signed-in member's name, which quietly defeated the design: the field is OPTIONAL, so
  // leaving it untouched is the default path, and the default answer to "whose phone is
  // this?" became "whoever clicked" — the exact collapse the migration header forbids,
  // because the owner minting a QR for the manager's handset is the ordinary case. A wrong
  // answer here is not a typo; it is stamped onto up to 5,000 contacts as a permanent tag.
  // Blank is honest. `createdByUserId` already records who clicked, separately.
  const [syncedBy, setSyncedBy] = useState('');

  // Whether this deployment can offer the WhatsApp path at all. Without the ingest
  // service there is nothing to produce a pairing code, so the card must not appear.
  // Declared before the poll so `polling` can read it; poll.data is undefined until the
  // first fetch resolves, which is exactly the initial state we want.
  const caps = useQuery({
    queryKey: ['contact-sync', 'capabilities'],
    queryFn: () => api.get<{ data: { whatsapp: boolean } }>('/api/v1/contacts/sync-capabilities'),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const whatsappAvailable = caps.data?.data.whatsapp === true;

  useEffect(() => {
    if (!open) return;
    setStep('device');
    setDevice(null);
    setAttested(false);
    setSession(null);
    setSyncedBy('');
  }, [open]);

  const create = useMutation({
    mutationFn: (body: {
      deviceKind: ContactSyncDeviceKind;
      defaultDialCode: string | null;
      marketingAttested: boolean;
      syncedByLabel: string | null;
    }) => api.post<{ data: CreatedSession }>('/api/v1/contacts/sync-sessions', body),
    onSuccess: (res) => {
      setSession(res.data);
      setStep('qr');
    },
    onError: () => toast.error('Could not start the sync. Try again.'),
  });

  const undo = useMutation({
    mutationFn: (sessionId: string) =>
      api.post<{
        data: { removed: number; fieldsReverted: number; kept: number };
      }>(`/api/v1/contacts/sync-sessions/${sessionId}/revert`, {}),
    onSuccess: (res) => {
      void qc.resetQueries({ queryKey: ['contacts'] });
      toast.success(
        res.data.removed > 0 ? `Removed ${res.data.removed} contacts.` : 'Nothing left to remove.',
      );
    },
    onError: () => toast.error('Could not undo that sync.'),
  });

  // `enabled` covers dialog-closed and wrong-step; the function form of refetchInterval
  // covers terminal states. Without both, closing the dialog mid-wait left an
  // authenticated 2s poll running for the life of the page (this component is permanently
  // mounted by the contacts page), and expiry never stopped it either.
  const poll = useQuery({
    queryKey: ['contact-sync', 'session', session?.id],
    queryFn: () =>
      api.get<{ data: ContactSyncSession }>(`/api/v1/contacts/sync-sessions/${session!.id}`),
    enabled: open && step === 'qr' && !!session,
    refetchInterval: (query) => {
      const st = query.state.data?.data.status;
      // 'review' is terminal for polling — the tenant has been sent to the queue.
      // 'importing' deliberately is NOT: an apply is still in flight.
      return st === 'completed' || st === 'expired' || st === 'failed' || st === 'review'
        ? false
        : 2000;
    },
  });

  const live = poll.data?.data;

  useEffect(() => {
    if (!live) return;
    if (live.status === 'completed') {
      setStep('done');
      void qc.resetQueries({ queryKey: ['contacts'] });
    }
    // Staged instead of imported. The queue cannot live in this dialog — it is
    // sm:max-w-lg and wipes its state on close — so hand off to the review page.
    if (live.status === 'review') {
      onOpenChange(false);
      router.push(`/contacts/sync/${live.id}`);
    }
  }, [live, qc, router, onOpenChange]);

  const expired = live?.status === 'expired';
  const failed = live?.status === 'failed';
  const isWhatsapp = device === 'whatsapp';
  // WhatsApp pairing codes arrive asynchronously from the ingest service, so there is a
  // real gap between minting the session and having anything to show.
  const waQr = live?.waQr ?? null;
  const waLinked = live?.status === 'opened' && isWhatsapp;

  const startSync = (kind: ContactSyncDeviceKind) =>
    create.mutate({
      deviceKind: kind,
      // Meaningless for WhatsApp: JIDs are already full international numbers, and
      // prefixing one would corrupt it.
      defaultDialCode: kind === 'whatsapp' ? null : dialCode || null,
      marketingAttested: attested,
      // Blank stays blank all the way down. An empty string would fail the min(1) schema,
      // and substituting the member's name here would turn "they didn't answer" into a
      // confident claim about a phone nobody identified.
      syncedByLabel: syncedBy.trim() || null,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sync contacts with phone</DialogTitle>
          <DialogDescription>
            Copy the contacts saved on your phone into Hader. Nothing is sent until you choose to
            share it.
          </DialogDescription>
        </DialogHeader>

        {step === 'device' ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">How would you like to share them?</p>
            <div className={whatsappAvailable ? 'grid grid-cols-3 gap-3' : 'grid grid-cols-2 gap-3'}>
              <button
                type="button"
                onClick={() => {
                  setDevice('android');
                  setStep('options');
                }}
                className="flex flex-col items-center gap-2 rounded-lg border border-border p-5 transition hover:border-primary hover:bg-accent"
              >
                <Smartphone className="size-7" aria-hidden />
                <span className="text-sm font-medium">Android</span>
                <span className="text-center text-[11px] text-muted-foreground">
                  Pick contacts on your phone
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setDevice('ios');
                  setStep('options');
                }}
                className="flex flex-col items-center gap-2 rounded-lg border border-border p-5 transition hover:border-primary hover:bg-accent"
              >
                <Apple className="size-7" aria-hidden />
                <span className="text-sm font-medium">iPhone</span>
                <span className="text-center text-[11px] text-muted-foreground">
                  Export and upload a file
                </span>
              </button>
              {whatsappAvailable ? (
                <button
                  type="button"
                  onClick={() => {
                    setDevice('whatsapp');
                    setStep('options');
                  }}
                  className="flex flex-col items-center gap-2 rounded-lg border border-border p-5 transition hover:border-primary hover:bg-accent"
                >
                  <MessageCircle className="size-7" aria-hidden />
                  <span className="text-sm font-medium">WhatsApp</span>
                  <span className="text-center text-[11px] text-muted-foreground">
                    Works on any phone
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 'options' && device ? (
          <div className="space-y-4">
            {/* Asked as "whose phone", never "your name". The person at the keyboard is
                often not the person holding the handset, and a field labelled as the author
                would collect a confident wrong answer from a prefill nobody re-read. */}
            <div className="space-y-1.5">
              <Label htmlFor="synced-by">Whose phone is this?</Label>
              <Input
                id="synced-by"
                value={syncedBy}
                maxLength={CONTACT_SYNC_LABEL_MAX_CHARS}
                onChange={(e) => setSyncedBy(e.target.value)}
                placeholder="Rita's iPhone, Shop counter phone…"
              />
              <p className="text-xs text-muted-foreground">
                Saved with every contact this adds, so you can find them later — or undo the
                whole batch if the wrong phone gets synced. Optional.
              </p>
            </div>

            {isWhatsapp ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                <p className="text-xs whitespace-pre-line text-amber-900 dark:text-amber-200">
                  {CONTACT_SYNC_WA_NOTICE_TEXT}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="dial-code">Country code for local numbers</Label>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">+</span>
                  <Input
                    id="dial-code"
                    value={dialCode}
                    inputMode="numeric"
                    maxLength={4}
                    onChange={(e) => setDialCode(e.target.value.replace(/\D/g, ''))}
                    className="w-28"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Most numbers in a phone are saved the local way, like 03 123 456. This turns those
                  into full numbers. Contacts already saved with a + are left alone; local ones are
                  skipped if you leave this empty.
                </p>
              </div>
            )}

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
                className="mt-1 size-4"
              />
              <span className="text-xs whitespace-pre-line text-muted-foreground">
                {CONTACT_SYNC_ATTESTATION_TEXT}
              </span>
            </label>

            <DialogFooter>
              <Button variant="secondary" onClick={() => setStep('device')}>
                Back
              </Button>
              <Button disabled={create.isPending} onClick={() => startSync(device)}>
                {create.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                {isWhatsapp ? 'Show WhatsApp code' : 'Show QR code'}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 'qr' && session && device ? (
          <div className="space-y-4">
            <div className="flex min-h-[232px] items-center justify-center">
              {isWhatsapp ? (
                waQr ? (
                  <div className="rounded-lg border border-border bg-white p-4">
                    {/* The ingest service sends the raw WhatsApp pairing payload; we
                        render it here, exactly like the android/ios QR. */}
                    <QRCodeSVG value={waQr} size={200} level="M" marginSize={4} />
                  </div>
                ) : waLinked ? (
                  <div className="flex flex-col items-center gap-2 text-emerald-700">
                    <Check className="size-8" />
                    <span className="text-sm">Linked — copying your contacts…</span>
                  </div>
                ) : expired || failed ? (
                  // Terminal: the message below says what happened. A spinner here read as
                  // "still working" directly above an error saying it had stopped.
                  <div className="text-sm text-muted-foreground">Not linked.</div>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-6 animate-spin" />
                    <span className="text-sm">Preparing your WhatsApp code…</span>
                  </div>
                )
              ) : session.url ? (
                <div className="rounded-lg border border-border bg-white p-4">
                  <QRCodeSVG value={session.url} size={200} level="M" marginSize={4} />
                </div>
              ) : null}
            </div>

            <ol className="space-y-1.5 text-sm text-muted-foreground">
              {STEPS[device].map((s, i) => (
                <li key={s} className="flex gap-2">
                  <span className="font-medium text-foreground">{i + 1}.</span>
                  {s}
                </li>
              ))}
            </ol>

            <div className="flex items-center justify-center gap-2 text-sm">
              {expired ? (
                <span className="text-destructive">This code expired. Generate a new one.</span>
              ) : failed ? (
                <span className="text-destructive">
                  {live?.failureReason ?? 'That did not work. Try again.'}
                </span>
              ) : live?.status === 'opened' && !isWhatsapp ? (
                <>
                  <Check className="size-4 text-emerald-600" />
                  <span className="text-emerald-700">Phone connected — waiting for contacts…</span>
                </>
              ) : !isWhatsapp || waQr ? (
                <>
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  <span className="text-muted-foreground">Waiting for you to scan…</span>
                </>
              ) : null}
            </div>

            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => {
                  // Drop the minted session. Keeping it meant "Show QR code" created a
                  // SECOND simultaneously-valid token — and if the tenant had already
                  // scanned (the very reason to press Back, to fix the dial code) their
                  // upload landed under the old settings and was never shown.
                  setSession(null);
                  setStep('options');
                }}
              >
                Back
              </Button>
              {expired || failed ? (
                <Button disabled={create.isPending} onClick={() => startSync(device)}>
                  <RefreshCw className="size-4" /> New code
                </Button>
              ) : null}
            </DialogFooter>
          </div>
        ) : null}

        {step === 'done' && live ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-2 py-4">
              <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100">
                <Check className="size-6 text-emerald-600" />
              </div>
              <p className="text-lg font-medium">Contacts synced</p>
              {live.syncedByLabel ? (
                <p className="text-xs text-muted-foreground">
                  Tagged <span className="font-medium text-foreground">{live.syncedByLabel}</span>
                </p>
              ) : null}
              {live.waPhone ? (
                <p className="text-xs text-muted-foreground">
                  From WhatsApp account +{live.waPhone}
                </p>
              ) : null}
            </div>

            <dl className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-md border border-border p-3">
                <dt className="text-xs text-muted-foreground">Added</dt>
                <dd className="text-xl font-semibold">{live.contactsCreated}</dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-xs text-muted-foreground">Updated</dt>
                <dd className="text-xl font-semibold">{live.contactsUpdated}</dd>
              </div>
              <div className="rounded-md border border-border p-3">
                <dt className="text-xs text-muted-foreground">Skipped</dt>
                <dd className="text-xl font-semibold">{live.contactsSkipped}</dd>
              </div>
            </dl>
            {/* Honest, specific lines derived from the per-row ledger. The previous copy
                asserted every skip was an unusable number, which folded genuine write
                failures and deliberately-not-resurrected deletions under a false label. */}
            <ul className="space-y-1.5">
              {summarizeContactSync({
                received: live.contactsReceived,
                created: live.contactsCreated,
                updated: live.contactsUpdated,
                unchanged: live.breakdown?.unchanged ?? 0,
                named: live.breakdown?.named ?? 0,
                skippedUnusable: live.breakdown?.skippedUnusable ?? live.contactsSkipped,
                skippedDeleted: live.breakdown?.skippedDeleted ?? 0,
                skippedFailed: live.breakdown?.skippedFailed ?? 0,
                waReachable: live.breakdown?.waReachable ?? 0,
              }).map((line) => (
                <li
                  key={line.text}
                  className={
                    line.tone === 'warning'
                      ? 'text-xs text-amber-700 dark:text-amber-400'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {line.text}
                </li>
              ))}
            </ul>

            {undo.isSuccess ? (
              <p className="text-xs text-muted-foreground">
                Removed {undo.data.data.removed}
                {undo.data.data.kept > 0
                  ? `. Kept ${undo.data.data.kept} that have since been messaged, edited, or opted out.`
                  : '.'}
              </p>
            ) : null}

            <DialogFooter>
              {/* Undo is only offered while it can actually do something. The ledger is
                  pruned on the same window, so a button beyond it would 404 silently. */}
              {!undo.isSuccess && (live.undoableCount ?? 0) > 0 ? (
                <Button
                  variant="secondary"
                  disabled={undo.isPending}
                  onClick={() => undo.mutate(live.id)}
                >
                  {undo.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Undo this sync
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 'qr' && device ? (
          <p className="sr-only" aria-live="polite">
            {DEVICE_LABEL[device]} sync in progress
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
