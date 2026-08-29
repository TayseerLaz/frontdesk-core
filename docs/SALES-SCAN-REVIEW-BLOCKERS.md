# Sales Scan — adversarial review findings (2026-07-30)

> Produced by an 11-agent verification run against tree `7996ad8`: 6 seam investigators → a
> file-by-file implementation plan → 3 adversarial reviewers (correctness / privacy+ban-risk /
> house-pattern). Full artifacts (~330 KB) in the session scratchpad; this is the actionable distillate.
> Design doc: [SALES-SCAN-FEATURE-BRAINSTORM.md](SALES-SCAN-FEATURE-BRAINSTORM.md).

## The verdict that governs sequencing

> **"The gating/DB/API/web slice is safe to land. The capture half is NOT safe to point at a real
> tenant's live sales line."**

The recurring failure pattern the reviewer named, which is worth internalising:
**a control is named, a mechanism is designed for the happy path, and the compensating path that makes
the promise true is absent.**

**→ Ship in two slices. Slice 1 is safe and additive. Slice 2 must not touch a real number until the
16 blockers below are closed.**

---

## Slice 2 build stance (locked 2026-07-30): STRICT DEFAULTS, number-agnostic

The owner's position is that **which number gets scanned is not information the build needs** — and
that is right, provided the system is safe for *any* number. So the privacy controls are **not
conditional on the operator's identity**: they are on by default, always. This deliberately removes
the "is this a test number or a real client?" branch from the design.

What that fixes, and why each is now a default rather than an option:

| Blocker | Strict default |
|---|---|
| **B8** consent copy says 7 days while history reaches backwards | **`shouldSyncHistoryMessage: () => false`** — forward-only. The copy becomes true by construction, and the corpus can never predate consent. Costs us history depth; buys us an accurate promise. |
| **B6** raw corpus shipped to OpenAI | Cluster **locally** (char-trigram + cosine, already in `retrieval.ts`); only scrubbed cluster *representatives* may leave the box. |
| **B7** quotes carry customer PII | Verbatim text in the summary comes **only from `direction='out'`** — the tenant's own words, which is where "how they talk" lives anyway. Never call the corpus redacted or anonymised; it is payment-credential-stripped. |
| **B1** credentials outlive consent | Separate `ensurePurged` (unguarded, retried) from `terminateGrant` (guarded); reaper drives `authPurgedAt` non-null; alert after 3 failures. |
| **B2** boot-resume resurrects dead capture | Refuse to construct a socket unless a grant is live and unexpired; delete orphan auth rows at boot. |
| **B3** bare `setInterval` is the only enforcement | Supervised loop + per-session try/catch + dead-man switch: if the heartbeat to the platform fails 10 min, tear down every session. |
| **B12** bodies in logs/Sentry | Ingest logger structurally cannot log a body; `Sentry.beforeSend` strips request data. |
| **B4** unlimited re-grant | `windowDays` already clamped 1..14 in Slice 1; add cooldown + cumulative cap. |
| **B11** "stop and delete" doesn't delete | Already fixed in Slice 1 — separate routes, separate buttons, matching labels. |

Consequence: **no legal-page update is a prerequisite for the first capture** (forward-only + no raw
egress + outbound-only quotes keeps it inside what the shipped privacy policy already describes), but
the privacy/terms/data-deletion sections in **H3 remain required before this is sold to clients.**

---

## SLICE 1 — safe to build and deploy now

Gating + DB + portal API + settings card + tests. Zero tenant impact: the feature key is
`defaultDisabled`, so every existing org sees nothing at all (until 2026-08-05 they saw a locked "contact admin to upgrade" card; the card is now hidden when the feature is off, like every other feature).

**Four real bugs the review found in this slice — fix them here, they are cheap:**

| ID | Finding |
|---|---|
| **C-4** | **Live fail-open, unrelated to this feature.** `auth.service.ts:69-71` creates orgs on self-signup with `tx.organization.create({ data: { slug, name } })` — **no `disabledFeatures`**, while the admin path forces defaults off (`admin.routes.ts:265-273`). So **every self-signup today gets `shopify` + `partner_listings` ENABLED.** Fix in this PR. |
| **C-3** | `disabledFeatures` is capped `.max(20)` in **two** places (`packages/shared/src/schemas/org.ts:57`, `admin.routes.ts:3699`) and there are exactly **19** keys today. Adding a 20th leaves zero headroom → bump both to 40, plus a ceiling test. |
| **Loading flash** | `settings/page.tsx:60` is `organization?.disabledFeatures ?? []` → during fetch the array is empty → `!includes(...)` is true → **every gated card flashes visible**. Needs three-valued state (loading / on / off), not a boolean. |
| **Inline RLS is mandatory** | `redeploy.sh:125` runs `prisma migrate deploy` with **no** `rls:apply` step, and `deploy.yml` applies rls.sql with `|| true`. A new tenant table whose RLS lives only in `rls.sql` ships **unprotected**. |

