#!/usr/bin/env bash
# Deploy hader-wa-ingest (Sales Scan capture service) — run ON the AlignDesk box.
#
#   ssh -o KexAlgorithms=curve25519-sha256 -i ~/.ssh/id_ed25519 -p 7777 aladmin@88.80.145.157
#   bash ~/hader-wa-ingest/infra/scripts/deploy-wa-ingest.sh
#
# Pull-based and git-based, same shape as infra/scripts/redeploy.sh: reset the checkout to
# a ref, rebuild, restart, health-check, and auto-roll-back to the last known-good SHA if
# the new build comes up unhealthy. Idempotent — re-running with no upstream change just
# rebuilds (cached) and re-verifies.
#
# ⚠ THIS BOX ALSO RUNS SOMEONE ELSE'S PRODUCTION.
#   `qr_whatsapp` (~/qr_whatsapp, 127.0.0.1:4100) is a DIFFERENT product serving a paying
#   customer's live WhatsApp bot. This script never cd's into that directory, never runs a
#   command there, and scopes every docker call to the `hader-wa-ingest` compose project.
#   The only thing it does with qr_whatsapp is a read-only `docker ps` at the end, to prove
#   it is still up.
#
# Differences from redeploy.sh, and why:
#   · No swapfile management — do not reshape a shared box's memory config from here.
#   · No `sudo` — aladmin is in the docker group; nothing here needs root.
#   · No migrations / no dist builds — this service owns no schema and compiles nothing
#     (it runs via tsx from source, so the image build IS the whole build).
#   · An extra pre-flight the Hader box doesn't need: recreating this container DROPS every
#     live Baileys session, so the script refuses to run mid-capture unless told to.
set -euo pipefail

APP_DIR=${APP_DIR:-$HOME/hader-wa-ingest}
DEPLOY_REF=${DEPLOY_REF:-origin/main}
PROJECT=hader-wa-ingest
CONTAINER=hader-wa-ingest
SERVICE=wa-ingest

say()  { printf '%s\n' "$*"; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── Guards: make it hard to point this at the wrong thing ────────────────────────────────
case "$APP_DIR" in
  *qr_whatsapp*)
    die "APP_DIR points inside qr_whatsapp ($APP_DIR). That is a different product's live
    deployment — this script must never operate there. Expected ~/hader-wa-ingest." ;;
  /opt/aligned/app*)
    die "APP_DIR is the HADER box path ($APP_DIR). This script is for the AlignDesk box
    (88.80.145.157); the Hader box uses infra/scripts/redeploy.sh." ;;
esac

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout. First-time setup: see
    apps/wa-ingest/README.md → 'First-time bootstrap'."

COMPOSE_DIR="$APP_DIR/apps/wa-ingest"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || die "no docker-compose.yml in $COMPOSE_DIR —
    wrong checkout, or the ref predates the deploy artifacts."

# Fail before touching git if the secret file is missing: `git reset --hard` leaves the
# untracked .env alone, but there is no point rebuilding toward a container that cannot boot.
[ -f "$COMPOSE_DIR/.env" ] || die "missing $COMPOSE_DIR/.env — copy .env.example, fill
    HADER_API_URL + WA_INGEST_SECRET, chmod 600. See README.md."

command -v docker >/dev/null 2>&1 || die "docker not on PATH"
docker compose version >/dev/null 2>&1 || die "docker compose v2 not available (this file
    uses the v2 'name:' key and 'docker compose' subcommand)"
# Checked explicitly: every health probe below routes through curl, and a missing curl would
# read as "unhealthy" and trigger a pointless auto-rollback of a perfectly good build.
command -v curl >/dev/null 2>&1 || die "curl not on PATH — required for the health check"

# Port the service will bind. Read from .env so a port change stays in one place. Tolerates
# quotes and CRLF (this file gets edited from Windows).
PORT=$(sed -n 's/^[[:space:]]*WA_INGEST_PORT[[:space:]]*=[[:space:]]*//p' "$COMPOSE_DIR/.env" \
        | tail -1 | tr -d '"'"'"'\r[:space:]')
PORT=${PORT:-4200}
HEALTH_URL="http://127.0.0.1:${PORT}/health"

say "▶ Deploying hader-wa-ingest"
say "  host      : $(hostname) ($(id -un))"
say "  checkout  : $APP_DIR"
say "  ref       : $DEPLOY_REF"
say "  health    : $HEALTH_URL"

# ── Pre-flight: is a tenant mid-capture right now? ───────────────────────────────────────
# `up -d --build` recreates the container, which tears down every live Baileys socket. The
# sessions DO come back (credentials persist in the volume and reconcileOnBoot restarts the
# authorised ones), but a reconnect burst from a shared datacenter IP is the single ban
# signal this service is most exposed to. So: never do it by accident during a live window.
health_json() { curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true; }
parse_active() { sed -n 's/.*"active"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p'; }

BEFORE=$(health_json)
if [ -n "$BEFORE" ]; then
  ACTIVE=$(printf '%s' "$BEFORE" | parse_active)
  ACTIVE=${ACTIVE:-0}
  say "  current   : up, ${ACTIVE} active session(s)"
  if [ "$ACTIVE" != "0" ] && [ "${ALLOW_ACTIVE_SESSIONS:-0}" != "1" ]; then
    die "REFUSING: ${ACTIVE} capture session(s) are live. Recreating the container drops
    them and forces a reconnect burst from this box's shared IP.
    Wait for the window(s) to end, or if this deploy is the fix for a live problem:
      ALLOW_ACTIVE_SESSIONS=1 bash $0"
  fi
