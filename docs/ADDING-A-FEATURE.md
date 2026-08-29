# Adding a Feature — the House Pattern

> Distilled 2026-07-29 from the wallet/billing (`50adb5a`), voice gateway, and Google Calendar
> (`ed5bcf4` — smallest complete slice, 12 files) features. Copy this pattern; don't invent a new one.
> Structural map: [ARCHITECTURE.md](ARCHITECTURE.md). Session log: [../CLAUDE.md](../CLAUDE.md).

---

## 0. TL;DR — ordered checklist

1. `packages/db/prisma/schema.prisma` — model(s) with `organizationId`; extend `AuditAction` / `NotificationKind` enums if needed.
2. `pnpm db:migrate --name <feature>` (or `migrate:create` to hand-edit first) → **append `SELECT _apply_tenant_rls('<table>');` inside that same migration** for every new tenant table.
3. Append the same line at the bottom of `packages/db/prisma/rls.sql` (after the `-- end` marker). Both places are required.
4. `packages/shared/src/schemas/<feature>.ts` + re-export from `packages/shared/src/index.ts`; new error codes in `packages/shared/src/types/api-error.ts`; `ORG_FEATURES` entry in `packages/shared/src/constants/org-features.ts` if HQ-toggleable.
5. `apps/api/src/lib/<feature>.ts` — the engine (business logic, money, external clients).
6. `apps/api/src/lib/env.ts` + `.env.example` — new env vars, same commit.
7. `apps/api/src/modules/<feature>/<feature>.routes.ts` — routes (see §2).
8. `apps/api/src/server.ts` — import (~line 22-69) + register with `{ prefix: '/api/v1' }` in the correct auth-group block (~line 344-405); optional Swagger tag (~287-299); optional tick (~422-446).
9. Background jobs (if any): `apps/api/src/lib/queues.ts` → `apps/worker/src/jobs/<feature>.ts` (`startXWorker`) → register in `apps/worker/src/index.ts`.
10. `apps/api/test/<feature>.test.ts`; add new tables to the TRUNCATE list in `test/setup.ts`; add a cross-org block to `test/tenant-isolation.test.ts` (the HARD deploy gate).
11. `apps/web/src/lib/dashboard-api.ts` — typed fetcher.
12. `apps/web/src/app/(dashboard)/<slug>/page.tsx` — `'use client'`, TanStack Query, `PageHeader`, sonner toasts.
13. `apps/web/src/components/shell/sidebar.tsx` (+ optionally `command-palette.tsx`, or a Settings card).
14. Docs: `docs/ARCHITECTURE.md` subsystem table + `CLAUDE.md` §5 Current Status.

**Non-negotiables:** RLS in the same migration as the table · Zod in `packages/shared` is the single source of truth · no mocks in integration tests · `.env.example` in sync · never edit an applied migration (forward-fix only).

---

## 1. Permission layers (every request passes through, in order)

Plugins register in `apps/api/src/server.ts:336-342`:
`errorHandler → metrics → healthcheck → authPlugin → apiKeyPlugin → voiceGatewayPlugin → tenantContext`.

### 1a. Authentication (JWT, `jose`)
- Claims: `sub` (userId), `org`, `role`, `aa` (isSuperAdmin), `sid` — `apps/api/src/lib/jwt.ts:9-15`. HS256 pinned.
- `app.requireAuth` attaches `req.auth = { userId, organizationId, role, isSuperAdmin, sessionId }` (`apps/api/src/plugins/auth.ts:38`).
- Role comes from the **Membership row**, re-read on refresh/switch-org — demotion takes effect on next refresh.

### 1b. RBAC
- Hierarchical ranks `{ viewer: 1, editor: 2, admin: 3 }` (`plugins/auth.ts:9`). `requireRole('viewer')` passes for editors/admins.
- Declare per route: `preHandler: [app.requireRole('editor')]`. Convention: **read = viewer, write = editor, destructive/billing = admin**. `product.routes.ts` mixes all three (`:56` viewer list, `:164` editor write, `:570` admin destructive).
- `app.requireSuperAdmin` for HQ (`/hq/*`) surfaces.

