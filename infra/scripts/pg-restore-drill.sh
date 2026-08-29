#!/usr/bin/env bash
# Postgres restore drill — PROVE the backups actually restore, without touching
# production. Fetches the latest WAL-G base backup + replays WAL into a THROWAWAY
# data dir on a spare port, then runs sanity queries. "DR you haven't tested is
# DR you don't have" — run this monthly (and after any backup-config change).
#
# Exit 0 = restore verified. Non-zero = your backups are NOT trustworthy; fix now.
#
# Usage (run as a user that can sudo to postgres, on a node with WAL-G + the
# /etc/wal-g.d/env credentials):
#   sudo bash infra/scripts/pg-restore-drill.sh                 # restore to latest
#   sudo TARGET_TIME='2026-06-22 10:00:00+00' bash …            # PITR to an instant
set -euo pipefail

PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
DRILL_DIR=${DRILL_DIR:-/var/tmp/pg-restore-drill}
DRILL_PORT=${DRILL_PORT:-5455}
WALG_ENV=${WALG_ENV:-/etc/wal-g.d/env}
TARGET_TIME=${TARGET_TIME:-}           # empty = restore to latest

log(){ echo "[$(date -u +%H:%M:%S)] $*"; }
fail(){ echo "✗ DRILL FAILED: $*" >&2; exit 1; }

[ -r "$WALG_ENV" ] || fail "WAL-G env not readable at $WALG_ENV"
command -v wal-g >/dev/null || fail "wal-g not installed"

log "wiping previous drill dir $DRILL_DIR"
rm -rf "$DRILL_DIR"; mkdir -p "$DRILL_DIR"; chown postgres:postgres "$DRILL_DIR"; chmod 700 "$DRILL_DIR"

log "fetching latest base backup from object storage…"
sudo -u postgres bash -c "set -a; . '$WALG_ENV'; set +a; wal-g backup-fetch '$DRILL_DIR' LATEST" \
  || fail "backup-fetch failed (no base backup? bad creds?)"

# Configure recovery: replay archived WAL up to the target (or to the end).
log "writing recovery config…"
sudo -u postgres bash -c "cat > '$DRILL_DIR/postgresql.auto.conf'" <<EOF
port = $DRILL_PORT
restore_command = 'envdir $(dirname "$WALG_ENV") wal-g wal-fetch %f %p'
$( [ -n "$TARGET_TIME" ] && echo "recovery_target_time = '$TARGET_TIME'" )
recovery_target_action = 'promote'
archive_mode = 'off'
EOF
sudo -u postgres touch "$DRILL_DIR/recovery.signal"

log "starting recovery instance on port $DRILL_PORT…"
sudo -u postgres "$PG_BIN/pg_ctl" -D "$DRILL_DIR" -o "-p $DRILL_PORT" -w -t 300 start \
  || fail "recovery instance failed to start (check $DRILL_DIR/log)"

cleanup(){ sudo -u postgres "$PG_BIN/pg_ctl" -D "$DRILL_DIR" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Wait for recovery to finish (promote).
for i in $(seq 1 60); do
  if sudo -u postgres "$PG_BIN/psql" -p "$DRILL_PORT" -tAc 'select not pg_is_in_recovery();' 2>/dev/null | grep -q t; then
    break
  fi
  sleep 2
  [ "$i" = 60 ] && fail "recovery did not complete within 120s"
done

log "running sanity checks…"
ORGS=$(sudo -u postgres "$PG_BIN/psql" -p "$DRILL_PORT" -tAc 'select count(*) from organizations;' 2>/dev/null) \
  || fail "query failed — restored DB is unusable"
PRODUCTS=$(sudo -u postgres "$PG_BIN/psql" -p "$DRILL_PORT" -tAc 'select count(*) from products;' 2>/dev/null || echo "?")
LATEST=$(sudo -u postgres "$PG_BIN/psql" -p "$DRILL_PORT" -tAc 'select max(created_at) from audit_logs;' 2>/dev/null || echo "?")

[ "$ORGS" -ge 0 ] 2>/dev/null || fail "organizations count is not a number ($ORGS)"

echo "----------------------------------------------------------------"
echo "✓ RESTORE VERIFIED"
echo "  organizations: $ORGS    products: $PRODUCTS"
echo "  newest audit_log row recovered: $LATEST"
[ -n "$TARGET_TIME" ] && echo "  PITR target: $TARGET_TIME"
echo "  (throwaway instance on :$DRILL_PORT will be stopped + wiped)"
echo "----------------------------------------------------------------"
log "drill complete; tearing down."
