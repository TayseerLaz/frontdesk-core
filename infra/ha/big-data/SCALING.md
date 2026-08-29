# Big-data scaling (independent of HA)

HA keeps you *up*; this keeps you *fast* as enterprise tenants pour in data.
These bite at volume regardless of how many VMs you have. Today the DB is ~31 MB
— so this is a **plan to execute before** a large tenant lands, not firefighting.

## 1. The unbounded tables (they grow forever)
From the schema, these only ever grow and will dominate size + slow queries,
vacuum, and backups first:

| Table | Grows with | Strategy |
|---|---|---|
| `whatsapp_messages` | every inbound/outbound msg, all channels | **partition by month** + retain (e.g. 18 mo hot, archive older) |
| `message_provenance` | every bot reply (+ big JSON: prompt, citations) | partition by month + retain 6–12 mo; prompts already deduped via `system_prompt_snapshots` |
| `broadcast_recipients` | audience size × campaigns | retain by campaign; drop with the broadcast or after N months |
| `broadcast_events` / `webhook_deliveries` | delivery/retry rows | partition by month + short retention (30–90 d) |
| `usage_events` | every metered action | roll up into `usage_monthly` (already exists), then drop raw >90 d |
| `audit_logs` | every state change | partition by month; **keep long** (compliance) but on cheaper storage / archive |
| `voice_call_turns` | every call utterance | partition by month + retain |

## 2. Partitioning pattern (Postgres native, declarative)
Convert a hot table to range-partitioned on `created_at`. Because these are big
to rewrite, do it as a **planned migration during a window** (or with `pg_partman`
+ logical-replication cutover for zero downtime). Pattern:

```sql
-- 1. New partitioned parent (same columns/indexes as the original).
CREATE TABLE whatsapp_messages_p (LIKE whatsapp_messages INCLUDING ALL)
  PARTITION BY RANGE (created_at);

-- 2. Monthly partitions (automate creation with pg_partman or a monthly job).
CREATE TABLE whatsapp_messages_2026_06 PARTITION OF whatsapp_messages_p
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
-- … plus a DEFAULT partition so nothing ever fails to insert.

-- 3. Backfill (batched) then swap names in one transaction.
INSERT INTO whatsapp_messages_p SELECT * FROM whatsapp_messages;
BEGIN;
  ALTER TABLE whatsapp_messages       RENAME TO whatsapp_messages_old;
  ALTER TABLE whatsapp_messages_p     RENAME TO whatsapp_messages;
COMMIT;
```
- **RLS note:** re-apply the tenant-isolation policy to the new parent — RLS is
  inherited by partitions, so `_app_userly_tenant_rls('whatsapp_messages')`
  after the swap keeps isolation intact (verify with the rls-drift test).
- **Retention** then becomes instant + cheap: `DROP TABLE whatsapp_messages_2024_12`
  instead of a giant `DELETE` (no vacuum storm). Automate with `pg_partman`'s
  retention or a monthly tick.
- Recommend **`pg_partman`** to auto-create future partitions + enforce retention
  so no one has to remember.

## 3. Read replica routing (offload the primary)
The standby from Tier 1 doubles as a read replica. The HAProxy `:5433`
read-only pool (`haproxy.cfg`) already routes to hot standbys. Use it for the
heavy, latency-tolerant reads so they don't compete with the live bot:
- **Analytics / dashboards / data-export** — point these at a second Prisma
  client built from a `DATABASE_URL_RO` env (the `:5433` pool).
- The **chatbot read API** is already Redis-cached (60 s/5 min), so it mostly
  doesn't hit PG — but its cache-miss reads can also go to the replica.
- Keep all **writes + the bot's transactional reads** on the primary (`:5432`).
- Caveat: replicas are eventually-consistent (ms behind). Never read-back a
  just-written row from the replica in the same flow.

## 4. Index & vacuum hygiene at volume
- Confirm composite `(organization_id, …)` + the `pg_trgm` GIN indexes are used
  on million-row tables (`EXPLAIN` the hot read-API/inbox queries) before a big
  tenant finds the missing one for you.
- The tuned autovacuum in `postgresql.tuned.conf` (lower scale factors) keeps
  high-churn tables from bloating.
- `pg_stat_statements` (enabled in the tuned conf) → find the top-time queries
  monthly and index/rewrite them.

## 5. Backups at volume
Logical `pg_dump` does not scale — once the DB is tens of GB it's slow and the
restore is hours. The WAL-G PITR setup (Tier 1) is **physical** and scales fine;
make it the primary backup once partitioning is in and retire the nightly dump.
