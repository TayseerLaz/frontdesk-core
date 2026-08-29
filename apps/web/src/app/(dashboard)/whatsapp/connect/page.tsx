'use client';

// Meta Embedded Signup — COEXISTENCE onboarding. The tenant connects the number
// that is already live in their WhatsApp Business app.
//
// FIVE THINGS HERE ARE LOAD-BEARING. Each one fails SILENTLY if broken:
//
//  1. This page must be reached by a PLAIN <a href="/app/whatsapp/connect">.
//     Cross-Origin-Opener-Policy is decided at DOCUMENT LOAD (set per-path in
//     src/middleware.ts). A next/link soft navigation carries the previous
//     page's `same-origin`, window.opener is severed, and the popup can never
//     talk back. Nothing is logged anywhere.
//
//  2. The SDK <script> is CREATED FROM JS, never written into markup and never
//     nonced. Our CSP is `script-src 'self' 'nonce-…' 'strict-dynamic'`, which
//     IGNORES host allowlists but propagates trust to a script element created
//     by already-trusted code — this bundle. A nonce would buy nothing anyway:
//     the (dashboard) layout is a client component that withholds `children`
//     until the session resolves, so nothing on this route is ever
//     parser-inserted.
//
//  3. window.fbAsyncInit is assigned BEFORE the tag is appended, so the SDK
//     cannot execute before its init callback exists.
//
//  4. The code and the WABA id arrive on TWO channels with no documented
//     ordering — the FB.login callback and a window `message` event. Both are
//     parked in a ref and the POST fires as soon as both are present.
//
//  5. That code lives 30 SECONDS and cannot be retried, so nothing is awaited
//     between having both halves and sending them.
//
// And the consequence that makes error copy matter more than usual: finishing
// Meta's popup UNLINKS the tenant's WhatsApp Web/Desktop companion devices, and
// there is no API undo. "Try again" is only honest before the popup succeeds.

import { brand } from '@/lib/brand';
import type {
  WhatsAppChannelDto,
  WhatsAppEmbeddedSignupBody,
  WhatsAppEmbeddedSignupConfig,
} from '@platform/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  History,
  Link2,
  MessageCircle,
  Monitor,
  RefreshCcw,
  ShieldCheck,
  Smartphone,
  Users,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

// Exactly the URL from Meta's implementation guide.
const FB_SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';

// EXACT-MATCH allowlist. Meta's own sample uses
// `event.origin.endsWith('facebook.com')`, which also accepts
// https://evil-facebook.com — and this listener decides which WhatsApp Business
// Account gets bound to this organisation. Fail closed instead.
const FB_ORIGINS = new Set([
  'https://www.facebook.com',
  'https://web.facebook.com',
  'https://business.facebook.com',
  'https://m.facebook.com',
]);
const isFacebookOrigin = (origin: string): boolean =>
  FB_ORIGINS.has(origin) || origin.endsWith('.facebook.com');

// The two documented events that mean "a number was connected".
//  FINISH                                  — new number: waba_id + phone_number_id
//  FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING — coexistence: waba_id ONLY
// Matched EXACTLY, not by prefix: FINISH_ONLY_WABA means the tenant finished
// WITHOUT adding a number, and treating that as success would post an exchange
// that fails while telling them something false about why.
const FINISH_EVENTS = new Set(['FINISH', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING']);

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}
interface FbSdk {
  init(params: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(cb: (response: FbLoginResponse) => void, opts: Record<string, unknown>): void;
}
declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

interface SignupSession {
  type?: string;
  event?: string;
  version?: number;
  data?: {
    waba_id?: string;
    phone_number_id?: string;
    current_step?: string;
    error_message?: string;
    error_code?: string | number;
  };
}

// The flow ENDS with the WhatsApp Business app scanning a QR shown on this
// screen — it is physically impossible to finish on the phone itself, and
// in-app browsers (a link tapped inside WhatsApp) also suppress the Meta
// popup. Detect both and say so up front instead of failing silently — this
// is the single most likely real-world failure.
function detectWrongDevice(): 'in-app' | 'mobile' | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/WhatsApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|Snapchat/i.test(ua)) return 'in-app';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
  return null;
}

