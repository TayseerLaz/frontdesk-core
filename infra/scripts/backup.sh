#!/usr/bin/env bash
# Daily Postgres backup → Wasabi, encrypted with age.
#
# Runs every morning via cron. Emits a success/failure ping to an optional
# healthchecks.io-style URL so on-call can notice when it stops running
# (silent failures are the nightmare — a backup that never runs looks the
# same as one that completes).
#
# Crontab on the prod host:
#   5 3 * * * /srv/aligned/infra/scripts/backup.sh >> /var/log/aligned-backup.log 2>&1
#
# Required env vars (load via /etc/aligned/backup.env):
#   POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB POSTGRES_HOST
#   WASABI_BUCKET WASABI_ENDPOINT WASABI_ACCESS_KEY_ID WASABI_SECRET_ACCESS_KEY
#   AGE_RECIPIENT            # e.g. "age1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# Optional:
#   HEALTHCHECK_URL          # GET on success, /fail on failure
#   RETENTION_DAYS           # default 30
set -euo pipefail

if [[ -f /etc/aligned/backup.env ]]; then
  # shellcheck disable=SC1091
  source /etc/aligned/backup.env
fi

: "${POSTGRES_DB:?required}"
: "${POSTGRES_USER:?required}"
: "${POSTGRES_PASSWORD:?required}"
: "${POSTGRES_HOST:=localhost}"
: "${WASABI_BUCKET:?required}"
: "${WASABI_ENDPOINT:?required}"
: "${AGE_RECIPIENT:?required}"
: "${RETENTION_DAYS:=30}"

log() { echo "[backup $(date -u +%FT%TZ)] $*"; }
ping_ok()   { [[ -n "${HEALTHCHECK_URL:-}" ]] && curl -fsS -m 10 "$HEALTHCHECK_URL" >/dev/null 2>&1 || true; }
ping_fail() { [[ -n "${HEALTHCHECK_URL:-}" ]] && curl -fsS -m 10 "$HEALTHCHECK_URL/fail" >/dev/null 2>&1 || true; }

trap 'rc=$?; if [[ $rc -ne 0 ]]; then log "FAILED (rc=$rc)"; ping_fail; fi' EXIT

STAMP=$(date -u +"%Y%m%dT%H%M%SZ")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' INT TERM
# (Note: the EXIT trap above already handles cleanup + failure ping.)

DUMP="$TMP/aligned-$STAMP.dump"
ENCRYPTED="$TMP/aligned-$STAMP.dump.age"

log "dumping $POSTGRES_DB from $POSTGRES_HOST…"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  --host="$POSTGRES_HOST" --username="$POSTGRES_USER" \
  --format=custom --no-owner --no-privileges \
  --file="$DUMP" \
  "$POSTGRES_DB"

# Integrity check before we ship it off — `pg_restore --list` parses the
# custom-format table of contents. If pg_dump produced a corrupt file this
# fails loudly, and we abort before overwriting a good remote backup.
log "verifying dump integrity…"
pg_restore --list "$DUMP" >/dev/null

DUMP_SIZE=$(stat -c%s "$DUMP" 2>/dev/null || stat -f%z "$DUMP")
log "dump OK ($DUMP_SIZE bytes)."

log "encrypting with age → $AGE_RECIPIENT…"
age --encrypt --recipient "$AGE_RECIPIENT" --output "$ENCRYPTED" "$DUMP"

log "uploading to s3://$WASABI_BUCKET/backups/aligned/…"
AWS_ACCESS_KEY_ID="$WASABI_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$WASABI_SECRET_ACCESS_KEY" \
aws --endpoint-url "$WASABI_ENDPOINT" s3 cp "$ENCRYPTED" \
  "s3://$WASABI_BUCKET/backups/aligned/$(basename "$ENCRYPTED")"

# Prune old backups. Portable date-N-days-ago (GNU + BSD).
if date -u -d "$RETENTION_DAYS days ago" +"%Y%m%d" >/dev/null 2>&1; then
  CUTOFF=$(date -u -d "$RETENTION_DAYS days ago" +"%Y%m%d")
else
  CUTOFF=$(date -u -v-"${RETENTION_DAYS}"d +"%Y%m%d")
fi
log "pruning backups older than $CUTOFF…"

# Earlier version had `grep … || true | while …` which binds as
# `grep … || (true | while …)` — grep success skipped the loop entirely.
# Using a subshell + filter-then-loop here avoids the precedence gotcha.
mapfile -t KEYS < <(
  AWS_ACCESS_KEY_ID="$WASABI_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$WASABI_SECRET_ACCESS_KEY" \
  aws --endpoint-url "$WASABI_ENDPOINT" s3 ls "s3://$WASABI_BUCKET/backups/aligned/" \
    | awk '{print $4}' \
    | grep -E '^aligned-[0-9]{8}T.*\.age$' || true
)

for key in "${KEYS[@]}"; do
  [[ -z "$key" ]] && continue
  key_date=$(echo "$key" | sed -E 's/^aligned-([0-9]{8})T.*/\1/')
  if [[ -n "$key_date" && "$key_date" < "$CUTOFF" ]]; then
    log "  removing $key"
    AWS_ACCESS_KEY_ID="$WASABI_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$WASABI_SECRET_ACCESS_KEY" \
    aws --endpoint-url "$WASABI_ENDPOINT" s3 rm \
      "s3://$WASABI_BUCKET/backups/aligned/$key"
  fi
done

log "done. sending success ping."
ping_ok
