# Feature Brainstorm — "Scan your sales WhatsApp" (Sales Line Learning)

> Status: **DESIGN / NOT BUILT.** Written 2026-07-29. Core architecture decisions **LOCKED 2026-07-29** (§0).
> Build pattern to follow: [ADDING-A-FEATURE.md](ADDING-A-FEATURE.md).

---

## 0. Locked decisions (2026-07-29) — do not re-litigate

| # | Decision | Consequence |
|---|---|---|
| **Architecture** | **New service `platform-wa-ingest`**, forking `WaSession` — **its own systemd unit on the the platform prod box** (`91.92.108.178`), NOT inside `apps/api`/`apps/worker`, NOT on AlignDesk | `redeploy.sh:163` restarts only `platform-api platform-worker` (+web), so a the platform deploy never touches the ingest unit — sessions survive deploys. Localhost Postgres for the auth store + message writes; one box to operate; no cross-box webhook hop. **Baileys inside api/worker is ruled out**: every deploy would drop every session → reconnect storm → ban signal. |
| **Session model** | **On-demand, permission-gated, time-boxed.** No tenant has a session by default. Permission grant → session connects → recent history + live capture for a bounded window → **auto-disconnect + purge auth** → learning runs on the corpus. Re-grant to refresh. | Concurrency ceiling, not a customer ceiling. Slots recycle. A tenant's number is attached to an unofficial client only during an active window. Permission expires naturally instead of drifting into a forgotten standing grant. |
| **Window length** | **7 days** (was open; settled by the owner 2026-07-29) | 15 slots ÷ 1-week windows ≈ **~60 tenant scans/month** through one box. Summary generation fires at window close. |
| **Gating (hidden when off)** | ~~The card renders for **every** tenant~~ — **REVERSED 2026-08-05 by owner decision.** Sales Scan now matches every other paged feature: the key registers `hrefs: ['/settings/sales-scan']`, so `isHrefDisabled` hides the Settings card and bounces the route when the feature is off. The **API** is gated with `assertOrgFeature` — *except* `GET /sales-scan/status` and the two revocation routes (stop capture, delete captured data), which stay ungated so a tenant whose feature is switched off can still withdraw consent. | No longer a deviation. Pinned by `apps/api/test/pure/sales-scan-invariants.test.ts`. |
| **Number scanned** | The tenant's **live, currently-in-use sales line** | Maximum ban blast radius; 4-device cap becomes a real UX path; primary phone online daily (mitigates the 14-day logout). |
| **History depth** | **Recent history** — accept what WhatsApp pushes on link, decline FULL sync (`syncType !== 2`, same guard `qr_whatsapp` already uses) | Real corpus on day one without the full-sync CDN burst. **Phase 0 must measure how much actually arrives** — with a time-boxed window this is now doubly load-bearing: it sets how long the window must be. |
| **Billing** | **Feature flag + offline payment.** New `ORG_FEATURES` key `sales_scan`, `defaultDisabled: true`, HQ enables per tenant after payment is arranged | Zero billing code for the pilot. **MUST ship the `array_append(disabled_features,'sales_scan')` backfill migration** or `feature-backfill-invariant.test.ts` fails the build. Data model still designed so `OrgAddon` can slot in later. |
| **Proxies** | **Pilot without, add before rollout** | Accepted risk, but it needs explicit guardrails — see below. |

### Capacity budget (the platform box, verified 2026-07-29)
`7.8 GB` total · `1.8 GB` in use (api + worker + web + postgres + redis + caddy) · `5.6 GB` available · 4 CPUs at ~0 load · 20 GB disk free · 4 GB swap.

