#!/usr/bin/env bash
# Reliable manual deploy for the Platform/the platform server (run ON the server).
#
# Why this exists: the manual SSH deploy used to "git reset + restart" and skip
# rebuilding the workspace packages that api/worker import as COMPILED dist
# (@platform/db, @platform/shared, both gitignored). Skipping that shipped stale
# Zod schemas / Prisma client — a fix would "deploy" but not take effect (the
# 2026-06-12 overnight-hours incident). This script ALWAYS rebuilds those
# packages, regenerates the Prisma client, runs migrations, rebuilds web only
# when web source changed, reinstalls only when the lockfile changed, restarts
# the services, and health-checks. One command, no skippable steps.
#
# Usage:  bash infra/scripts/redeploy.sh
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/platform/app}
API_HEALTH_URL=${API_HEALTH_URL:-https://api.example.com/health}
cd "$APP_DIR"

# Ensure swap exists. `next build` is memory-hungry and has repeatedly OOM'd
# this box (taking the whole server down mid-deploy). A swapfile lets the build
# spill instead of the kernel killing processes. Idempotent: only creates it if
# there's no active swap.
if [ "$(swapon --show --noheadings 2>/dev/null | wc -l)" = "0" ]; then
  echo "▶ No swap found — creating a 4G swapfile…"
  if sudo fallocate -l 4G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 2>/dev/null; then
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null 2>&1 || true
    sudo swapon /swapfile 2>/dev/null || true
    grep -q '^/swapfile' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    echo "  ✓ swap on: $(free -h | awk '/Swap/{print $2}')"
  else
    echo "  ⚠ could not create swap (continuing) — the build may still OOM."
  fi
fi

# Which ref to deploy. Defaults to origin/main (production), but can be
# overridden to deploy a branch, e.g. while shipping the UX redesign:
#   DEPLOY_REF=origin/ux-redesign bash infra/scripts/redeploy.sh
# (Previously this was hardcoded to origin/main, which silently bounced a
# branch checkout back to main — that's the bug this fixes.)
DEPLOY_REF=${DEPLOY_REF:-origin/main}
echo "▶ Fetching ${DEPLOY_REF}…"
# Diff against the last SUCCESSFULLY-deployed SHA, not the pre-reset HEAD. If a
# prior run aborted (e.g. a prisma-generate flake) AFTER git reset but BEFORE
# the web rebuild, HEAD already moved — diffing PREV→NEW would then show no
# changes and wrongly skip the web build. .last-deployed-sha only advances on a
# fully successful run, so this stays correct across aborted runs.
LAST=$(cat .last-deployed-sha 2>/dev/null || true)
git fetch origin --quiet
git reset --hard "$DEPLOY_REF"
NEW=$(git rev-parse HEAD)
echo "  ${LAST:-<unknown>} → $NEW"

# No known-good baseline (or invalid) → rebuild everything to be safe.
if [ -n "$LAST" ] && git cat-file -e "$LAST^{commit}" 2>/dev/null; then
  CHANGED=$(git diff --name-only "$LAST" "$NEW" || true)
else
  CHANGED="apps/web/ pnpm-lock.yaml"
fi

# Load production env (DATABASE_URL/DIRECT_DATABASE_URL for prisma, NEXT_PUBLIC_*
# baked into the web build, SECRET_ENCRYPTION_KEY for the crypto extension).
set -a; . ./.env.production; set +a

# Install when the lockfile changed OR when devDependencies are missing. The
# build + migrate steps need `prisma` (the CLI) and `tsc`, which are BOTH
# devDependencies — and this script sources .env.production, which sets
# NODE_ENV=production, so a plain `pnpm install` (or anything that prunes to
# prod deps out-of-band) strips them and the next deploy dies with
# "tsc: not found" / "prisma not found". `--prod=false` forces devDeps back in.
NEED_INSTALL=0
echo "$CHANGED" | grep -q '^pnpm-lock.yaml$' && NEED_INSTALL=1
# The build/migrate steps need these per-package bins (tsc + prisma). pnpm's
# frozen check can report "up to date" while a package's node_modules/.bin is
# actually missing its symlinks, so check the real bins, not just the lockfile.
[ -x node_modules/.bin/tsc ] || NEED_INSTALL=1
[ -x packages/db/node_modules/.bin/prisma ] || NEED_INSTALL=1
[ -x packages/db/node_modules/.bin/tsc ] || NEED_INSTALL=1
[ -x packages/shared/node_modules/.bin/tsc ] || NEED_INSTALL=1
if [ "$NEED_INSTALL" = 1 ]; then
  echo "▶ Reinstalling dependencies (relink bins, incl. devDeps)…"
  # Why rm only the .bin dirs (NOT the whole node_modules) + plain install:
  #   - The running services (platform-api/worker/web via node/tsx) hold open
  #     file handles inside node_modules/.pnpm, so `rm -rf node_modules` can't
  #     finish ("Directory not empty") and leaves node_modules half-deleted →
  #     tsc/prisma vanish mid-deploy.
  #   - `pnpm install --force` avoids that but re-extracts the whole pnpm store
  #     and a corrupted entry aborts the deploy (ENOENT copyfile).
  #   - The actual failure we need to fix is missing .bin symlinks while pnpm
  #     reports "up to date". Removing just the .bin dirs (services don't hold
  #     those open) and running a plain install relinks them cleanly and
  #     re-fetches anything genuinely missing.
  # CI=1 + confirmModulesPurge=false keep it non-interactive (no Y/n prompt).
  rm -rf node_modules/.bin packages/*/node_modules/.bin apps/*/node_modules/.bin
  CI=1 pnpm install --frozen-lockfile --prod=false --config.confirmModulesPurge=false
fi

echo "▶ Regenerating Prisma client…"
# Retry up to 3× — prisma generate occasionally flakes (transient OOM under
# concurrent load) and `set -e` would otherwise abort the whole deploy.
GEN_OK=0
for attempt in 1 2 3; do
  if pnpm --filter @platform/db exec prisma generate >/dev/null 2>&1; then
    GEN_OK=1
    break
  fi
  echo "  prisma generate flaked (attempt $attempt) — retrying…"
  sleep 3
done
[ "$GEN_OK" = 1 ] || { echo "  ✗ prisma generate failed 3× — aborting"; exit 1; }

echo "▶ Rebuilding workspace packages consumed as dist (ALWAYS, clean)…"
# Wipe dist + the incremental tsbuildinfo first. tsc's incremental cache can go
# stale (e.g. index.js referencing a schema whose .js was never re-emitted),
# which surfaces downstream as a web build error like "Can't resolve
# './schemas/user.js'". A clean emit every deploy is cheap and removes the class
# of bug entirely.
rm -rf packages/db/dist packages/db/tsconfig.tsbuildinfo \
       packages/shared/dist packages/shared/tsconfig.tsbuildinfo
pnpm --filter @platform/db build
pnpm --filter @platform/shared build

echo "▶ Applying migrations…"
pnpm --filter @platform/db exec prisma migrate deploy

WEB_CHANGED=0
if echo "$CHANGED" | grep -q '^apps/web/'; then
  echo "▶ web source changed — rebuilding Next…"
  # Stamp the service worker with this deploy's SHA. `git reset --hard` above
  # restored the __BUILD_ID__ token, so this makes sw.js byte-different every
  # deploy → returning browsers install the new worker, its activate handler
  # purges the old caches, and PwaRegister reloads open tabs onto the fresh
  # build. Without this the SW keeps serving cached chunks and "the deploy
  # didn't land" (the whole point of a PWA cache, working against us here).
  if [ -f apps/web/public/sw.js ]; then
    sed -i "s/__BUILD_ID__/${NEW}/g" apps/web/public/sw.js
    echo "  ✓ stamped sw.js → ${NEW}"
  fi
  # Next 15.5 intermittently fails the final "Collecting build traces" step with
  # ENOENT on a *.nft.json it wrote moments earlier (a concurrency race on this
  # box). The compiled .next is otherwise complete, and a plain retry succeeds —
  # so retry up to 3× on a clean .next before treating the build as failed. We
  # are NOT using `output: standalone`, so traces don't affect `next start`; the
  # retry just gets us a clean exit-0 with the final manifests written.
  web_built=0
  for attempt in 1 2 3; do
    rm -rf apps/web/.next
    # Bound Node's heap so a single build can't balloon and OOM the box (paired
    # with the swapfile above). 2 GB is comfortably enough for this app's build.
    if NODE_OPTIONS="--max-old-space-size=2048" pnpm --filter @platform/web build; then
      web_built=1; break
    fi
    echo "  ⚠ web build attempt $attempt failed — retrying…"
  done
  [ "$web_built" = 1 ] || { echo "✗ web build failed after 3 attempts"; exit 1; }
  WEB_CHANGED=1
else
  echo "▶ web unchanged — skipping web build."
fi

echo "▶ Restarting services…"
sudo systemctl restart platform-api platform-worker
[ "$WEB_CHANGED" = 1 ] && sudo systemctl restart platform-web

echo "▶ Service status:"
systemctl is-active platform-api platform-worker platform-web || true

# Health check with retry — the api runs under tsx and cold-starts in ~10-20s,
# so a single immediate probe gives a false 502. Poll for up to ~60s.
echo "▶ Health check (waiting for cold start)…"
HEALTHY=0
for i in $(seq 1 20); do
  if curl -fsS --max-time 10 "$API_HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=1
    echo "  ✓ $API_HEALTH_URL OK (after ~$(( i * 3 ))s)"
    break
  fi
  sleep 3
done
if [ "$HEALTHY" != 1 ]; then
  echo "  ✗ HEALTH CHECK FAILED after ~60s"
  # ---- Tier 3: automatic rollback to the last known-good SHA ----------------
  # The new code is unhealthy. If we have a known-good baseline that differs,
  # roll the code back and restart so the outage is seconds, not "until someone
  # wakes up". DB migrations are forward-only and (by our convention) additive/
  # backward-compatible, so reverting the CODE is safe; we do NOT auto-revert
  # migrations. If rollback also fails, leave it for a human.
  if [ -n "${LAST:-}" ] && [ "$LAST" != "$NEW" ] && [ "${NO_AUTO_ROLLBACK:-0}" != 1 ]; then
    echo "  ↩ AUTO-ROLLBACK → $LAST (set NO_AUTO_ROLLBACK=1 to disable)"
    git reset --hard "$LAST"
    rm -rf packages/db/dist packages/db/tsconfig.tsbuildinfo \
           packages/shared/dist packages/shared/tsconfig.tsbuildinfo
    pnpm --filter @platform/db exec prisma generate >/dev/null 2>&1 || true
    pnpm --filter @platform/shared build && pnpm --filter @platform/db build
    if echo "${CHANGED:-}" | grep -q '^apps/web/'; then
      rm -rf apps/web/.next
      NODE_OPTIONS="--max-old-space-size=2048" pnpm --filter @platform/web build || true
    fi
    sudo systemctl restart platform-api platform-worker platform-web
    for i in $(seq 1 20); do
      if curl -fsS --max-time 10 "$API_HEALTH_URL" >/dev/null 2>&1; then
        echo "  ✓ rolled back to $LAST and healthy. Investigate $NEW before redeploying."
        echo "    (.last-deployed-sha left at $LAST)"
        exit 1   # still non-zero: the intended deploy did NOT succeed
      fi
      sleep 3
    done
    echo "  ✗✗ ROLLBACK ALSO UNHEALTHY — manual intervention required (journalctl -u platform-api -n 100)"
    exit 2
  fi
  echo "    no known-good baseline to roll back to — investigate (journalctl -u platform-api -n 100)"
  exit 1
fi
# Record the known-good SHA ONLY on full success, so an aborted future run
# (and the auto-rollback above) still diffs against this baseline.
echo "$NEW" > .last-deployed-sha
echo "✓ Deploy complete: $NEW"
