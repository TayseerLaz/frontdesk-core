# syntax=docker/dockerfile:1.7
#
# One Dockerfile, three targets: api, worker, web.
# (wa-ingest keeps its own Dockerfile at apps/wa-ingest/Dockerfile — it is
# already current and tuned for Baileys/libsignal. Do not duplicate it here.)
#
#   docker build -f infra/k8s/Dockerfile --target api    -t platform/api:$SHA .
#   docker build -f infra/k8s/Dockerfile --target worker -t platform/worker:$SHA .
#   docker build -f infra/k8s/Dockerfile --target web    -t platform/web:$SHA \
#          --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .
#
# Base is bookworm-slim (glibc), NOT alpine: sharp and libsignal ship glibc
# prebuilds, and the musl path has burned this project before.
ARG NODE_IMAGE=node:20-bookworm-slim

########################################################################
# deps — a single workspace install shared by every target.
########################################################################
FROM ${NODE_IMAGE} AS deps
ENV PNPM_VERSION=9.12.0
# Installed via npm, deliberately NOT corepack: corepack on older Node 20
# patch releases fails signature verification (same reasoning as the
# wa-ingest Dockerfile, which pins the identical version).
RUN npm i -g pnpm@${PNPM_VERSION}
WORKDIR /app

# .dockerignore already excludes node_modules, dist, .next and .env, so the
# context stays small enough that a single COPY is the right trade-off
# against enumerating nine package.json paths by hand.
COPY . .

# --prod=false is LOAD-BEARING, not a convenience.
# api, worker and wa-ingest have NO build step — they execute TypeScript
# directly via `tsx --conditions=source`, and tsx is a devDependency. Prune
# devDeps and you get an image that builds cleanly and then dies at boot with
# "tsx: not found". This is the same trap redeploy.sh guards against on the
# systemd host.
RUN pnpm install --frozen-lockfile --prod=false \
 && pnpm --filter @platform/db exec prisma generate

########################################################################
# packages — compiled dist for @platform/db + @platform/shared.
#
# api and worker do NOT consume these: the `source` export condition resolves
# those packages to their .ts sources at runtime, which is the whole point of
# `--conditions=source`. Only `next build` needs the emitted dist.
########################################################################
FROM deps AS packages
RUN pnpm --filter @platform/db build \
 && pnpm --filter @platform/shared build

########################################################################
# api
########################################################################
FROM deps AS api
# ffmpeg is required, not optional: the WhatsApp ingest path transcodes
# OGG/Opus voice notes to MP3 and measures their duration from ffmpeg's
# stderr. The bundled ffmpeg-static fallback "frequently fails silently" on
# glibc, so install the real one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/apps/api
# Files are root-owned but world-readable, and nothing in the app writes
# inside /app (uploads stream to Wasabi in memory), so `USER node` needs no
# chown -R over a very large pnpm store. tsx's transpile cache goes to
# $TMPDIR — mount an emptyDir at /tmp if you set readOnlyRootFilesystem.
USER node
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
# `pnpm start`, never a bare `tsx src/server.ts` — the package script is what
# carries --conditions=source. Dropping it reintroduces the stale-dist bug.
CMD ["pnpm", "start"]

########################################################################
# worker
########################################################################
FROM deps AS worker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/apps/worker
USER node
ENV NODE_ENV=production WORKER_METRICS_PORT=9100
EXPOSE 9100
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]

########################################################################
# web
########################################################################
FROM packages AS web-build
# NEXT_PUBLIC_* is inlined at BUILD time, not read at runtime. Getting this
# wrong produces a portal that silently calls http://localhost:4000 from the
# browser. It must be a build arg, and the image is therefore environment-
# specific — tag it accordingly.
ARG NEXT_PUBLIC_API_URL=https://api.example.com
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NODE_ENV=production
# next.config.ts does NOT set output:'standalone', so .next alone is not
# runnable — the full node_modules has to come along. Bounded heap because
# this build has OOM'd the old box repeatedly.
RUN NODE_OPTIONS="--max-old-space-size=2048" pnpm --filter @platform/web build

FROM web-build AS web
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/apps/web
USER node
ENV NODE_ENV=production
# The portal is served under basePath '/app' — the Ingress must route
# /app and /app/* here, and health probes must target /app, not /.
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "start"]