// The three-stage progress rail at the top of the page.
function ConnectStepper({ stage }: { stage: 0 | 1 | 2 }) {
  const steps = ['Prepare', 'Approve with Meta', 'Connected'];
  return (
    <div className="mb-6 flex items-center gap-0" aria-label={`Step ${stage + 1} of 3`}>
      {steps.map((label, i) => (
        <div key={label} className="flex flex-1 items-center">
          <div className="flex items-center gap-2">
            <span
              className={
                i < stage
                  ? 'flex size-7 shrink-0 items-center justify-center rounded-full bg-success text-white'
                  : i === stage
                    ? 'flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white'
                    : 'flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-foreground-subtle'
              }
            >
              {i < stage ? <CheckCircle2 className="size-4" /> : <span className="text-xs font-semibold">{i + 1}</span>}
            </span>
            <span
              className={
                i === stage
                  ? 'whitespace-nowrap text-sm font-semibold text-foreground'
                  : 'whitespace-nowrap text-sm text-foreground-subtle'
              }
            >
              {label}
            </span>
          </div>
          {i < steps.length - 1 ? (
            <div className={`mx-3 h-px flex-1 ${i < stage ? 'bg-success' : 'bg-border'}`} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

// One compact fact row in the "before you connect" card.
function FactRow({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border/70 bg-surface px-3 py-2.5">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-500">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 text-sm">
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">{children}</p>
      </div>
    </div>
  );
}

export default function WhatsAppConnectPage() {
  const { session } = useSession();
  const isOrgAdmin = session?.organization.role === 'admin';

  // Both routes are requireRole('admin'), so don't fire the query for an
  // editor/viewer — a 403 toast is noise, not information.
  const configQ = useQuery({
    queryKey: ['whatsapp-embedded-signup-config'],
    queryFn: () =>
      api.get<{ data: WhatsAppEmbeddedSignupConfig }>('/api/v1/whatsapp/embedded-signup/config'),
    enabled: isOrgAdmin,
    staleTime: 5 * 60_000,
  });
  const cfg = configQ.data?.data ?? null;

  const [sdkReady, setSdkReady] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'popup' | 'exchanging'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  // Set when Meta's popup SUCCEEDED but our side did not. The tenant's
  // companion devices are already unlinked at that point, so the copy must not
  // say "try again".
  const [halfDone, setHalfDone] = useState(false);
  const [connected, setConnected] = useState<WhatsAppChannelDto | null>(null);
  // Set after mount (never during SSR render) so hydration stays consistent.
  const [wrongDevice, setWrongDevice] = useState<'in-app' | 'mobile' | null>(null);
  useEffect(() => setWrongDevice(detectWrongDevice()), []);
  // Last session event, rendered on the page: the first real run is the only
  // way to learn which Embedded Signup version this config resolves to.
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  // ---- history consent ----------------------------------------------------
  // Three separate ticks, all required, all default FALSE. Connecting a number
  // and handing over 180 days of customer conversations are different acts, so
  // this is opt-IN: leave them unticked and the number still connects, contacts
  // still sync, and we simply never ask Meta for the history.
  //
  // It has to be collected HERE and not in Settings afterwards: Meta sends the
  // history once, inside a 24-hour window, and it cannot be re-requested
  // without disconnecting the number and starting over. There is no later
  // moment at which asking would still work.
  const [ackScope, setAckScope] = useState(false);
  const [ackDuty, setAckDuty] = useState(false);
  const [ackEffects, setAckEffects] = useState(false);
  const historyConsentGiven = ackScope && ackDuty && ackEffects;

  // ---- load + init the SDK ------------------------------------------------
  useEffect(() => {
    const appId = cfg?.appId;
    const version = cfg?.graphVersion;
    if (!cfg?.configured || !appId || !version) return;
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      setSdkReady(true);
      return;
    }
    // Assigned BEFORE the tag exists — the SDK calls this the moment it runs.
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      setSdkReady(true);
    };
    const script = document.createElement('script');
    script.src = FB_SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () =>
      setProblem("Meta's sign-up script could not load. Check the network and reload this page.");
    document.body.appendChild(script);
  }, [cfg?.configured, cfg?.appId, cfg?.graphVersion]);

  const exchange = useMutation({
    mutationFn: (body: { code: string; wabaId: string; phoneNumberId?: string }) =>
      api.post<{ data: WhatsAppChannelDto }>('/api/v1/whatsapp/embedded-signup/exchange', body),
    onSuccess: (res) => {
      setConnected(res.data);
      toast.success(`${res.data.displayPhoneNumber ?? 'Your number'} is connected`);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.payload.message : 'Connecting failed.';
      // Meta already finished by the time this POST runs. Never invite a retry.
      setHalfDone(true);
      setProblem(msg);
      toast.error(msg);
    },
    onSettled: () => setPhase('idle'),
  });

  const pending = useRef<{
    code?: string;
    wabaId?: string;
    phoneNumberId?: string;
    // Snapshotted at the moment of the click, not read at send time. The tenant
    // consented to what was on screen when they pressed the button, and a ref
    // also keeps trySend's closure honest — reading the checkbox state here
    // would capture whatever it was when the callback was last rebuilt.
    historyConsent?: WhatsAppEmbeddedSignupBody['historyConsent'];
  }>({});
  const fired = useRef(false);

  const trySend = useCallback(() => {
    const p = pending.current;
    if (fired.current || !p.code || !p.wabaId) return;
    fired.current = true;
    setPhase('exchanging');
    exchange.mutate({
      code: p.code,
      wabaId: p.wabaId,
      // Omit the key entirely when coexistence gave us nothing, rather than
      // sending an empty string the server would have to special-case.
      ...(p.phoneNumberId ? { phoneNumberId: p.phoneNumberId } : {}),
      // Same rule: omitted entirely when unticked. The server treats absence as
      // a refusal, so there is nothing to encode for "no".
      ...(p.historyConsent ? { historyConsent: p.historyConsent } : {}),
    });
  }, [exchange]);

  // ---- session logging: the ONLY channel that carries waba_id -------------
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.origin !== 'string' || !isFacebookOrigin(event.origin)) return;
      if (typeof event.data !== 'string') return;
      let parsed: SignupSession;
      try {
        parsed = JSON.parse(event.data) as SignupSession;
      } catch {
        return; // ordinary non-JSON chatter from the SDK's own frames
      }
      if (parsed.type !== 'WA_EMBEDDED_SIGNUP' || !parsed.event) return;
      // Deliberate: the raw payload is the evidence for which ES version this
      // config resolves to, and whether coexistence ever sends phone_number_id.
      console.info('[embedded-signup] session event', parsed);
      setLastEvent(parsed.event);

      if (FINISH_EVENTS.has(parsed.event)) {
        if (parsed.data?.waba_id) pending.current.wabaId = parsed.data.waba_id;
        if (parsed.data?.phone_number_id) {
          pending.current.phoneNumberId = parsed.data.phone_number_id;
        }
        trySend();
        return;
      }
      if (parsed.event === 'FINISH_ONLY_WABA') {
        setPhase('idle');
        setProblem(
          'Meta finished without connecting a phone number. Start again and make sure you pick the number your WhatsApp Business app uses.',
        );
        return;
      }
      if (parsed.event === 'CANCEL' || parsed.event === 'ERROR') {
        setPhase('idle');
        setProblem(
          parsed.data?.error_message ??
            (parsed.data?.current_step
              ? `You stopped at "${parsed.data.current_step}". Nothing was changed — you can start again.`
              : 'Sign-up was cancelled. Nothing was changed.'),
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [trySend]);

  const start = () => {
    const fb = window.FB;
    const configId = cfg?.configId;
    if (!fb || !configId) return;
    setProblem(null);
    setHalfDone(false);
    setLastEvent(null);
    pending.current = {};
    // Snapshot the consent as it stands right now, against the copy version the
    // server served us. If the server has since shipped new copy the exchange
    // refuses this block rather than accepting agreement to text nobody read.
    if (historyConsentGiven && cfg?.historyConsent.version) {
      pending.current.historyConsent = {
        version: cfg.historyConsent.version,
        acknowledgedScope: true,
        acknowledgedControllerDuty: true,
        acknowledgedOnboardingEffects: true,
      };
    }
    fired.current = false;
    setPhase('popup');
    fb.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          setPhase('idle');
          setProblem(
            'The Meta window closed before finishing. Nothing was changed — you can try again.',
          );
          return;
        }
        pending.current.code = code;
        trySend();
        // If the session event never arrives, the 30-second code dies anyway.
        // Say so rather than spinning: a domain missing from the Meta app's
        // Allowed domains / Valid OAuth redirect URIs produces exactly this —
        // a code with no ids.
        window.setTimeout(() => {
          if (fired.current) return;
          setPhase('idle');
          setHalfDone(true);
          setProblem(
            "Meta did not tell us which WhatsApp account was connected, so we could not finish. Do NOT repeat this — contact support, because Meta's side may already have completed.",
          );
        }, 10_000);
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        // `setup: {}` is verbatim from Meta's implementation guide.
        //
        // featureType is what selects COEXISTENCE ("connect the number already
        // in my WhatsApp Business app") instead of "create a new number". It is
        // documented for Embedded Signup v2 / v2-public-preview / v3 /
        // v3-public-preview, and Meta's v4 page says WhatsApp Business app
        // onboarding "continues to be supported through the feature_type
        // parameter". v4's own extras sample is empty, so on a v4 config this
        // key is at worst redundant. Do NOT send 'coex' or 'coexistence' —
        // both are dead.
        //
        // DO NOT add `sessionInfoVersion` back without testing it first.
        // Meta's own Embedded Signup Builder generates
        // extras={"sessionInfoVersion":"3","version":"v4"} for this exact app
        // and config, so the key is clearly valid SOMEWHERE — but adding it
        // here on 2026-08-24 was the only change to these dialog parameters
        // between a flow that opened Meta's real consent screen (21 Aug) and
        // one that returned Meta's generic "Sorry, something went wrong" on
        // /v20.0/dialog/oauth. Reverted rather than debugged live.
        //
        // Note what the Builder does differently: it sends sessionInfoVersion
        // ALONGSIDE `version: "v4"`, and sends NO `setup` and NO `featureType`.
        // Our shape is one Meta's own tool never emits. If this is retried,
        // send `version: 'v4'` with it, and prove it on a throwaway number
        // before it goes anywhere near a tenant.
        extras: {
          setup: {},
          featureType: 'whatsapp_business_app_onboarding',
        },
      },
    );
  };

  const busy = phase !== 'idle';

  if (connected) {
    const askedForHistory = Boolean(pending.current.historyConsent);
    const nextSteps: Array<{ title: string; detail: string }> = [
      {
        title: 'Your contacts are syncing now',
        detail:
          'Names and numbers from your WhatsApp Business app appear under Contacts over the next few minutes.',
      },
      ...(askedForHistory
        ? [
            {
              title: 'Your past conversations are on their way',
              detail:
                'WhatsApp sends up to 180 days of history in the background. Recent chats arrive first; the rest can take a few hours.',
            },
          ]
        : []),
      {
        title: 'Sign WhatsApp Web / Desktop back in',
        detail:
          'Connecting signed your other devices out. On the phone: WhatsApp Business → Linked devices → Link a device.',
      },
      {
        title: 'Send yourself a test message',
        detail:
          `Message your business number from a personal phone — it appears in the ${brand.name} inbox within seconds.`,
      },
    ];
    return (
      <>
        <PageHeader
          title="Number connected"
          description={`Your WhatsApp Business number is now linked to ${brand.name}.`}
          backHref="/whatsapp"
          backLabel="Back to WhatsApp"
        />
        <ConnectStepper stage={2} />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="flex size-8 items-center justify-center rounded-full bg-success/15 text-success">
                <CheckCircle2 className="size-5" />
              </span>
              {connected.displayPhoneNumber ?? connected.label ?? 'Your number'} is connected
            </CardTitle>
            <CardDescription>
              You can keep answering from the phone, from {brand.name}, or both — they stay in sync.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="space-y-2.5">
              {nextSteps.map((step, i) => (
                <li
                  key={step.title}
                  className="flex items-start gap-3 rounded-md border border-border/70 bg-surface px-3 py-2.5"
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-600">
                    {i + 1}
                  </span>
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-foreground">{step.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">
                      {step.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href="/inbox">
                  Open the inbox <ArrowRight className="ml-1.5 size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/whatsapp">WhatsApp settings</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/bot">Set up your AI assistant</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Connect your WhatsApp Business number"
        description={`Bring the number you already use in WhatsApp Business into ${brand.name}. You keep using the app on your phone.`}
        backHref="/whatsapp"
        backLabel="Back to WhatsApp"
      />

      {!isOrgAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4" /> Ask an admin
            </CardTitle>
            <CardDescription>
              Only an admin on this account can connect a WhatsApp number.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : configQ.isLoading ? (
        <p className="text-sm text-foreground-muted">Loading…</p>
      ) : !cfg?.configured ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4" /> Not available yet
            </CardTitle>
            <CardDescription>
              One-click connecting is not switched on for this server. You can still connect by
              entering your Meta credentials by hand on the{' '}
              <Link href="/whatsapp" className="text-brand-500 underline">
                WhatsApp page
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <ConnectStepper stage={busy ? 1 : 0} />

          {wrongDevice ? (
            <Card className="mb-4 border-warning/50 bg-warning-100/40">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base text-warning">
                  <Monitor className="size-4" />{' '}
                  {wrongDevice === 'in-app'
                    ? 'Open this page in a real browser'
                    : 'Switch to a computer to connect'}
                </CardTitle>
                <CardDescription>
                  {wrongDevice === 'in-app'
                    ? 'You are inside an app\u2019s built-in browser, which blocks the Meta sign-up window. Open example.com in Chrome or Safari — ideally on a computer.'
                    : 'Connecting ends with a QR code that the WhatsApp Business app on your phone must scan — so the phone cannot also be the screen showing it. Open this page on a computer and keep the phone next to you.'}
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageCircle className="size-4" /> What to know before you connect
              </CardTitle>
              <CardDescription>
                It takes about a minute. Use a computer, with the phone that runs WhatsApp Business
                next to you.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                <FactRow icon={Smartphone} title="Keep using WhatsApp on your phone">
                  Nothing moves. Answer from the phone or from {brand.name} — both stay in sync.
                </FactRow>
                <FactRow icon={RefreshCcw} title="WhatsApp Web &amp; Desktop will sign out">
                  Expected, and not undoable from here. Sign back in after: WhatsApp Business →
                  Linked devices → Link a device.
                </FactRow>
                <FactRow icon={Users} title="Your contacts come across automatically">
                  Names and numbers from the app, so you never start from a blank list. Past
                  conversations are separate and optional — see below.
                </FactRow>
                <FactRow icon={Zap} title="Sending is capped at 20 messages per second">
                  Meta&apos;s limit for a number used in both places — well above normal replying.
                </FactRow>
                <FactRow icon={Monitor} title="Finish it in one go">
                  Keep this tab open and the phone unlocked — Meta ends with a QR code the phone
                  scans, and may ask you to confirm on the handset.
                </FactRow>
                <FactRow icon={ShieldCheck} title="Stopping later happens on the phone">
                  WhatsApp Business → Settings → Account → Business Platform → Disconnect. We
                  cannot undo it from here.
                </FactRow>
              </div>
            </CardContent>
          </Card>

          {/* Optional history opt-in. Rendered only when HQ has switched sales_scan
              on for this org — the server enforces the same condition, so a
              hidden card and a refused request agree. Its own card because
              it is a separate decision from connecting the number — and because
              it is the only thing on this page that cannot be undone or redone
              later. */}
          {cfg.historyConsent.available ? (
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="size-4" /> Teach the bot from your past conversations
                <span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
                  optional
                </span>
              </CardTitle>
              <CardDescription>
                WhatsApp can send us up to 180 days of the conversations you have already had, so
                your assistant learns the questions your customers actually ask and the way your
                team answers. Leave this unticked and we never ask for them — the number still
                connects and your contacts still come across.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border border-warning/40 bg-warning-100 px-3 py-2 text-xs text-warning">
                <strong>This happens once.</strong> WhatsApp sends this history a single time,
                within 24 hours of connecting, and will not send it again. Getting it later would
                mean disconnecting your number completely and starting over.
              </div>

              <div className="space-y-3">
                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={ackScope}
                    onChange={(e) => setAckScope(e.target.checked)}
                    disabled={busy}
                    className="mt-0.5 size-4 shrink-0 rounded border-border accent-brand-600"
                  />
                  <span>
                    I want {brand.name} to receive <strong>up to 180 days</strong> of my past customer
                    conversations, both what they sent and what I sent. Group chats are not
                    included, and files older than 14 days arrive as a note rather than the file.
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={ackDuty}
                    onChange={(e) => setAckDuty(e.target.checked)}
                    disabled={busy}
                    className="mt-0.5 size-4 shrink-0 rounded border-border accent-brand-600"
                  />
                  <span>
                    I understand <strong>my customers have not agreed anything with {brand.name}</strong>.
                    Their data stays my responsibility; {brand.name} processes it on my instruction, only
                    for my account, and never to train anything shared with other businesses.
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={ackEffects}
                    onChange={(e) => setAckEffects(e.target.checked)}
                    disabled={busy}
                    className="mt-0.5 size-4 shrink-0 rounded border-border accent-brand-600"
                  />
                  <span>
                    I understand connecting will <strong>sign my other WhatsApp devices out</strong>,
                    and that I must keep opening the WhatsApp Business app every week or two or the
                    connection can lapse.
                  </span>
                </label>
              </div>

              {cfg?.historyConsent.text ? (
                <details className="rounded-md border border-border bg-surface-elevated px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-foreground-muted">
                    Read the full terms ({cfg.historyConsent.version})
                  </summary>
                  {/* Rendered from the server's copy, not duplicated here: the
                      version we display is the version the exchange will accept,
                      and the exact text is what gets stored on the record of what
                      was agreed. */}
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-foreground-muted">
                    {cfg.historyConsent.text}
                  </pre>
                </details>
              ) : null}
            </CardContent>
          </Card>
          ) : null}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Link2 className="size-4" /> Ready
              </CardTitle>
              <CardDescription>
                A Meta window opens on top of this page. Leave this tab open until it finishes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                onClick={start}
                disabled={!sdkReady || busy || wrongDevice !== null}
                loading={busy}
                className="w-full"
              >
                {phase === 'exchanging'
                  ? 'Finishing up…'
                  : phase === 'popup'
                    ? 'Waiting for Meta…'
                    : 'Continue with Meta'}
              </Button>
              {!sdkReady && !problem ? (
                <p className="text-xs text-foreground-subtle">Loading Meta&apos;s sign-up window…</p>
              ) : null}
              {problem ? (
                <p
                  className={halfDone ? 'text-xs text-danger' : 'text-xs text-coral-700'}
                  role="alert"
                >
                  {problem}
                </p>
              ) : null}
              {lastEvent ? (
                <p className="font-mono text-[11px] text-foreground-subtle">{lastEvent}</p>
              ) : null}
            </CardContent>
          </Card>
          </div>
        </>
      )}
    </>
  );
}
