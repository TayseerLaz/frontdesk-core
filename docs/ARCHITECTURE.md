# the platform / Alignbot — Architecture

> **Status:** written 2026-07-22 from a full read of the repo at `4e334f6`.
> **Scope at the time:** 677 tracked files, 121,338 lines of TS/TSX, 79 Prisma models, 97 migrations.
> **As of 2026-08-28 (`e03c325`) that is now ~89 models and 131 migrations** — the counts above
> are the original reading, kept so you can see the drift rather than trust a stale number.
> **Relationship to `CLAUDE.md`:** that file is the running *session log* and plan.
> This file is the *structural map*. Where they disagree, this file was written from
> the code — see [§8 Gotchas](#8-gotchas) for the specific contradictions.
>
> **2026-08-28 amendment.** The whole **Coexistence / Embedded Signup** subsystem post-dates the
> original write-up and was entirely absent from it. It now appears in §4, §5.10 and invariants
> 38–44, with the full treatment in **[COEXISTENCE.md](COEXISTENCE.md)**. A CEO/team-level
> handover covering the same ground plus commercial and operational state is in
> **[HANDOVER.md](HANDOVER.md)**.

---

## Contents

1. [What this is](#1-what-this-is)
2. [Runtime topology](#2-runtime-topology)
3. [Tenancy model](#3-tenancy-model)
4. [Subsystem index](#4-subsystem-index)
5. [Critical paths](#5-critical-paths)
6. [Invariants](#6-invariants)
7. [How to read this repo](#7-how-to-read-this-repo)
8. [Gotchas](#8-gotchas)
9. [Open questions](#9-open-questions)

---

## 1. What this is

the platform is a multi-tenant SaaS whose core product is an **AI customer-service bot** that
talks to a business's customers on WhatsApp Cloud API, Facebook Messenger, Instagram DM
and a phone line — grounded exclusively in that tenant's own catalog, services, FAQs and
business info — and which captures real commerce (carts → orders, bookings, payment
links) plus a human-operator inbox on top.

It is **three runtime processes**:

| Process | What | Build |
|---|---|---|
| `apps/api` | Fastify REST API, **47** route modules registered under `/api/v1` | **No build.** Runs from TS source via `tsx --conditions=source` |
| `apps/worker` | BullMQ: **9** queue consumers + **8** interval ticks + an uptime probe | **No build.** Same `tsx` arrangement |
| `apps/web` | Next.js 15 App Router portal (**62** pages), `basePath: '/app'` | `next build` — the only compiled app |

over **PostgreSQL 16 + Redis 7**, with three shared workspace packages:
`packages/db` (Prisma schema + migrations + the raw-SQL RLS layer), `packages/shared`
(the Zod wire contract between api and web), `packages/config`.

**The central design bet is that the LLM guides but never decides.** Retrieval is hybrid
(char-trigram sparse + OpenAI embeddings, RRF-fused); the model is chosen per tenant by
`Organization.aiPlan`; and the raw output then passes a 10-step deterministic validator
pipeline, a grounding gate, and a marker protocol before send. The actual order contents
come from a regex-parsed draft cart — **not** from the model's own item list. Everything
sent is audited into `MessageProvenance` (system-prompt snapshot, candidate KB ids,
citations, hallucinations, tokens, latency).

---

## 2. Runtime topology

```
                    Caddy (prod box, hand-edited /etc/caddy/Caddyfile)
                    ├── example.com/app*  → 127.0.0.1:3000   Next portal
                    ├── example.com/*     → static marketing SPA
                    └── api.example.com   → 127.0.0.1:4000   Fastify   (/metrics hard-403)
                                              │
        ┌─────────────────────────────────────┼─────────────────────────────────┐
        │                                     │                                 │
   apps/api (systemd platform-api)      apps/worker (platform-worker)     apps/web (platform-web)
   47 route modules                    9 queues + 8 ticks               100% client-rendered
   + 2 in-process ticks:               /metrics on :9100                zero DB access
     embed-backfill, wallet-alert
        │                                     │
        └──────────────┬──────────────────────┘
                       │
   ┌───────────────────┼────────────────────┬─────────────────────┐
   │                   │                    │                     │
PostgreSQL 16      Redis 7              Wasabi (S3)         External services
+ PgBouncer        BullMQ queues        images, media,      Meta Graph v20.0
(transaction       read cache           TTS audio,          OpenAI / Anthropic / Groq
 pooling)          rate limits          imports, exports    Cohere (flagged off)
                   AI-msg counters                          ElevenLabs / Google TTS
pgcrypto,          SSE nonces                               Stripe / MyFatoorah / PayPal
citext,            tick locks                               Shopify Admin REST
pg_trgm            uptime ZSET                              a partner (RS256 SSO + mirror)
                                                            SES SMTP, Sentry
```

**Postgres carries real logic**, not just storage: RLS policies, pg_trgm GIN indexes with
trigger-maintained `search_text`, an append-only audit-log hash chain, and the a partner
read-only mirror-row guard trigger.

**Connection strings.** `DATABASE_URL` goes through PgBouncer (`?pgbouncer=true`);
`DIRECT_DATABASE_URL` bypasses it and is what migrations and `rls:apply` use.

**Separate repo:** the Aseer-time phone voicebot (Asterisk/AudioSocket + OpenAI realtime)
at `VOICE_HOST`. It owns telephony and audio only — it pulls a fully compiled
per-tenant system prompt and structured order/booking form config from
`GET /api/v1/voice/config`, and posts call lifecycle, transcript turns, orders and
bookings back.

---

## 3. Tenancy model

Shared schema, `organization_id` on **71 RLS-protected tables**, with Postgres
Row-Level Security as the backstop. `Organization` is the hub — ~50 relations hang off it.

### The one seam

Everything funnels through three wrappers in
[apps/api/src/lib/db.ts](../apps/api/src/lib/db.ts):

| Wrapper | What it sets | When it's legitimate |
|---|---|---|
| `withTenant(orgId, fn)` :38 | `SET LOCAL ROLE app_user` **+** `app.current_org_id` | Every authenticated request |
| `withRlsBypass(fn)` :55 | `app.bypass_rls = 'on'` | HQ cross-tenant ops + auth bootstrap. Caller MUST be gated by `requireSuperAdmin` |
| `witha partnerSync(orgId, fn)` :78 | tenant scope **+** `app.partner_sync = 'on'` | Only the a partner→the platform mirror sync |

The policy, applied by the `_apply_tenant_rls` macro at
[rls.sql:60-72](../packages/db/prisma/rls.sql#L60):

```sql
USING      (rls_bypassed() OR organization_id = current_org_id())
WITH CHECK (rls_bypassed() OR organization_id = current_org_id())
```

with `ENABLE` **and** `FORCE ROW LEVEL SECURITY` so even the table owner is filtered.

### Why `SET LOCAL ROLE app_user` is the whole ballgame

The pooled Prisma client connects as a **superuser**, and superusers bypass RLS
unconditionally. `withTenant` is the *only* caller of `SET LOCAL ROLE`. Therefore:

> **Any query issued outside `withTenant` is unfiltered.** The API leans on this
> deliberately — many portal handlers write no explicit org filter at all
> (e.g. [product.routes.ts:60-82](../apps/api/src/modules/catalog/product.routes.ts#L60)).

Both settings use `set_config(..., true)` — **transaction-local**, never session-level,
because PgBouncer pools connections.

### The self-enforcing gate

[rls-drift.test.ts](../apps/api/test/rls-drift.test.ts) queries `information_schema` for
every table carrying an `organization_id` column and fails the build unless each has RLS
enabled, forced, and ≥1 policy. The exemption list is deliberately **empty**.
[tenant-isolation.test.ts](../apps/api/test/tenant-isolation.test.ts) proves org A cannot
read org B both at the HTTP layer and by rebinding the Postgres connection directly.

> ⚠️ **The worker does not participate in this.** See [§8](#live-defects).

---

## 4. Subsystem index

| Subsystem | One line | Anchor files |
|---|---|---|
| **Tenancy & RLS** | The one seam; `withTenant` + two escape hatches | `lib/db.ts`, `prisma/rls.sql`, `test/tenant-isolation.test.ts`, `worker/jobs/db.ts` |
| **Data model** | 79 models / 39 enums + 97 migrations carrying RLS, triggers and partial unique indexes Prisma can't express | `schema.prisma`, `migrations/20260421082152_rls_helpers/`, `migrations/20260623120000_multi_number_whatsapp/`, `db/src/secret-crypto.ts` |
| **Auth / RBAC** | HS256 access JWT + rotating httpOnly refresh cookie with a device-bound grace window; 3 roles + an HQ `isSuperAdmin` flag; TOTP; a partner SSO; impersonation | `auth/auth.service.ts`, `plugins/auth.ts`, `lib/jwt.ts`, `lib/hq-admin.ts` |
| **AI bot engine** | `gatherBotData` → hybrid retrieval → sectioned prompt (split for Anthropic caching) → plan-routed completion → validators → gate → provenance | `lib/bot-engine.ts`, `lib/openai.ts`, `lib/reply-validators.ts`, `lib/grounding-gate.ts` |
| **Retrieval & embeddings** | Trigram sparse + 1536-d dense, RRF-fused; content-hash-idempotent embed-on-write + a 3-min cross-tenant backfill tick inside the API | `lib/retrieval.ts`, `lib/embedding.ts`, `lib/embed-backfill-tick.ts` |
| **AI safety & audit** | 10-step validator pipeline, shadow/enforce grounding gate, one `MessageProvenance` row per reply | `lib/reply-validators.ts`, `lib/provenance-scanner.ts`, `lib/provenance.ts`, `lib/pipeline-timer.ts` |
| **Scripted flows & fast path** | Two LLM-bypassing layers: a deterministic node engine (optional Haiku distress pre-check) and regex fast-paths | `lib/scripted-flow.ts`, `lib/bot-fastpath.ts`, `db/scripts/seed-fatme-flow.ts` |
| **WhatsApp** | HMAC webhook, multi-number channels each with own creds + bot switch, 24h-window enforcement, templates, media transcode, and the 3,100-line `maybeReplyAsBot` | `whatsapp/whatsapp.routes.ts`, `lib/wa-thread.ts`, `whatsapp-templates/templates.routes.ts`, `lib/meta-media-cache.ts` |
| **Coexistence / Embedded Signup** | Tenant self-connects the number they already use on their handset; consent-gated 180-day history request, a capture-first landing pad, and handset-reply echoes that stop the bot talking over the owner. **Two of its three data streams have no consumer** — see [COEXISTENCE.md](COEXISTENCE.md) | `whatsapp/embedded-signup.ts`, `lib/coexistence-capture.ts`, `lib/handset-echo.ts`, `lib/sales-scan-window.ts`, `migrations/20260820120000_meta_webhook_events/` |
| **Messenger / Instagram** | Second and third surfaces reusing the same tables + engine + validators + gate + provenance; identity is a PSID in the phone slot | `messenger/messenger.routes.ts`, `lib/messenger-send.ts` |
| **Operator inbox** | Unified human surface: thread list, history with presigned media, operator reply (self-assigns → pauses bot), notes, tags, canned replies, SSE | `whatsapp-inbox/inbox.routes.ts`, `lib/inbox-events.ts`, `lib/sse-nonce.ts`, `web/components/inbox/inbox-screen.tsx` |
| **Carts & bookings** | Draft cart built by regex-parsing the bot's own "added N× X" sentences; promoted on `[CART:]`. Bookings resolve a spoken slot against computed availability | `lib/cart-parser.ts`, `lib/cart-flow.ts`, `lib/booking-slots.ts`, `carts/carts.routes.ts` |
| **Payments** | Per-tenant provider switch minting a per-order link + three signature-verified webhooks converging on an idempotent `markCartPaid` | `lib/payments/index.ts`, `lib/payments/confirm.ts`, `payments/payment-webhook.routes.ts` |
| **Wallet & billing** | Prepaid per-tenant wallet in integer micro-USD, charged at send; plus a separate plan/quota system (monthly AI-message allowance, dunning) | `lib/wallet.ts`, `lib/ai-messages.ts`, `lib/billing.ts`, `shared/schemas/wallet.ts` |
| **Voice / phone** | Platform is brain + system of record for an external voicebot: compiles a budgeted prompt + structured form config, ingests idempotent call lifecycle | `voice/voice.routes.ts`, `lib/voice-prompt.ts`, `lib/voice-order.ts`, `voice/phone-integration.routes.ts` |
| **Phone follow-through (CALL-E)** | Outbound AI calls that close chat-opened records: COD order confirmation, booking confirmation, operator goals; dry-run default, verified-number override, region gate, daily cap, CAS write-back | `lib/calle.ts`, `lib/phone-tasks.ts`, `lib/phone-task-tick.ts`, `phone-tasks/phone-tasks.routes.ts`, `phone-tasks/calle-webhook.routes.ts` |
| **Broadcasts & sequences** | CSV/segment/manual audiences fanned out to per-recipient rows, sent under a per-`phone_number_id` token bucket with opt-out + send-window + wallet gates | `worker/jobs/broadcast-fanout.ts`, `worker/jobs/broadcast-send.ts`, `worker/jobs/sequence-tick.ts` |
| **Ingestion** | Streaming CSV/XLSX import, cron+webhook connectors, Shopify scrape→review→commit, Playwright crawler — all converging on one org-scoped upsert | `worker/jobs/import.ts`, `worker/jobs/shared-upsert.ts`, `worker/jobs/shopify.ts`, `worker/jobs/sync.ts` |
| **Read API & webhooks** | Public tenant-data API keyed by `X-Api-Key` with per-key rate limits + org-prefixed Redis cache; HMAC-signed outbound webhooks with backoff + auto-disable | `read/read.routes.ts`, `lib/read-cache.ts`, `lib/webhooks.ts`, `worker/jobs/webhook-delivery.ts` |
| **HQ admin & partner** | Cross-tenant admin panel (orgs, features, wallets, AI cost, provenance browser, exports, eval dashboard, copilot) + a shared-secret partner surface for a partner | `admin/admin.routes.ts`, `partner/partner.routes.ts`, `lib/admin-copilot.ts` |
| **Eval harness** | Golden sets + deterministic scorers + a binary LLM judge running the **real** engine, persisted to an HQ-only `eval_runs` table | `eval/runner.ts`, `eval/scorers.ts`, `eval/README.md` |
| **Build / CI / deploy** | Turborepo (only shared/db/web compile), CI with 9 hard gates and everything else `continue-on-error`, manual pull-based systemd deploy with health-check auto-rollback | `infra/scripts/redeploy.sh`, `.github/workflows/ci.yml`, `infra/systemd/`, `apps/api/src/server.ts` |

---

## 5. Critical paths

### 5.1 Inbound WhatsApp → bot reply *(the product)*

```
Meta POST /api/v1/whatsapp/webhook/:orgId
  → channel resolved by metadata.phone_number_id            whatsapp.routes.ts:2462
  → HMAC-SHA256 over req.rawBody vs x-hub-signature-256     :2497-2524  (rawBody: server.ts:178-193)
  → statuses[] branch: delivery state + refund failed sends :2579-2694
  → messages[] dedup on (org, metaMessageId, inbound)       :2757
  → Contact upsert + multi-locale STOP                      :2817
  → upsertWaThread find-or-create                           wa-thread.ts:29
  → whatsapp_messages row
  → return 200, fire maybeReplyAsBot fire-and-forget        :3066-3081
────────────────────────────────────────────────────────────────────────────
maybeReplyAsBot                                             :3115
  → `withRlsBypass` is REBOUND to withTenant → hot path is RLS-ON  :3139
  → coalesce + flood throttle
  → ~11 skip gates (deployed / thread / assigned / escalated /
     feature 'ai' / blocked / opted-out / channel active + botEnabled)
  → gatherBotData                                           bot-engine.ts:306
  → scripted flow may fully pre-empt                        :3457
  → fast path may answer                                    :3636
  → canSendAiMessage                                        :3998
  → buildBotResponse                                        bot-engine.ts:778
  → validateReply                                           reply-validators.ts:587
  → groundingGate                                           grounding-gate.ts:99
  → payment link, cart sync, marker parse/strip, images, TTS
  → POST graph.facebook.com/v20.0/{phoneNumberId}/messages  :5491
  → persist tx + cart promotion + deterministic receipt     :5677-6100
  → recordProvenance                                        :6154
```

### 5.2 Request → tenant-scoped rows

JWT `org` claim ([plugins/auth.ts:38](../apps/api/src/plugins/auth.ts#L38)) →
`app.tenant(req, fn)` ([tenant-context.ts:22](../apps/api/src/plugins/tenant-context.ts#L22))
→ `withTenant` ([db.ts:38](../apps/api/src/lib/db.ts#L38)) opens an interactive tx, runs
`SET LOCAL ROLE app_user` + `set_config('app.current_org_id', $1, true)` → the policy
filters everything.

### 5.3 Login → rotating session

`POST /auth/login` → `login()` gates `lockedUntil` / disabled / bcrypt / emailVerified /
TOTP / active membership → `issueSession` inserts a `sessions` row, signs access
`{sub,org,role,aa,sid}` + refresh `{sub,sid}`, stores `sha256(refresh)`. Refresh cookie is
httpOnly, `SameSite=Lax`, scoped to `/api/v1/auth`.
`POST /auth/refresh` checks `previous_token_hash` first: **within the grace window AND same
User-Agent** ⇒ benign multi-tab race (new access token, cookie not re-set); otherwise ⇒
treated as theft → revoke session + audit.

### 5.4 Order capture

Bot reply text → `parseAddedItems` upserts draft `CartItem`s by SKU and recomputes totals
(`whatsapp.routes.ts:4393-4573`) → on `[CART:{…}]` the **draft is promoted in place** to
`status='new'` and **the marker's own `items[]` are ignored** (`:5786-5896`) → delivery fee
applied, `fields[]` frozen, thread → `pending`, `cart_created` webhook + notification →
after commit a deterministic `✅ Order #… Total …` receipt is sent, **replacing** the LLM's
own confirmation (`:6056-6100`).

### 5.5 Payment confirmation

`[PAYMENT_LINK]` + a draft with items → `PaymentConfig` decrypted → `resolvePaymentLink`
dispatches per provider ([payments/index.ts:46](../apps/api/src/lib/payments/index.ts#L46))
→ `recordPaymentIntent` stamps provider/ref/pending → later the gateway POSTs
`/api/v1/payments/webhooks/{stripe|myfatoorah|paypal}/:orgId` → signature verified over
`rawBody` (Stripe 300s tolerance; MyFatoorah alphabetically-sorted keys + 24h Redis nonce;
PayPal remote verify) → `findCartByPaymentRef` → `markCartPaid` flips
`status='confirmed'` / `paymentStatus='paid'` / `paidAt`, writes an inbox note, then
post-commit notification + `order_paid` webhook.

### 5.6 Phone call

Bridge holds either the line's API key (dedicated) or the platform gateway secret +
`X-Phone-Integration-Id` (shared) → `GET /voice/resolve?did=` maps the dialed number to a
tenant → `GET /voice/config` returns a **budgeted** compiled prompt (24k-char budget with
section dropping, [voice-prompt.ts:189](../apps/api/src/lib/voice-prompt.ts#L189)) plus
structured `orderForm`/`bookingForm` built from **the tenant's own field keys**, cached in
the read-API Redis keyspace so a catalog write invalidates the persona →
`POST /voice/calls`, `…/turns` (idempotent on `(voiceCallId, seq)`), `…/end` (write-once) →
`submit_order`/`submit_booking` run required-field and min-order guards and return
spoken-friendly 400s the model reads back to the caller.

### 5.7 Broadcast send

Wizard → `/broadcasts` → fanout worker materialises `BroadcastRecipient` rows (round-robin
across selected numbers) → send worker: opt-out gate → recipient-TZ send window →
per-`phone_number_id` token bucket → `canAfford` → Meta template send → `chargeAtSend`
debits the wallet and stamps `billed_at` → Meta status webhook re-enters
`whatsapp.routes.ts:2613` to advance counters and, on `failed`, `refundFailedSend` credits
the wallet back (idempotent via an atomic `refunded_at` claim).

### 5.8 Catalog write → bot sees it

Catalog route or import/Shopify/sync worker → embed-on-write (content-hash idempotent),
with the 3-minute `embed-backfill-tick` as the universal backstop for rows written by any
path → `emitWebhookEvent` fires outbound webhooks **and** invalidates `read:{orgId}:*`,
which also flushes the compiled voice persona → next `gatherBotData` sees the row.

### 5.9 Deploy

`git push origin main` → SSH to the box → `bash infra/scripts/redeploy.sh` in
`/opt/platform/app` → ensure 4G swap → `git reset --hard origin/main` → diff against
`.last-deployed-sha` → conditional `pnpm install` → `prisma generate` (3 retries) → wipe
and rebuild `@platform/db` + `@platform/shared` dist → `prisma migrate deploy` → conditional
`next build` (3 retries, 2GB heap) → `systemctl restart platform-api/-worker` (+web if
rebuilt) → poll `/health` 20×3s → **on failure auto-rollback** to the last known-good SHA.

### 5.10 Coexistence connect → handset reply *(the newest path, and the least proven)*

`POST /whatsapp/embedded-signup/exchange` — an eight-step ordering that touches no database
until Meta's 30-second code is spent: trade code → prove the number via `/{waba}/phone_numbers`
→ cross-check app id + secret → **write the channel BEFORE subscribing** (Meta can deliver the
instant the subscription lands) → `POST /{waba}/subscribed_apps` with an override callback →
read the callback back (⚠ advisory only) → request `smb_app_state_sync` **unconditionally** and
`history` **only** behind three fail-closed gates (fresh versioned consent + the `sales_scan`
feature + a grant created *first*).

Afterwards: any webhook field that is not `messages` is **parked verbatim** in
`meta_webhook_events` before the live loops run — awaited, not fire-and-forget, returning 503 on
failure so Meta redelivers, because `history` arrives **once** and Meta never retries a 200.
`smb_message_echoes` is then consumed by `consumeMessageEchoes`, which stamps
`whatsapp_threads.handset_replied_at` forward-only and overwrites the `botcoalesce` token so a
reply typed mid-generation kills the bot's draft.

⚠ **Nothing on this path has ever run against real Meta bytes**, and the `history` and contact
streams are parked but never read. Full detail, invariants and gap list: **[COEXISTENCE.md](COEXISTENCE.md)**.

---

## 6. Invariants

Rules that must never break. Each names where it is enforced.

### Tenancy
1. Tenant filter is `rls_bypassed() OR organization_id = current_org_id()` for both USING
   and WITH CHECK, with FORCE RLS — `rls.sql:60-72`.
2. **RLS only bites inside `withTenant`**, the sole caller of `SET LOCAL ROLE app_user`
   — `db.ts:41`. The pooled client is a superuser; anything outside is unfiltered.
3. Settings must be transaction-local (`set_config(..., true)`) because PgBouncer pools
   connections — `db.ts:41-42`.
4. Every `organization_id` table has RLS enabled + forced + ≥1 policy; exemption list is
   empty — `rls-drift.test.ts:14,44-57`.
5. Org A must never read org B by crafted id — `tenant-isolation.test.ts:108-129`. **The one
   true hard deploy gate** (`ci.yml:75-76`).
6. `sessions` is bypass-only and `users` writes require bypass — `rls.sql:247,266-275`.
   Tenant transactions must never touch them.

### Webhooks & ingestion
7. Every inbound webhook (Meta WA, Meta Messenger/IG, connector, Shopify, Stripe,
   MyFatoorah) must be HMAC-verified over the **original bytes** in `req.rawBody`, never a
   re-serialization — captured once at `server.ts:178-193`.
8. Webhook handlers return 2xx fast and do work fire-and-forget; Meta retries on non-2xx or
   >5s — `whatsapp.routes.ts:3066-3081`.
9. Inbound processing is idempotent on `(organizationId, metaMessageId, direction)` so a
   Meta retry cannot double-reply or double-capture an order — `:2757-2775`.
10. WhatsApp thread dedup uses **two partial unique indexes** Prisma cannot express, so
    resolution must be findFirst→create with a P2002 retry, never `upsert` —
    `migrations/20260623120000_multi_number_whatsapp/migration.sql:93-99`, `wa-thread.ts:29`.

### Bot behaviour
11. The bot never replies when: `BotConfig.deployedAt` is null, the thread is assigned or
    `escalated`, the org feature `ai` is off, the contact is blocked or opted-out, the
    arriving channel is inactive or `botEnabled=false`, the monthly AI-message allowance
    is exhausted, **the inbound is older than `BOT_MAX_INBOUND_AGE_MINUTES` by Meta's own
    timestamp** (the 2026-08-10 stale-redelivery gate), or **the business already answered
    this message from their handset** (`handset_replied_at` ≥ the inbound's timestamp —
    §5.10) — `whatsapp.routes.ts:3254-3361,3998`. *(Line refs in this file are
    from `4e334f6`; `bot-engine.ts` and `openai.ts` shift often — grep the symbol name
    if a number looks off.)*
12. The bot goes silent the moment a human takes over — which is why the operator reply
    route self-assigns the thread — `inbox.routes.ts:1030-1036`.
13. Free-form WhatsApp text/media is legal only inside Meta's 24-hour window; outside it
    only an approved template may be sent — `whatsapp.routes.ts:1596-1609`.
14. `gatherBotData` does DB reads **only** and must return before the LLM call;
    `buildBotResponse` must hold **no** Prisma transaction, or the 5s interactive-tx timeout
    expires mid-completion — `bot-engine.ts:15-22,773-774`.
15. A scripted flow, once enabled, **fully owns** the conversation: `runScriptedFlow`
    returning true means the caller MUST skip the LLM — `scripted-flow.ts:115-117`.

### AI output safety
16. The **draft cart**, not the LLM's `[CART:]` marker items, is the source of truth for
    order contents — `whatsapp.routes.ts:5786-5789,5853-5885`.
17. No booking or order may be claimed to the customer without a persisted row —
    `reply-validators.ts:305-334`.
18. `[IMAGE:]` markers pointing at an unknown SKU are dropped server-side before send —
    `reply-validators.ts:176-201`.
19. All internal markers and any unresolved `{{…}}` token must be stripped before the text
    reaches a customer — `whatsapp.routes.ts:4681-4688,5062-5068`.
20. The grounding gate and `recordProvenance` must judge a reply against the **same**
    candidate bundle — `buildScanCandidates` is the single source of truth —
    `grounding-gate.ts:53-56`.
21. **Nothing in the AI path may be load-bearing**: provider tiers degrade to the basic
    stack on any error; validators / gate / provenance / notifications are all wrapped so a
    failure degrades but never blocks a reply — `openai.ts:449-525`, `provenance.ts:162-167`.
22. The **only** enforced AI spend limit is the monthly AI-message allowance. The daily
    token counter is tracking-only and `consumeDailyTokens` always returns true — this
    deliberately kills the old outage mode where a token cap bricked a tenant's bot —
    `openai.ts:191-207` (`return true` at :207), `ai-messages.ts:72`.
23. Prompt-cache correctness: `systemPromptStable + '\n' + systemPromptVariable` must be
    byte-identical to `systemPrompt`, and the split is keyed on the literal `# Catalog`
    header — `bot-engine.ts:1544-1551`. **Renaming that header silently disables caching.**
24. Embeddings are content-hash idempotent, so the 3-minute backfill tick is free at steady
    state — `embedding.ts:41-44`.

### Money
25. **Units.** Catalog prices = `Int` minor units. `Cart`/`CartItem` money = **BigInt**
    minor units (after the LBP int4 overflow that bricked a live bot). Wallet = **BigInt
    micro-USD**. Convention: arithmetic in JS `number`, `Number()` on read, `BigInt()` on
    write — `schema.prisma:1714-1716,1767-1768,2634-2659`.
26. Totals are always recomputed server-side from `CartItem` rows; client- or LLM-supplied
    totals are never trusted — `carts.routes.ts:85-98`.
27. Payment confirmation is idempotent: `paidAt` is written once and short-circuits later
    calls; `recordPaymentIntent` filters on `paidAt IS NULL` so it can never downgrade a
    paid order — `payments/confirm.ts:57,171`.
28. Wallet metering is **opt-in twice over** (no wallet row ⇒ unmetered;
    `metering_enabled=false` ⇒ ungated), and charge/refund are idempotent per recipient via
    `billed_at` + an atomic `refunded_at` claim — `schema.prisma:2599-2605,2645`.
29. Voice orders are idempotent per `callUuid` — a retried `submit_order` returns the
    existing cart with `merged=true` — `voice-order.ts:140-162`.

### Data integrity
30. **Secrets at rest.** bcrypt cost 12 for passwords; sha256 for verify/reset/invite/API-key
    tokens; AES-256-GCM for TOTP secrets and integration credentials. The transparent Prisma
    extension covers **only** `whatsAppChannel.accessToken/appSecret` — every other secret is
    encrypted by an explicit call at its own call site — `db/src/secret-crypto.ts:125,165-176`.
31. Rows with `source_system='partner'` on products/services are immutable outside
    `witha partnerSync`, enforced by a trigger that **RETURNs NULL** (silently cancels the
    write) — which even a superuser cannot bypass —
    `migrations/20260713131000_partner_readonly_trigger/migration.sql:27-39`.
    *Corollary: never backfill `price_minor` for mirror rows; RE price lives in `attributes`.*
32. `audit_logs` is append-only and hash-chained per org by a BEFORE INSERT trigger under a
    per-org advisory lock. The application must never set `prev_hash`/`hash`; `recordAudit`
    never throws — `migrations/20260526150000_audit_log_hash_chain/migration.sql:70-123`.
33. `search_text` on products/services/faqs is **trigger-owned**; any application write is
    overwritten — `rls.sql:189-223`.
34. Every key in `ORG_FEATURE_DEFAULT_DISABLED` MUST ship an
    `array_append(disabled_features,'<key>')` backfill migration —
    `feature-backfill-invariant.test.ts:59`.
35. Tenant **type** must be read from the positive `Organization.sourceSystem` column and
    fail **closed** to `'native'`; never inferred from a feature flag's presence or absence —
    `schema.prisma:390-400`.

### Plumbing
36. The SSE nonce is single-use and consumed atomically with a Lua GET+DEL (prod Redis is
    <6.2, so native `GETDEL` is unavailable) — `sse-nonce.ts:38-47`.
37. Every route must throw an `HttpError` from `lib/errors.ts`; a plain `Error` becomes an
    opaque 500 — `plugins/error-handler.ts`.

### Coexistence
*(Full reasoning for each: [COEXISTENCE.md](COEXISTENCE.md) §7.)*

38. **Never request `history` without fresh, versioned, explicitly-acknowledged consent.**
    `shouldRequestHistory` fails closed — absence is never consent —
    `coexistence-capture.ts:68-76`.
39. **The grant is created BEFORE the request**, never after; if creation throws we do not
    ask. History can begin arriving the instant Meta accepts, so ordering is the only thing
    guaranteeing a corpus never exists without a record of what was agreed.
40. **The consent SHA is pinned in the blocking pure gate.** Editing
    `COEXISTENCE_CONSENT_TEXT` without bumping `_VERSION` fails CI. The Baileys copy and its
    hash are **separate and untouched** — they describe a different transport.
41. **Never unsubscribe `history`, `smb_app_state_sync` or `smb_message_echoes`.** `history`
    is delivered **once**, inside a 24-hour window, and cannot be re-requested without the
    tenant fully offboarding from their handset.
42. **The two revocation routes stay ungated by the feature flag.**
    `DELETE /sales-scan/grant` and `DELETE /sales-scan/messages` must never sit behind
    `assertOrgFeature` — switching the feature off must not trap a tenant's own "stop" and
    "delete". This hole existed and was closed 2026-08-05; do not reintroduce it.
43. **`handset_replied_at` is written forward-only** and compared against the inbound
    message's **own** timestamp, never `now()` — Meta redelivers for 7 days, and an
    out-of-order older echo must not walk the stamp backwards — `handset-echo.ts`.
44. **Park before consume.** The raw `meta_webhook_events` row is the recoverable copy;
    `processed_at` is stamped only on success, and a park failure returns **503** so Meta
    redelivers — a 200 is unrecoverable.

---

## 7. How to read this repo

Seven passes, each depending only on what earlier passes established. **Read the giant
files by region** — the region maps below are the point of this section.

### Pass 1 — Orientation and the tenancy boundary *(3–4h)*

`CLAUDE.md` §1–§4 and **only the top 5 entries of §5** (the rest is a 6-month changelog —
archaeology, not truth) · `docs/PLATFORM-REPORT.md` · `pnpm-workspace.yaml` · root
`package.json` scripts · `turbo.json` · **`apps/api/src/lib/db.ts`** (92 lines) ·
`packages/db/prisma/rls.sql` (helpers :28-36, role + grants :41-56, macro :60-72, custom
policies :227-275) · `migrations/20260421082152_rls_helpers/` ·
`apps/api/src/plugins/tenant-context.ts` · `apps/api/src/plugins/auth.ts` ·
`apps/api/test/tenant-isolation.test.ts` · `apps/api/test/rls-drift.test.ts` ·
**`apps/worker/src/jobs/db.ts`** — read against the API twin; *the difference is the point*.

`schema.prisma` **regions only**: `:369-470` (Organization/User) · `:1426-1500` (channels) ·
`:1556-1640` (threads) · `:1689-1780` (Cart/CartItem BigInt) · `:2634-2670` (TenantWallet).

Then `packages/shared/src/constants/org-features.ts` ·
`packages/shared/src/types/api-error.ts` · `apps/api/src/server.ts` (note the `rawBody`
parser at :178-193).

**Exit:** explain why `SET LOCAL ROLE app_user` is the whole ballgame; name the three DB
access modes; say which processes actually enforce RLS; point at the file every HMAC
verifier depends on.

### Pass 2 — API skeleton: identity, config, errors, secrets *(3–4h)*

`lib/jwt.ts` · `lib/cookies.ts` · `lib/crypto.ts` · `auth/auth.service.ts` (the grace window
and `refreshSession`) · `auth/auth.routes.ts` · `lib/hq-admin.ts` · `plugins/api-key.ts` ·
`plugins/error-handler.ts` · `lib/errors.ts` · `lib/env.ts` (also the de-facto docs for AI
provider routing) · `db/src/secret-crypto.ts` · `db/src/client.ts` · `lib/audit.ts` +
`scripts/verify-audit-chain.ts` + `migrations/20260526150000_audit_log_hash_chain/` ·
`shared/schemas/common.ts` · `shared/schemas/auth.ts` · `shared/src/index.ts` ·
`lib/org-feature-guard.ts` · `lib/redis.ts`.

**Exit:** the five auth modes and where each gets its org id; why a *new* secret column is
plaintext by default; that access tokens are never revocation-checked.

### Pass 3 — The bot brain *(5–6h)*

`lib/bot-engine.ts` **regions** (1,860 lines): `:48-120` (`BotData`) · `:306-460`
(`gatherBotData` + load caps) · `:778-1035` (`buildBotResponse` opens; retrieval / RRF) ·
`:1160-1560` (prompt-section array; the `# Catalog` header at :1398 and the prompt-cache
split at :1544-1551) · `:1780-1860` (marker parsers).

Then `lib/retrieval.ts` · `lib/embedding.ts` · `lib/embed-backfill-tick.ts` ·
`lib/openai.ts` (`consumeDailyTokens` :191-207, plan router `switch (plan)` :307) ·
`lib/ai-messages.ts` · `lib/ai-pricing.ts` · `lib/model-degrade.ts` ·
`lib/reply-validators.ts` (the 10-step pipeline ~:587) · `lib/grounding-gate.ts` ·
`lib/provenance-scanner.ts` · `lib/provenance.ts` · **`lib/pipeline-timer.ts`** (its header
comment is the clearest prose description of the reply pipeline) · `lib/scripted-flow.ts` ·
`lib/bot-fastpath.ts` · `lib/contact-memory.ts` · `lib/markdown-normalize.ts` ·
`lib/variant-image-collapse.ts` · `eval/README.md` + `eval/runner.ts` ·
`docs/OPERATOR-INPUTS.md` (which DB field produces which prompt sentence) ·
`test/reply-validators.test.ts`.

**Exit:** recite the prompt sections in order; name the three layers that can suppress or
rewrite a reply and which is only in shadow mode; explain why the marker protocol exists
instead of trusting the model's prose.

### Pass 4 — WhatsApp end-to-end, then Messenger/IG and the inbox *(6–7h)*

Read `whatsapp.routes.ts` **in execution order, by region.** Skip `:54-680` (helpers) and
`:691-2390` (config routes) on the first pass:

| Region | What |
|---|---|
| `:2391-2540` | handshake, HMAC, channel resolution by `phone_number_id` |
| `:2579-2700` | status webhook → broadcast counters → wallet refund |
| `:2746-3081` | ingest: dedup, contact/STOP, thread, message, media, bot dispatch |
| `:3115-3500` | `maybeReplyAsBot` gates → `gatherBotData` → scripted-flow pre-emption |
| `:3506-3730` | handoff short-circuit, fast path |
| `:4143-4300` | validators, grounding gate, payment link |
| `:4393-4712` | cart sync, marker parse/strip, buttons |
| `:4713-4950` | images, greeting media |
| `:5306-5560` | TTS, then the actual Meta send |
| `:5677-6100` | persist tx, booking, cart promotion, receipt |
| `:6144-6238` | provenance |

Then `lib/wa-thread.ts` + the two partial unique indexes in
`migrations/20260623120000_multi_number_whatsapp/` · **second sweep** of `:691-1180`
(channel config, verify, WABA subscribe) and `:1508-2160` (the two operator send routes) ·
`lib/meta-media-cache.ts` · `lib/wa-voice-note.ts` · `lib/opt-out.ts` ·
`lib/audio-transcode.ts` · `whatsapp-templates/templates.routes.ts`.

`messenger/messenger.routes.ts` regions: `:333-450` (webhook + HMAC) · `:449-619`
(ingestion) · `:621-830` (bot gates + the WS4a parity block) · `:894-1207` (cart, payment,
booking, send, provenance). Then `lib/messenger-send.ts`.

`whatsapp-inbox/inbox.routes.ts` regions: `:36-260` (thread DTO) · `:269-470` (list +
filters) · `:466-850` (history, media presign, template hydration) · `:963-1060` (operator
reply, self-assign) · `:1251-1520` (block, tags, notes, handoff) · `:1618-1670` (SSE) ·
`:1781-2093` (admin provenance). Then `lib/inbox-events.ts` · `lib/sse-nonce.ts` ·
`shared/schemas/whatsapp.ts` · `test/multi-number-whatsapp.test.ts` ·
`infra/scripts/wa-backfill-subscribe.ts`.

**Exit:** name every gate between inbound and sent, in order; explain
`override_callback_uri` and why a "verified green" number can still have an empty inbox;
explain why the same customer gets a thread per WhatsApp number but one on Messenger;
explain how an operator reply silences the bot.

### Pass 5 — Commerce and money *(4h)*

`shared/schemas/cart.ts` · `lib/cart-parser.ts` (the three anti-hallucination guards) ·
`lib/cart-flow.ts` (the channel-agnostic engine Messenger and voice use) ·
`carts/carts.routes.ts` · `test/cart-parser.test.ts` · `lib/booking-slots.ts` ·
`bookings/bookings.routes.ts` · `worker/jobs/booking-reminder-tick.ts` ·
`lib/payments/index.ts` · `lib/payments/confirm.ts` · `payments/payment-webhook.routes.ts` ·
`payments/payment.routes.ts` · `lib/myfatoorah.ts` · `lib/wallet.ts` **+ its worker twin** ·
`shared/schemas/wallet.ts` · migrations `20260701130000_tenant_wallet_billing` and
`20260630160000_cart_money_bigint` · `lib/billing.ts` · `worker/jobs/draft-cart-ttl.ts`.

**Exit:** why the LLM's `[CART:]` items are ignored; the money unit for catalog prices vs
cart totals vs wallet and where each converts; the (much shorter than documented) list of
paths that actually debit the wallet.

### Pass 6 — Voice and the async spine *(5h)*

`voice/voice.routes.ts` · `lib/voice-prompt.ts` (24k budget + section dropping :448-461;
structured form contract :472-492) · `plugins/voice-gateway.ts` ·
`voice/phone-integration.routes.ts` · `lib/voice-order.ts` · `lib/voice-booking.ts` ·
`lib/voice-payment.ts` · the three `lib/tts-*.ts` skimmed together · `lib/queues.ts` ·
`apps/worker/src/index.ts` · **`worker/jobs/shared-upsert.ts`** (where every ingestion path
converges) · `worker/jobs/import.ts` · `worker/jobs/sync.ts` · `worker/jobs/shopify.ts` ·
`worker/jobs/crawl.ts` (skim) · `lib/safe-fetch.ts` + `shared/util-ssrf.ts` ·
`worker/jobs/broadcast-fanout.ts` · `worker/jobs/broadcast-send.ts` ·
`worker/jobs/sequence-tick.ts` · `lib/webhooks.ts` + `webhooks/webhooks.routes.ts` +
`worker/jobs/webhook-delivery.ts` · `read/read.routes.ts` + `lib/read-cache.ts` ·
`worker/jobs/data-export.ts` + `shared/constants/export-sections.ts`.

**Exit:** how the external voicebot gets a tenant-specific prompt and why a catalog edit
invalidates it; every queue and tick and what each guarantees; **why a worker job that
forgets an org filter has no database backstop**; how the read cache is keyed and invalidated.

### Pass 7 — HQ admin, portal, and how it ships *(4h)*

`admin/admin.routes.ts` **regions only** — `:250-300` (org creation + feature union) ·
`:440-470` (org delete) · `:820-900` (impersonation) · `:3640-3760` (copilot + feature
toggles). **Do not read all 4,048 lines.** Then `lib/admin-copilot.ts` (skim the
cross-tenant tool list) · **`partner/partner.routes.ts` in full** — short, and the sharpest
edge in the system · `shared/schemas/org.ts` · `status/status.routes.ts` ·
`plugins/healthcheck.ts` · `plugins/metrics.ts` · `lib/trust-proxy.ts`.

Web: `apps/web/next.config.ts` · `src/lib/session.tsx` · `src/lib/api.ts` · `src/lib/sse.ts` ·
`src/app/(dashboard)/layout.tsx` (the client-side feature/route gate) ·
`src/components/shell/sidebar.tsx` · `inbox-screen.tsx` **regions only** (`:280-320` and
`:580-600` channel filter · `:900-960` channel-aware send · `:2780-2810` canned
substitution · `:3600-3621` SSE hook) · `hq/new-tenant/page.tsx`.

Ship: **`infra/scripts/redeploy.sh` every line — this IS the deploy** ·
`.github/workflows/ci.yml` (note which steps are `continue-on-error` and which are hard
gates) · `infra/systemd/README.md` + `platform-api.service` · `infra/caddy/Caddyfile` ·
`docs/RUNBOOK.md` (treat the Docker sections as obsolete) ·
`docs/SECURITY-AUDIT-2026-05-26.md` (skim) · `docs/ai-upgrade-plan.md` (skim — it defines
the shadow→enforce doctrine).

**Exit:** deploy a change end-to-end and roll it back; state exactly which tests can block a
PR; explain why the portal lives under `/app` and what breaks when `WEB_PUBLIC_URL` omits
it; name the two surfaces where one shared secret or one admin flag grants cross-tenant reach.

---

## 8. Gotchas

### Stale documentation (the code disagrees)

| Claim | Reality |
|---|---|
| `CLAUDE.md` §2: **Email = Resend** | [lib/email.ts](../apps/api/src/lib/email.ts) is **nodemailer over SMTP** (AWS SES in prod, Mailpit in dev). Resend appears nowhere. |
| `CLAUDE.md` §2: **Hosting = Docker Compose + Caddy** | Prod is **native systemd** + a manual pull-based `redeploy.sh`. The Docker prod stack was deleted. |
| ~~`README.md` advertises the wrong domains and commits live production credentials in plaintext~~ | **RESOLVED 2026-08-28.** The credentials were stripped, and the file was rewritten as a real entry point (doc index, stack, local-dev traps, CI reality, deploy). ⚠ **The credentials remain in git history — rotation, not deletion, is the remedy.** |
| ~~`worker/jobs/db.ts` header: "Mirrors apps/api/src/lib/db.ts so that RLS is enforced"~~ | **RESOLVED 2026-08-28 (`d9ee8a5`).** It now does: `SET LOCAL ROLE app_user` at [db.ts:28 and :39](../apps/worker/src/jobs/db.ts#L28), tagged `H-1`. The header is accurate again. *(Recorded rather than deleted because the old entry outlived the defect and caused two separate reviews to re-report a fixed bug as critical.)* |
| `whatsAppChannel` schema comment (`schema.prisma:1426-1429`): fields stored plain | They are AES-256-GCM encrypted via the Prisma extension. |
| `provenance.ts:13-15`: "NEVER awaited" | `whatsapp.routes.ts:6157` awaits it. |
| `messenger.routes.ts:9-10`: images/cart/booking are "follow-ups" | All shipped. |
| `templates.routes.ts:9-16`: a template-status webhook exists | It does not — status only changes via manual sync. |
| `rls.sql` header: the authoritative policy registry | `bookings` is missing from it; its policy exists only inline in `migrations/20260513170000_bookings/`. |

### Live defects

**Tenancy / deploy**
- ~~**The worker does not enforce RLS.**~~ **FIXED 2026-08-28 (`d9ee8a5`).**
  [worker/jobs/db.ts](../apps/worker/src/jobs/db.ts#L28) now issues `SET LOCAL ROLE app_user`
  in both helpers (tagged `H-1`), so worker queries get the same database backstop as the API.
  **Still worth doing:** the hand-written `where` clauses this defect used to be the only guard
  for remain thin in places — `shopify.ts:270,337`; `import.ts:156`;
  `broadcast-send.ts:404,423,481,534`; `broadcast-fanout.ts:240,275,325,398`. RLS now covers
  them, but belt-and-braces is the house rule.
- **Production never applies `rls.sql`.** [redeploy.sh:125](../infra/scripts/redeploy.sh#L125)
  runs `prisma migrate deploy` directly, **not** the `migrate:deploy` package script that
  chains `pnpm rls:apply`. CI *does* apply it, so **CI is permanently greener than prod**.
  → *Put every new policy **inline in its migration**. Anything living only in `rls.sql`
  never reaches production.*
- **`rls.sql` is not cleanly idempotent.** It does `DROP POLICY IF EXISTS tenant_isolation ON
  sessions` but creates a differently-named `sessions_bypass_only`, so a second apply raises
  42710 — and because node-pg runs the file as one implicit transaction, **everything rolls
  back**, including the trailing wallet tables. One-line fix, never made.
- **Partner routes take the org id from the request body.**
  [partner.routes.ts:225,317,356](../apps/api/src/modules/partner/partner.routes.ts#L225)
  pass a body-supplied `platformOrgId` straight into `witha partnerSync`/`withRlsBypass`,
  authenticated by one platform-wide shared secret. RLS provides **zero** protection because
  the org id *is* the input — and `/reset` destructively deletes any org's mirror. This
  directly contradicts the rule written at [db.ts:74-76](../apps/api/src/lib/db.ts#L74).

**Bot / channel**
- **The bot resolves threads without the channel.** `whatsapp.routes.ts:3259` does
  `findFirst({ organizationId, customerPhone })` with no `whatsAppChannelId` and no
  `orderBy`; the outbound persist at `:5678` repeats it — while the webhook correctly
  created a per-channel thread. For a customer who messaged two of the org's numbers, the
  bot can read history from and log its reply into the **wrong number's thread**.
- **`if (thread.inboundCount === 0)` is unreachable** (`:2983`). `upsertWaThread` returns the
  post-write row — create sets `inboundCount: 1`, update increments. So the "New
  conversation" notification never fires. The comment two lines above says the intended test
  was `== 1`.
- **Thread search text is clobbered on every inbound.** The update sets
  `searchText: { set: '' }` (`:2949`) and the follow-up raw SQL appends to the now-empty
  column, so the "rolling 16 KB blob" only ever holds the latest message. Inbox search
  across history silently does nothing.
- **The grounding gate is effectively blind to Arabic.** Both hallucination detectors
  ([provenance-scanner.ts:532,568](../apps/api/src/lib/provenance-scanner.ts#L532)) require
  English trigger words *and* `[A-Z]` Latin capitals, so an Arabic reply can never reach
  severity `critical` and can never be blocked even in enforce mode. Most tenants are
  Arabic-first. The gate also judges against the **full** gathered catalog, not the top-K
  actually packed into the prompt.
- **`GROUNDING_GATE_MODE` defaults to `shadow` and prod is on shadow.** Nothing is refused;
  it only annotates `MessageProvenance.blocked`. Do not read "gate" as "enforcement".
- **The monthly AI-message cap is bypassed by three paths.** `canSendAiMessage` sits at
  `:3998`, *after* the scripted-flow `continue` (`:3473`), the handoff-confirm `continue`
  (`:3627`) and the fast-path `continue` (`:3726`). A pure scripted-flow tenant is
  effectively uncapped, and those replies produce **no provenance row**.
- **Blocking a Messenger/IG customer does not stop the bot.** The inbox normalises
  `customerPhone` with `toE164()` (`inbox.routes.ts:144`) and blocks `+<PSID>`, but Messenger
  ingestion and the bot's block gate key on the **raw** PSID (`messenger.routes.ts:577,653`).
  Blocking creates a second contact row, the badge shows blocked, and the bot keeps replying.
- **`POST /inbox/threads/:id/handoff` sets status `pending`**, but the bot only stops on
  `escalated` or an assignee. The generic handoff endpoint does not silence the bot; the UI
  toast says it does.
- **The 24-hour window check is not channel-scoped** (`:1596`). An inbound on number A opens
  the free-form window for a send from number B, which Meta then rejects with 131047.
- **Inbound media always uses the primary channel's token** (`:219,407`), and
  `/whatsapp/send-media` and `/whatsapp/subscribe` are hardcoded to `isPrimary`. Secondary
  numbers can receive text but not media.
- **`knowledge_base_entries` is dead for the bot** but still live in the UI: `gatherBotData`
  always returns `kb: []` (`bot-engine.ts:429`), yet the crawl worker still writes the table
  and `/bot` routes still CRUD it. Operators can enter KB rows the bot will never read.
- **The daily token budget is dead code with live handlers.** `consumeDailyTokens` always
  returns true, so every `TOKEN_BUDGET_EXCEEDED` throw is unreachable — yet
  `whatsapp.routes.ts:4055` still branches on it and the admin UI still reports a "limit".

**Money** *(18 defects survived adversarial refutation; 6 were killed)*
- **Payment links are minted on the cart subtotal, excluding delivery**
  (`whatsapp.routes.ts:4290`, `messenger.routes.ts:949`) while the persisted order and the
  receipt charge subtotal + delivery. Any tenant with a delivery fee **under-collects by
  exactly that fee**. The voice path (`voice-payment.ts:43`) correctly bills the total — so
  the three paths disagree.
- **Payment links are minted from the pre-LLM draft-cart snapshot**, so items added in the
  same reply are excluded from the invoice amount.
- **`markCartPaid` never compares the gateway's reported amount or currency to the order
  total** (`payments/confirm.ts:42-99`) — an underpayment marks the order fully paid.
- **Currency minor-unit tables are duplicated 3–4× with different contents**
  (`bot-engine.ts:282`, `voice-payment.ts:25`, `whatsapp.routes.ts:4288/6029`,
  `carts.routes.ts:332`, `web/src/lib/format.ts:13`). For a JOD/TND/IQD/LYD tenant the
  invoice amount and the displayed amount differ by 10×.
- **`products.price_minor` is still `int4`** (`schema.prisma:778`) with no upper bound in the
  write path — cart money was migrated to BigInt, catalog was not. High-denomination (LBP)
  prices above ~21.4M major units fail with an opaque 500.
- **Cart lines are priced off the parent product only**; a null parent price silently becomes
  0 and overrides the correct marker price.
- **The marker-fallback promote skips `CartItem` creation on an item-less draft**, producing
  a priced order with zero line items.
- **Messenger/IG `captureCart` has no duplicate-capture guard** (`cart-flow.ts:307-437`) — a
  re-fired `[CART:]` marker creates a second payable order.
- **`/rerun-failed` refunds already-delivered, correctly-billed recipients** (it lacks the
  never-delivered guard the webhook and reaper both apply) **and clears `billed_at` even when
  the refund threw**, permanently stranding the charge (`broadcasts.routes.ts:1316,1323`).
- **Sequence and test-send charges carry no recipient id** (`sequence-tick.ts:209-213`) → the
  charge is non-idempotent *and* structurally unrefundable, because `refundFailedSend` is
  keyed exclusively on `broadcast_recipients`.
- **A metered broadcast message can be sent-but-never-billed** when `chargeAtSend` throws
  after the recipient is marked `sent` — three separate top-level Prisma calls with no
  enclosing transaction (`broadcast-send.ts:593-620`).
- **Booking-reminder templates bypass the wallet entirely** — a Meta-billable message class
  with no balance gate and no charge.
- **`wallet.adjust` records the full requested delta in the immutable ledger even when the
  balance clamp applied less** (`wallet.ts:216,222`).
- **Changing the org currency relabels every catalog price without rescaling `priceMinor`**
  (`business-info.routes.ts:138-153`).
- **api and worker `chargeAtSend` have diverged**: the API copy has
  `AND metering_enabled = true` in its conditional UPDATE ([wallet.ts:408-410](../apps/api/src/lib/wallet.ts#L408));
  the worker copy does **not** ([worker/lib/wallet.ts:68-69](../apps/worker/src/lib/wallet.ts#L68)).
  The worker treats the broadcast's price snapshot as its metering authority, so the window is
  narrow — reachable when metering is toggled off while a broadcast is in flight.
- **The wallet does not charge conversational traffic.** `chargeAtSend`/`canAfford` appear
  only in `broadcast-send.ts`, `sequence-tick.ts`, and `POST /whatsapp/test-send`. Neither
  `maybeReplyAsBot` (which can emit ~7 billable Meta messages per turn) nor the operator's
  manual send ever charges. This contradicts `CLAUDE.md`'s "charges per WhatsApp message
  sent" — but may be the intended design. **Open question #2.**

*Refuted (recorded so nobody re-raises them):* the `DEFAULT_META_COST_MICROS` fallback is
unreachable and feeds no margin report; the low-balance threshold **is** read at runtime and
warns on four paths; `adjust()`'s clamped ledger row does not corrupt the balance (every row
stores the authoritative post-state); PayPal's `.toFixed(2)` cannot mischarge because PayPal
supports no 3-decimal currency.

**Structural / drift**
- **Two full implementations of the cart logic exist and have diverged** — the inline one in
  `whatsapp.routes.ts` and `lib/cart-flow.ts` (used by Messenger and voice). `cart-flow` uses
  `toBig()` on every money write; `whatsapp.routes.ts:4515` passes plain JS numbers into
  BigInt columns. **Every fix must be made twice.**
- **`_partner_guard_mirror_row` fails silently by design** — it RETURNs NULL, so a bulk UPDATE
  touching a partner mirror rows reports success and changes nothing. Superusers do **not**
  bypass triggers. Anyone debugging "my UPDATE did nothing" must check `source_system` first.
- **Transparent secret encryption covers exactly one model and two fields**
  (`whatsAppChannel.accessToken/appSecret`). Every other secret is encrypted by an explicit
  call at its call site, so **a new token column is plaintext by default**. The module is also
  a no-op passthrough when `SECRET_ENCRYPTION_KEY` is unset, so dev differs from prod.
- **Audit actions are heavily overloaded** — feature changes and org self-delete log
  `org_suspended`; org export and payment-config changes log `business_info_updated`; all
  three 2FA operations log `password_changed`. **Any query filtering by action is wrong** —
  the real event is in `metadata.event`.
- **Impersonation sessions have no time-box.** `isImpersonation` is sticky on the session row
  and `refreshSession` keeps synthesizing `role='admin'` for the life of the sliding 30-day
  refresh token; only `switch-org` ends it.
- **Two incompatible user-tombstone conventions exist** and neither clears `partnerSubject`, so
  re-provisioning a disconnected a partner agency returns the dead user and org.

**Toolchain**
- **`pnpm lint` is non-functional.** ESLint 9 (flat-config-only) is pinned and every package
  runs `eslint .`, but there is **no `eslint.config.*` at any package root** — only
  `packages/config/eslint/*.js`, which nothing wires up. That is why CI's lint step is
  `continue-on-error`.
- **Typecheck has blind spots.** `apps/api/tsconfig.json` includes only `src/**` and excludes
  `test/`; `eval/` is not in `include` at all. `apps/web` sets `ignoreBuildErrors` +
  `ignoreDuringBuilds`, so `next build` is not a gate either.
- **Tests and production resolve the shared packages differently.** Production runs
  `tsx --conditions=source` (TypeScript source); vitest declares no `resolve.conditions`, so
  tests load `@platform/db` and `@platform/shared` from compiled `dist`. CI never runs
  `pnpm build` — `dist` exists only because `turbo.json` makes lint/typecheck/test
  `dependOn: ["^build"]`. An implicit, undocumented ordering dependency.
- **The "pure-logic" CI gates are not pure.** `apps/api/vitest.config.ts:7` forces
  `test/setup.ts` globally, which builds a full Fastify server and TRUNCATEs ~30 tables before
  every test — so `retrieval`/`grounding-gate`/`markdown-normalize` all need live
  Postgres + Redis.
- **Local port shadowing.** Native Windows Postgres on 5432 and Redis on 6379 shadow the
  containers; a gitignored `docker-compose.override.yml` remaps to 15432/16379.
- **`BigInt.prototype.toJSON` is monkeypatched** by `lib/bigint-json.ts`, which must remain the
  **first import** in both `apps/api/src/server.ts` and `apps/worker/src/index.ts`.
- **`emitWebhookEvent()` is also the only read-cache invalidator** (`lib/webhooks.ts:31`).
  Skipping it on a write means the chatbot and the voice persona serve stale data.
- **Leftover debug instrumentation:** `[AL-VOICE-DEBUG]` log lines in `/whatsapp/send-media`
  and the failed-status branch log payload snippets (`:1795,1917,1970,2070,2099,2594`).

### Cross-cutting facts nobody's subsystem owns

- **Env is validated in two Zod schemas that between them miss ~30 vars**
  (`AI_DAILY_TOKEN_LIMIT`, `BOT_COALESCE_MS`, `WHATSAPP_SEND_TOKENS_PER_SECOND`,
  `API_DOCS_PUBLIC`, `BROADCAST_MAX_RECIPIENTS`, `DEFAULT_MONTHLY_AI_MESSAGES`,
  `WORKER_METRICS_PORT`, all `*_TICK_INTERVAL_MS`) which are read via bare `process.env` and
  appear in neither the schema nor `.env.example`.
- **The error contract is two-sided**: any thrown value that is not an `HttpError` becomes a
  500, and the 500 payload deliberately leaks name/message/stack to `isSuperAdmin` callers.
  `apps/web/src/lib/api.ts` mirrors it as a client-side `ApiError`.
- **There is not one `timestamptz` column in the schema** — every `DateTime` is
  `TIMESTAMP(3)` (naive, Prisma-UTC), while tenant-facing scheduling (booking slots,
  broadcast send-windows, business hours) is hand-rolled `Intl.DateTimeFormat` offset math
  with no date library (`lib/booking-slots.ts`).
- **i18n does not exist in the portal.** Every operator-facing string is hardcoded English
  with essentially no RTL support. All Arabic/dialect handling is prompt text inside
  `bot-engine.ts` — so "the product speaks Arabic" and "the UI speaks Arabic" are different
  claims, and only the first is true.
- **The audit hash chain is a Postgres trigger, not application code.** `recordAudit()` never
  computes a hash and swallows all errors, so the tamper-evidence property is invisible from
  TypeScript and can be forked by any out-of-band INSERT.

---

## 9. Open questions

These need a human; the code cannot answer them.

1. **What Postgres role does production connect as?** The entire RLS guarantee depends on the
   app being able to `SET LOCAL ROLE app_user` — which today works only because the
   connection role is a superuser (dev compose creates `platform` as `POSTGRES_USER`). There is
   no `GRANT app_user TO <role>` anywhere outside `.github/workflows/e2e.yml:123`. So
   either prod is superuser (meaning every non-`withTenant` query is unfiltered) or the grant
   was made by hand and is undocumented. `docs/PHASE_1_OVERVIEW.md:393` and
   `docs/PLATFORM-REPORT.md:155` give contradictory answers.
2. **Is the wallet supposed to meter conversational replies and operator sends**, or was
   "charge per message" always scoped to broadcasts and sequences?
3. **Is the payment-link-excludes-delivery-fee discrepancy deliberate** (link = goods, fee on
   delivery) or genuine under-collection? Which tenants have `deliveryFeeMinor` set?
4. **Is the multi-number thread mix-up live or latent** — how many orgs currently run more
   than one WhatsApp number?
5. **What is blocking `GROUNDING_GATE_MODE` from moving shadow → enforce?** Has anyone looked
   at the `MessageProvenance.blocked` rate, and is the scanner's Arabic blindness the real
   blocker?
6. **Should `deploy-remote.sh` and `.github/workflows/deploy.yml` be deleted?** Both are dead
   relative to `redeploy.sh`, and they have **diverged** on `WEB_PUBLIC_URL` (one includes
   `/app`, one doesn't — the exact bug that broke every reset/verify/invite link in prod).
   `redeploy.sh` never writes `.env.production` at all, so nothing in the repo keeps prod's
   env correct across deploys.
7. **Was `infra/caddy/Caddyfile` ever meant to be installed?** Today it is documentation only;
   the live `/etc/caddy/Caddyfile` is hand-edited (the 2026-07-17 GTM/GA4 CSP fix was applied
   in place and never committed). Drift between the two is invisible.
8. **Are the e2e specs meant to be a real gate?** 13 files / ~3,470 lines, currently
   `workflow_dispatch`-only because the specs use root-relative paths while the portal lives
   under `/app`. Fixing the paths would turn a large body of behavioural coverage back on.
9. **Is the eval harness intended to gate deploys?** `eval/README.md` says its non-zero exit
   "gates CI or a pre-deploy check", but no workflow invokes it and there is no root
   `eval:gate` script. Today it is manual-only.
10. **Which is authoritative for the `fatme-ismail` tenant:** `CLAUDE.md`'s 2026-07-20 entry
    describing a 16-node deterministic scripted flow, or `seed-fatme-flow.ts`, which now sets
    `scriptedFlow: Prisma.DbNull` (pure-LLM)? The diagnostic script agrees with the code.
11. **Was the CSRF gap consciously accepted?** `ApiErrorCode.CSRF_INVALID` is declared with
    zero implementation, and `COOKIE_SECURE` defaults to false and is not forced in
    production. Same question for the other unclosed Medium findings in
    `docs/SECURITY-AUDIT-2026-05-26.md`.
12. **Who owns `PARTNER_PROVISION_SECRET` and is it rotated?** Given that `/partner/reset`
    destructively deletes any org's mirror on a body-supplied org id, this is the
    highest-blast-radius credential in the system.
13. **Is `infra/ha/` an active plan or a shelved design?** (Patroni + HAProxy + WAL-G + Redis
    Sentinel.) It is the only documented path off the current single-box single-point-of-failure.
14. **What is the intended relationship between `design-system/`** (lavender/coral,
    ported verbatim into `apps/web/src/styles/globals.css`) **and `docs/UX-REDESIGN-PLAN.md`**
    (neutral-minimal oxblood)? The two directions conflict, and nothing imports the directory
    at build time — so it is easy to delete by accident.