**House-pattern corrections (the plan got these wrong):**
- `packages/shared/src/lib/` **does not exist** → shared utils are `src/util-*.ts` (e.g. `util-url-guard.ts`), re-exported from `index.ts`.
- `packages/shared` has **no test runner and zero test files** → pure tests go in `apps/api/test/`.
- `dashboard-api.ts` is **only** for dashboard widgets → settings sub-features fetch **inline in the page** with `api.get/post` + TanStack Query (see `settings/google-calendar/page.tsx:37-40`).
- Every new test lands in the **non-blocking** `pnpm test` CI step → add the PII/gating tests to the **HARD** gate list at `ci.yml:83-89` or they guard nothing.
- Response envelopes were unspecified → wrap at the route (`z.object({ data: … })` / `listEnvelopeSchema`).
- `conflict()` / `notFound()` **do not take an `ApiErrorCode`** (`errors.ts:26,31`) — only `badRequest`/`unauthorized`/`forbidden` do.
- Synthesis should be an **API-side tick** (`server.ts:422-446`), not a worker→API HTTP hop — there is **no** worker→API business-logic RPC anywhere in this repo, and both deps (`complete()`, `embedding.ts`) live in `apps/api`.
- `cosineSimilarity` already exists (`embedding.ts:98-105`) — don't rewrite it.
- Reuse the `integrations` Swagger tag.

---

## SLICE 2 — 16 blockers. Do NOT link a real number until these are closed.

### A. "Time-boxed" silently becomes permanent
- **B1 — Credentials outlive consent, forever.** No reaper for `endedAt IS NOT NULL AND authPurgedAt IS NULL`, and `endGrant`'s idempotency guard makes retry impossible once the row is terminal. Tenant clicks stop during an ingest restart → DB says revoked, socket resumes and keeps capturing. **Split `terminateGrant` (guarded) from `ensurePurged` (unguarded, retried until `authPurgedAt` is stamped) + alert after 3 failures.**
- **B2 — Boot-resume has no grant precondition.** A restart weeks later re-links the number. **Refuse to construct a socket unless `status IN ('active','disconnected') AND expiresAt > now()`; delete orphan auth rows at boot; check the deadline in the message handler, not only the reaper.**
- **B3 — The only thing enforcing the window is a bare `setInterval`.** One uncaught rejection and it stops. **Supervised `while(true){try/catch/await sleep}` + per-session try/catch + an ingest-side dead-man switch: if the heartbeat to the platform fails for 10 min, tear down every session.** A capture process that cannot reach the system holding the consent record must not keep capturing.
- **B4 — Re-grant is an unlimited loop.** "Scan again for another week" with no cooldown, no cumulative cap, and `windowDays` from an unclamped env var. "7 days" becomes rolling permanent surveillance with a time-boxed label. **Clamp `.min(1).max(14)`, hard cumulative cap (~28 capture-days/org/rolling-year), ≥30-day cooldown, re-consent each grant, show the running total on the consent screen.**
- **B5 — `expiresAt` stamped at grant creation, before linking.** Queued 4 days → 3-day scan. **Keep an absolute `grantExpiresAt` (compliance deadline, never moved) AND `captureEndsAt = linkedAt + windowDays`, clamped; reaper terminates on `min(both)`.**

### B. Third-party PII: stored, shipped to LLMs, unredactable
- **B6 — Stage 2 embeds every inbound message → the entire raw corpus goes to OpenAI**, nullifying the plan's own "digest, not corpus" argument. **Cluster locally first** (the char-trigram index in `retrieval.ts` already took retrieval to 100%); if embeddings are needed, embed only scrubbed cluster representatives. **No raw customer body may leave the box unscrubbed and unaggregated.**
- **B7 — The scrubber omits the PII this corpus is actually made of** — names, addresses, landmarks, phones, emails. It covers OTPs/PANs/IBANs. **Call it "payment-credential stripping", never "PII redaction", in user-facing copy;** add contact-shaped patterns; and allow quotes in the summary **only from `direction='out'`** (the tenant's own words — which is where "how they talk" lives anyway).
- ~~**B8 — The consent copy is false.**~~ **RESOLVED (copy half) 2026-08-05.** It said "7 days" while history sync reached backwards past the consent date. Owner chose to **keep history sync and widen the wording** rather than go forward-only, because the older messages are the point — they are what makes the corpus worth training on. Consent version `2026-08-05.1` now states plainly that linking pulls conversations from **before** the tenant agreed, that the depth is decided by WhatsApp and the handset so **we cannot promise a cut-off**, and that older messages carry the same stripping/90-day/erasure terms. Pinned by a dedicated assertion in the pure gate so a reword cannot silently drop it. **Still open:** history sync pulls from WhatsApp's CDN, which is itself a ban signal (see §C), and the second local copy on the monitor host needs its own 90-day prune — see B8a.
- **B8a — the "second pile" needs its own retention.** Owner decided 2026-08-05 that the monitor service keeps a local copy of captured messages as well as pushing to the platform. the platform's side is covered (payment-credential stripping on the receiver, the 90-day `sweepRetention`, the tenant's delete button). The monitor's own SQLite has **none of that** today, so without a matching local prune the second pile quietly outlives the 90 days the consent promises. **Add a local retention sweep on the same ceiling, and make the tenant's "delete captured data" reach both piles, before capture is pointed at a real number.**
- **B9 — Per-subject erasure is a dead route** (requires a hash only the server can compute). **Accept `{ phone }`, hash server-side, add a UI form + an HQ-side equivalent.**
- **B10 — Erasure can't reach backups or the derived summary**, while `example.com/data-deletion` publicly commits to 30-day fulfilment / 90-day backups. **Qualify the in-product confirmation, re-scrub or stale the summary on erasure, update the public page.**
- **B11 — "Stop and delete now" does not delete** — it stops capture, enqueues the LLM job, and keeps the corpus 90 days. **Rename to "Stop capturing", add a separate explicit delete, make label and effect match.**
- **B12 — Message bodies will land in logs and Sentry**, outside every retention promise. pino `redact.paths` covers headers/tokens but nothing for content. **Add body redact paths, a logger in ingest that structurally cannot log a body, and `Sentry.beforeSend` stripping request data.**
- ~~**B10a — the 90-day retention ceiling had no enforcer at all.**~~ **RESOLVED 2026-08-05.** Not on the original list, found by the pre-change audit: the consent text promises "Messages are kept for at most 90 days" and `sales_messages` carries an index annotated *"Retention pruning (90-day raw window)"*, but the only `deleteMany` on the table was the tenant's own delete button — so a tenant who never pressed it kept their customers' messages forever. `sweepRetention()` in [sales-scan-reaper-tick.ts](../apps/api/src/lib/sales-scan-reaper-tick.ts) now prunes on `createdAt` (how long *we* held it, matching the index) in 5,000-row batches. `RETENTION_DAYS` is a constant, not an env var — it is a promise in a SHA-pinned consent text, so a deployment must not be able to extend it. Note this does **not** close B10 proper, which is about backups and the derived summary.

