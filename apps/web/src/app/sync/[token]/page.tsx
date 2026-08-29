'use client';

// The PHONE-facing page. Opened by scanning the QR shown in the portal.
//
// Deliberately outside the (dashboard) route group: the person holding the phone is not
// logged in, and requiring a login here would defeat the entire point of the QR. The
// token in the URL is the credential — short-lived, single-use, and useless once spent.
//
// Two flows because the platforms genuinely differ:
//   Android — Chrome implements the Contact Picker API, so the OS itself renders the
//             picker and the user chooses who to share. We ALSO always offer the export
//             route, because "send all my contacts" is what most people actually want.
//   iOS     — Safari does not implement Contact Picker at all, so exporting is the only
//             path. The instructions have to carry someone who has never done it.
//
// Styling uses the app's design TOKENS, not a raw palette. The first version hard-coded
// neutral-*, which the root layout's dark mode does not remap: on a phone set to dark the
// card went near-black while the text stayed dark grey — 1.7:1 contrast, an unreadable
// page that threw no error.
import { Check, Loader2, Upload, Users } from 'lucide-react';
import { use, useCallback, useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface PublicSession {
  status: string;
  deviceKind: 'android' | 'ios' | 'whatsapp';
  organizationName: string;
  defaultDialCode: string | null;
  expiresAt: string;
}

interface SyncResult {
  received: number;
  created: number;
  updated: number;
  skipped: number;
  /**
   * 'staged' means NOTHING has been imported — the run is waiting for the tenant to review
   * it on the desktop. Staging is the common case, not the edge one: it fires above 50
   * contacts or whenever the attestation was ticked.
   *
   * The field shipped on the API and was never read here, so every staged sync ended on
   * "All done — 0 added, 0 updated", which is both a lie and a contradiction of the desktop
   * screen the same person is about to walk back to.
   */
  mode?: 'imported' | 'staged';
}

interface PickedContact {
  name?: string[];
  tel?: string[];
  email?: string[];
}
interface ContactsManagerLike {
  select(props: string[], opts?: { multiple?: boolean }): Promise<PickedContact[]>;
}

function contactPicker(): ContactsManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const c = (navigator as unknown as { contacts?: ContactsManagerLike }).contacts;
  if (!c || typeof c.select !== 'function') return null;
  if (typeof window !== 'undefined' && window.top !== window.self) return null;
  return c;
}

/**
 * Drop PHOTO/LOGO before the file leaves the phone.
 *
 * An iOS "export all" embeds every contact photo as base64 and routinely produces a 40 MB
 * file; stripping takes it to well under a megabyte. It is also simply not our business to
 * receive photographs of a tenant's customers to import a phone book.
 */