### 1c. Tenant isolation
- Handlers wrap ALL queries: `await app.tenant(req, (tx) => …)` → `withTenant` (`apps/api/src/lib/db.ts:38`) opens a tx with `SET LOCAL ROLE app_user` + `set_config('app.current_org_id', …)`. Org id always comes from the verified JWT — **never from a client parameter**.
- `withRlsBypass` (`db.ts:55`) only behind `requireSuperAdmin` or in the auth/OAuth-callback path.
- Owner `prisma` (bare, RLS-bypassed) is the documented exception for atomic conditional SQL (e.g. wallet debits) — every query must then filter by `organization_id` explicitly.
- Postgres RLS (FORCE + `tenant_isolation` policy) is the backstop, not the primary control.

### 1d. Per-tenant feature toggles
- `ORG_FEATURES` in `packages/shared/src/constants/org-features.ts` — `{ key, label, description, hrefs[], defaultDisabled? }`. Storage is **negative**: `Organization.disabledFeatures String[]` (listed = disabled).
- One entry drives all three web gates automatically: sidebar filter, `(dashboard)/layout.tsx` URL bounce via `isHrefDisabled`, command palette.
- API side: gate handlers with `assertOrgFeature(app, req, '<key>', msg)` (`apps/api/src/lib/org-feature-guard.ts:18`) → 403 `FEATURE_DISABLED`. (Existing modules hand-roll this check; the helper is the intended path for new code.)
- **If `defaultDisabled: true` you MUST ship a backfill migration** — `UPDATE "organizations" SET "disabled_features" = array_append("disabled_features", '<key>') WHERE NOT ('<key>' = ANY("disabled_features"));` — or `test/feature-backfill-invariant.test.ts` fails the build. (This is the 2026-07-20 fleet-wide "Properties" incident rule.)
- Never derive tenant TYPE from a flag's absence — use a positive marker (`Organization.sourceSystem`), fail-closed.

### 1e. API-key auth (chatbot read API)
- Header `x-api-key`, sha256-hashed lookup, scopes on `ApiKey.scopes` (`plugins/api-key.ts`). Scope list: `packages/shared/src/schemas/api-key.ts:5-14` — add new scopes there; the `/api-keys` page picks them up automatically.
- New read endpoints must live under `/api/v1/read/` (or `/api/v1/voice/`) to inherit **per-key** rate-limit bucketing (`server.ts:236-260`); everything else buckets per IP.
- Prefer `preHandler: [app.requireApiKey]` + scope check; note existing read routes return 403 for a missing scope while the unused `requireApiKeyScope` plugin helper returns 401 — pick one deliberately.

### 1f. Web-side session
- `GET /auth/session` → `sessionResponseSchema` (`packages/shared/src/schemas/auth.ts:150-180`): `user.isSuperAdmin`, `organization.{role, disabledFeatures, sourceSystem}`. **Zod strips unknown fields** — if the API adds an org/user field the web needs, extend this schema or it silently disappears.
- Client role checks are inlined (`session?.organization.role === 'admin'`) and flat, not ranked — for "editor or above" write `role !== 'viewer'`.
- HQ web pages under `(dashboard)/hq/` use a per-page soft render guard; the API's `requireSuperAdmin` is the real boundary.

---

## 2. API route module anatomy