```
7.8 GB total
−1.8 GB  current services
−2.0 GB  reserved for `next build` during deploys   ← documented OOM history, redeploy.sh:20-23
−1.0 GB  headroom (postgres cache, spikes)
─────────
 ~2.5 GB for ingest → ~20 sessions @ ~120 MB → CAP AT 15 CONCURRENT
```
- `MemoryMax=2.5G` on the `platform-wa-ingest.service` unit, so a Baileys leak kills the ingest service rather than Postgres.
- **15 = concurrent active windows, not customers.** At a 14-day window that serves ~30 tenants/month.
- Text-only ingest in v1 (media is most of the disk; 20 GB free).
- Past 15 concurrent, move the unit to its own box — trivial, because it's already a separate service with its own port and DB connection.

### Session lifecycle (the core of the design)
```
tenant grants permission ──► GRANT row (pending)  ──► slot available? ──no──► queued
                                                            │yes
                                                            ▼
                                              session connects, QR/pairing shown
                                                            │
                                                     linked (active)
                                                            │
                                    recent-history sync + live capture, N days
                                                            │
                        ┌───────────────────────────────────┼──────────────────┐
                        ▼                                   ▼                  ▼
                 window expires                      tenant revokes      logged out / banned
                        └───────────────────────────────────┴──────────────────┘
                                                            ▼
                                   DISCONNECT + PURGE AUTH STATE + release slot
                                                            ▼
                                          corpus retained → learning job runs
```
- **Purge auth on teardown, always.** Keeping companion credentials after a window ends is the thing that turns a
  time-boxed grant back into a standing one.
- Revoke must be instant and available at all times from the settings page — not only while connected.
- Notify the tenant before expiry (re-grant prompt) and on unexpected logout.
- A queued grant that never gets a slot must surface honestly in the UI, not silently wait.

### Proxy decision — the guardrails that make it survivable
Running tenant sales lines on the shared AlignDesk datacenter IP (alongside `bot1`, `zeed`, `zeed-mohamad`) is
the deferred mitigation from [[client-numbers-must-not-be-banned]], now pointed at a client's real number. To keep
"pilot without" from becoming "production without":

1. **Pilot tenant must knowingly accept the ban risk, in writing**, in the consent copy — not buried.
2. **Prefer a secondary/newer sales line** over the irreplaceable main business number for tenant #1.
3. **Hard cap: 2 tenant numbers on the shared IP.** Wire `BOT_PROXIES` before tenant #3, and before *any*
   high-value client — whichever comes first. Track this as a release gate, not a backlog item.
4. **Read-only is absolute** while unproxied — no sends, no presence, no read receipts, ever.
5. Ship the **re-link flow and connection-health alerting in Phase 1, not Phase 4** — if a pilot number does get
   logged out or banned, the tenant must find out from us, immediately, not from a customer.

### Still open (non-blocking — assumptions stated, revisit before Phase 3)
- Raw-message retention → **assuming 90 days raw, indefinite derived artifacts** until told otherwise.
- One sales line per tenant → **assuming one active grant at a time**; multiple grants over time is the re-grant path.
- Voice profile auto-apply → **assuming reviewed suggestion, never silent** (persona diff + approve). The spec says
  "show him a summary", which is display-only — so applying it to the live bot is explicitly **out of scope for v1**.
- Pilot tenant → **not chosen yet.** Needed before Phase 1 ships.
- Card position within Integrations → spec says "4th place"; the column already shows 4 cards (WhatsApp,
  Messenger & Instagram, Phone integration, Google Calendar). **Assuming it goes in the Integrations list**; exact
  ordinal is cosmetic and trivially moved.

**Product name (owner, 2026-07-29): "Teach the bot with your own data".**

**The ask:** a tenant QR-links **the live sales WhatsApp number they are currently using**; we capture **all DMs,
incoming and outgoing, for one week**; then we produce **a summary of all chats + an analysis of how they talk**,
displayed back to them in the portal. Surfaced as a card in the **Integrations** column of `/settings`. Activation
is flipped **by an HQ admin** per tenant, outside all plans.

