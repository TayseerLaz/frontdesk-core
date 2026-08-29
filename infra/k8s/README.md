# Hader on Kubernetes

Converts the platform from its systemd deployment to container + Kubernetes.

**Read this first:** production was never containerised. `docker-compose.yml` is
dev-only infrastructure (Postgres/Redis/pgbouncer/Mailhog) and the Docker prod
stack was deliberately deleted on 2026-06-22 in favour of native systemd. The
only real Dockerfile in the repo is `apps/wa-ingest/Dockerfile`. So this is not
a port of an existing container setup — `infra/k8s/Dockerfile` is new, and
`apps/api`, `apps/worker` and `apps/web` are being containerised here for the
first time. Expect to shake out image bugs before you trust it with traffic.

---

## The five things that will bite you

1. **`--prod=false` on install is load-bearing.** api, worker and wa-ingest have
   no build step — they execute TypeScript at runtime through `tsx`, which is a
   *devDependency*. Prune devDeps and the image builds fine and then dies at
   boot with `tsx: not found`.

2. **Migrations must run `pnpm --filter @platform/db migrate:deploy`**, never a
   bare `prisma migrate deploy`. The package script is
   `prisma migrate deploy && pnpm rls:apply`, and the second half installs
   `prisma/rls.sql` — the row-level-security policies that are the actual
   enforcement layer for tenant isolation. Skip it and you get a database that
   migrates cleanly and serves every tenant's data to every other tenant.

3. **The API cannot run more than one replica today.** Six background ticks
   start in every API process and four take no distributed lock — including the
   Google Calendar sync, which writes into tenants' real calendars. Two replicas
   silently double all of it. `40-api.yaml` pins `replicas: 1` and uses the
   `Recreate` strategy for the same reason. See the comment block in that file
   for how to split the ticks out.

4. **Redis runs `noeviction`, not the `allkeys-lru` from docker-compose.** BullMQ
   keeps job state in ordinary keys; under LRU, Redis silently evicts them when
   memory fills and jobs vanish with no error. This is a real bug in the dev
   compose file that must not be carried over.

5. **`WEB_PUBLIC_URL` must end in `/app`** and web probes must target `/app`, not
   `/`. The portal runs under Next's `basePath: '/app'`; `/` returns 404, and
   the API mints every emailed link off `WEB_PUBLIC_URL`.

---

## Build

```bash
SHA=$(git rev-parse --short HEAD)
REG=ghcr.io/tayseerlaz

docker build -f infra/k8s/Dockerfile --target api    -t $REG/hader-api:$SHA .
docker build -f infra/k8s/Dockerfile --target worker -t $REG/hader-worker:$SHA .
docker build -f infra/k8s/Dockerfile --target web    -t $REG/hader-web:$SHA \
       --build-arg NEXT_PUBLIC_API_URL=https://api.hader.ai .

docker push $REG/hader-api:$SHA && docker push $REG/hader-worker:$SHA && docker push $REG/hader-web:$SHA
```

`NEXT_PUBLIC_API_URL` is inlined at build time, so the web image is
environment-specific. Tag it accordingly; you cannot repoint it with an env var
at runtime.

## Deploy

```bash
cp infra/k8s/base/11-secret.example.yaml infra/k8s/base/11-secret.yaml
$EDITOR infra/k8s/base/11-secret.yaml        # gitignored
kubectl apply -f infra/k8s/base/00-namespace.yaml
kubectl apply -f infra/k8s/base/11-secret.yaml

kubectl apply -k infra/k8s/base

# Migrations first, to completion, before the app pods matter.
kubectl -n hader wait --for=condition=complete job/hader-migrate --timeout=600s
kubectl -n hader logs job/hader-migrate | tail -30      # confirm rls:apply ran

kubectl -n hader rollout status deploy/hader-api
kubectl -n hader rollout status deploy/hader-web
```

Jobs are immutable — re-applying an unchanged `hader-migrate` fails with
"field is immutable". Suffix the name per release or use
`kubectl replace --force -f`.

## Verify before pointing DNS

```bash
kubectl -n hader port-forward svc/hader-api 4000:4000 &
curl -fsS localhost:4000/health          # {"status":"ok"}
curl -fsS localhost:4000/health/ready    # 200 only if Postgres AND Redis answer
```

Then the one that actually matters — tenant isolation is enforced by Postgres
RLS, and a migration job that half-ran will not tell you it failed:

```bash
kubectl -n hader exec -it sts/hader-postgres -- psql -U aligned -d aligned -c \
  "select tablename, rowsecurity from pg_tables
   where schemaname='public' and rowsecurity=false;"
```

Any tenant-scoped table appearing in that output is a data-leak bug. Expect only
HQ-level tables (e.g. `eval_runs`) to legitimately lack RLS.

## Not included

- **`43-wa-ingest.yaml` is written but excluded from `kustomization.yaml`.** It
  binds `127.0.0.1` in source, which is unreachable from a Service, and that
  bind is a security control (its `/v1/status` hands out WhatsApp
  device-linking QR codes). Moving it to `0.0.0.0` requires the NetworkPolicy in
  that file as the replacement control. Applying it is also what arms the
  sales-scan capture path.
- **The hader.ai marketing site.** It is not in this repo — it was edited in
  place on the old server under `/opt/aligned/hader-ai-website` and has no git
  history anywhere. `hader.ai/` has no backend in these manifests until those
  files are recovered or rebuilt. The legal pages it served (`/privacy`,
  `/terms`, `/data-deletion`, `/refund-policy`) are referenced by Meta app
  review.
- **The voice bot** (separate Aseer-time repo, ran on its own box).
