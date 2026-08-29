# Platform Core

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

- `docs/ARCHITECTURE.md` — runtime topology, the tenancy seam, subsystem index, critical paths
- `docs/RUNBOOK.md` — deploy, rollback, restore, add-tenant, rotate secrets, incidents
- `docs/ADDING-A-FEATURE.md` — the house pattern for a new feature + its feature flag
- `docs/COEXISTENCE.md` — WhatsApp coexistence mechanics
- `docs/SALES-SCAN-REVIEW-BLOCKERS.md` — **read before enabling Sales Scan**; it ships
  disabled and has open blockers