function stripPhotos(vcf: string): string {
  const lines = vcf.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const isContinuation = /^[ \t]/.test(line);
    if (skipping && isContinuation) continue;
    skipping = false;
    if (/^(PHOTO|LOGO|SOUND|KEY)[;:]/i.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\r\n');
}

export default function PhoneSyncPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [session, setSession] = useState<PublicSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  // Set when the OS picker exists but refuses to open (Samsung Internet does this), so we
  // can fall back instead of leaving a button that does nothing.
  const [pickerFailed, setPickerFailed] = useState(false);
  const [expired, setExpired] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/contact-sync/s/${encodeURIComponent(token)}`);
        if (!res.ok) throw new Error('invalid');
        const body = (await res.json()) as { data: PublicSession };
        if (!cancelled) setSession(body.data);
      } catch {
        if (!cancelled) setLoadError('This link has expired or has already been used.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The iOS path sends people into another app for minutes at a time, so tell them how
  // long they have rather than letting them discover it after all the work.
  const [minsLeft, setMinsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!session) return;
    const tick = () => {
      const ms = new Date(session.expiresAt).getTime() - Date.now();
      setMinsLeft(Math.max(0, Math.ceil(ms / 60_000)));
      if (ms <= 0) setExpired(true);
    };
    tick();
    const id = setInterval(tick, 20_000);
    return () => clearInterval(id);
  }, [session]);

  const send = useCallback(
    async (path: string, payload: unknown) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `${API_URL}/api/v1/contact-sync/s/${encodeURIComponent(token)}/${path}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(120_000),
          },
        );
        // The API envelope is { error: { code, message } } — reading body.message (as the
        // first version did) is always undefined, so every authored message died and the
        // generic fallback always won. .catch(null) covers a non-JSON gateway body during
        // a deploy, which would otherwise render a raw JSON parse error to the tenant.
        const body = (await res.json().catch(() => null)) as {
          data?: SyncResult;
          error?: { message?: string };
        } | null;
        if (!res.ok) {
          if (res.status === 404) setExpired(true);
          throw new Error(body?.error?.message ?? 'Could not sync those contacts.');
        }
        setResult(body!.data!);
      } catch (e) {
        const msg =
          e instanceof DOMException && e.name === 'TimeoutError'
            ? 'That took too long. Check your connection and try again.'
            : e instanceof Error
              ? e.message
              : 'Something went wrong.';
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  const pick = useCallback(async () => {
    const picker = contactPicker();
    if (!picker) return;
    try {
      const picked = await picker.select(['name', 'tel', 'email'], { multiple: true });
      if (picked.length === 0) return; // the user tapped cancel — not an error
      await send('contacts', {
        contacts: picked.map((c) => ({
          name: c.name?.[0] ?? null,
          phones: c.tel ?? [],
          email: c.email?.[0] ?? null,
        })),
      });
    } catch (err) {
      // A cancelled picker is already handled above by the empty-selection check, so
      // anything landing here is a genuine failure — most often Samsung Internet, which
      // exposes navigator.contacts and then throws on select(). Swallowing it silently
      // (as the first version did) left a button that did nothing, forever.
      if ((err as DOMException)?.name === 'AbortError') return;
      setPickerFailed(true);
      setError('Your phone could not open the contact picker. Use the file option below.');
    }
  }, [send]);

  const onFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      let text: string;
      try {
        text = await file.text();
      } catch {
        // Reading can genuinely fail — an iCloud/Drive file that has not been downloaded
        // yet is the common one. Previously this rejected outside every try/catch and
        // outside setBusy, so the tap produced no visible change whatsoever.
        setBusy(false);
        setError(
          'Could not read that file. If it is stored in iCloud or Drive, open it once so it downloads, then try again.',
        );
        return;
      }
      await send('vcard', { vcard: stripPhotos(text) });
    },
    [send],
  );

  // ---- render -------------------------------------------------------------

  if (loadError) {
    return (
      <Shell>
        <p className="text-center text-lg font-medium">Link expired</p>
        <p className="mt-2 text-center text-sm text-foreground-muted">{loadError}</p>
        <p className="mt-4 text-center text-sm text-foreground-muted">
          Go back to Hader on your computer and tap “Sync contacts with phone” again.
        </p>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <div className="flex justify-center py-8">
          <Loader2 className="size-6 animate-spin text-foreground-subtle" />
        </div>
      </Shell>
    );
  }

  if (result) {
    // Two genuinely different endings. Reporting "added" for a staged run would contradict
    // the desktop, which is showing a review queue with nothing imported yet.
    const staged = result.mode === 'staged';
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-4">
          <div
            className={
              staged
                ? 'flex size-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950'
                : 'flex size-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950'
            }
          >
            {staged ? (
              <Upload className="size-7 text-amber-600 dark:text-amber-400" />
            ) : (
              <Check className="size-7 text-emerald-600 dark:text-emerald-400" />
            )}
          </div>
          <p className="text-lg font-medium">{staged ? 'Sent for review' : 'All done'}</p>
          {staged ? (
            <p className="text-center text-sm text-foreground-muted">
              {result.received} contacts sent. Nothing has been added yet — finish on your
              computer, where you can check the list and choose what to keep.
            </p>
          ) : (
            <p className="text-center text-sm text-foreground-muted">
              {result.created} added, {result.updated} updated
              {result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.
            </p>
          )}
          <p className="mt-2 text-center text-sm text-foreground-subtle">
            You can close this page and go back to your computer.
          </p>
        </div>
      </Shell>
    );
  }

  if (expired) {
    return (
      <Shell>
        <p className="text-center text-lg font-medium">This link expired</p>
        <p className="mt-2 text-center text-sm text-foreground-muted">
          Go back to Hader on your computer and tap “Sync contacts with phone” again to get a
          fresh code.
        </p>
      </Shell>
    );
  }

  const isAndroid = session.deviceKind === 'android';
  const hasPicker = contactPicker() !== null && !pickerFailed;
  const showPicker = isAndroid && hasPicker;

  // Android, but the picker is not available. Almost always because the QR was opened in
  // an in-app WebView — most camera and QR-scanner apps do that, and Samsung Internet
  // exposes navigator.contacts and then throws on select(). Chrome is the only Android
  // browser that actually implements the Contact Picker API.
  //
  // Previously the page just silently rendered the file flow, so the tenant had no idea
  // the picker existed or why it had gone. Say it, and offer the one-tap fix.
  const androidNeedsChrome = isAndroid && !hasPicker;
  // Android intent URL that forces Chrome specifically. Falls back harmlessly to a
  // no-op on anything that does not understand it.
  const chromeIntentUrl =
    typeof window === 'undefined'
      ? '#'
      : `intent://${window.location.host}${window.location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;

  return (
    <Shell>
      <div className="flex flex-col items-center gap-2 pb-4">
        <div className="flex size-12 items-center justify-center rounded-full bg-surface-muted">
          <Users className="size-6 text-foreground" aria-hidden />
        </div>
        <h1 className="text-center text-lg font-medium">Share contacts</h1>
        <p className="text-center text-sm text-foreground-muted">
          with <span className="font-medium text-foreground">{session.organizationName}</span> on
          Hader
        </p>
      </div>

      {showPicker ? (
        <>
          <button
            type="button"
            onClick={pick}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-3.5 text-base font-medium text-white disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Users className="size-5" />}
            {busy ? 'Sending…' : 'Choose contacts'}
          </button>
          <p className="mt-3 text-center text-xs text-foreground-subtle">
            Your phone will ask which contacts to share. Only the ones you pick are sent.
          </p>

          {/* "Send everything" is what most people actually want, and the picker makes them
              tap every name. Always offer the export route as a peer, not a fallback. */}
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-center text-xs text-foreground-subtle">
              Want to send <span className="font-medium text-foreground-muted">all</span> your
              contacts at once?
            </p>
            <button
              type="button"
              onClick={() => setPickerFailed(true)}
              className="mt-2 w-full rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground"
            >
              Export my whole contact list
            </button>
          </div>
        </>
      ) : (
        <>
          {androidNeedsChrome ? (
            <div className="mb-5 rounded-lg border border-border bg-surface-muted p-4">
              <p className="text-sm font-medium text-foreground">
                Want to pick contacts one by one?
              </p>
              <p className="mt-1 text-xs text-foreground-muted">
                That needs Chrome. This page opened in a different browser, which can’t show
                your phone’s contact picker.
              </p>
              <a
                href={chromeIntentUrl}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-3 text-sm font-medium text-white"
              >
                <Users className="size-4" aria-hidden /> Open in Chrome
              </a>
              <p className="mt-3 text-center text-xs text-foreground-subtle">
                Or send your whole list using the steps below — no Chrome needed.
              </p>
            </div>
          ) : null}

          <Instructions kind={session.deviceKind} />

          <label
            className="mt-5 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-3.5 text-base font-medium text-white focus-within:ring-2 focus-within:ring-brand-400 focus-within:ring-offset-2"
            aria-label="Choose your exported contacts file"
          >
            {busy ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
            {busy ? 'Sending…' : 'Choose contacts file'}
            <input
              ref={fileRef}
              type="file"
              accept=".vcf,text/vcard,text/x-vcard"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Clear it so re-picking the SAME file after a failure fires again;
                // otherwise the retry is a dead button.
                e.target.value = '';
                if (f) void onFile(f);
              }}
            />
          </label>

          {session.deviceKind === 'android' && pickerFailed ? (
            <button
              type="button"
              onClick={() => {
                setPickerFailed(false);
                setError(null);
              }}
              className="mt-3 w-full text-center text-xs text-foreground-subtle underline"
            >
              Go back to picking contacts one by one
            </button>
          ) : null}
        </>
      )}

      {error ? (
        <p className="mt-4 text-center text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      <p className="mt-6 text-center text-xs text-foreground-subtle">
        Contact names, numbers and emails are saved to your Hader account. Contact photos are
        never uploaded.
        {minsLeft !== null && minsLeft > 0 ? ` This link works for ${minsLeft} more minutes.` : ''}
      </p>
    </Shell>
  );
}

/**
 * The export instructions.
 *
 * Written for someone who has never exported contacts before, which is the realistic
 * user. Every step names what they will see, each platform's menu is spelled out because
 * Samsung, Google and Xiaomi all differ, and there is an explicit escape hatch — because
 * on iOS in particular, some people genuinely cannot find Export.
 */
function Instructions({ kind }: { kind: 'android' | 'ios' | 'whatsapp' }) {
  if (kind === 'ios') {
    return (
      <div className="space-y-3">
        <ol className="space-y-2.5 text-sm text-foreground-muted">
          <Step n={1}>
            Open the <b className="text-foreground">Contacts</b> app (the grey one with the
            silhouette). If you only have <b className="text-foreground">Phone</b>, open that and
            tap <b className="text-foreground">Contacts</b> at the bottom.
          </Step>
          <Step n={2}>
            Tap <b className="text-foreground">Lists</b> at the very top left. Do not see it? Tap
            the <b className="text-foreground">back arrow</b> at the top left first — that takes
            you to the Lists screen.
          </Step>
          <Step n={3}>
            Press and hold on <b className="text-foreground">All Contacts</b> (or any list) until a
            menu appears, then tap <b className="text-foreground">Export</b>.
          </Step>
          <Step n={4}>
            Tap <b className="text-foreground">Save to Files</b>, choose{' '}
            <b className="text-foreground">On My iPhone</b>, and tap{' '}
            <b className="text-foreground">Save</b>.
          </Step>
          <Step n={5}>Come back to this page and tap the button below.</Step>
        </ol>
        <p className="rounded-md bg-surface-muted p-3 text-xs text-foreground-subtle">
          <b className="text-foreground-muted">Can’t find Export?</b> Older iPhones don’t have it.
          Go back to your computer and choose the <b className="text-foreground-muted">WhatsApp</b>{' '}
          option instead — it copies your contacts without any of this.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-2.5 text-sm text-foreground-muted">
        <Step n={1}>
          Open your <b className="text-foreground">Contacts</b> app.
        </Step>
        <Step n={2}>Find the export option — it depends on your phone:</Step>
      </ol>
      <ul className="space-y-1.5 pl-8 text-xs text-foreground-subtle">
        <li>
          <b className="text-foreground-muted">Samsung</b> — menu (☰) →{' '}
          <b className="text-foreground-muted">Manage contacts</b> → Import/export contacts →
          Export
        </li>
        <li>
          <b className="text-foreground-muted">Google Contacts</b> (Pixel and most phones) —{' '}
          <b className="text-foreground-muted">Fix &amp; manage</b> → Export to file
        </li>
        <li>
          <b className="text-foreground-muted">Xiaomi / Redmi</b> — Settings →{' '}
          <b className="text-foreground-muted">Import &amp; export</b> → Export to storage
        </li>
      </ul>
      <ol className="space-y-2.5 text-sm text-foreground-muted">
        <Step n={3}>
          Save the file to your phone. It ends in <b className="text-foreground">.vcf</b>.
        </Step>
        <Step n={4}>Come back to this page and tap the button below.</Step>
      </ol>
      <p className="rounded-md bg-surface-muted p-3 text-xs text-foreground-subtle">
        <b className="text-foreground-muted">Can’t find it?</b> Go back to your computer and choose
        the <b className="text-foreground-muted">WhatsApp</b> option — it copies your contacts
        without any menus.
      </p>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-elevated text-xs font-medium text-foreground">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

/** Self-contained shell — this page renders on a phone, outside the portal chrome. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-surface-muted px-5 py-10">
      <div className="mx-auto w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-sm">
        {children}
      </div>
    </main>
  );
}