**Three tenant-visible states — the card is hidden until activated** *(reversed 2026-08-05; it used to be always visible)*:
| State | What the tenant sees |
|---|---|
| Not activated | **Nothing** — no card, and `/settings/sales-scan` bounces, exactly like every other feature that is off |
| Activated, not yet linked | A **Baileys QR code** to scan with their sales number |
| Capturing | Live status + **days remaining** in the 7-day window |
| Window complete | The **summary + voice analysis** |

⚠️ **This gating is a deliberate DEVIATION from the house pattern.** the platform's `Organization.disabledFeatures` +
`isHrefDisabled` mechanism **hides** a feature and bounces its route. Here the card must render for *every* tenant
and merely change state. See §0 for the resolution.

⚠️ **The scanned number is the tenant's live, in-use sales line.** Not a burner. Consequences: (a) ban blast radius
is their working business phone; (b) the phone is online daily, so the ~14-day companion auto-logout mostly stops
being a churn source — a genuine plus; (c) **the 4-companion-device cap is now a first-class UX problem** — an
active sales line is usually already on WhatsApp Web/Desktop across 1–3 devices, so some tenants will have no free
slot, and linking could evict a device their team is actively using. Detect and explain it; don't discover it in
support.

---

## 1. Ground truth — what exists today (verified 2026-07-29)

