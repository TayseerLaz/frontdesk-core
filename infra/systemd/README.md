# systemd units (production)

Canonical, version-controlled service definitions for the native (non-Docker)
production deploy on the Platform Cloud Server. Previously these lived only on
the server (hand-created), so a critical deploy detail — that the api/worker
must run with `--conditions=source` — was undocumented and un-versioned.

## Why `pnpm start` (not bare `tsx`)

`apps/api` and `apps/worker` run via `tsx` with **no compile step**, but they
import `@platform/db` and `@platform/shared`. Those packages' `package.json`
`exports` now expose a `source` condition pointing at their `.ts` source, and
each app's `start` script runs `tsx --conditions=source …`. Result: the running
process imports the packages **from source**, never from the gitignored,
easily-stale `dist/`. The ExecStart in these units therefore goes through
`pnpm start` so that flag is always applied.

## Install / update

```
sudo cp infra/systemd/platform-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart platform-api platform-worker platform-web
```

`redeploy.sh` still rebuilds `dist/` as a belt-and-suspenders backstop, but with
`--conditions=source` the runtime no longer depends on it being fresh.
