# platform-wa-ingest — Sales Scan capture service.
#
# Runs on the AlignDesk box (CAPTURE_HOST), fully isolated from the qr_whatsapp
# container that shares that machine. See ./README.md for topology + bootstrap and
# ./docker-compose.yml for the runtime contract.
#
# ── Why this image looks the way it does ──────────────────────────────────────────
#
# 1. node:20-bookworm-slim, NOT alpine. Verified against the resolved dep graph rather
#    than assumed:
#      · libsignal (github:WhiskeySockets/libsignal-node) ships NO binding.gyp — it is
#        pure JS, so there is no node-gyp/python3/build-essential requirement.
#      · sharp and jimp are OPTIONAL peerDependencies of Baileys and are NOT in the
#        lockfile graph for this app (`auto-install-peers` skips optional peers), so the
#        usual musl/sharp breakage never arises — but glibc costs us nothing and this
#        service must not be the thing that surprises us on a live box.
#      · Both `github:` dependencies resolve to codeload tarballs in pnpm-lock.yaml
#        (`resolution: {tarball: https://codeload.github.com/...}`), so pnpm does NOT
#        need a `git` binary here.
#    Net result: zero apt layers.
#
# 2. No compile step. The service runs `tsx --conditions=source src/index.ts`, exactly as
#    platform-api and platform-worker run in production. @platform/shared therefore resolves
#    to its TypeScript source and there is no gitignored `dist` in the image that could go
#    stale (the 2026-06-22 stale-dist footgun that shipped old Zod schemas).
#
# 3. devDependencies are REQUIRED at runtime, because `tsx` is a devDependency. Hence
#    `--prod=false`, and NODE_ENV is set only AFTER the install layer — setting it before
#    makes pnpm prune devDeps and the container dies with "tsx: not found", the same trap
#    infra/scripts/redeploy.sh documents at length.

ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE}

# Keep in sync with the root package.json "packageManager" field. Installed via npm rather
# than corepack: corepack shipped in older Node 20 patches fails signature verification on
# newer pnpm releases, and a deploy is a bad place to discover that.
ARG PNPM_VERSION=9.12.0
RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force

WORKDIR /repo

# ── install layer ────────────────────────────────────────────────────────────────────
# Copy EVERY workspace manifest, sources of none. Two reasons:
#   · `--frozen-lockfile` validates the lockfile against the whole discovered workspace.
#     A package that pnpm-lock.yaml lists as an importer but that is missing on disk fails
#     that check, so a partial manifest set breaks the build with a confusing error.
#   · Manifests change rarely, so this layer (the slow one) stays cached across code edits.
#
# ⚠ ADDING A WORKSPACE PACKAGE? Add its package.json below, or this build fails with
#   "Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date".
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json     packages/db/
COPY apps/api/package.json        apps/api/
COPY apps/e2e/package.json        apps/e2e/
COPY apps/web/package.json        apps/web/
COPY apps/worker/package.json     apps/worker/
COPY apps/wa-ingest/package.json  apps/wa-ingest/

# `<pkg>...` = the package plus its dependencies, so apps/api, apps/web, apps/worker and
# packages/db are never installed here. This image has no Prisma client and no reason to
# grow one: the capture service talks to Postgres only through the the platform API.
RUN pnpm install --frozen-lockfile --prod=false --filter @platform/wa-ingest...

# ── source layer ─────────────────────────────────────────────────────────────────────
# Copy only what runs. Deliberately NOT `COPY apps/wa-ingest apps/wa-ingest`: if anyone
# has ever run this service natively, apps/wa-ingest/data/ holds live Baileys credentials,
# and that path is in neither .gitignore nor .dockerignore today. Baking a tenant's
# WhatsApp credentials into an image layer is precisely the leak the purge path exists to
# prevent, so the copy list is explicit instead of a directory sweep.
COPY packages/config packages/config
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY apps/wa-ingest/tsconfig.json apps/wa-ingest/
COPY apps/wa-ingest/src apps/wa-ingest/src

# ── runtime ──────────────────────────────────────────────────────────────────────────
ENV NODE_ENV=production \
    WA_INGEST_DATA_DIR=/data

# /data is the ONLY writable path the service needs: env.ts mkdirs it at import time and
# auth-store.ts puts one Baileys credential directory per grant under /data/auth/<grantId>.
# Created owned by `node` so the named volume inherits that ownership when Docker first
# initialises it, which is what lets the service run unprivileged.
RUN mkdir -p /data && chown -R node:node /data

USER node
WORKDIR /repo/apps/wa-ingest

# Informational only — docker-compose.yml uses host networking, where EXPOSE is ignored.
EXPOSE 4200

# Exec form, paired with `init: true` in compose so tini is PID 1. SIGTERM must reach the
# app: its handler calls pool.stopAll() before exiting, and a graceful socket close matters
# here — abruptly killed Baileys sockets look like a flapping client to WhatsApp, which is
# the signal we are most trying not to send from a shared datacenter IP.
#
# Invoked through the pnpm bin shim rather than `pnpm start` so no package-manager process
# sits between tini and tsx; the argv is otherwise identical to the "start" script.
CMD ["./node_modules/.bin/tsx", "--conditions=source", "src/index.ts"]
