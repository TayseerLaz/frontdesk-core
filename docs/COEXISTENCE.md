# WhatsApp Coexistence — the engineering chapter

> **Scope.** How Coexistence works *in this codebase*: the data flow, the consent gates, the
> handset-echo path, what is built, and what is not. Written 2026-08-28 against `e03c325`.
>
> **This is the code half.** The Meta half — dashboard state, app config, App Review, the traps
> that bite during a real connect — lives in
> **[META-COEXISTENCE-DASHBOARD-CHECKS.md](META-COEXISTENCE-DASHBOARD-CHECKS.md)**, which is
> actively maintained and self-correcting. Read that one before touching anything Meta-side.
> Read this one before touching anything in `apps/`.
>
> **Why this file exists.** [ARCHITECTURE.md](ARCHITECTURE.md) was written 2026-07-22 and the
> whole subsystem post-dates it — it contained zero mentions of coexistence, embedded signup or
> handset replies. This is the chapter it was missing.

---

## 1. What Coexistence is, and why it is worth the trouble

Connecting a business to the WhatsApp Cloud API normally means giving up the WhatsApp Business
app on the phone. For a small business that is a non-starter: the owner *lives* in that app.

**Coexistence is Meta's answer.** The business keeps using WhatsApp on their handset exactly as
before, and the same number is simultaneously connected to the Cloud API. Both work at once.

Commercially it removes the biggest objection in the sales conversation — *"so I lose WhatsApp
on my phone?"* — and it is the only way to obtain three things:

| Stream | Meta webhook field | What it is |
|---|---|---|
| Contact list | `smb_app_state_sync` | Names and numbers from the tenant's own Business app |
| Conversation history | `history` | Up to **180 days** of their past customer conversations |
| Handset replies | `smb_message_echoes` | A live copy of every message they send from their phone |

**All three fields are subscribed on Meta app `1727898828528257`** and have been since
2026-08-20. Do not unsubscribe them (§7).

---

## 2. Current state — read this before believing anything else

| Stream | Requested? | Consumed? | Net effect |
|---|---|---|---|
| **Contact list** | **Always**, no gate | **No consumer** | Requested on every connect. Nothing reads it. The connect UI tells the tenant contacts "appear under Contacts over the next few minutes". |
| **History** | 3 gates, all fail-closed | **Metadata only** | Only `phase`/`progress` are read, to draw a progress bar. Message content is never parsed. Deleted at 90 days. **Cannot be re-requested.** |
| **Handset replies** | Subscribed | **Yes** | Fully consumed. Stops the bot answering a customer the owner already answered. The one stream that works end to end. |

**No tenant has ever completed a coexistence connect.** Zero `audit_logs` rows carry
`metadata->>'via' = 'embedded_signup'`, and `meta_webhook_events` was empty at last check. Every
defect below is therefore a loaded gun, not a fired one — which is exactly why they are cheap to
fix now and expensive after the first tenant.

---

## 3. The connect flow

One route does the whole thing: `POST /whatsapp/embedded-signup/exchange` in
[whatsapp.routes.ts](../apps/api/src/modules/whatsapp/whatsapp.routes.ts). The ordering is
deliberate and the code says so — Meta's authorisation code has a **30-second** lifetime and
cannot be retried, so nothing touches the database until the exchange succeeds.

Pure helpers extracted to
[embedded-signup.ts](../apps/api/src/modules/whatsapp/embedded-signup.ts).

| # | Step | On failure |
|---|---|---|
| 1 | **Config gate** — needs `META_ES_APP_ID` + `META_ES_APP_SECRET` | 400, no DB write |
| 2 | **Trade code for token** — `GET /oauth/access_token`, 10s timeout, deliberately no `redirect_uri` | 400 carrying Meta's message; the trace id is logged, the code never is |
| 3 | **Prove the phone number** — `GET /{waba}/phone_numbers` | If the browser named a number it must appear in Meta's list. In the coexistence case the browser supplies only a WABA id, so the list must contain **exactly one** number, else refuse with copy telling the tenant *not* to retry |
| 4 | **Cross-check credentials** — self-debug the token, then probe with an app access token | Meta error 190 ⇒ secret mismatch. Both probes **skip themselves on network error** so a Meta blip cannot block signup |
| 5 | **Write the channel — before subscribing** | Credentials encrypted at rest by the Prisma extension. Row lands `isActive:false`. Written first because Meta can deliver the instant the subscription exists, and the webhook resolves ownership from the stored number |
| 6 | **Subscribe the webhook** — `POST /{waba}/subscribed_apps` twice: bare baseline, then with `override_callback_uri` | Channel left inactive, `lastVerifyStatus: subscribe_failed:<status>`, 400 |
| 7 | **Read back the callback** | ⚠ **Advisory only** — logs a warning and continues. See §6.2 |
| 8 | **Ask for contacts, and for history only with consent** | Non-fatal individually; the channel is already usable for live traffic |