### The AlignDesk server
| | |
|---|---|
| Host | `88.80.145.157`, SSH port **7777**, user **`aladmin`** (NOT `aliadmin` — that's the a partner box at `.120`) |
| Key | `~/.ssh/id_ed25519`, needs `-o KexAlgorithms=curve25519-sha256` |
| Public | `https://qr.aligndesk.ai` → nginx → `127.0.0.1:4100` (LE cert, SSE-friendly) |
| App dir | `~/qr_whatsapp` — a real git repo tracking `origin/main` |
| Deploy | push to GitHub → `git fetch && git reset --hard origin/main && docker compose up -d --build` |
| Other tenants of this box | `zeed` (4000), `zeed-mohamad` (4001) |

⚠️ fail2ban bans this machine's IP for ~10 min after ~5 bad SSH attempts (symptom flips from "Permission denied" to raw TCP timeout). Use the exact user+key on the first try.

**Live status right now:** container `qr_whatsapp` **Up 2 weeks**, `READ_ONLY=true`, `BOT_NUMBERS=bot1,bot2,bot3,bot4,bot5`, **no `BOT_PROXIES` line at all** (→ all sessions share the datacenter IP). Auth dirs: `bot1` = 411 files (**linked, live**), `bot2`–`bot5` = **0 files (running but unlinked, sitting at QR)**.

### How multiple bots run today
[`src/wa/pool.ts`](../../qr_whatsapp/src/wa/pool.ts) — `SessionPool` is a `Map<label, WaSession>`; `startAll()` reads `env.BOT_NUMBERS`, constructs one `WaSession` per label, and **staggers starts by 1.5–3 s random** so N handshakes don't land in the same second (a bot-like signal). Each `WaSession` ([`src/wa/session.ts`](../../qr_whatsapp/src/wa/session.ts)) is a fully isolated Baileys companion socket with its own auth dir (`data/wa-auth/<label>/`), own reconnect/watchdog/authGen guard, own group map, and an optional **per-label proxy agent**. Browser fingerprint is varied per label (`browser: [label, 'Chrome', '120.0.0']`).

So: **N bots = N entries in `BOT_NUMBERS` + N QR scans.** No sharding, all in one Node process — deliberate and fine "for a handful of owned numbers."

**To link bot2–bot5** (I cannot do this — it needs the physical phone that owns each number):
1. Open `https://qr.aligndesk.ai` → log in as `admin` (password in the server `~/qr_whatsapp/.env`).
2. **Numbers** tab → pick `bot2` → "Relink (new QR)" for a QR, or "Link by code" for an 8-char pairing code.
3. On the phone: WhatsApp → Settings → **Linked Devices** → Link a device → scan / enter code.
4. Status flips to `open`; the per-number API-key dialog auto-pops.
5. Repeat, **spaced out** (don't link 4 numbers in one burst from one IP).

### The blocking finding 🚨
[`session.ts:547-550`](../../qr_whatsapp/src/wa/session.ts) — the capture path opens with:
```ts
const jid = waMsg.key.remoteJid ?? '';
if (!jid.endsWith('@g.us')) return;   // ← every DM is DROPPED
if (waMsg.key.fromMe) return;         // ← every OUTGOING message is DROPPED
```
**The existing engine cannot do this feature at all.** It is a *group auction* capture engine: it drops exactly the two things you need — 1:1 sales DMs, and the tenant's own outgoing replies (which is where "how they speak" actually lives). Everything downstream (`engine.ts` auction/bid lifecycle, the `/number/v1` API fenced to a number's *groups*, the `groups`/`auctions`/`bids` tables) is auction domain logic that this feature does not want.

**What IS reusable — and it's the expensive part:** the whole `WaSession` reliability layer (serialized start, `authGen` stale-write guard, liveness watchdog, reconnect-on-close, offline backlog de-dup, LID→phone resolution, media download with size caps, proxy agent, pairing-code linking, staggered pool start). That's ~626 hard-won lines you do not want to rewrite.

---

## 2. The five structural mismatches (why this is a new service, not a flag)

| # | Today (qr_whatsapp) | This feature needs |
|---|---|---|
| 1 | **Owner-owned** pool of 5 numbers, labels hardcoded in `BOT_NUMBERS` env, **container restart to add one** | **Tenant-owned** numbers, N unbounded, provisioned **at runtime** when a tenant clicks "Connect" |
| 2 | **Groups only**, DMs dropped | **DMs only** (sales conversations); groups arguably excluded on purpose |
| 3 | **Inbound only**, `fromMe` dropped | **Both directions** — outgoing is the higher-value half |
| 4 | `useMultiFileAuthState` → **plaintext files on one box's disk** | Encrypted, DB-backed auth store (memory already flags this: *"must not be used in prod at scale"*); survives box loss |
| 5 | SQLite + `tenant_id` as a loose optional string | the platform's hard tenancy: `organization_id` + **RLS**, per [ADDING-A-FEATURE.md](ADDING-A-FEATURE.md) |

Plus: ban blast radius changes character completely. Today a ban costs *you* a burner. Here it bans **the client's real sales line** — per [[client-numbers-must-not-be-banned]] that outranks features, scale, and ship speed.

---

## 3. Architecture options

**A. Extend `qr_whatsapp` in place** — add a "DM capture mode" + tenant provisioning API to the existing engine.
*+* Reuses the hardened session layer immediately; one box, one deploy you already know.
*−* Welds two very different products (auction capture for Zeed/Pierre vs. sales learning for the platform tenants) into one codebase and one blast radius; the partner/number-key layer is auction-shaped; a bad deploy takes down Pierre's live bot1.

**B. New sibling service `platform-wa-ingest` on AlignDesk, forking `WaSession`** ⭐ **recommended**
*+* Clean separation of concerns and failure domains; free to be DM-first, tenant-first, Postgres-backed, with no auction baggage; reuses the proven session code by copying the one file that matters; deploys independently of Pierre's live traffic.
*−* Duplicates `WaSession` (accepted — the repo already does deliberate twinning, e.g. `apps/api/src/lib/wallet.ts` ↔ `apps/worker/src/lib/wallet.ts`); two places to patch a Baileys protocol bump.

**C. Buy WAHA (self-hosted, NOWEB engine)**
*+* Multi-session + QR/pairing + per-session webhooks + restart survival are its whole job; a prior 14-agent analysis (memory: [[project-multitenant-bidding-feature]]) already recommended **buy the session layer, build only the domain**.
*−* Another vendor/runtime to operate; less control over the exact ban-avoidance knobs you've already tuned; migration cost if you later want your own.
**Genuinely worth reconsidering here** — this feature is the *"many tenant numbers"* case that recommendation was written for, which is exactly what qr_whatsapp's `BOT_NUMBERS`-env model is worst at.

**D. Build Baileys into the the platform monorepo (`apps/worker`)**
*−* **Don't.** Long-lived stateful WebSockets don't belong in a BullMQ worker that gets restarted on every deploy; every the platform deploy would drop every tenant's WhatsApp session. Also drags an unofficial-client dependency into the compliance surface of the Meta Cloud API product.

**Recommendation: B, with C as the fallback** if session ops become a burden. Either way the the platform-side contract is identical (signed webhooks in, REST out) — so B→C is a swap of one service, not a rewrite.

---

## 4. Proposed shape

```
Tenant browser                the platform (this repo)                  AlignDesk 88.80.145.157
─────────────                 ─────────────────                  ────────────────────────
/settings/sales-scan   ──►  POST /api/v1/sales-scan/connect ──►  POST /admin/v1/sessions
   consent + Connect                                              {orgId, proxy, dmOnly:true}
   ◄── QR / pairing code ◄──  SSE or poll  ◄──────────────────    session.qr event
   scan on phone ──────────────────────────────────────────────►  Baileys link
                              POST /webhooks/inbound/wa-ingest ◄── HMAC-signed batches
                                    │                              (messages, both directions)
                                    ▼
                              ingest → redact → store
                                    │
                                    ▼
                              BullMQ: sales-insight job
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
                  Voice profile           Question clusters
                  (how they speak)        (common questions)
                        │                       │
                        └────► review & approve queue ────► BotConfig / FAQs
```

### the platform-side data model (sketch)
All tenant-scoped, `organization_id` + RLS inline in the same migration:
- **`SalesScanGrant`** — the permission record and the unit of session lifetime (replaces the earlier always-on
  `SalesLineConnection`). `organizationId`, `phoneE164`, `status` (`pending`→`queued`→`linking`→`active`→
  `completed`|`revoked`|`expired`|`failed`), `windowDays`, `grantedAt`/`grantedByUserId`, `consentVersion`,
  `startedAt`, `expiresAt`, `endedAt`, `endReason`, `ingestSessionId`, `authPurgedAt`.
  **`authPurgedAt` is the auditable proof** that a finished window really did release the credentials — it's the
  field a DPA question will land on. Multiple grants per org over time (that's the re-grant/refresh path); at most
  one non-terminal grant at a time.
- **`SalesMessage`** — `organizationId`, `connectionId`, `waMsgId`, `counterpartyHash`, `direction` (in/out), `kind`, `body`, `sentAt`. **Volume is the design driver** (see §7) — this is the table that could hit millions of rows.
- **`SalesInsightRun`** — job status, window, model, token cost, counts.
- **`SalesInsight`** — the derived artifacts: `kind` (`voice_profile` | `faq_candidate` | `objection` | `phrase`), payload JSONB, `status` (`suggested`/`approved`/`rejected`), `appliedAt`. **Reuse the Shopify `shopify_staged_items` review→approve→import pattern verbatim** — it's the closest precedent in the codebase and tenants already understand it.

### The learning layer (the actual product)
1. **Voice profile** — tone, formality, greeting/sign-off habits, emoji use, language mix (Arabic/English/Arabizi — critical for Lebanon), sentence length, how they quote prices, how they push for the close. Output → a persona block appended to `BotConfig.adminSystemPromptAppend` (same lever the support-tenant and fatme personas already use). **Show a diff and require approval** — never silently rewrite a live bot's persona.
2. **Common questions** — embed + cluster inbound messages, rank clusters by frequency × recency, draft a Q&A per cluster **using the tenant's own best historical answer as the source**, push to the review queue → approved ones become `FAQ` rows (which the existing 3-min embed-backfill tick then embeds automatically, so the bot can retrieve them).
3. **Free upside, near-zero extra cost:** response-time distribution, unanswered-question rate, peak hours, top products mentioned, objection taxonomy, win/loss phrasing. This is a genuinely sellable analytics page on its own.

---

## 5. Ban risk — non-negotiables

This is the client's **real sales number**. Per [[client-numbers-must-not-be-banned]]:
- **Hard read-only.** Never send, never type, never mark-read from an ingest session. `markOnlineOnConnect: false`. Enforce in code, not config — a `sendText` on this service should not exist.
- **Residential/mobile proxy per tenant number.** Currently `BOT_PROXIES` is *empty on prod* — every session shares one datacenter IP. Aggregate IP correlation is the single biggest detection signal, and it's the one mitigation you've deferred twice. For tenant numbers this is a **day-one blocker, not a follow-up.** Budget ~$3–8/number/month.
- **Stagger link-ups**, never bulk-link.
- **Max 4 linked devices per WhatsApp account** — a sales team already using WhatsApp Web on 2–3 machines may have **no free slot**. Detect and explain this in the UI; it will be a top support ticket.
- **Companion sessions auto-logout if the primary phone is offline ~14 days** — recurring silent churn. Need connection-health monitoring, a notification, and a one-tap re-link that loses no data.
- **Baileys is an unofficial client and violates WhatsApp ToS.** The official Cloud API cannot read a business's existing DM history, so there is no compliant substitute — which is exactly why the mitigations are mandatory and why the tenant must be told plainly what they're opting into.
- Set expectations in the product: this is a **learning/analytics** feature, not a channel. The bot answering customers stays on the official Cloud API number.

---

## 6. Privacy & legal (do not skip — this is the real risk)

Reading a business's entire customer DM history is a materially bigger data-protection surface than anything the platform does today.
- The **customers on the other end never consented** to the platform. The tenant is data **controller**, the platform is **processor** → you need a **DPA**, a retention policy, and a documented purpose limitation.
- **Explicit, specific, logged consent** at connect: what is read (all DMs both directions), why, how long it's kept, who can see it, how to delete. Store `consentVersion` + timestamp + user id. A checkbox that says "I confirm I'm authorised to connect this business number."
- **Redact before the LLM ever sees it:** OTPs/verification codes, card numbers/IBANs, national IDs. Regex pass on ingest, before storage if you can afford to lose fidelity.
- **Scope controls:** DMs only (skip groups), tenant-side contact blocklist, and a **date-window cap** on history.
- **Retention:** short raw retention (30–90 d) + indefinite *derived* artifacts. Minimizing the raw PII you hold is both cheaper and safer. **[DECIDE]**
- the platform's own [privacy policy + data-deletion page](https://example.com/privacy) (shipped 2026-07-28) will need a section covering this.

---

## 7. Scale & cost reality

- **Memory:** ~80–150 MB per live Baileys session. One 8 GB box ≈ **30–50 tenant sessions**, and the single Node event loop becomes the real ceiling before RAM does (media decrypt is CPU-bound). Plan the shard boundary *before* you need it: `sessions` table with a `shard_id`, service horizontally cloneable. Don't build sharding now; don't design it out either.
- **History backfill is the big one.** A 2-year sales inbox can be 100k+ messages. Note the current engine deliberately **declines full history** (`shouldSyncHistoryMessage: msg.syncType !== 2`) to avoid a CDN burst on reconnect — but this feature *wants* history to learn from. **[DECIDE]**: (a) live-forward only, learn over 2–4 weeks — safest, slowest to value; (b) accept recent history only (what WhatsApp pushes on link, typically weeks–months) — **recommended balance**; (c) full history sync — richest, biggest ban signal and storage hit.
- **LLM cost:** don't feed 100k messages to Sonnet. Sample + cluster first (embeddings are cheap), then run the expensive model on cluster representatives. Ballpark: embedding 100k short messages ≈ low single-digit dollars; a good voice profile + 30 FAQ drafts from representatives ≈ well under $5/tenant/run. Budget per-run and record it in `SalesInsightRun` (the codebase already prices per-tenant AI in `ai-pricing.ts`).
- **Media:** default to **text-only ingest** for v1. Skip image/video/audio download entirely — it's most of the storage, most of the CDN ban signal, and adds little to "how they speak." (Voice notes are a strong v2: Lebanese sales runs heavily on voice, and you already have `gpt-4o-transcribe` wired.)

---

## 8. Activation "outside of all plans" — **[DECIDE]**

There is **no add-on concept in the codebase today** (no `addon`/`add_on` anywhere in `packages/shared` or `lib/billing.ts`). Three existing mechanisms could carry it:

| Option | How | Fit |
|---|---|---|
| **1. Feature flag only** | New `ORG_FEATURES` key `sales_scan`, `defaultDisabled: true`; HQ enables per tenant after payment is arranged offline | Simplest, ships fastest, zero billing code. Manual/offline money. **Best for the pilot.** |
| **2. Wallet charge** | Reuse `TenantWallet` (µ$, already live on 10 orgs) — a one-off activation debit + optional monthly | Money plumbing already exists and is battle-tested; but the wallet is currently framed as *per-WhatsApp-message* metering, so overloading it may confuse the `/billing` page |
| **3. New `OrgAddon` table** | `organization_id`, `addonKey`, `status`, `priceMicros`, `activatedAt`, `renewsAt` — properly orthogonal to `Plan` | Cleanest long-term and reusable for future add-ons; most new code |

**Recommendation: ship on Option 1 for the pilot, design the data model so Option 3 slots in later.** Whichever you pick — **the `defaultDisabled: true` flag MUST ship with an `array_append(disabled_features, 'sales_scan')` backfill migration**, or `feature-backfill-invariant.test.ts` fails the build. That gate exists precisely because the `partner_listings` rollout skipped it on 2026-07-20 and mislabelled the entire fleet.

---

## 9. Build plan — file by file

### Phase 0 — de-risk (do this FIRST, before any the platform code)
Cheap, and it answers the two unknowns every later estimate depends on: *does DM + `fromMe` capture actually
work*, and *how much history does WhatsApp really push on link*.

- New scratch repo `platform-wa-ingest`, copy `qr_whatsapp/src/wa/{session,classify,proxy}.ts` + `types.ts` + `logger.ts` + `env.ts`.
- In the forked `session.ts` `onMessage`, **invert the two filters** — this is the entire point of the fork:
  ```ts
  if (jid.endsWith('@g.us')) return;      // DMs only — skip groups
  if (jid === 'status@broadcast') return;
  // do NOT drop fromMe — direction: waMsg.key.fromMe ? 'out' : 'in'
  ```
- Keep `shouldSyncHistoryMessage: (m) => m?.syncType !== 2` (recent history, decline FULL — the locked decision).
- Keep `markOnlineOnConnect:false`, `READ_ONLY`; **delete `sendText`/`sendMedia` outright** so read-only is structural, not configurable.
- Log to a scratch SQLite: count messages by `direction`, by `isLive` (live vs history backfill), earliest/latest
  timestamp, distinct counterparties, media vs text.
- Link **one throwaway number**. Let it sit 48 h. **Deliverable: a real number for "how many historical messages arrive on link."**

**Exit criteria:** DMs captured both directions ✓ · history volume measured ✓ · session stable across a
reconnect ✓. If history turns out to be near-zero, revisit the history decision before Phase 3.

### Phase 1 — ingest service + the platform receiver
**`platform-wa-ingest` (new service, own systemd unit on the the platform box, port 4200):**
- `POST /admin/v1/sessions` `{orgId, grantId, windowDays, proxyUrl?}` → allocate a slot and provision at **runtime**
  (no `BOT_NUMBERS` env, no restart — the key departure from `qr_whatsapp`); returns `queued` when the pool is full.
  `GET /admin/v1/sessions/:id` → status + QR/pairing code. `DELETE` → disconnect + **purge auth** + release slot.
- **Slot manager** — bounded pool (`MAX_SESSIONS=15`), FIFO queue when full, and a **window reaper** that tears
  down + purges any session past `expiresAt`. The reaper is the load-bearing part: if it fails, time-boxed grants
  silently become permanent ones. It needs its own alert.
- **DB-backed encrypted auth store** replacing `useMultiFileAuthState` (Postgres + AES-GCM, mirroring
  `packages/db/src/secret-crypto.ts`) — survives a restart mid-window, and makes "purge" a single deletable row
  rather than files scattered on disk.
- `systemd` unit: `MemoryMax=2.5G`, `Restart=always`, **not** referenced by `redeploy.sh`.
- Outbound: **HMAC-SHA256 signed batches** to the platform, reusing the `webhook_outbox` durable at-least-once pattern
  already proven in `qr_whatsapp/src/integration/webhook.ts`. (Localhost, but keep the seam — it's what makes
  moving the service to its own box a config change.)
- Redact on ingest, before persistence: OTPs, card numbers, IBANs.
- **No `sendText`/`sendMedia` at all** — read-only is structural, not a config flag.

**the platform side (this repo), per [ADDING-A-FEATURE.md](ADDING-A-FEATURE.md):**
| File | What |
|---|---|
| `packages/db/prisma/schema.prisma` | `SalesScanGrant`, `SalesMessage`, `SalesInsightRun`, `SalesInsight` — all `organizationId` |
| `packages/db/prisma/migrations/<ts>_sales_scan/migration.sql` | tables + `SELECT _apply_tenant_rls(...)` per table **inline** |
| `packages/db/prisma/migrations/<ts>_sales_scan_backfill/migration.sql` | `array_append(disabled_features,'sales_scan')` — **required by the invariant gate** |
| `packages/db/prisma/rls.sql` | same `_apply_tenant_rls` lines appended after the `-- end` marker |
| `packages/shared/src/constants/org-features.ts` | `sales_scan` key, `defaultDisabled: true`, `hrefs: ['/settings/sales-scan']` |
| `packages/shared/src/schemas/sales-scan.ts` (+ `index.ts` export) | Zod DTOs |
| `apps/api/src/modules/sales-scan/sales-scan.routes.ts` | portal CRUD, `requireRole('admin')` for connect/disconnect, `assertOrgFeature` gate |
| `apps/api/src/modules/sales-scan/sales-scan-ingest.routes.ts` | **public** HMAC-verified receiver (own file, registered in the public block) |
| `apps/api/src/server.ts` | register both, correct auth-group blocks |
| `apps/api/test/sales-scan.test.ts` + `test/tenant-isolation.test.ts` + `test/setup.ts` | feature tests + **cross-org block in the hard gate** + TRUNCATE list |

### Phase 2 — Settings UI
`apps/web/src/app/(dashboard)/settings/sales-scan/page.tsx` — the **permission grant** flow: consent gate (logged
`consentVersion`), explicit "scan for N days" framing, QR/pairing display, live status, **days remaining on the
active window**, revoke-now (always available, not only while connected), delete-my-data, past-grants history, and
the 4-linked-device warning. Queued state shown honestly when the pool is full. Card link from `settings/page.tsx`.
Per the proxy guardrails, **re-link flow + health alerting ship here, not Phase 4.**

Notifications: window expiring soon (re-grant prompt), window completed, unexpected logout.

### Phase 3 — Learning
BullMQ `sales-insight` queue → worker job: redact → embed → cluster → draft with cluster representatives (never
feed the raw corpus to Sonnet). Review/approve queue modelled directly on `shopify_staged_items`. Approved FAQ
candidates become `FAQ` rows (the existing 3-min embed-backfill tick picks them up automatically). Voice profile
lands as a **persona diff requiring approval**.

### Phase 4 — Analytics + hardening
Response-time distribution, unanswered rate, question trends, objection taxonomy. Retention pruning (90 d raw).
**Proxy rollout — gated before tenant #3.**
