# CALL-E Hackathon — 8-hour sprint plan

> Written 2026-09-14 10:55 EEST. **Submission closes tonight: 14 Sep 2026, 23:45 SGT = 18:45 EEST.**
> Judging 30 Sep – 13 Oct (project must stay testable until then). Feedback survey (separate $200 prize) open until 18 Sep 23:45 SGT.

---

## 0. Three blockers only you can clear — do these first (before 11:15)

| # | Blocker | Why | Action |
|---|---|---|---|
| 1 | **Lebanon (+961) is NOT a supported CALL-E region.** Supported (23): AU, BD, BR, CA, CN, DE, ES, FI, GB, ID, IN, JP, MX, MY, NL, PH, PK, PL, SG, TH, TR, US, VN | Every test call and the demo footage need a phone you can answer in one of those countries | Get a number **now**: a Turkish/UK/US SIM you or a friend holds, or a virtual number (Google Voice, TextNow, Hushed) that rings on your handset. Confirm it rings from an international caller. This number becomes `CALLE_LIVE_OVERRIDE_PHONE`. |
| 2 | **CALL-E account + API key** | SDK needs `CALLE_API_KEY`; 20 free calls come with signup | `npx -y skills add https://github.com/CALLE-AI/call-e-integrations --skill calle -g` → `calle auth login` (browser) → copy key from <https://dashboard.heycall-e.com/account/api-keys>. Also fill the extra-calls form (<https://forms.gle/EPQttEZ1rkW8iq9q6>) — it takes 1–5 business days, so **budget the 20 calls**: 1 smoke, 4 dev, 3 demo takes, rest spare. |
| 3 | **This repo has no git remote and no fork of the submission repo** | Judges need a public repo; the PR must come from your fork | `gh repo create <public-name> --public --source=. --push` (pick a product name today — e.g. `frontdesk-core`) and `gh repo fork CALLE-AI/awesome-phone-call-agents --clone=false`. |

Local infra note: Docker daemon is down, but Homebrew **postgresql@16 and redis are already running**. Role `app_user` exists; role/db `platform` do not. Redis requires a password (`NOAUTH`) — put it in `REDIS_URL` as `redis://:PASSWORD@localhost:6379`.

---

## 1. The idea (decided — don't re-litigate)

**"Phone follow-through for the AI front desk": the chat bot picks up the phone when chat isn't enough.**

The platform already turns WhatsApp / Messenger / Instagram into an AI front desk that captures **orders (carts)** and **bookings**, grounded in the tenant's own catalogue and policies, with a shared inbox. CALL-E adds the one thing chat can't do: **close the loop by voice, with structured results written back into the same records and the same inbox thread.**

