# ALIGNED Business Platform — Runbook

This document is the source of truth for operating the platform in production.
Keep it up to date when procedures change.

> ⚠️ **DEPLOY MODEL: NATIVE, NOT DOCKER.** Production runs `api`/`worker` via
> `tsx` and `web` via `next start`, all under **systemd** (unit files in
> [infra/systemd/](../infra/systemd/)). The prod Docker stack
> (`docker-compose.prod.yml` + per-app Dockerfiles) was **removed** — it
> contradicted the live model (it compiled to `dist/` and ran `node dist/…`).
>
> - **Deploy / rollback:** `cd /opt/aligned/app && git pull && bash infra/scripts/redeploy.sh`
>   (rollback = `git checkout <good-sha>` then re-run). See **Deploys** / **Rollback** below.
> - **Restart a service:** `sudo systemctl restart aligned-api aligned-worker aligned-web`.
> - The `docker compose …` commands that remain in the sections below are
>   **historical** and refer to the dev stack only (`docker-compose.yml`:
>   Postgres/Redis/PgBouncer/Mailpit). Do not use them for production deploys.
>
> 🏗 **Scaling to enterprise HA (no single point of failure):** the full multi-VM
> blueprint — Postgres primary/standby + Patroni auto-failover + PITR to Wasabi,
> app-tier load balancing, Redis Sentinel, deploy hardening, alerting, and
> big-data partitioning — lives in [infra/ha/README.md](../infra/ha/README.md).
> The deploy script now **auto-rolls-back** to the last known-good SHA if
> `/health` fails after a deploy. Rehearse restores with
> [infra/scripts/pg-restore-drill.sh](../infra/scripts/pg-restore-drill.sh).

---

## Topology

- **Aligned Cloud Server** running Docker Compose:
  - `caddy` (TLS terminator) → `web` (Next.js) and `api` (Fastify)
  - `worker` (BullMQ) consumes jobs from `redis`
  - `postgres` (data) ← `pgbouncer` (transaction pooling) ← `api` + `worker`
- **Wasabi** holds product images, CSV uploads, and encrypted DB backups
- **GitHub Container Registry** (`ghcr.io/<org>/aligned-{api,worker,web}`) holds versioned images
- **Sentry** receives unhandled exceptions
- **Prometheus** scrapes `/metrics` on the api (port 4000) and worker (port 9100)

## Domains

| Service | Domain |
|---|---|
| Portal (Next.js) | `app.aligned.com` |
| API + chatbot read API | `api.aligned.com` |

---

## Day-1 server bootstrap

1. SSH to the server, install Docker + Docker Compose plugin.
2. Clone the repo to `/srv/aligned`.
3. `cp .env.production.example .env.production`, edit, `chmod 600 .env.production`.
4. `docker login ghcr.io -u <username>` with a PAT that has `read:packages`.
5. `docker compose -f docker-compose.prod.yml --env-file .env.production pull`.
6. Run migrations once: `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm api node node_modules/prisma/build/index.js migrate deploy --schema packages/db/prisma/schema.prisma`.
7. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d`.
8. Verify: `curl -sf https://api.aligned.com/health` returns `{"status":"ok"}`.

---

## Deploys

Pushing to `main` triggers `.github/workflows/deploy.yml` which:

1. Builds and pushes new images to GHCR with the short commit SHA as the tag.
2. SSHes to the server, pulls the new images, runs Prisma migrations, and `up -d --remove-orphans`.
3. Smoke-tests `/health`.