---

## 4. The consent architecture

This is the best-engineered part of the subsystem. **Do not weaken it.**

### 4.1 Why it exists

Until 2026-08-24, step 8 looped `['smb_app_state_sync', 'history']` **unconditionally** on every
connect. That asked Meta for 180 days of the connecting business's customers' conversations —
third-party message content, most of it exchanged before the request, from people who have agreed
nothing with us. There was no consent text, no grant, no retention clock and no feature gate.

`whatsapp.routes.ts` contained **zero** references to `sales_scan`, `salesScanGrant` or
`salesMessage`, so the platform's entire consent apparatus was bypassed. Nothing leaked only
because nobody had connected. Full write-up in [FIXLOG.md](../FIXLOG.md), 2026-08-24.

### 4.2 The gate, as deployed

History is requested only if **all three** hold:

1. **Fresh, versioned consent.** `shouldRequestHistory()` in
   [coexistence-capture.ts](../apps/api/src/lib/coexistence-capture.ts) fails closed on an absent
   consent block (`not_offered`) and on a version mismatch (`stale_copy`).
2. **The `sales_scan` feature is on for that org.** Deliberately a gate on **collection**, not
   just on the UI — holding a business's customer conversations is only defensible when a product
   consumes them. `defaultDisabled`, so a tenant is asked only after someone switched it on.
3. **A grant row was created first.** `createCoexistenceGrant` runs *before* the request; if it
   throws, we do not ask. History can begin arriving the instant Meta accepts, so the ordering is
   the only thing guaranteeing a corpus never exists without a record of what was agreed.

> ⚠ **The contact list has none of these gates.** `syncTypes` is seeded as
> `['smb_app_state_sync']` before any gate runs, so contacts are requested on **every** connect.
> A branch adds an env kill switch for this (§8) — it is not merged.

### 4.3 Why the consent text is pinned

`COEXISTENCE_CONSENT_TEXT` / `_VERSION` live in
[sales-scan.ts](../packages/shared/src/schemas/sales-scan.ts), currently `2026-08-24.1`. Its
SHA-256 is asserted in the blocking pure CI gate, so editing a word without bumping the version
fails the build.

It is **deliberately separate from the Baileys consent copy**, not a reword of it. That copy
describes a linked device, a 4-device cap and an unpromisable history depth — none of which
describes Coexistence. Rewriting it in place would have made it wrong for the transport it
documents. **The Baileys hash is untouched.**

The version is served **by the server** and echoed back by the client, so a tab left open across a
copy change cannot consent someone to text they never saw. Consent is collected **on the connect
screen**, not in Settings, because Meta sends history once inside a 24-hour window and there is no
later moment at which asking would work.

### 4.4 The two deadlines

`effectiveEndsAt()` in [sales-scan-window.ts](../apps/api/src/lib/sales-scan-window.ts) takes the
**earlier** of:

- `grantExpiresAt` — absolute, never moved, so an unlinked grant still expires;
- `captureEndsAt` = `linkedAt + windowDays` (clamped 1–14 in the engine as well as in Zod).

The **grant**, not the tenant, is the unit of capture lifetime.

---

## 5. Handset replies — the stream that works

Under coexistence the owner keeps answering from their phone. Those replies never reach Hader's
servers, so without this the inbox shows the thread as unanswered and **the bot sends a second,
different answer from the same number seconds later** — the 2026-08-09 double-reply shape, with a
human as one of the two speakers.

The only gate that pauses the bot for human involvement is `assigned_to_user_id`, and both its
writers are authenticated portal routes. **A handset reply produces no HTTP request to Hader at
all**, so nothing sets it and that gate can never fire.

[handset-echo.ts](../apps/api/src/lib/handset-echo.ts) consumes `value.message_echoes[]` and
stamps `whatsapp_threads.handset_replied_at` (migration `20260824120000`).

### Three decisions to preserve

- **Its own column, not `assigned_to_user_id`.** A handset reply has no Hader user behind it; a
  sentinel id would be a lie every other reader of that column would have to know about.
- **Compared against the inbound message's own timestamp, never `now()`.** The question is *"did
  the owner already answer **this**?"* — so a customer who writes again still gets a reply, and one
  handset message never silences a thread permanently. Written **forward-only**, because Meta
  redelivers for up to 7 days and an out-of-order older echo must not walk the stamp backwards.