else
  say "  current   : not responding (first deploy, or currently down)"
fi

# ── Pre-flight: port ownership ───────────────────────────────────────────────────────────
# Host networking means a port clash is a crash loop rather than a clear error, and 4000 /
# 4001 / 4100 on this box belong to zeed / zeed-mohamad / qr_whatsapp.
if command -v ss >/dev/null 2>&1; then
  if ss -H -ltn "sport = :${PORT}" 2>/dev/null | grep -q .; then
    if [ -z "$(docker ps -q --filter "name=^${CONTAINER}$")" ]; then
      die "port ${PORT} is already listening and it is NOT our container. Something else on
    this box owns it — do not steal it. Pick a free port (WA_INGEST_PORT in
    apps/wa-ingest/.env) and update the reverse-tunnel unit to match."
    fi
  fi
fi

cd "$APP_DIR"

# ── Update the checkout ──────────────────────────────────────────────────────────────────
# LAST is the last SHA that deployed AND passed its health check, not the previous HEAD, so
# an aborted earlier run cannot leave us diffing from a broken baseline (the reason
# redeploy.sh keeps this file too).
LAST=$(cat .last-deployed-sha 2>/dev/null || true)
say "▶ Fetching ${DEPLOY_REF}…"
git fetch origin --quiet
git reset --hard "$DEPLOY_REF" --quiet
NEW=$(git rev-parse HEAD)
say "  ${LAST:-<unknown>} → $NEW"
if [ -n "$LAST" ] && [ "$LAST" = "$NEW" ]; then
  say "  (no upstream change — rebuilding and re-verifying anyway; this is idempotent)"
fi

# ── Build + start ────────────────────────────────────────────────────────────────────────
# -p pins the project name even on a compose that ignores the file's `name:` key, so this
# can never adopt or recreate containers belonging to another project on this box.
say "▶ Building + starting (project: ${PROJECT})…"
cd "$COMPOSE_DIR"
docker compose -p "$PROJECT" up -d --build

# ── Health check ─────────────────────────────────────────────────────────────────────────
# tsx cold-starts in ~10-20s and boot reconciliation runs after listen(), so poll rather
# than probing once.
say "▶ Health check (waiting for cold start)…"
HEALTHY=0
for i in $(seq 1 20); do
  BODY=$(health_json)
  if [ -n "$BODY" ]; then
    HEALTHY=1
    say "  ✓ $HEALTH_URL OK after ~$(( i * 3 ))s"
    say "    $BODY"
    break
  fi
  sleep 3
done

if [ "$HEALTHY" != 1 ]; then
  say "  ✗ HEALTH CHECK FAILED after ~60s"
  say "▶ Last 40 log lines:"
  docker compose -p "$PROJECT" logs --tail 40 "$SERVICE" 2>&1 || true

  # ── Auto-rollback ──────────────────────────────────────────────────────────────────────
  # Safe here in a way it is not everywhere: this service owns no schema, so rolling the
  # code back has no migration to reconcile, and the Baileys credentials live in the volume
  # rather than the image, so a rollback does not cost anyone a re-scan.
  if [ -n "${LAST:-}" ] && [ "$LAST" != "$NEW" ] && [ "${NO_AUTO_ROLLBACK:-0}" != 1 ]; then
    say "  ↩ AUTO-ROLLBACK → $LAST (set NO_AUTO_ROLLBACK=1 to disable)"
    cd "$APP_DIR"
    git reset --hard "$LAST" --quiet
    cd "$COMPOSE_DIR"
    docker compose -p "$PROJECT" up -d --build
    for i in $(seq 1 20); do
      if [ -n "$(health_json)" ]; then
        say "  ✓ rolled back to $LAST and healthy. Investigate $NEW before redeploying."
        say "    (.last-deployed-sha left at $LAST)"
        exit 1   # non-zero: the deploy we intended did NOT succeed
      fi
      sleep 3
    done
    die "✗ ROLLBACK ALSO UNHEALTHY — manual intervention required:
    docker compose -p $PROJECT logs --tail 200 $SERVICE"
  fi
  die "no known-good baseline to roll back to — investigate:
    docker compose -p $PROJECT logs --tail 200 $SERVICE"
fi

# ── Report ───────────────────────────────────────────────────────────────────────────────
say "▶ Container:"
docker compose -p "$PROJECT" ps

# Dangling images from OUR builds only. The label filter is what keeps this from touching
# images belonging to qr_whatsapp / zeed / zeed-mohamad.
docker image prune -f --filter "label=com.docker.compose.project=${PROJECT}" >/dev/null 2>&1 || true

# Read-only reassurance that the neighbour is untouched. We never operate on it.
say "▶ Neighbour check (must still be Up — we never touch it):"
docker ps --filter "name=qr_whatsapp" --format '  qr_whatsapp: {{.Status}}' 2>/dev/null \
  || say "  (could not query — check manually)"

echo "$NEW" > "$APP_DIR/.last-deployed-sha"
say "✓ Deploy complete: $NEW"
say ""
say "Reminder: Hader reaches this service through the reverse SSH tunnel. If /connect on the"
say "portal reports the ingest unreachable, check the tunnel, not this container:"
say "  systemctl status hader-wa-ingest-tunnel"
