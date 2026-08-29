# ALIGNED / Hader — High-Availability & Scale Blueprint

This package takes the platform from **one VM (single point of failure)** to a
**fault-tolerant, horizontally-scalable** topology suitable for enterprise
clients with large datasets. It is the concrete execution of the Tier 1–4 plan
and the answer to "should I have multiple VMs?".

> **Current reality (measured 2026-06-22):** one Ubuntu 22.04 VM, 4 vCPU / 8 GB
> RAM / 38 GB disk, Postgres 16.13 (`wal_level=replica` already on,
> `archive_mode=off`), DB ≈ 31 MB, Redis with RDB-only persistence. Everything
> (Postgres, Redis, api, worker, web, Caddy) runs on this one box.

---

## 1. Should you have multiple VMs? — **Yes. Unambiguously, for enterprise.**

A single VM means *any* of these takes down **every** tenant at once: a kernel
panic, a full disk, a Postgres OOM, the one worker process crashing, or even a
routine `next build` (which has already OOM'd this box twice). No enterprise
security/procurement review passes "what happens when your database server
dies?" with "we restore from a nightly dump and hope."

You do **not** need a big fleet. The decision is *how many* and *what each does*:

### Target topology (minimum true HA) — 4 VMs

```
                          ┌─────────────── Caddy LB (on app nodes, ip_hash) ───────────────┐
                          │                                                                 │
                  ┌───────▼────────┐                                            ┌───────────▼────┐
                  │  vm-app-1      │   api :4000  worker  web :3000             │  vm-app-2      │
                  │  (current box) │   Redis PRIMARY   etcd-1                   │  Redis REPLICA │
                  └───────┬────────┘                                            └───────┬────────┘
                          │   PgBouncer → Patroni VIP / HAProxy :5432 (always points at the leader)
                          └───────────────────────────┬─────────────────────────────────┘
                              ┌───────────────────────┴───────────────────────┐
                      ┌───────▼────────┐                              ┌────────▼───────┐
                      │  vm-db-1       │   Postgres PRIMARY           │  vm-db-2       │   Postgres STANDBY
                      │  Patroni etcd-2│   (Patroni-managed)          │  Patroni etcd-3│   (sync streaming)
                      └───────┬────────┘                              └────────────────┘
                              │  continuous WAL archive (PITR)
                              ▼
                       Wasabi  s3://…/pg-wal/   +   nightly base backups
```

- **2 DB VMs** (`vm-db-1` primary, `vm-db-2` standby) — dedicated, the only nodes
  that need to be beefy/IO-fast. Streaming replication + **Patroni** automated
  failover. This is the enterprise blocker; do it first.
- **2 app VMs** (`vm-app-1` = your current box, `vm-app-2` new) — each runs
  api + worker + web; Caddy load-balances across them. Stateless, so they're
  disposable and enable zero-downtime rolling deploys.
- **etcd quorum of 3** (one per db node + one on app-1) — Patroni's brain;
  3 nodes tolerate 1 failure without split-brain.
- **Redis** primary on app-1, replica on app-2, **3 Sentinels** co-located with
  etcd. Enable **AOF** for durability (queues/locks survive a crash).

### Pragmatic stepping stones (don't boil the ocean)
You can climb this ladder one rung at a time, each rung shippable on its own:

| Rung | VMs | What you get | Score |
|---|---|---|---|
| **0 — today** | 1 | everything co-located, SPOF everywhere | 7.5 |
| **1 — split the DB** | 2 | DB on its own node (resource isolation) + a streaming standby you can *manually* promote; PITR to Wasabi | ~8.2 |
| **2 — auto-failover** | 3 | Patroni + etcd quorum → DB failover in seconds, no human | 8.5 |
| **3 — app HA** | 4 | second app node behind the LB → no app SPOF, zero-downtime deploys | 9.0 |

Rung 1 alone removes ~80 % of the catastrophic risk. Rungs 2–3 remove the rest.

### One honest tradeoff: self-host vs managed Postgres
Operating self-hosted Postgres HA (Patroni, failover testing, split-brain
avoidance, WAL archive monitoring) is genuinely hard for a small team. The
configs here are **complete and correct for self-hosting** (fits "Aligned Cloud
Servers"), **but**: if your cloud can give you a **managed Postgres with built-in
HA + PITR**, take it — it offloads the single hardest operational burden, and the
rest of this blueprint (app HA, Redis, deploy, observability) still applies
verbatim. Decide this before Rung 2. Either way, **the app tier is yours to run.**

---

## 2. VM sizing (for "big data" enterprise tenants)

| Role | vCPU | RAM | Disk | Notes |
|---|---:|---:|---|---|
| `vm-db-1` / `vm-db-2` | 8 | 32 GB | 200 GB+ NVMe | RAM ≈ 25 % to `shared_buffers`; fast disk for WAL. Grow disk as data grows. |
| `vm-app-1` / `vm-app-2` | 4 | 8–16 GB | 40 GB | stateless; the `next build` wants ~2 GB headroom (keep the swapfile). |

Your current 4 vCPU / 8 GB box is fine as **an app node**, undersized as a DB
node for big data. Don't put a big-data Postgres on it.

---

## 3. Execution order (each step links to its config here)

1. **Tier 1 — DB resilience** (the blocker)
   1. Provision `vm-db-1` + `vm-db-2`.
   2. Tune Postgres → [`postgres/postgresql.tuned.conf`](postgres/postgresql.tuned.conf).
   3. Set up **PITR to Wasabi** with WAL-G → [`postgres/walg.README.md`](postgres/walg.README.md). *(the only step needing a brief primary restart — `archive_mode=on`)*
   4. Stand up **Patroni + etcd** → [`postgres/patroni.yml`](postgres/patroni.yml).
   5. Point PgBouncer at the Patroni leader (HAProxy/VIP) → [`postgres/haproxy.cfg`](postgres/haproxy.cfg).
   6. **Rehearse a restore** → [`../scripts/pg-restore-drill.sh`](../scripts/pg-restore-drill.sh). *Do this before you trust it.*
2. **Tier 2 — App HA**
   1. Provision `vm-app-2`; install the repo + [`../systemd/`](../systemd/) units on both app nodes.
   2. Redis primary/replica + Sentinel → [`redis/`](redis/).
   3. Caddy load-balances both app nodes → [`caddy/Caddyfile.ha`](caddy/Caddyfile.ha).
3. **Tier 3 — Deploy hardening**
   - Key-only SSH + secrets → [`../DEPLOY-HARDENING.md`](../DEPLOY-HARDENING.md).
   - Health-gated deploy with auto-rollback is already wired into
     [`../scripts/redeploy.sh`](../scripts/redeploy.sh) (rolls back to the last-good SHA if `/health` fails).
4. **Tier 4 — Observability/SLA**
   - Prometheus alert rules + Alertmanager → [`observability/`](observability/).
5. **Big-data scaling** (independent of HA)
   - Partition + retain high-growth tables; route read API at a replica →
     [`big-data/SCALING.md`](big-data/SCALING.md).

---

## 4. What this buys, in SLA terms
- **RPO** (max data loss): from ~24 h (nightly dump) → **seconds** (sync standby + continuous WAL archive).
- **RTO** (time to recover): from hours (manual rebuild) → **< 1 min** DB failover (Patroni) / instant app failover (LB).
- **Planned-maintenance downtime:** from "restart the box" → **zero** (rolling deploys, failover for DB patching).
