# PITR (Point-In-Time Recovery) with WAL-G → Wasabi

Replaces the nightly logical `pg_dump` (`infra/scripts/backup.sh`) — which has an
RPO of up to 24 h and a restore time that grows with the dataset — with
**continuous WAL archiving + periodic base backups**. Result: restore to *any
second* in the retention window, RPO ≈ `archive_timeout` (60 s).

> Keep the existing `backup.sh` running in parallel during cutover — belt and
> braces until the first successful restore drill (see `../scripts/pg-restore-drill.sh`).

WAL-G is chosen over pgBackRest only for its first-class S3/Wasabi support and
single static binary; pgBackRest is an equally good alternative.

## 1. Install (on every Postgres node, as root)

```bash
WALG_VER=v3.0.3
curl -fsSL -o /tmp/wal-g.tar.gz \
  "https://github.com/wal-g/wal-g/releases/download/${WALG_VER}/wal-g-pg-ubuntu-20.04-amd64.tar.gz"
tar -xzf /tmp/wal-g.tar.gz -C /usr/local/bin && mv /usr/local/bin/wal-g-pg-* /usr/local/bin/wal-g
chmod +x /usr/local/bin/wal-g && wal-g --version
```

## 2. Credentials (`/etc/wal-g.d/env`, chmod 600, owned by postgres)

```bash
# Reuse the platform's Wasabi creds, but a SEPARATE bucket/prefix from app files.
WALG_S3_PREFIX=s3://aligned-pg-backups/prod
AWS_ACCESS_KEY_ID=<WASABI_ACCESS_KEY_ID>
AWS_SECRET_ACCESS_KEY=<WASABI_SECRET_ACCESS_KEY>
AWS_ENDPOINT=https://s3.<region>.wasabisys.com
AWS_S3_FORCE_PATH_STYLE=true
AWS_REGION=<region>
WALG_COMPRESSION_METHOD=brotli
WALG_DELTA_MAX_STEPS=7           # delta base backups: cheap dailies, weekly full
WALG_RETENTION_FULL=14          # keep ~2 weeks of base backups
```

Make Postgres load it for `archive_command` (systemd drop-in):
```ini
# /etc/systemd/system/postgresql@.service.d/walg.conf
[Service]
EnvironmentFile=/etc/wal-g.d/env
```
(With Patroni, instead put the env on the patroni service and reference it from
`archive_command` — see patroni.yml.)

## 3. Enable archiving (THE one-time restart)

In `postgresql.tuned.conf` (or Patroni params): `archive_mode = on`,
`archive_command = 'wal-g wal-push %p'`, `archive_timeout = 60`.
`archive_mode` only takes effect after a **restart** (≈10 s; do it during a
window, or let Patroni do it on the standby then failover for zero downtime).

## 4. First base backup + verify

```bash
sudo -u postgres bash -c 'set -a; . /etc/wal-g.d/env; set +a; wal-g backup-push "$PGDATA"'
sudo -u postgres bash -c 'set -a; . /etc/wal-g.d/env; set +a; wal-g backup-list'
# Confirm WAL is flowing:
sudo -u postgres psql -c "select last_archived_wal, last_failed_wal, stats_reset from pg_stat_archiver;"
```
`last_failed_wal` must stay NULL. **Alert if it isn't** (see observability/alerts.yml).

## 5. Schedule base backups (cron, on the PRIMARY)

```cron
# daily delta base backup at 03:10, plus retention prune
10 3 * * *  postgres  set -a; . /etc/wal-g.d/env; set +a; wal-g backup-push "$PGDATA" && wal-g delete retain FULL 14 --confirm
```
With Patroni, gate this so it only runs on the leader:
`patronictl list | grep -q "$(hostname).*Leader" && wal-g backup-push …`

## 6. Restore (PITR) — rehearsed by `../scripts/pg-restore-drill.sh`
Concept: `wal-g backup-fetch $PGDATA LATEST` → write a `recovery.signal` +
`restore_command='wal-g wal-fetch %f %p'` + `recovery_target_time='…'` → start
Postgres → it replays WAL to the target instant. The drill script does this into
a throwaway data dir + port so you can prove it WITHOUT touching production.