Hero use case (P0) — **Cash-on-delivery order confirmation calls.** In Lebanon, the Gulf and SE Asia most chat-commerce orders are COD. Fake or forgotten orders cause failed deliveries, and shops pay staff to phone-confirm every order by hand. Here, an order that lands from a chat is confirmed by an AI call within minutes: items and total read back from the **actual cart rows** (never the LLM's list — repo invariant 16), address confirmed, result → cart `confirmed` / `cancelled` / `needs_review`, transcript summary posted as an inbox note, notification + outbound webhook fired. Real, specific, measurable (Most Practical).

Why it's non-obvious (Quality of Idea): it is **omnichannel escalation, not "an AI that calls people"** — text first, voice only when a record needs closing; the call is grounded in the same tenant data the chat bot uses (business name, hours, delivery/return policy, customer locale); results are governed (low confidence never auto-cancels — it routes to a human). None of the 75+ existing TypeScript apps in the submission repo does chat-commerce COD confirmation; the closest, `ai-front-desk`, is appointment-only — so **do not pitch bookings as the headline**.

Secondary triggers, same engine:
- P0 **Operator-triggered "Call customer"** from the Orders row (and, if time, the inbox thread) — makes the demo deterministic.
- P1 **Booking day-before confirmation by phone** when the WhatsApp reminder template got no reply (reuse `reminderSentAt`, check no inbound since).

Safety pattern the community repo rewards (copy `ai-front-desk`): `CALLE_DRY_RUN=true` by default; `CALLE_LIVE_OVERRIDE_PHONE` forces every live call to your verified number **in code**; respects `Contact.optedOutAt/blockedAt`; idempotency key persisted before the first request; per-org daily cap; low-confidence → `needs_review`, never a destructive write.

---

## 2. Build spec (follow `docs/ADDING-A-FEATURE.md` exactly)

### 2.1 Data (`packages/db`)
New migration `20260914120000_phone_tasks` (hand-picked timestamp, **never edit the baseline**):

```
model PhoneTask {
  id, organizationId (Cascade), kind  'cod_order_confirm' | 'booking_confirm' | 'custom'
  targetType 'cart'|'booking'|'thread'|null, targetId uuid?, contactId uuid? (SetNull), threadId uuid? (SetNull)
  phoneE164, locale?, task Text, resultSchema Json, metadata Json
  idempotencyKey String @unique, calleCallId String?, dryRun Boolean
  status 'queued'|'in_progress'|'completed'|'failed'|'canceled'|'needs_review'
  structuredResult Json?, summary Text?, taskCompleted Boolean?, confidence Float?, transcript Json?, error Text?
  appliedAt DateTime?, createdById uuid?, createdAt, updatedAt, completedAt?
  @@index([organizationId, status, createdAt desc]) @@index([organizationId, targetType, targetId]) @@map("phone_tasks")
}
```
+ nullable `phone_task_settings Json` on `organizations` (additive; no RLS work). In the **same migration**: `SELECT _apply_tenant_rls('phone_tasks');` and append the same line to `prisma/rls.sql`. Export the model type in `packages/db/src/index.ts`.

### 2.2 Shared (`packages/shared`)
`schemas/phone-task.ts` (Zod: create body, list/detail, settings) + re-export. `ORG_FEATURES` entry `{ key: 'phone_tasks', label: 'Phone follow-through (CALL-E)', hrefs: ['/phone-tasks'] }` — **not** `defaultDisabled` (avoids the mandatory backfill migration). Error codes: `PHONE_TASK_REGION_UNSUPPORTED`, `PHONE_TASK_CONTACT_OPTED_OUT`, `PHONE_TASK_DAILY_CAP`.

### 2.3 API (`apps/api`)
- `lib/env.ts` + `.env.example`: `CALLE_API_KEY?`, `CALLE_BASE_URL` (default `https://api.heycall-e.com`), `CALLE_DRY_RUN` (default `true`), `CALLE_LIVE_OVERRIDE_PHONE?`, `CALLE_WEBHOOK_TOKEN?`, `PHONE_TASK_DAILY_CAP` (default 50).
- `lib/calle.ts` — the **only** file importing `@call-e/calle` (`pnpm --filter @platform/api add @call-e/calle@0.7.0`). `createCall({task, phone, region, locale, resultSchema, metadata, idempotencyKey, webhookUrl})` → real `client.calls.create(...)` or a deterministic dry-run stub; `getCall(id)`. Live path: if `CALLE_LIVE_OVERRIDE_PHONE` set, replace the phone and record the override in metadata. Derive `region` from the E.164 prefix; throw `PHONE_TASK_REGION_UNSUPPORTED` for anything outside the 23.
- `lib/phone-tasks.ts` — builders + write-back:
  - `buildCodOrderConfirmTask(cart, items, org, contact)` → task text (business name, item lines with qty, total via `formatMoney`, delivery address from `cart.fields`, delivery policy snippet from business info via `gatherBotData`, customer locale) + `resultSchema {confirmed: yes|no|reschedule|unknown, address_correct, requested_changes, preferred_delivery_window, disposition: confirmed|cancelled|changed|voicemail|no_answer|wrong_number|needs_human}`.
  - `buildBookingConfirmTask(...)` (P1) and `buildCustomTask(goal)`.
  - `applyResult(task, call)`: confidence ≥ 0.7 and `task_completed` → cart `confirmed`/`cancelled` via the existing status path (server-side recompute stays intact); else `needs_review`. Always: inbox note on `task.threadId` via the existing `WhatsAppNote` path (transcript summary + link), `createNotification(kind: 'generic')` (avoid an enum migration), `emitWebhookEvent` with an existing kind if one fits or `generic`. Idempotent on `appliedAt`.
- `modules/phone-tasks/phone-tasks.routes.ts` (JWT, `assertOrgFeature('phone_tasks')`): `POST /phone-tasks` (body: kind + targetId or custom goal; editor), `GET /phone-tasks`, `GET /phone-tasks/:id`, `POST /phone-tasks/:id/refresh` (poll CALL-E now; viewer), `PATCH /phone-tasks/settings` + `GET` (admin: `codAutoConfirm: boolean`, `delayMinutes`).
- `modules/phone-tasks/calle-webhook.routes.ts` (public block): `POST /calle/webhook/:orgId?token=` — token = `CALLE_WEBHOOK_TOKEN`; dedupe on event `id` (require `CALL-E-Event-Id` header == body id); look up by `calleCallId`; `applyResult`. Return 2xx fast.
- `lib/phone-task-tick.ts` (API-side tick, like `wallet-alert-tick`): every 30 s (a) poll `queued/in_progress` tasks older than 60 s via `getCall` (webhooks won't reach localhost — **polling is the demo's reliable path**); (b) for orgs with `codAutoConfirm`, enqueue a task for carts `status='new'` older than `delayMinutes` with no PhoneTask yet, honouring the daily cap. Register in `server.ts` inside try/catch.
- `server.ts`: import + register both route modules; Swagger tag `phone-tasks`.
- Tests (P1): `test/phone-tasks.test.ts` dry-run happy path; add `phone_tasks` to `test/setup.ts` TRUNCATE; add an org-A-cannot-read-B block in `tenant-isolation.test.ts` (the hard gate).

### 2.4 Web (`apps/web`)
- `lib/dashboard-api.ts`: typed fetchers.
- `(dashboard)/phone-tasks/page.tsx`: list (kind, target, status badge, confidence, created) + detail drawer (summary, structured result JSON, transcript turns, "Refresh" button, link to order/thread). Show a persistent **DRY RUN** banner when the API reports dry-run.
- `(dashboard)/cart/page.tsx`: add **"Confirm by phone"** action per order row → `POST /phone-tasks {kind:'cod_order_confirm', targetId}` → toast + link.
- Sidebar `NavItem` `/phone-tasks` (icon `PhoneOutgoing`). Settings card with the `codAutoConfirm` toggle (P1). Inbox thread "Call customer" (P1).

### 2.5 Cut line
- **15:30 EEST:** if the backend isn't live-tested, drop the inbox button, booking trigger and settings UI. Keep: Orders button, list page, tick, webhook.
- **16:30 EEST:** if no real call has succeeded, record the demo in dry-run with the smoke-test call footage from §3 step 3 and say so honestly in the description. Do not skip the video.

---

## 3. Timeline (EEST)

| Time | Block | Done when |
|---|---|---|
| 10:55–11:15 | §0 blockers: number, CALL-E login + key, public repo push, fork, extra-calls form | `calle auth status` OK; key in hand; `git remote -v` shows origin |
| 11:15–11:45 | Local stack: `createdb platform`, create role `platform`, write `.env` (4 required vars + `BRAND_*`, `INITIAL_ADMIN_*`, Groq/OpenAI key, `REDIS_URL` with password), `pnpm install && pnpm bootstrap && pnpm dev`, log in, `pnpm db:seed:demo`. **Smoke call (1 credit):** `npx @call-e/calle@0.7.0 calls create --phone "$CALLE_LIVE_OVERRIDE_PHONE" --task "Call and ask whether they can hear clearly." --wait --json` | Portal at :3000/app works; your phone rang; JSON result seen |
| 11:45–14:15 | Backend §2.1–2.3, `pnpm typecheck`, curl a dry-run task end to end | `POST /phone-tasks` → tick → `completed` in dry-run, note lands on thread |
| 14:15–15:30 | Web §2.4 | Orders row button → task visible on /phone-tasks with result |
| 15:30–16:15 | `CALLE_DRY_RUN=false` + override phone. 2–3 real calls on a seeded COD order. Fix task wording / schema until `structured_result` is clean | One real call flips an order to `confirmed` with a transcript note |
| 16:15–17:00 | Record + trim video (§4). Upload to YouTube **public** | Link works logged-out |
| 17:00–17:45 | Submission PR (§5) + platform README section "Phone follow-through with CALL-E" + commit/push | Validator passes; PR open |
| 17:45–18:20 | Devpost form (§6). Submit. | Confirmation email |
| 18:20–18:45 | Buffer | — |
| Later (by 18 Sep) | CALL-E Feedback Survey (Most Valuable Feedback, $200 ×5) — log every rough edge you hit today as you go | Survey submitted |

---

## 4. Demo video (≤ 3:00, own footage only, no music)

Screen-record the portal (QuickTime) + film the phone ringing with a second camera/phone. Script:

1. 0:00–0:25 **Problem.** "Chat-commerce shops in MENA/SEA get most orders as cash on delivery. Every order is phone-confirmed by a human, or it fails at the door." One sentence on what the platform already is (WhatsApp AI front desk, orders land in the inbox).
2. 0:25–0:50 **Order lands.** Show a WhatsApp conversation producing an order; the cart row appears in Orders as `new`.
3. 0:50–1:50 **The call.** Click "Confirm by phone" (or show auto-confirm timer). Cut to the phone ringing; answer; hold the conversation (confirm items, change delivery window). Show the live status on /phone-tasks moving to `in_progress` → `completed`.
4. 1:50–2:25 **Write-back.** Order flips to `confirmed`; transcript summary note in the inbox thread; structured JSON in the drawer; webhook fired. One line: "Low confidence never auto-cancels — it routes to a human."
5. 2:25–2:50 **How it's built.** One diagram: chat → cart → PhoneTask → `@call-e/calle` → webhook/poll → cart + inbox. Mention dry-run default, override phone, idempotency, RLS multi-tenancy.
6. 2:50–3:00 **Why it matters / what's next.** Booking confirmations, abandoned-cart callbacks, supplier stock checks.

---

## 5. Submission PR (repo `CALLE-AI/awesome-phone-call-agents`)

Branch `feat/<slug>-community-app`. Commits `feat(community-apps): add <Name> …` (Conventional Commits, kebab-case, English, masked numbers like `+1 415 555 0100`, emails only at `example.com`).

P0 files:
1. `README.md` → **Community apps** list: `- [<Name>](https://github.com/TayseerLaz/<repo>) - Cash-on-delivery order confirmation calls for a multi-tenant WhatsApp AI front desk: chat orders are confirmed by a grounded CALL-E call, results written back to the order and inbox; dry-run default, verified-number override. [Demo video](<youtube>) · [Integration notes](docs/community-apps/<slug>.md).`
2. `docs/community-apps/<slug>.md` — copy the structure of an existing note (e.g. `care-call-ai.md`): what it does, where CALL-E is called (`apps/api/src/lib/calle.ts`), setup, env vars, no-call default, side effects, cancellation (tasks are one-shot; auto-confirm is a per-tenant toggle), safety.

P1 (if ≥ 30 min remain): `skills/cod-order-confirmation-call/` with `SKILL.md` (frontmatter `name`, `description` ≥ 40 chars containing "call"), `references/safety.md`, `references/examples.md`, `scripts/build_task.ts` (order JSON → task text + result schema, dry-run). Scaffold with the `outbound-call-skill-creator` skill from the same repo. Add a Skills table row.

Then: `python3 scripts/validate_repository.py` must pass → push → `gh pr create` with title mirroring the commit.

Platform repo (public): add a README section + link the video; ensure `.env.example` documents the `CALLE_*` vars; `pnpm brand:check` and `pnpm typecheck` green; commit `feat(phone-tasks): CALL-E phone follow-through for orders and bookings`.

---

## 6. Devpost form

- PR URL; CALL-E account email; YouTube link.
- **Text description** must cover: the problem and who has it; features; **how CALL-E is used at runtime** (SDK `@call-e/calle` in `lib/calle.ts`, `POST /v1/calls` with `result_schema` + `Idempotency-Key`, webhook receiver + polling tick); the safety model; and the **"significantly updated since 23 Jul 2026"** paragraph (the whole `phone_tasks` subsystem, migration, routes, tick, UI, and today's commits — the repo's brand-neutral core cut on 29 Aug is also post-start).
- **Testing instructions**: public repo, cold-start commands from README (4 env vars), `CALLE_DRY_RUN=true` path needs no key; live path needs their own key. Optional demo URL only if a deploy is trivially safe — otherwise omit (judges may judge on video + text).

---

## 7. Facts gathered today (so you don't re-check)

- SDK: `@call-e/calle@0.7.0`, `new CalleClient({apiKey, baseUrl})`, `client.calls.create/createAndWait({task, recipients:[{phones, region, locale}], resultSchema, recipientResultSchema, metadata}, {idempotencyKey})`, `client.calls.get(id)`; response has `status` (`queued|in_progress|completed|failed|canceled`), `structuredResult`, `taskCompleted`, `completionConfidence {score,label}`, `summary`, `evidence`, `recipients[].transcript_turns`.
- REST: `https://api.heycall-e.com`, `Authorization: Bearer`, `POST /v1/calls` (`webhook_url` optional), `GET /v1/calls/{id}`, `GET /v1/calls/{id}/events`. Webhook: unsigned JSON `{id evt_…, type call.completed|call.failed|call.result_validation_failed, data: CallTask}`; dedupe on `CALL-E-Event-Id`.
- Existing repo hooks to reuse: `assertOrgFeature` (`lib/org-feature-guard.ts`), `createNotification` (`lib/notifications.ts`), `emitWebhookEvent` (`lib/webhooks.ts`), `formatMoney`/`gatherBotData` (`lib/bot-engine.ts`), `WhatsAppNote` model + `POST /inbox/threads/:id/notes`, cart status via `PATCH /carts/:id`, Orders page mutation already exists (`cart/page.tsx:178`).

---

## Status — 11:35 EEST (build done; 7 h 10 min to the deadline)

**Built, tested in dry-run, committed on branch `feat/calle-phone-tasks` (2 commits).** Verified through the real API and the portal:
COD order → task → cart `confirmed` + inbox note + notification; booking → `confirmed`; custom goal → note only;
auto-confirm tick placed a task on its own; `+961` rejected with `PHONE_TASK_REGION_UNSUPPORTED`; opted-out contact refused;
`pnpm brand:check` ✓, API + shared typecheck ✓, web typecheck clean on touched files; screenshots taken of all four screens.

**Submission repo prepared and pushed to your fork** — branch `feat/frontdesk-phone-follow-through` on
`TayseerLaz/awesome-phone-call-agents` (community-app note, README entries, `skills/cod-order-confirmation-call/`; validator passes).
Two placeholders remain: the public repo URL (currently `https://github.com/TayseerLaz/frontdesk-core`) and the video
(`https://youtu.be/REPLACE_WITH_VIDEO_ID`). Fix with:

```bash
cd /private/tmp/claude-501/-Users-tayseerlaz-Projects-platform/f02e515a-aab2-4600-9f42-d51e8574baf8/scratchpad/awesome
grep -rl "REPLACE_WITH_VIDEO_ID\|frontdesk-core" README.md docs skills | xargs sed -i '' -e 's#REPLACE_WITH_VIDEO_ID#<YOUTUBE_ID>#g' -e 's#TayseerLaz/frontdesk-core#TayseerLaz/<PUBLIC_REPO>#g'
python3 scripts/validate_repository.py && git commit -am "docs(community-apps): add FrontDesk demo video + repo link" && git push
gh pr create --repo CALLE-AI/awesome-phone-call-agents --head TayseerLaz:feat/frontdesk-phone-follow-through \
  --title "feat(community-apps): add FrontDesk Phone Follow-Through and cod-order-confirmation-call skill" --body-file /dev/stdin
```

**Your queue, in order:**
1. `npx -y skills add https://github.com/CALLE-AI/call-e-integrations --skill calle -g` → `calle auth login` → API key from the dashboard.
2. Get a phone number in a supported country (US/UK/TR/…); put it in `.env` as `CALLE_LIVE_OVERRIDE_PHONE=+…`, set `CALLE_API_KEY`, `CALLE_DRY_RUN=false`; restart the API (`pnpm --filter @platform/api dev`).
3. Smoke call (1 credit): Orders → **Confirm by phone** on a `new` order (any customer number — the override redirects to yours). Watch **Phone tasks** flip to Completed and the order to `confirmed`.
4. Publish the platform: `git checkout main && git merge --ff-only feat/calle-phone-tasks && gh repo create <PUBLIC_REPO> --public --source=. --push`.
5. Record the 3-minute video (script in §4), upload public to YouTube.
6. Replace the two placeholders + open the PR (commands above).
7. Devpost form (§6) before 18:45 EEST. Feedback survey by 18 Sep.

Local login for the demo: `tayseer.laz@aligned-tech.com` / the `INITIAL_ADMIN_PASSWORD` in `.env`; portal <http://localhost:3000/app>.

---

## Status — 12:05 EEST · live path proven against a mock, PR open

**Done since the 11:35 note:**

- Repo published: <https://github.com/TayseerLaz/frontdesk-core> (public, `main`). Secret scan clean — `.env` is
  gitignored and the two regex hits were false positives (a doc line and a minified audio worker).
- **PR opened: <https://github.com/CALLE-AI/awesome-phone-call-agents/pull/626>** — the community-app entry plus
  the `cod-order-confirmation-call` skill. The repository validator passes. The demo-video link was left OUT
  rather than shipped as a dead placeholder; it goes in as a follow-up commit on the same branch.
- CALL-E API key stored in `.env` and verified live (`GET /v1/goals` → HTTP 200).
- **The non-dry-run code path was exercised end to end against a mock CALL-E server** shaped like the published
  OpenAPI schema, so the first real call is not the first test. Verified:

  | Check | Result |
  |---|---|
  | Request shape | `task`, `recipients[{phones,locale,region}]`, `result_schema`, `recipient_result_schema`, `metadata` |
  | `Idempotency-Key` header | `phone-task:<org>:cod_order_confirm:<cart>:1:v1` |
  | Live override | intended `+14155550100` → dialed `+14155550111`, `liveOverride: true` in metadata |
  | Status machine | `queued` → `in_progress` → `completed` across two polls |
  | Result parsing | `completion_confidence.score` 0.94, structured result, 5 transcript turns, `offset_seconds` → ms |
  | Write-back | order flipped to `confirmed` |
  | **Low-confidence safety** | score 0.31 + `task_completed: false` → task `needs_review`, **order stayed `new`** |

- `.env` restored to the real endpoint and **left in dry-run with no override**, so no stray click can burn one
  of the 20 free calls before a verified number exists.

**Blocked on you, in order:**

1. **A phone number in a supported country that rings on your handset** (US, UK, TR, DE, ES, NL, PL, FI, SG, MY,
   TH, ID, PH, VN, IN, PK, BD, CN, JP, MX, BR, AU, CA). Lebanon is not supported. Send it and I will set
   `CALLE_LIVE_OVERRIDE_PHONE`, flip `CALLE_DRY_RUN=false`, restart, and place the call.
2. **Record and upload the video** (shot list in `CALLE-DEVPOST-SUBMISSION.md`). Public on YouTube.
3. **Devpost form** — full text ready in `CALLE-DEVPOST-SUBMISSION.md`. Due 18:45 EEST.
4. Feedback survey by 18 Sep (separate $200 prize, five winners).

---

## Status — 12:10 EEST · LIVE CALL SUCCEEDED

Real call placed and answered. Call id `call_gI_eGCpcqmdZXknQYRdrFg`, 29-turn transcript, 88%
confidence, one CALL-E credit spent (19 remain).

The customer asked to add an item during the call, so CALL-E returned `disposition: changed` and the
platform routed the task to `needs_review` and left the order at `new` — the governance rule working
on live input. Notification raised, transcript and structured result stored and rendering correctly
in the portal.

**Remaining, all yours:** record the video, send me the YouTube link, submit the Devpost form.
For the demo take, confirm the order **without** asking for changes so the order visibly flips to
`confirmed`; the existing `needs_review` row is already on screen as proof of the safety rule.