- File: `apps/api/src/modules/<feature>/<feature>.routes.ts`, default-export `async function xRoutes(app: FastifyInstance)`, first line `const r = app.withTypeProvider<ZodTypeProvider>();`. Public webhook receivers get their own file.
- Register in `server.ts` in the correct comment-bannered block: portal (JWT) `:344` · public/HMAC `:386` · read API `:400` · voice `:403`. Paths are written WITHOUT the `/api/v1` prefix.
- Schemas: import from `@platform/shared`; envelopes from `packages/shared/src/schemas/common.ts` — `itemEnvelopeSchema`, `listEnvelopeSchema` (`{ data, nextCursor, total? }`), `successSchema`. Handlers `return { data: … }`; `reply.code(201)` on create.
- Errors: **throw** the helpers from `apps/api/src/lib/errors.ts` (`badRequest`, `forbidden`, `notFound`, `paymentRequired`, `conflict`, …) with an `ApiErrorCode` from `packages/shared/src/types/api-error.ts`. Never hand-build error responses.
- Cross-cutting calls after a write:
  - `await recordAudit({ action, organizationId, actorUserId, entityType, entityId, metadata })` (`lib/audit.ts:22`; never throws; `action` must exist in the Prisma `AuditAction` enum → enum additions need their own migration).
  - `void emitWebhookEvent({ organizationId, eventKind, payload })` (`lib/webhooks.ts:29`) — fire-and-forget; **this is also what invalidates the read cache**, i.e. how the chatbot sees the change.
  - `createNotification({...})` (`lib/notifications.ts:23`) for user-visible events (`kind` ∈ `NotificationKind` enum).
  - `capCheck(tx, orgId, kind, …)` (`lib/billing.ts:127`) first thing inside the tenant tx on create routes with plan quotas.
- Per-route rate-limit override: `config: { rateLimit: { max, timeWindow, keyGenerator } }` (see `data-export.routes.ts:94-98`).

---

## 3. DB recipe

### Model conventions (see `Product` `schema.prisma:770-827`, `TenantWallet` `:2662-2693`)
- PK `String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid` (dbgenerated so raw-SQL inserts work).
- `organizationId String @map("organization_id") @db.Uuid` + relation with `onDelete: Cascade`; add the back-relation on `Organization`.
- Every `@@index`/`@@unique` org-prefixed. `@@map("snake_plural")`, `@map` on every multi-word field.
- `createdAt`/`updatedAt`; `deletedAt DateTime?` for soft delete + `@@index([organizationId, deletedAt])`.
- Money = integer minor units (`Int`); `BigInt` when overflow is real (cart money in LBP/IRR; wallet micro-USD). **Never backfill `price_minor` on Alinia mirror rows** — RE prices are display-layer from `attributes`.
- Secrets: `String?` columns encrypted via `encryptSecret`/`encryptJsonSecret` (`packages/db/src/secret-crypto.ts`) at the call site (only `whatsAppChannel` is auto-crypted by the client extension).

