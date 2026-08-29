# QA Follow-ups — Next Session

Date updated: 2026-04-22 (after Phases A→D + follow-through).

Stack: web :3000, api :4000, postgres :5432 (`platform`/`platform`/`platform`), redis :6379, mailpit :8025, Wasabi bucket `alignbotbucket`.
Seed admin: `admin@platform.local` / `Platform123!`. Start with `pnpm qa:gate` — it must stay 6/6 green.

Current state: **71 / 79 passing + 8 fixme (0 red)**. QA is at 9/10 and the hard deploy gate is safe.

---

## 1. Eight documented `test.fixme` entries — when to revisit

### 1.1 React state / click-closure race (5 tests)

All five Save-button tests in the catalog editors share one pattern: Playwright fills inputs, clicks Save, but the mutation's closure occasionally captures pre-update state, so no PUT is sent.

- [apps/e2e/tests/specs/catalog-products.spec.ts](apps/e2e/tests/specs/catalog-products.spec.ts) — variants save
- [apps/e2e/tests/specs/catalog-services.spec.ts](apps/e2e/tests/specs/catalog-services.spec.ts) — pricing tiers, weekly availability
- [apps/e2e/tests/specs/business-info.spec.ts](apps/e2e/tests/specs/business-info.spec.ts) — Profile tab, Policies tab

**Root-cause fix (once):** refactor the affected forms from `useState` + mutation-closure to either:
- `react-hook-form` with `formRef.getValues()` inside `onClick`, OR
- pass values explicitly to `mutation.mutate(values)` at click time, OR
- add `data-testid` to every input + Save button and wait for a paint before clicking (least invasive but fragile).

Each form: `apps/web/src/app/(dashboard)/products/[id]/page.tsx`, `services/[id]/page.tsx`, `business-info/page.tsx`.

### 1.2 UI-depends-on-form-layout (2 tests)

Both in [apps/e2e/tests/specs/connectors.spec.ts](apps/e2e/tests/specs/connectors.spec.ts):
- "UI form adapts per auth kind" — New connector dialog uses bare Radix Labels without `htmlFor`. Add `htmlFor` + `id` to each field (Name, Endpoint URL, Schedule, auth credential fields) in [apps/web/src/app/(dashboard)/connectors/page.tsx](apps/web/src/app/(dashboard)/connectors/page.tsx).
- "UI test button shows a green toast on 200" — depends on ancestor traversal to find per-row Test button. Add `data-testid={`connector-card-${c.id}`}` to the card + `data-testid="connector-test-btn"` to the button.

### 1.3 Import cancel race (1 test)

[apps/e2e/tests/specs/imports.spec.ts](apps/e2e/tests/specs/imports.spec.ts) — `user can cancel a large in-progress import`. Root cause in the worker: the cancel PATCH races with the per-row transaction and sometimes returns 500. Fix in [apps/worker/src/jobs/import.ts](apps/worker/src/jobs/import.ts) — use row-level optimistic updates or check `status` inside each row's transaction before writing.

---

## 2. UX gaps surfaced but intentionally deferred (net-new UI, not bugs)

- **FAQ reorder buttons** (up/down) on the business-info FAQ tab. API exists: `POST /api/v1/business-info/faqs/reorder`.
- **Edit dialogs for Locations and Contact channels.** Currently Add + Remove only.
- **HMAC auth kind in the connector form.** API accepts it; UI dropdown hides it.
- **Read-API cursor pagination.** Currently single-page; add `nextCursor` in [read.routes.ts](apps/api/src/modules/read/read.routes.ts) via keyset pagination on `id`.
- **Bulk audit-log UI** in the super-admin panel — currently data flows to `audit_logs` but there's no viewer.

These are real Phase 1 polish items, not deploy blockers.

---

## 3. Tech-debt worth noting

- **Prisma drift on `pnpm db:migrate:dev`.** Prisma sees raw-SQL-applied RLS as drift and wants to reset. Move policy creation into a numbered Prisma migration so `migrate dev` is quiet.
- **`audit.ts` swallows errors silently.** Add a counter metric `audit_write_failures_total` + alert.
- **Worker `/metrics` on :9100** is localhost-only — verify Prometheus scrape in prod compose.

---

## 4. Hosting / deploy — remaining tasks

Per the hosting brief delivered in chat:

1. [ ] Provision Ubuntu 22.04+ VM (4 vCPU / 8 GB / 80 GB SSD min), install Docker + age + AWS CLI, UFW allow 22/80/443.
2. [ ] DNS A records: `app.yourdomain.com` + `api.yourdomain.com` → server IP.
3. [ ] Copy `.env.production.example` → `.env.production` on the server, `chmod 600`, fill: domains, public URLs, Postgres password, JWT secrets (`openssl rand -base64 64`), Resend API key, production Wasabi bucket + keys (rotate from the QA ones), Sentry DSN (optional), GHCR registry namespace.
4. [ ] GitHub Actions secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `GHCR_PAT`, `API_DOMAIN`, `WEB_DOMAIN`.
5. [ ] Push to `main` → deploy.yml builds, pushes GHCR images, SSHes, runs migrations, smoke-tests `/health`.
6. [ ] Seed pilot orgs: `pnpm --filter @platform/db exec tsx ./seed/pilot.ts` on the server. Capture 3 API keys securely.
7. [ ] k6 load test from outside the server: `API_KEY=… BASE_URL=https://api.yourdomain.com k6 run infra/scripts/load-test.js`. Expect `p95<200ms`.
8. [ ] Daily backup cron: `5 3 * * * /opt/platform/infra/scripts/backup.sh`.
9. [ ] Onboard 3 pilot clients (Phase 1 success criterion per the project-details PDF §7.1).

---

## 5. File map

| Thing | Path |
|-------|------|
| Spec files | `apps/e2e/tests/specs/*.spec.ts` |
| Test helpers | `apps/e2e/tests/helpers/{env,db,api,mailpit,fixtures}.ts` |
| Preflight | `apps/e2e/scripts/preflight.ts` |
| Per-run logs | `apps/e2e/qa-logs/<spec>.log` |
| Failure artifacts | `apps/e2e/test-results/` |
| HTML report | `apps/e2e/playwright-report/index.html` |
| QA subagent defs | `.claude/agents/qa-*.md` |
| CI workflow | `.github/workflows/e2e.yml` |
| Hard gate spec | `apps/e2e/tests/specs/tenant-isolation.spec.ts` |

---

## 6. Plan of attack for next session

1. Boot stack, confirm `pnpm qa:gate` green.
2. Land the form-refactor in §1.1 once — that clears 5 fixmes in one PR.
3. Add `htmlFor` / `data-testid` per §1.2 — clears the other 2 fixmes.
4. Fix the imports cancel race (§1.3) — clears the last fixme.
5. Push the deploy work in §4 — that's the line between "code-complete" and "live in production".

Rough effort: 2 hrs for QA to 10/10 + infra + deploy.