### C. Ban risk
- **B13 — `MAX_CONCURRENT = 15` in code vs "hard cap 2 before proxies" in prose.** Prose is not a control — put 2 in the code.
- **B14 — A ban is treated as a retryable error; there is no fleet circuit breaker.** One tenant's ban should stop the fleet, not trigger reconnects.
- **H5–H7** link-attempt limits too loose; the watchdog probe payload is preserved without anyone knowing what it sends; restart bursts + version fetches.

### D. The 4-device cap (now a live-number problem)
- **H8 — The plan warns about the cap but cannot detect eviction**, and its copy tells the tenant to remove a device blindly. On a live sales line already on WhatsApp Web across 1–3 devices, this evicts something a team is actively using.

### E. Notifications & opt-out
- **B15 — Promises an email it never builds**, and ships none for logout/ban/expiry.
- **B16 — A customer who types STOP to the sales line during the window is neither detected nor honoured**, while the platform honours STOP everywhere else.

### F. Consent & legal surface
- **H1 — Consent evidence is not reproducible** (version string in TSX, no snapshot/hash). **Immutable versioned constant in `packages/shared` + store the rendered text + `consentTextSha256`, with a CI test so a reword without a version bump fails.**
- **H2 — Nothing establishes the tenant's controller obligations** to their own customers. Needs a third checkbox + explicit processor terms, and a plain statement of whether the voice profile is used only for that tenant.
- **H3 — The public legal pages become inaccurate on ship day** — privacy/terms/data-deletion describe nothing like bulk capture of tenants' customer conversations via a non-Meta client, nor Anthropic/OpenAI/Sentry as recipients. **Ship these edits in the same release.**
- **H4 — HQ can export raw customer DMs with no extra gate or access audit.** Exclude `sales_scan` from the HQ export, or require second-admin approval + justification + audit + tenant notification. Add a `sales_scan_summary_viewed` audit action.
- **M1 — `counterpartyHash` is not de-identification** (Lebanese mobile keyspace ~10⁸ is exhaustible in seconds with the salt). Never call the corpus pseudonymised or anonymised.

---

## Scope judgement (worth heeding)

The reviewers independently flagged the plan as **~2× over-built for a pilot whose central unknown is
unmeasured**: 56 files, a new workspace app, 4 tables, 4 reaper jobs, a FIFO queue with slot-freed
emails, and 5 UI states — all designed before a single real corpus exists, and while Part 13 concedes
nobody knows how much history WhatsApp actually pushes on link (which could invalidate the 7-day window
outright).

**Recommended Slice 2 when it does get built:** `useMultiFileAuthState` on a local dir (the hand-written
`SignalKeyStore` is the highest-risk, hardest-to-test component in the plan and buys nothing at 1–2
numbers), `MAX_SESSIONS=2`, **one** reaper, no queue, no relink, and a raw-counter page. Measure the
corpus, *then* build the summary. ~25 files.

Also: the "external source → LLM → staged items → approve → apply" pipeline already exists **twice**
(`POST /bot/analyze` + `CrawlJob` at `bot.routes.ts:636-1034`, and `shopify_staged_items`). A future
apply-phase should clone one, not invent a third.
