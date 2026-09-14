# Platform Core

> **Evaluating this project?** Read **[TESTING.md](TESTING.md)** — it takes you from a fresh
> clone to a real phone call in about fifteen minutes, including a no-credentials dry run.

A multi-tenant SaaS that turns a business's WhatsApp number into an AI front desk.

A tenant loads its catalogue, hours, FAQs and policies into a web portal and connects
its official Meta WhatsApp number. An AI assistant then answers that business's
customers around the clock — showing products, taking orders and bookings, and
handing off to a human when it should. The same engine serves Facebook Messenger,
Instagram DMs and phone calls, and every conversation lands in one shared inbox.

**This codebase names no product.** The brand lives entirely in `.env`, so standing up
a new one is a config file and a few image files — never a rename. A CI gate enforces
it (`pnpm brand:check`).

---

## Cold start

Four environment variables are required to boot. Everything else degrades gracefully:
storage returns 503 without Wasabi keys, push is a no-op without Firebase, email falls
back to Mailpit, WhatsApp reports itself unconfigured, and every AI provider is
optional. Each integration lights up the moment you add its key.

```bash
cp .env.example .env        # fill DATABASE_URL, REDIS_URL, both JWT secrets,
                            # then BRAND_* and INITIAL_ADMIN_*
docker compose up -d        # postgres, pgbouncer, redis, mailpit
pnpm install
pnpm bootstrap              # migrate + create the first super-admin
pnpm dev                    # portal on :3000/app, API on :4000
```

Log in at <http://localhost:3000/app> with `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`.
`pnpm db:seed:demo` adds a demo organisation if you want one.

## Rebranding

| What | Where |
|---|---|
| Name, domain, support email, accent | `.env` — the `BRAND_*` and `NEXT_PUBLIC_BRAND_*` pairs |
| Colour ramp | `apps/web/src/styles/globals.css` — one documented token block |
| Logo + icon | Replace the **files** in `apps/web/public/brand/` and `apps/web/public/icons/`; never change the paths |
| Fixed brand panel (auth + sidebar) | Two literal hexes in `app-shell.tsx` and `(auth)/layout.tsx`, documented in place |

`packages/shared/src/brand.ts` is the single source of truth; `apps/web/src/lib/brand.ts`
is its browser-safe twin (Next inlines `NEXT_PUBLIC_*` at build time).

## Phone follow-through with CALL-E

The AI front desk can now **pick up the phone when chat is not enough**. Orders and
bookings the chat bot captures are closed by an outbound AI call placed through
[CALL-E](https://www.heycall-e.com/) (`@call-e/calle`), and the structured result is
written back to the record and posted as a note in the same inbox conversation.

| Trigger | What the call does | Write-back |
|---|---|---|
| **Cash-on-delivery order** (manual button on Orders, or auto after N minutes) | Reads back the *real* cart rows and total, confirms the delivery address, records changes | cart → `confirmed` / `cancelled`, or `needs_review` for a human |
| **Booking** | Asks whether the customer can still attend; records a requested new time without promising it | booking → `confirmed` / `cancelled`, or `needs_review` |
| **Custom goal** from a conversation | Whatever the operator asks, grounded in the business name and policies | inbox note only |

Safety is enforced in code, not documentation:

- `CALLE_DRY_RUN=true` is the **default** — nothing is dialed, a synthetic result completes
  the whole write-back path so the feature can be evaluated without credentials.
- `CALLE_LIVE_OVERRIDE_PHONE` redirects **every** live call to one verified number.
- Contacts who opted out or are blocked are never called; unsupported countries are
  rejected before a row exists; a per-tenant daily cap bounds spend.
- Every task persists a durable `Idempotency-Key` before the first request, and results
  apply through a compare-and-set so the webhook and the 30-second poll can never
  double-apply.
- Low confidence or an ambiguous disposition **never** cancels an order — it becomes
  `needs_review`.

Code: `apps/api/src/lib/calle.ts` (the only importer of the SDK), `apps/api/src/lib/phone-tasks.ts`
(task builders + write-back), `apps/api/src/lib/phone-task-tick.ts` (poll + auto-confirm),
`apps/api/src/modules/phone-tasks/` (portal routes + the public webhook receiver),
`apps/web/src/app/(dashboard)/phone-tasks/`. Full subsystem notes: [docs/PHONE-TASKS.md](docs/PHONE-TASKS.md).

## Layout

```
apps/
  api/        Fastify REST API — auth, catalog, inbox, bot engine, webhooks
  worker/     BullMQ workers — imports, syncs, broadcasts, scheduled ticks
  web/        Next.js 15 portal (App Router, served under /app)
  wa-ingest/  Baileys capture service (opt-in; see docs/SALES-SCAN-*.md)
  e2e/        Playwright suites, incl. the tenant-isolation deploy gate
packages/
  db/         Prisma schema, the single baseline migration, RLS policies
  shared/     Zod schemas, enums, constants, brand — used by api + web + worker
  config/     ESLint, tsconfig and Prettier bases
infra/        Caddy, PgBouncer, systemd units, deploy + backup scripts
```

## Tenancy

Shared schema, an `organization_id` column on every tenant-scoped table, and
**Postgres row-level security as the backstop**. Each authenticated request runs in a
transaction that sets `app.current_org_id` and switches to the non-superuser
`app_user` role, so a missing `WHERE organization_id = …` fails closed instead of
leaking. `apps/api/test/tenant-isolation.test.ts` is a blocking CI gate.

## Gates

| Command | What it protects |
|---|---|
| `pnpm brand:check` | No hard-coded product name anywhere |
| `pnpm --filter @platform/api test:pure` | Consent hashes, billing, retrieval, scheduling logic — no DB needed |
| `pnpm qa:gate` | Cross-tenant isolation |
| `pnpm typecheck` | All five packages |

The database baseline is deliberately **one** migration. It applies to a genuinely
empty database with `prisma migrate deploy` alone — extensions, then tables, then the
raw SQL Prisma cannot express (functions, triggers, partial and trigram indexes, CHECK
constraints), then RLS.

## Docs

- `docs/PHONE-TASKS.md` — the CALL-E phone follow-through subsystem: the three task kinds, the
  safety rails, and the rule that decides whether a call may change a record
- `docs/ARCHITECTURE.md` — runtime topology, the tenancy seam, subsystem index, critical paths
- `docs/RUNBOOK.md` — deploy, rollback, restore, add-tenant, rotate secrets, incidents
- `docs/ADDING-A-FEATURE.md` — the house pattern for a new feature + its feature flag
- `docs/COEXISTENCE.md` — WhatsApp coexistence mechanics
- `docs/SALES-SCAN-REVIEW-BLOCKERS.md` — **read before enabling Sales Scan**; it ships
  disabled and has open blockers
