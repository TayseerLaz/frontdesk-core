# Redis HA — replica + Sentinel + durability

Redis is **not just a cache** here — it holds BullMQ queues, the per-org WhatsApp
token buckets, distributed locks for the worker tick-loops, rate-limit counters,
and SSE nonces. If Redis dies or loses data: jobs vanish, two workers can run the
same tick (locks gone), and broadcasts can double-send. So Redis needs both
**durability** (survive a crash) and **failover** (survive a node loss).

## 1. Durability (do this even on a single node — no new VM, ~no downtime)
Current state: RDB snapshots only (`save 900 1 …`), AOF **off** → up to ~60 s of
lost queue state on a crash. Turn on AOF (append-only file):

```bash
redis-cli CONFIG SET appendonly yes
redis-cli CONFIG SET appendfsync everysec      # ~1s worst-case loss, good perf
redis-cli CONFIG REWRITE                        # persist to redis.conf
```
`everysec` is the right balance for queues; `always` is safest but slower.

## 2. Replica + Sentinel (Tier 2, needs vm-app-2)
- **Primary** on `vm-app-1`, **replica** on `vm-app-2` (`replicaof <app-1-ip> 6379`).
- **3 Sentinels** (co-located with etcd: app-1, db-1, db-2) watch the primary and
  auto-promote the replica on failure (`quorum 2`).
- The app connects via the Sentinel-aware client (ioredis supports
  `{ sentinels: [...], name: 'aligned-redis' }`) so it always finds the current
  primary. **App change required:** point `REDIS_URL`/client at Sentinels — small,
  isolated change in `apps/*/src/lib/redis.ts`.

See `redis.conf` and `sentinel.conf` in this folder for drop-in templates.

## 3. Protect it
- `requirepass` + `masterauth` (set a strong password; put it in `.env.production`).
- `bind` to the private subnet only; never expose 6379 publicly.
- `maxmemory` + `maxmemory-policy noeviction` for the DB index 0 that holds
  queues/locks (evicting a lock or a queued job is data loss). If you also use
  Redis purely as a cache, isolate that on a separate instance/db with
  `allkeys-lru` so cache pressure can't evict queue data.