### Migration rules
- Dir name `YYYYMMDDHHMMSS_snake_name` (hand-picked timestamps). `pnpm db:migrate` = `prisma migrate dev && pnpm rls:apply` — rls.sql is always re-applied for you.
- Tenant table ⇒ RLS **inline in the same migration** (`SELECT _apply_tenant_rls('<table>');`) AND appended to `rls.sql`. The migration protects fresh DBs the instant the table exists; rls.sql is the every-deploy backstop. (Skipping the migration half caused the `contact_memory` cross-tenant leak.)
- Intentionally global table (HQ-only, e.g. `eval_runs`, `leads`) ⇒ header comment explaining why there's no `organization_id`/RLS; access solely behind `requireSuperAdmin` + `withRlsBypass`.
- `ALTER TYPE … ADD VALUE` (enum values) ⇒ **its own separate migration**, `IF NOT EXISTS`, timestamped just after the feature migration (Postgres can't use a fresh enum value in the same tx).
- Additive nullable columns on existing RLS tables need no policy work — say so in the migration header.
- Trigram search: the `search_text` column lives in the migration; the GIN index + maintaining trigger live in `rls.sql` (Prisma can't express them).
- No `GRANT` needed for new tables — `ALTER DEFAULT PRIVILEGES` covers `app_user`.
- If a new model/enum must be type-imported from `@platform/db`, add it to the hand-maintained export list in `packages/db/src/index.ts:16-81`.
- Backfills: `packages/db/scripts/backfill-<thing>.ts` — idempotent, own PrismaClient, raw parameterised SQL, invocation documented in the header; run manually after deploy (`set -a; . ./.env.production; set +a; pnpm --filter @platform/db exec tsx --conditions=source packages/db/scripts/<script>.ts`).

---

## 4. Web pattern

- Page: `apps/web/src/app/(dashboard)/<slug>/page.tsx`, `'use client'`. Settings sub-features: `(dashboard)/settings/<slug>/page.tsx` + a card link in `settings/page.tsx`.
- Data: TanStack Query + the fetch wrapper `apps/web/src/lib/api.ts` (`api.get/post/…`, auto token refresh). Typed per-feature fetchers in `apps/web/src/lib/dashboard-api.ts`. Mutations: `onSuccess: toast.success + qc.invalidateQueries`.
- UI kit: `PageHeader`, `Card`/`Button`/`Skeleton`/`confirmDialog` from `@/components/ui/*`, `sonner` toasts.
- Nav: add a `NavItem` to `groups` in `components/shell/sidebar.tsx:72-128` (flags: `adminOnly`, `hideForAdmin`, `badgeKey`, …) or `superAdminItems:130-138`; optionally `command-palette.tsx:107-126`.
- The web build ignores TS errors (`next.config.ts`) — **api/shared `tsc` is the real gate**; run `tsc --noEmit` for web when it matters.

## 5. Worker pattern (only if background jobs)

- Queue name + payload interface + lazy `getXQueue()` in `apps/api/src/lib/queues.ts`. Producers `getXQueue().add(name, payload, { jobId, attempts, backoff })`. **BullMQ jobIds must not contain `:`** — use `-`.
- Consumer: `apps/worker/src/jobs/<feature>.ts` exports `startXWorker()`; register in `apps/worker/src/index.ts` (`workers` array). Worker re-declares queue name + payload locally (apps are deliberately not import-coupled); shared engines are deliberately duplicated (`lib/wallet.ts` twins).
- Recurring work is a "tick", not a queue: worker-side ticks in `index.ts:123-157`, API-side ticks started in `server.ts:422-446` inside try/catch (an embedding/calendar-style tick that must live where its lib lives).
- Worker DB access: `apps/worker/src/jobs/db.ts` (note: its `withTenant` does NOT `SET LOCAL ROLE` — FORCE-RLS still filters, but keep explicit org filters).

## 6. Tests & gates

- `apps/api/test/*.test.ts`, Vitest, **real Postgres + Redis** (dev compose; this machine remaps to 15432/16379 via the gitignored override). `test/setup.ts` builds the real server once, TRUNCATEs the (hardcoded) table list per test — add new tables there. `seedOrgAndLogin(app, slug)` from `test/helpers.ts`.
- Shape: exercise the lib directly for invariant-critical logic, then `app.inject(...)` the routes; assert what must NOT leak (e.g. wallet hides `metaCostMicros`).
- Gates:
  - `test/tenant-isolation.test.ts` — **the HARD blocking CI gate** (`ci.yml:75`). Add an org-A-can't-read-B block (+ `probeRls` for sensitive tables) for every new tenant resource.
  - `test/rls-drift.test.ts` — auto-discovers any `organization_id` table missing ENABLE/FORCE/policy; zero per-table work. (Runs under the non-blocking `pnpm test` step — don't rely on it alone.)
  - `test/feature-backfill-invariant.test.ts` — filesystem scan enforcing the defaultDisabled-backfill rule.
- Import tests need dummy `WASABI_*` keys set or they 400 on the storage gate.

## 7. Deploy

Pull-based: commit + push to `origin/main`, then `infra/scripts/redeploy.sh` **on the server** (`aligned@91.92.108.178:269`, `/opt/aligned/app`) — resets to origin/main, rebuilds db+shared, `prisma migrate deploy` (+ rls.sql), rebuilds web (swap-backed), restarts, health-checks. Multiple concurrent chats may share this working tree — **commit early and often**; uncommitted work is not safe.

## 8. Known gotchas / latent gaps

- `assertOrgFeature` and `requireApiKeyScope` are the intended shared guards but currently have zero call sites (modules hand-roll) — use the helpers in new code.
- Scope-missing responses: read routes emit 403, the plugin helper 401 — be consistent within your feature.
- `deploy.yml` applies rls.sql with `|| true` — another reason inline-in-migration RLS is mandatory.
- Zod response schemas STRIP unknown fields — extend the shared schema when adding response fields (this bit the `sourceSystem` rollout).
- gpt-4o-mini copies literal example values from prompts — never put fictional product names in bot prompt text.