- **`sentBy: 'operator'`, no schema change.** The inbox already maps every non-`'bot'` outbound row
  to the operator bubble, so these render with zero UI work and the dashboard's bot-handled count
  correctly does not claim them. `via: 'handset'` distinguishes them for analytics.

Echoes also overwrite the `botcoalesce` token, so a reply typed during the bot's 8–20s generation
window kills the draft through the existing post-generation supersede check — no new mechanism.

### Deliberately NOT done on this path

No wallet charge (Meta billed the handset; `chargeAtSend` without a recipient row is structurally
unrefundable) · no bot dispatch · no STOP detection (an echo is the business's own words) · no
`lastInboundAt` write · **no thread reopen**, unlike the inbound path — the owner answering from
their phone is not a reason to resurface a thread an operator already resolved.

### One real behaviour change

Echoes bump `lastMessageAt` and `outboundCount`, making a thread eligible for a `noReply`
follow-up. That is what that engine is for, and the blast radius is nil today: `follow_ups` is
`defaultDisabled` and inert without an approved template.

---

## 6. The landing pad

### 6.1 What it is

`meta_webhook_events` (migration `20260820120000`) is a capture-first, interpret-later table. The
webhook's two main loops read only `value.messages` and `value.statuses`; **every other subscribed
field would fall straight through, get a 200, and be lost — and Meta never retries a 200.**

That is fine for repeatable streams and fatal for `history`, which arrives once. So anything
unrecognised is parked verbatim before the existing loops run.

Three hardening decisions, all from real reviews:

- **The park is `await`ed, not fire-and-forget.** An earlier version returned 200 to Meta before
  the row was durable, so a pool blip during a `history` delivery lost exactly the payload the
  table exists to protect.
- **A park failure returns 503**, so Meta redelivers. A retry is recoverable; a 200 is not.
- **`field === 'messages'` short-circuits first**, so ordinary inbound traffic never enters the
  block.

`organization_id` is the org the callback URL was *addressed to*; `resolved_organization_id` is the
true owner resolved globally from `phone_number_id` (migration `20260820160000`). During Embedded
Signup a new tenant's first deliveries arrive at the **app-level** callback — which points at
another org's URL entirely — so the two genuinely differ.

### 6.2 Known defects

| Defect | Detail |
|---|---|
| **Ownership ignores `waba_id`** | `ownerOrgOf()` resolves from `phone_number_id` only. An account-level payload without it — which `history` may well be — cannot be routed. A branch fixes this (§8); `main` cannot route on anything else. |
| **Callback read-back is advisory** | Step 7 only logs a warning on mismatch. A tenant can finish "connected" while Meta still delivers to another org's URL. |
| **Silent skip** | An echo arriving without routing metadata is parked with `processed_at` null and no error logged — discoverable only via the reaper's 90-day "never processed" warning. |
| **Multi-number blind spot** | The bot looks up the thread by phone number alone with no channel filter; the echo writer keys on channel. On a multi-number tenant the two can address different rows, so suppression can miss. The bot still *replies* from the correct number — it is the thread record that diverges. |
| **Fails open with no timestamp** | The bot gate is skipped entirely when an inbound carries no Meta timestamp. That field is documented as always present, so this is a latent defensive gap, not an observed failure. |

---

## 7. Invariants — do not regress these

1. **Never ask Meta for history without fresh, versioned, explicitly-acknowledged consent.**
   `shouldRequestHistory` fails closed; absence is never consent.
2. **The grant is created BEFORE the request.** A failure to create it means we do not ask.
3. **The consent SHA is pinned in CI.** Editing the copy without bumping the version fails the
   build. Bump both, together, or not at all.
4. **The Baileys consent copy and hash are separate and untouched.** They describe a different
   transport.
5. **Never unsubscribe `history`, `smb_app_state_sync` or `smb_message_echoes`.** `history` is
   delivered once and cannot be re-requested without the tenant fully offboarding.
6. **The two revocation routes stay ungated by the feature flag.** `DELETE /sales-scan/grant` and
   `DELETE /sales-scan/messages` must never sit behind `assertOrgFeature` — switching the feature
   off must not trap a tenant's own "stop" and "delete". This hole existed and was closed on
   2026-08-05; do not reintroduce it.
7. **`handset_replied_at` is written forward-only and compared to the inbound message's own
   timestamp**, never `now()`.
8. **Park before consume.** The raw row is the recoverable copy; `processed_at` is stamped only on
   success so a failure leaves a replayable row.
9. **Pure gates stay pure.** `coexistence-capture.ts` and `sales-scan-window.ts` import nothing
   from `env.ts` or `db.ts` — `env.ts` calls `process.exit(1)`, which is why vitest cannot boot on
   a developer machine. Keeping them pure is what lets them live in the blocking CI gate.

---

## 8. What is NOT built

### 8.1 There is no history consumer

Nothing anywhere parses `value.history[].threads[].messages[]`. Payloads are parked as raw JSONB.
`meta_webhook_events` has two writers and exactly **one** reader — `sweepWebhookLandingPad` in
[sales-scan-reaper-tick.ts](../apps/api/src/lib/sales-scan-reaper-tick.ts) — which **deletes**. Its
own log line says a consumer is missing.

The only code that touches a `history` payload is `GET /whatsapp/coexistence/status`, which reads
`payload.value.history[].metadata.{phase,progress}` to draw a progress bar and nothing else.

**Consequence.** WhatsApp delivers this once, inside a 24-hour window, and will not resend without
a full offboard and redo. A delivered corpus is banked, never read, and deleted at 90 days. Every
downstream feature — missed-enquiry report, bot bootstrapped from real history, contact sync,
re-engagement — remains impossible.

### 8.2 The revocation gate is dead code

`mayPersistCapturedMessage()` has **zero production call sites** — only its own definition and its
pure test. Its doc comment explains why it must exist: under coexistence there is no socket to
close and no way to make Meta stop sending, so revocation *is* this software gate.

### 8.3 Zero automated coverage of the connect flow

The exchange makes six or more Graph calls across eight failure branches. No test references it. No
recorded Meta payload, no fixture, no wire-shape test exists for history or echoes — every shape in
the code was written **from documentation**. Every parse degrades silently to nulls or a skip
counter, so the realistic first failure mode is *quiet wrongness*, not a crash.

### 8.4 Four places the code contradicts the pinned consent

| The promise | What the code does |
|---|---|
| "You can **delete everything we captured** at any time." | The delete route clears only `sales_messages` — the *Baileys-era* table, which coexistence never writes to. Coexistence data lives in `whatsapp_messages` and `meta_webhook_events`. Neither is touched. |
| "We **discard them on arrival** instead of storing them" (handset copies after stopping). | Echoes are stored unconditionally — no grant check, no feature check, no call to `mayPersistCapturedMessage`. |
| "We **strip payment credentials** before storing." | `stripPaymentCredentials` is called only on the Baileys ingest route. The echo path contains zero calls to it. |
| "We **summarise your conversations** and analyse how your team writes." | The insight tick returns immediately unless a Baileys-era secret is set. On this path it does nothing. |

### 8.5 Grants have no purge lifecycle

Nothing on the coexistence path ever stamps `authPurgedAt` — its only writer is the Baileys
`POST /wa-ingest/purged` route — and no column distinguishes a coexistence grant from a Baileys
one. Every coexistence grant that ends therefore enters the purge-retry alarm set and can never
satisfy it.

---

## 9. The parked branch

`wip/es-minimal-config-2026-08-26` at **`72cd734`** — committed, unmerged, deliberately parked.
Its commit message documents the divergence. It carries three things `main` lacks:

- **`META_ES_DATA_IMPORT_ENABLED`** (default **false**) — an env kill switch holding contact and
  history import behind an explicit switch. **`main` has no equivalent**, and this is the piece
  most worth carrying forward.
- **Server-side WABA discovery** from Meta's granular scopes, treating the browser's
  `postMessage` as a claim rather than truth.
- **WABA-id-based webhook routing** (`extractWebhookRoutingHints`) — the fix for §6.2's first row.
- A **fatal** rather than advisory callback read-back.

`main` took a different, deployed approach to the same surface (the SaaS-grade connect UX in
`f3f5f1f`), which is why this was parked rather than merged.

---

## 10. Operating notes

### 10.1 Graph API version

All 48 hardcoded `graph.facebook.com/v20.0` literals moved to **v25.0** in `e03c325`, and
`env.ts`'s default with them. **v20.0 expires 24 September 2026.**

Two follow-ups remain:

- ⚠ **`infra/scripts/wa-backfill-subscribe.ts` still hardcodes `v20.0`** in two places. The sweep's
  scope was api + worker + `packages/db`; `infra/scripts/` was missed. That script is
  operational — it registers per-WABA override callbacks — and will break on 24 September.
- The send path (`POST /{phone-number-id}/messages`) was **not** tested on v25.0, because testing
  it means messaging a real customer. **Do one test-send after the next deploy** and watch
  `/var/log/aligned-api.log`.

`connect/page.tsx`'s `/v20.0/dialog/oauth` reference is deliberately left — it is a historical
incident record, and rewriting it to a version that was never involved would falsify it.

### 10.2 Before the first real connect

Conditions, from the Meta-side doc:

- A number **ALIGNED owns** — never a tenant's — live in the WhatsApp Business app (2.24.17+) and
  in genuine use for about a week.
- Accept that its WhatsApp Web and desktop access will be lost; **WhatsApp for Windows cannot be
  re-linked at all.**
- **On a computer, with the handset beside it.** The flow ends by having the Business app scan a
  QR shown on screen, so it cannot be completed on a phone alone.
- From a Facebook account with **no role on the app** — role-holders are asked for all 8
  permissions, a real tenant for 2, so testing as an admin measures the wrong flow.
- **Capture every webhook payload Meta sends and freeze them as fixtures.** This is the single
  highest-value output of the exercise and it converts §8.3 from unfixable to fixable.

### 10.3 Things that will waste a day

- **Never click "Launch Embedded Signup" in Meta's Builder.** It onboards the number for real, and
  the code goes to Meta's tool rather than our server — so the one-shot 24-hour history window
  passes unused and that number's corpus is gone permanently.
- **A link tapped inside WhatsApp fails.** The in-app browser suppresses the popup, the SDK falls
  back to a redirect, and there are no valid redirect URIs configured. It looks like our bug.
- **Pairing takes 2–3 minutes; the connect page gives up after 10 seconds** with an alarming "do
  not repeat this" message. If it appears during a real connect, **check the database before
  believing it.**
- **Cross-Origin-Opener-Policy must vary by path.** Meta's popup `postMessage`s back to its opener;
  a blanket `same-origin` COOP severs `window.opener` with no error at all. It is set per-request
  in `apps/web/src/middleware.ts`, which is the only writer — grep there before adding it to
  `next.config.ts`.
- **Isolate by changing machines before changing code.** The 2026-08-24 "Sorry, something went
  wrong" incident was machine-specific — same code, same config, same day, different box. Test
  OAuth from a residential browser, not a hosted VM.

---

## 11. Code map

| Concern | File |
|---|---|
| Exchange route, webhook, landing-pad park | [whatsapp.routes.ts](../apps/api/src/modules/whatsapp/whatsapp.routes.ts) |
| Pure ES helpers (WABA discovery, routing hints) | [embedded-signup.ts](../apps/api/src/modules/whatsapp/embedded-signup.ts) |
| Consent + capture gates (pure, CI-gated) | [coexistence-capture.ts](../apps/api/src/lib/coexistence-capture.ts) |
| Grant deadlines (pure, CI-gated) | [sales-scan-window.ts](../apps/api/src/lib/sales-scan-window.ts) |
| Grant lifecycle | [sales-scan.ts](../apps/api/src/lib/sales-scan.ts) |
| Handset echo consumption | [handset-echo.ts](../apps/api/src/lib/handset-echo.ts) |
| Retention + purge alarm | [sales-scan-reaper-tick.ts](../apps/api/src/lib/sales-scan-reaper-tick.ts) |
| Consent copy, SHA-pinned | [sales-scan.ts](../packages/shared/src/schemas/sales-scan.ts) |
| Wire schemas | [whatsapp.ts](../packages/shared/src/schemas/whatsapp.ts) |
| Connect UI | [connect/page.tsx](<../apps/web/src/app/(dashboard)/whatsapp/connect/page.tsx>) |
| Blocking pure test | [coexistence-capture.test.ts](../apps/api/test/pure/coexistence-capture.test.ts) |
| Migrations | `20260820120000_meta_webhook_events`, `20260820160000_coexistence_attribution`, `20260824120000_coexistence_handset_echoes` |

---

## 12. Open questions

1. **Ship or pause?** Requesting contacts and history and consuming neither, while the UI reports
   success, is a position nobody chose deliberately. Build the consumer, or stop requesting and
   correct the copy. The current middle is the worst of the three.
2. **Is grounding a tenant's own assistant on their own history defensible under Meta's 15 Jan 2026
   terms?** They prohibit "sharing chat data for AI model training or improvement" while permitting
   third-party LLM processing for defined purposes. Per-tenant looks defensible; pooling across
   tenants does not. **This is a lawyer question and it gates the bootstrap feature.**
3. **Do the legal pages cover bulk capture and LLM recipients?** They live only on the server, in
   no repo. They may need rewriting — and recreating — before capture ships.
4. **Merge or drop the parked branch?** The kill switch has no counterpart upstream.
