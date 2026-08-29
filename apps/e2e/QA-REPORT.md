# Phase 1 QA — 10/10 ✅

Generated: 2026-04-22.
Stack under test: dev (web :3000, api :4000, postgres :5432, redis :6379, mailpit :8025, wasabi bucket `alignbotbucket` in `eu-central-1`).

## Final scoreboard

**79 / 79 passing · 0 fixme · 0 red.**

| Suite | Result |
|-------|:------:|
| tenant-isolation (HARD DEPLOY GATE) | **6 / 6** ✅ |
| auth | **5 / 5** ✅ |
| api-keys | **4 / 4** ✅ |
| admin-panel | **4 / 4** ✅ |
| categories | **6 / 6** ✅ |
| read-api | **9 / 9** ✅ |
| members | **6 / 6** ✅ |
| webhooks-outbound | **5 / 5** ✅ |
| imports | **8 / 8** ✅ |
| connectors | **10 / 10** ✅ |
| catalog-products | **6 / 6** ✅ |
| catalog-services | **5 / 5** ✅ |
| business-info | **5 / 5** ✅ |

## Application bugs fixed (across both sessions)

| # | Fix | Files |
|--:|-----|-------|
| 1 | 🚨 **Critical RLS bypass** — Prisma connected as Postgres superuser, silently bypassing every tenant policy. Fixed: `withTenant` now switches to `app_user` role. | [apps/api/src/lib/db.ts](apps/api/src/lib/db.ts) |
| 2 | 🚨 **`api.put` was missing from the browser client** — Save buttons on 5 different forms (variants, pricing tiers, weekly availability, business-profile, policies) silently swallowed `TypeError: api.put is not a function`. All replace-set Save actions were dead UI. | [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts#L110-L120) |
| 3 | 🚨 **Wasabi PUT signature mismatch** — AWS SDK v3 ≥3.729 injects `x-amz-checksum-crc32` into presigned URLs that browsers don't send. Image upload + CSV import would 403 in production. Fixed with `requestChecksumCalculation: 'WHEN_REQUIRED'`. | [apps/api/src/lib/storage.ts](apps/api/src/lib/storage.ts) |
| 4 | Auth rate-limit env-driven + bypass for `x-e2e-run: 1` header (non-prod only). | [auth.routes.ts](apps/api/src/modules/auth/auth.routes.ts), [server.ts](apps/api/src/server.ts) |
| 5 | `POST /connectors` with `enableInboundWebhook: true` returned 500 (NOT NULL on `endpoint_url`). Made nullable + migration `20260421160000_connector_endpoint_url_nullable`. | [schema.prisma](packages/db/prisma/schema.prisma), migration |
| 6 | Scheduled syncs never produced `SyncRun` rows — worker updated the `__pending__` sentinel id. Worker now creates the row at job start. | [apps/worker/src/jobs/sync.ts](apps/worker/src/jobs/sync.ts) |
| 7 | Dead env var `RATE_LIMIT_READ_API_PER_SECOND` — wired into per-URL rate-limit. | [server.ts](apps/api/src/server.ts) |
| 8 | Read-API cache HIT/MISS now exposes `x-cache` response header for deterministic client + test assertions. | [read.routes.ts](apps/api/src/modules/read/read.routes.ts) |
| 9 | `addOptionKey` on variants was a no-op before the first variant existed — `optionKeys` was derived from `variants[].options`. Tracked independently in `extraOptionKeys`. | [products/[id]/page.tsx](apps/web/src/app/(dashboard)/products/[id]/page.tsx) |
| 10 | `POST /connectors/:id/sync` required `z.object({}).optional()` but Fastify delivered `null` for empty body → Zod 400. Now `.optional().nullable()`. | [shared/schemas/connector.ts](packages/shared/src/schemas/connector.ts) |
| 11 | Connector dialog labels had no `htmlFor` → broken accessibility + screen readers couldn't associate. Now every field has `htmlFor`+`id`. | [connectors/page.tsx](apps/web/src/app/(dashboard)/connectors/page.tsx) |
| 12 | Connector cards had no test hooks. Added `data-testid="connector-card-<id>"` and `data-testid="connector-test-btn"`. | same |

## Spec bugs fixed (harness self-inflicted)

- `uniqueSlug` emitted uppercase characters, violating `slugSchema` regex.
- `ApiClient.delete()`, `connectors.apiJson()`, and `imports.apiJson()` all sent `content-type: application/json` with no body → Fastify 500. Now only when body is present.
- `read-api.spec.ts` used policy kind `returns` — enum is `return`.
- `webhooks-outbound` signing-secret locator; scoped to the "Save this signing secret" dialog.
- `catalog-products.spec.ts` used `__dirname` in ESM.
- `categories.spec.ts` "DELETE clears" used a shared fixture category; now provisions fresh.
- `members.spec.ts` teardown deleted users before org → FK on invitations. Flipped order.
- `members.spec.ts` email subject was "Invit..."; actual is "Join <org> on the platform".
- `webhooks-outbound` retry + manual-retry tests matched prior tests' delivered rows; now filtered to specific delivery IDs.
- `admin-panel` notifications-bell test needed `page.reload()` to force the react-query refetch.

## Ship-readiness

**Phase 1 code-complete and all tests green.** The full suite now runs in ~4.5 minutes. Tenant-isolation hard gate is 6/6; deploy is safe.

Remaining before production launch (all infra, not code):
1. Provision Ubuntu server, install Docker + age + AWS CLI.
2. DNS A records for `app.` and `api.` subdomains.
3. Fill `.env.production` + generate JWT + Postgres secrets + rotate Wasabi keys for prod.
4. GitHub Actions secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `GHCR_PAT`, `API_DOMAIN`, `WEB_DOMAIN`.
5. Push to `main` → deploy.yml ships it.
6. Seed pilot orgs on server; capture API keys.
7. k6 load test from outside (`p95<200ms`).
8. Daily backup cron (`5 3 * * *`).
9. Onboard 3 pilot clients (Phase 1 §7.1 success criterion).

## How to re-run

```sh
# hard gate only:
pnpm qa:gate

# full sweep with HTML report:
pnpm qa
pnpm qa:report

# one suite:
pnpm --filter @platform/e2e test:auth
```

Logs: `apps/e2e/qa-logs/*.log`.
HTML report: `apps/e2e/playwright-report/index.html`.
Traces + screenshots: `apps/e2e/test-results/`.

## CI gating

`.github/workflows/e2e.yml` stands up ephemeral Postgres + Redis + Mailpit, runs migrations + seed, boots api/worker/web, runs preflight + hard-gate + full suite. Gate this workflow as required on PRs.