If the smoke test fails the deploy job exits non-zero. The previous containers
keep running until the new ones are ready (Compose's default behaviour).

---

## Rollback

```bash
ssh deploy@aligned-cloud
cd /srv/aligned
export TAG=<previous-short-sha>
export REGISTRY=ghcr.io/<org>
docker compose -f docker-compose.prod.yml --env-file .env.production pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --remove-orphans
```

If you also need to roll back a Prisma migration, see "Database migrations" below — Prisma does not auto-down-migrate; restore from backup is the safer path.

---

## Database migrations

- Schema lives in `packages/db/prisma/schema.prisma`.
- New migrations go through `pnpm db:migrate` locally first, committed, then `migrate deploy` runs in CI/CD.
- RLS policies are re-applied automatically after every migration via `pnpm rls:apply`.
- **Never** edit a migration file after it has been applied to production.

If a bad migration ships:
1. `docker compose stop api worker` (stop writes).
2. Decide: forward-fix (preferred) or restore from backup.
3. Forward fix → write a new migration that undoes the damage, deploy as usual.
4. Restore → see next section.

---

## Restore from backup

Backups are written nightly to `s3://aligned-prod/backups/aligned/` by `infra/scripts/backup.sh`. They are gzipped + age-encrypted with the recipient configured in `/etc/aligned/backup.env`.

```bash
# 1. Pull the dump
aws --endpoint-url $WASABI_ENDPOINT s3 cp \
  s3://$WASABI_BUCKET/backups/aligned/aligned-YYYYMMDDTHHMMSSZ.sql.gz.age .

# 2. Decrypt + decompress
age --decrypt --identity ~/.config/age/aligned.key aligned-*.sql.gz.age | gunzip > restore.sql

# 3. Stop writers
docker compose stop api worker

# 4. Restore
docker compose exec -T postgres psql -U $POSTGRES_USER $POSTGRES_DB < restore.sql

# 5. Re-apply RLS (just in case)
docker compose run --rm api node packages/db/scripts/apply-rls.ts

# 6. Start writers
docker compose start api worker
```

---

## Add a new tenant (manual)

If a pilot client needs a hand-held setup before self-serve signup is opened:

```bash
docker compose exec api node -e '
  const { PrismaClient } = require("@platform/db");
  const p = new PrismaClient();
  (async () => {
    await p.$executeRawUnsafe("SET app.bypass_rls = on");
    const org = await p.organization.create({ data: { slug: "newclient", name: "New Client" } });
    console.log(JSON.stringify(org, null, 2));
    await p.$disconnect();
  })();
'
```

Then send the client an invitation through the ALIGNED admin UI.

---

## Rotate secrets

**Cadence (Sprint 3 #23):** rotate the secrets in the table below **every quarter** (first Monday of Jan / Apr / Jul / Oct). Stagger the rotations across two business days so any breakage is easier to isolate.

| Secret | Rotation procedure |
|---|---|
| `JWT_ACCESS_SECRET` | Generate `openssl rand -base64 64`, update `.env.production`, restart api. **Existing access tokens become invalid immediately**, users will reauthenticate via refresh cookie. |
| `JWT_REFRESH_SECRET` | Same as above; **also forces a full re-login**. Coordinate with users. |
| `EMAIL_SMTP_PASS` | In AWS IAM, delete the SES SMTP user's password and generate a new one. Update env, restart api. The `AKIA…` username stays the same. |
| `WASABI_*` | Issue new keys, update env, restart api+worker. Existing presigned URLs (15-min TTL) keep working until they expire. |
| `SENTRY_DSN` | Rotate the client DSN in Sentry → Settings → Client Keys → Re-issue. The DSN is read-only ingest, so leak is low-impact, but quarterly hygiene catches stale env files. |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → roll the signing secret. Update env, restart api. Stripe shows BOTH the old and new secret for ~24 h so you can roll without dropping inbound events. |
| `RESEND_API_KEY` (if used) | Dashboard → API keys → revoke + reissue. |
| API keys (per org) | Issue a new one in the portal `/api-keys`, hand to the bot operator, revoke the old. Tracked per-org so rotation cadence can lag the platform's quarterly cycle when an integration is brittle. |
| Webhook signing secrets | The portal allows recreating an endpoint to rotate. Old endpoint stays live for ~24 h with the old secret so the receiver has time to switch. |
| Postgres `aligned` role password | `ALTER ROLE aligned WITH PASSWORD '…';` then update env, restart api+worker. PgBouncer also needs the new password in its `userlist.txt`. |
| age backup encryption key | `age-keygen -o /etc/aligned/backup.key.new`. Re-encrypt the most recent dump with the new key before discarding the old one (keep both keys for one quarter). |

After each rotation, **smoke-test**: log in via the portal, fetch a product through the read API with an org key, and trigger one outbound webhook delivery from `/webhooks` to confirm signing still verifies on the receiver.

---

## WAF — Cloudflare cutover

The platform is built behind Caddy on the Aligned Cloud Server, with API
nodes never directly exposed to the public internet. Layering Cloudflare
in front gives DDoS absorption + managed OWASP rules + bot scoring.

This is a 60-minute cutover when the team is ready:

1. **Sign Cloudflare up + add the zone.** Use the orange-cloud proxy
   mode for `api.hader.ai`, `app.hader.ai`, and any custom-CNAME hosts
   you want behind WAF. Cloudflare will assign nameservers — update at
   your registrar.
2. **Lock origin access.** In the server's firewall, allow port 443
   only from Cloudflare's [published IP ranges][cf-ips]. Anyone hitting
   the origin directly should get rejected at the OS firewall, not the
   application layer. (The Cloudflare ranges are mirrored in
   `apps/api/src/lib/trust-proxy.ts`.)
3. **Switch the API to Cloudflare-aware proxy trust.** In
   `.env.production`:
   ```env
   TRUST_PROXY=cloudflare
   TRUST_CF_CONNECTING_IP=true
   ```
   Restart api + worker. `req.ip` now resolves to the original client.
   Verify with a known-IP test: hit `/health` from a phone hotspot and
   confirm the audit log shows the phone's public IP, not a Cloudflare
   edge IP.
4. **Confirm Caddy still works behind Cloudflare.** Caddy's auto-TLS
   still issues certs because Cloudflare passes ACME HTTP-01 challenges
   through when the orange cloud is on. If something breaks, switch
   that hostname to "DNS only" (grey cloud) temporarily.
5. **Configure managed rules.** Enable the **OWASP Core Rule Set** at
   sensitivity = `medium`, then add custom rules: rate-limit `/auth/*`
   to 60 req/min per IP, block any direct `*.aligned-tech.com` host
   header (those should only be DNS, never user-supplied), and enable
   Bot Fight Mode + Super Bot Fight Mode for the portal.
6. **Tune false positives.** Watch `Security → Events` for the first 48
   hours and add rule exceptions for any legitimate traffic blocked
   (chatbot user-agents are the usual suspect — exempt the read-API
   path).

Roll-back is fast: in `.env.production`, set `TRUST_PROXY=true` +
`TRUST_CF_CONNECTING_IP=false`, restart, and at the registrar revert
nameservers to your previous setup. Cloudflare's "Pause Cloudflare" toggle
also bypasses the WAF in 60s if you need an emergency abort without DNS.

[cf-ips]: https://www.cloudflare.com/ips/

---

## Quarterly tenant-isolation chaos test

**Cadence (Sprint 3 #24):** the first Monday of each quarter. Run on staging, never production.

The CI deploy gate (`apps/api/test/tenant-isolation.test.ts`) blocks any merge that breaks the multi-tenant boundary, but it tests a narrow set of routes. The quarterly chaos test exercises the boundary at scale across **every** tenant-scoped table, with randomised reads — designed to catch a regression that snuck past the targeted tests (e.g. a new feature that uses raw SQL).

**Procedure**

1. Spin up a staging DB with at least two pilot tenants and ~5k rows per table in each.
2. From `apps/api/test/chaos`:
   ```bash
   pnpm tsx apps/api/scripts/tenant-chaos.ts \
       --orgs <orgA-uuid>,<orgB-uuid> \
       --iterations 5000 \
       --tables auto
   ```
   The script picks random tenant-scoped tables, picks random row IDs (mixing both orgs), and asserts the rows returned ONLY belong to the bound tenant.
3. Any row returned that doesn't match the bound `app.current_org_id` is a **HARD STOP**: file a P0, do not deploy, roll back the most recent migrations until isolated.
4. Save the run output to `docs/security/chaos-YYYY-Q?.txt` in the repo.

If `apps/api/scripts/tenant-chaos.ts` does not yet exist, build it from the pattern in `apps/api/test/tenant-isolation.test.ts` — the `probeRls` helper there is the building block.

---

## Common incidents

### Read API p95 spiking
1. Check `/metrics` — `http_request_duration_seconds` histogram.
2. Confirm Redis is healthy (`redis-cli ping`). Cache misses → DB hits → slowness.
3. If Redis is full (`maxmemory` reached): bump `--maxmemory` on Redis container or scale up.
4. If the DB is the bottleneck: check `pg_stat_activity`, kill long queries, consider read replicas.

### Worker queue depth growing
1. Check the ALIGNED admin panel → System health → Queues.
2. If `failed` is climbing: `docker logs aligned-worker | grep error`.
3. Scale worker replicas in `docker-compose.prod.yml` (`replicas: N`) and redeploy.

### Webhook deliveries failing
1. Check `/webhooks` page — endpoints with `consecutiveFailures > 0` are flagged.
2. Endpoints auto-disable after 25 consecutive failures.
3. Manual retry from the deliveries log if the customer's endpoint is back up.

### Broadcast stuck in `sending` with no progress
1. Check worker logs: `docker logs aligned-worker | grep broadcast`.
2. Verify the `broadcast-fanout` and `broadcast-send` queues are draining: ALIGNED admin → System health.
3. Check the WhatsApp channel is active (`/whatsapp` page) — token expiry or Meta-side disable.
4. Pause the broadcast (button on detail page), fix the underlying issue, then Resume.
5. The send worker auto-pauses after 25 consecutive recipient failures inside a 60s window; look for a `recipient_failed_burst` event in the timeline.

---

## Operating broadcasts

- **Audience materialization**: manual + segment recipients land in `broadcast_recipients` immediately on send. CSV recipients land in the fanout worker (streaming, restart-safe).
- **Per-org rate limit**: the send worker honors `WHATSAPP_SEND_TOKENS_PER_SECOND` (default 80). Bump after Meta tier upgrades.
- **Permanent vs transient errors**: the send worker classifies Meta error codes into permanent (skip + count as failed) and transient (BullMQ retries with exponential backoff up to 5 attempts).
- **Status updates**: delivered/read/failed on a recipient row are driven by the existing `message_status` webhook, joined by `meta_message_id`.
- **A/B tests**: 50/50 deterministic split by phone hash. Variant counters are inferred by filtering recipients on the detail page.

---

## Pilot onboarding checklist

For each new client:

- [ ] Create the org via `/hq` (or have client self-signup).
- [ ] Invite the client admin (their work email).
- [ ] Walk them through: products → services → business info.
- [ ] Issue an API key (in `/api-keys`) and hand the secret to the bot team.
- [ ] (Optional) Help them upload a CSV via `/imports`.
- [ ] (Optional) Set up an outbound webhook from the chatbot to the platform if the bot needs change notifications.
- [ ] Verify the read API works end-to-end:
      `curl -H "X-Api-Key: $KEY" https://api.aligned.com/api/v1/read/products`
