# platform-wa-ingest — Sales Scan capture service (deploy + operations)

Captures a tenant's own WhatsApp sales messages for the duration of a permission grant, then
destroys the credentials. the platform is the system of record; this service is a **follower** that
re-derives what it is allowed to run from the platform on every sweep.

**What it is not:** it cannot send. There is no `sendText`/`sendMedia` anywhere in
`src/session.ts` and there must never be one — on a tenant's live sales line, read-only is the
single largest ban-risk reducer, and a config flag is too weak a guarantee.

| | |
|---|---|
| Runs on | **AlignDesk**, `CAPTURE_HOST` (SSH port **CAPTURE_SSH_PORT**, user **`CAPTURE_USER`**) |
| Directory | `~/platform-wa-ingest` (a git checkout of this repo) |
| Listens | `127.0.0.1:4200` — loopback only, never published |
| Reached by the platform via | **reverse SSH tunnel** from this box to `PLATFORM_HOST` (see [Networking](#networking)) |
| Talks to the platform at | `https://api.example.com` (outbound, public, HMAC-signed) |
| Deploy | `bash ~/platform-wa-ingest/infra/scripts/deploy-wa-ingest.sh` |
| Session cap | **2** (`WA_INGEST_MAX_SESSIONS`) — a ban-risk control, not a perf knob |

> ### ⚠ This box is shared with someone else's production
> `qr_whatsapp` (`~/qr_whatsapp`, `127.0.0.1:4100`, public at `https://qr.aligndesk.ai`) is a
> **different product** serving a paying customer's live WhatsApp bot. Nothing in this
> deployment touches it: separate directory, separate compose project (`platform-wa-ingest`),
> separate container name, separate volume, separate port.
>
> **Never** run compose for this service from `~/qr_whatsapp`, never add this service to that
> project's file, and never run an unscoped `docker compose down`. Ports already taken on this
> box: **4000** zeed · **4001** zeed-mohamad · **4100** qr_whatsapp.
>
> `fail2ban` bans your IP for ~10 min after ~5 bad SSH attempts, and the symptom flips from
> "Permission denied" to a raw TCP **timeout**. Get the user + key right on the first try.

---

## Networking

the platform runs on a **different box** (`PLATFORM_HOST`) and makes two calls into this service:
`POST /v1/reconcile` (nudge, so a QR appears in seconds instead of on the next sweep) and
`POST /v1/stop` (stop + purge a grant). `/v1/status` exists and returns the **WhatsApp
device-linking QR**; the platform does not currently call it (it uses the Redis QR relay) but it is on
the same listener.

**Chosen: a reverse SSH tunnel initiated from AlignDesk.** The service stays bound to
`127.0.0.1` and is published nowhere:

```
the platform box PLATFORM_HOST                     AlignDesk CAPTURE_HOST
───────────────────────                     ────────────────────────
platform-api / platform-worker
  WA_INGEST_URL=http://127.0.0.1:4200
        │
        └── 127.0.0.1:4200 ══[ ssh -R, systemd: platform-wa-ingest-tunnel ]══► 127.0.0.1:4200
                                                                            platform-wa-ingest

        ◄────────── https://api.example.com (outbound, public internet, HMAC) ──────────
                    grants · status · message batches · heartbeat · purge reports
```

### Why the tunnel and not an nginx vhost with an IP allowlist

- **`/v1/status` hands out WhatsApp linking QR codes.** That is the most abusable secret in this
  feature — a leaked QR links a stranger's device to a tenant's live sales number. HMAC + a
  5-minute skew window protects it, but "two POSTs a day" is not worth putting a QR relay on a
  public interface at all.
- **The nginx on this box fronts a paying customer's live bot.** Editing that config and
  reloading it puts `qr.aligndesk.ai` at risk for our convenience. Small risk, entirely avoidable.
- **No DNS record, no Let's Encrypt cert, no renewal to rot.**
- **The control stays in code.** The `127.0.0.1` bind in `src/index.ts` is the reachability
  control; it cannot be widened by mis-editing an `allow` line. An IP allowlist also quietly
  becomes meaningless the day anything proxies in front of it.
- **Tunnel direction was chosen for fail2ban.** It dials the *the platform* box's sshd, so a flapping
  tunnel can never get anything banned from AlignDesk — the known hazard on this machine.

### What it costs, honestly

- One more stateful moving part that can die. Mitigated by `ExitOnForwardFailure=yes` +
  `ServerAliveInterval=30` + systemd `Restart=always`, and by the fact that a tunnel failure
  looks like plain `ECONNREFUSED` in the platform's logs.
- It grants this box an SSH connection to the the platform box, so the key is restricted to exactly one
  port-forward and nothing else (`restrict,port-forwarding,permitlisten=…,command="/bin/false"`).

### Why a dead tunnel is not a safety problem

**The tunnel is a latency optimisation, not a safety dependency.** Everything that enforces the
permission window travels the *other* direction, over the public HTTPS call the tunnel is not
involved in:

- The ingest fetches authorised grants from `api.example.com` every `WA_INGEST_REAP_INTERVAL_MS`
  (60s) and holds its own copy of each deadline, so windows still expire on time.
- A grant revoked in the portal disappears from `authorised-grants`, and the next sweep ends the
  session as `revoked_upstream` — no inbound call needed.
- If the platform becomes unreachable for `WA_INGEST_HEARTBEAT_FAIL_LIMIT_MS` (10 min), the dead-man
  switch tears every session down. Losing contact with the consent authority revokes authority.
- the platform's own reaper independently terminates the grant in its own DB, so the consent record is
  authoritative regardless.

With the tunnel down, the only user-visible cost is that a QR takes up to ~60s to appear instead
of ~instantly, and a revoke stops capture on the next sweep instead of immediately.

### The one invariant this depends on

The container uses `network_mode: host` **because** `src/index.ts` binds `127.0.0.1`: under
bridge networking Docker's port proxy dials the container's bridge IP, where nothing is
listening, so a bridge setup would require changing the app to bind `0.0.0.0`. Host networking
keeps the reviewed code as-is and avoids `ports:` DNAT rules, which bypass `ufw`.

> **Do not change `host: '127.0.0.1'` in `src/index.ts` to `0.0.0.0`.** With host networking
> there is no port publishing left to constrain it, so that one edit would put the QR endpoint on
> the public internet. If you ever need bridge networking, change both together and re-read this
> section.

---

## First-time bootstrap

Four ordered stages. `WA_INGEST_URL` on the the platform box is set **last**, deliberately: it is the
instant, no-code kill switch — unset it and the tenant UI drops back to "scanning goes live
soon" immediately.

**Setting it is no longer sufficient to arm the tenant UI** (changed 2026-08-05). Availability
is now `isIngestConfigured() && isCaptureLive()`, where liveness is the 60s heartbeat this
service emits *only* while `WA_CAPTURE_ENABLED=true`. Before that change the gate checked that
the vars were *set*, not that anything was running — so production spent six days offering a QR
code while this service sat with capture switched off, and a grant hung in `linking` the whole
time. To go live you must now do both: set the vars on the the platform box **and** enable capture here.

### 1 — AlignDesk: clone the repo

```bash
ssh -o KexAlgorithms=curve25519-sha256 -i ~/.ssh/id_ed25519 -p CAPTURE_SSH_PORT CAPTURE_USER@CAPTURE_HOST

# Read-only deploy key for this private repo (do not reuse the box's personal key).
ssh-keygen -t ed25519 -f ~/.ssh/id_alignbot_deploy -N '' -C 'aligndesk-alignbot-deploy'
cat ~/.ssh/id_alignbot_deploy.pub
#   → add on github.com/TayseerLaz/Alignbot → Settings → Deploy keys → Add (leave write access OFF)

ssh-keyscan github.com >> ~/.ssh/known_hosts

GIT_SSH_COMMAND='ssh -i ~/.ssh/id_alignbot_deploy -o IdentitiesOnly=yes' \
  git clone git@github.com:TayseerLaz/Alignbot.git ~/platform-wa-ingest

# Persist the key for this checkout, or the deploy script's `git fetch` will fail.
cd ~/platform-wa-ingest
git config core.sshCommand 'ssh -i ~/.ssh/id_alignbot_deploy -o IdentitiesOnly=yes'
git fetch origin   # verify
```

### 2 — AlignDesk: the environment file

```bash
cd ~/platform-wa-ingest/apps/wa-ingest
cp .env.example .env && chmod 600 .env

openssl rand -hex 32        # ← the shared secret; keep it, stage 4 needs it on the the platform box
$EDITOR .env                # set WA_INGEST_SECRET=<that value>, PLATFORM_API_URL=https://api.example.com
```

Leave `WA_INGEST_MAX_SESSIONS=2`. Every session on this box shares one datacenter IP
(`qr_whatsapp` already runs `bot1..bot5` here with **no** `BOT_PROXIES` line), and a cluster of
companion links from one address is the ban signal we are most exposed to. Review blocker B13
capped it at 2 until residential proxies exist.

### 3 — The reverse SSH tunnel

**On AlignDesk** — key + known_hosts (`StrictHostKeyChecking=yes` needs it pre-populated):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_platform_tunnel -N '' -C 'platform-wa-ingest-tunnel'
ssh-keyscan -p PLATFORM_SSH_PORT PLATFORM_HOST >> ~/.ssh/known_hosts
cat ~/.ssh/id_platform_tunnel.pub
```

**On the the platform box** (`ssh -p PLATFORM_SSH_PORT platform@PLATFORM_HOST`) — confirm the port is free, then
authorise that key for **one forward and nothing else**:

```bash
ss -ltn | grep ':4200' || echo 'port 4200 free — good'

# Single line. `restrict` disables everything, then port-forwarding is added back and pinned.
cat >> ~/.ssh/authorized_keys <<'EOF'
restrict,port-forwarding,permitlisten="127.0.0.1:4200",command="/bin/false" ssh-ed25519 AAAA…PASTE… platform-wa-ingest-tunnel
EOF
```

**Back on AlignDesk** — the unit:

```bash
sudo tee /etc/systemd/system/platform-wa-ingest-tunnel.service >/dev/null <<'EOF'
[Unit]
Description=Reverse SSH tunnel: expose platform-wa-ingest :4200 on the the platform box loopback
After=network-online.target
Wants=network-online.target
# Never give up: this must come back on its own after a network partition or a the platform reboot.
StartLimitIntervalSec=0

[Service]
User=CAPTURE_USER
ExecStart=/usr/bin/ssh -NT \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes \
  -i /home/CAPTURE_USER/.ssh/id_platform_tunnel \
  -p PLATFORM_SSH_PORT -R 127.0.0.1:4200:127.0.0.1:4200 platform@PLATFORM_HOST
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now platform-wa-ingest-tunnel
systemctl status platform-wa-ingest-tunnel --no-pager
```

`ExitOnForwardFailure=yes` matters: without it, ssh happily holds a connection whose forward was
never established, and the tunnel looks healthy while being useless.

### 4 — Start the service, then point the platform at it

```bash
# On AlignDesk
bash ~/platform-wa-ingest/infra/scripts/deploy-wa-ingest.sh
curl -s http://127.0.0.1:4200/health        # {"ok":true,"active":0,"max":2}
```

```bash
# On the the platform box — verify the tunnel actually carries traffic BEFORE wiring the portal
curl -s http://127.0.0.1:4200/health        # same JSON, through the tunnel

cd /opt/platform/app
$EDITOR .env.production
#   WA_INGEST_URL=http://127.0.0.1:4200
#   WA_INGEST_SECRET=<the same 64-hex value from stage 2>
sudo systemctl restart platform-api platform-worker
```

Then confirm from the ingest logs that the secret matches — `docker logs platform-wa-ingest` must
**not** show `boot: cannot reach the platform` or a 401 from `/authorised-grants`.

---

## Redeploying

```bash
ssh -o KexAlgorithms=curve25519-sha256 -i ~/.ssh/id_ed25519 -p CAPTURE_SSH_PORT CAPTURE_USER@CAPTURE_HOST
bash ~/platform-wa-ingest/infra/scripts/deploy-wa-ingest.sh
```

Resets the checkout to `origin/main`, rebuilds, recreates the container, health-checks, and
auto-rolls-back to `.last-deployed-sha` if the new build is unhealthy. Idempotent.

- `DEPLOY_REF=origin/some-branch` to deploy a branch.
- `NO_AUTO_ROLLBACK=1` to keep a broken build up for debugging.
- **`ALLOW_ACTIVE_SESSIONS=1`** — required to deploy while a capture is live. The script refuses
  by default because recreating the container drops every Baileys socket, and a reconnect burst
  from this box's shared IP is exactly the signal we are trying not to send. Sessions do come
  back on their own (credentials persist in the volume; `reconcileOnBoot()` restarts the
  authorised ones with no new QR scan) — the concern is the burst, not data loss.

The tunnel is independent of the container: a redeploy never touches it.

---

## Rotating `WA_INGEST_SECRET`

The secret is the HMAC key in **both** directions and, on the the platform side, the salt for
`counterpartyHash`. There is no dual-secret/grace window in the code — `verify()` compares
against exactly one value — so rotation is a hard cutover.

**Two consequences to accept before starting:**

1. **Rotate only when `/health` reports `active: 0`.** In-flight signed requests fail during the
   cutover, and a rejected message batch is a batch that may not be retried.
2. **Counterparty hashes change.** The same customer hashes to a different value after rotation,
   so per-counterparty grouping in summaries will not join across the boundary. Historical rows
   are unaffected; they simply belong to the old salt. This is a reason to rotate on a
   credential-exposure event, not on a routine schedule.

```bash
# 1. Confirm nothing is live (and no open grant in the portal)
curl -s http://127.0.0.1:4200/health        # → "active":0

# 2. New secret
openssl rand -hex 32

# 3. the platform box first
cd /opt/platform/app && $EDITOR .env.production      # WA_INGEST_SECRET=<new>
sudo systemctl restart platform-api platform-worker

# 4. AlignDesk — then RECREATE (see the gotcha below)
cd ~/platform-wa-ingest/apps/wa-ingest && $EDITOR .env
docker compose -p platform-wa-ingest up -d --force-recreate

# 5. Verify: no 401s, grants fetch cleanly
docker logs --tail 50 platform-wa-ingest
```

> **Gotcha:** `docker compose restart` does **not** re-read `env_file`. Use `up -d`
> (`--force-recreate` to be certain) or the container keeps running with the old secret while the
> file on disk says otherwise — a confusing 30 minutes.

Between steps 3 and 4 the two sides disagree: the ingest's `authorised-grants` fetch 401s, so it
starts nothing and (after 10 min) the dead-man switch would tear down sessions. Harmless given
step 1, but keep the gap short.

---

## ⚠ Wiping auth is destructive

The named volume `platform-wa-ingest-data` holds **live WhatsApp credentials** — one Baileys auth
directory per grant under `/data/auth/<grantId>`. This is the same hazard as `qr_whatsapp`'s
"Relink (new QR)" button, with the same non-automatable recovery.

Destroying it means:

- Every linked tenant is **unlinked**. Their phone shows the linked device vanish.
- Capture stops silently mid-window.
- Recovery requires the **owner's physical phone** to scan a fresh QR. It cannot be automated,
  and asking a tenant to re-link mid-scan is a poor look for a privacy feature.
- The the platform-side audit disagrees with reality: a manual delete skips `reportPurged()`, so
  `authPurgedAt` is never stamped even though the bytes are gone. `authPurgedAt` is the field a
  DPA question lands on.

**Never** do this to end a window. Revoke from the portal (or `POST /v1/stop`) and let
`pool.drainPurges()` destroy the credentials and report the purge — the designed path is retried
until the bytes are verified gone, and only then tells the platform.

Commands that destroy it — read twice:

```bash
docker compose -p platform-wa-ingest down -v     # ← the -v deletes the volume. Never use it.
docker volume rm platform-wa-ingest-data         # ← unlinks every tenant
docker exec platform-wa-ingest rm -rf /data/auth/<grantId>   # ← unlinks that one tenant
```

A plain `down`/`up`/rebuild is safe: the volume is separate from the container and the image.

---

## Day-2 operations

```bash
# Health + how many sessions are live (unauthenticated, loopback only)
curl -s http://127.0.0.1:4200/health

# Logs. Bodies cannot appear here: src/logger.ts has no parameter that carries text and
# redacts body/text/caption/message defensively. Message lines are metadata + a char COUNT.
docker logs -f --tail 100 platform-wa-ingest
docker compose -p platform-wa-ingest logs --tail 200 wa-ingest

# Tunnel
systemctl status platform-wa-ingest-tunnel --no-pager
journalctl -u platform-wa-ingest-tunnel -n 50 --no-pager

# Is anything still holding credentials? (empty = clean; the DPA-relevant check)
docker exec platform-wa-ingest ls -la /data/auth
```

Signed admin calls, e.g. the status + QR for one grant:

```bash
cd ~/platform-wa-ingest/apps/wa-ingest
SECRET=$(sed -n 's/^[[:space:]]*WA_INGEST_SECRET[[:space:]]*=[[:space:]]*//p' .env | tr -d '"'"'"'\r')
BODY='{"grantId":"00000000-0000-0000-0000-000000000000"}'      # ← real grant id
TS=$(date +%s%3N)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -s -X POST http://127.0.0.1:4200/v1/status \
  -H 'content-type: application/json' \
  -H "x-wa-ingest-timestamp: $TS" -H "x-wa-ingest-signature: sha256=$SIG" \
  -d "$BODY"
# same shape for /v1/stop with {"grantId":"…","reason":"manual"}
```

The signature covers the **exact bytes** of the body, so reuse the same `$BODY` string in `-d` —
do not reformat it.

---

## Invariants — do not regress

These are review conclusions, not preferences:

- **Read-only by construction.** No send path in `session.ts`, ever. Not a config flag.
- **Forward-only history.** `shouldSyncHistoryMessage: () => false` stays. It is what makes the
  consent copy ("7 days") true by construction — the corpus cannot predate consent.
- **`stripPaymentCredentials` is not PII redaction.** It strips payment credentials. Never
  describe the corpus as redacted or anonymised.
- **The raw corpus never leaves the box wholesale.** Cluster locally; only scrubbed cluster
  representatives may be sent to a model.
- **`WA_INGEST_MAX_SESSIONS=2`** until residential proxies exist.
- **`127.0.0.1` bind** — see [the invariant above](#the-one-invariant-this-depends-on).
- **Never operate on `~/qr_whatsapp`.**

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Build: `Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date` | A workspace package was added to the monorepo. Add its `package.json` to the manifest `COPY` list in `Dockerfile` — `--frozen-lockfile` validates the lockfile against the whole workspace. |
| Container restart-loops, `EADDRINUSE` | Port `4200` is taken (host networking). Find the owner (`ss -ltnp \| grep 4200`); do not steal a port from `zeed`/`qr_whatsapp`. Changing `WA_INGEST_PORT` means changing the tunnel unit too. |
| `Refusing to start: PLATFORM_API_URL must be set` | `.env` missing or in the wrong directory. It must be `apps/wa-ingest/.env`, next to `docker-compose.yml`. |
| Ingest logs `boot: cannot reach the platform — starting no sessions` | Secret mismatch (401) or `api.example.com` unreachable. **This is fail-closed and correct** — no consent authority means no capture. Fix the secret, then it self-heals on the next sweep. |
| the platform logs `ingest reconcile nudge failed` / `ECONNREFUSED 127.0.0.1:4200` | Tunnel down. `systemctl status platform-wa-ingest-tunnel`. Capture safety is unaffected (see [why a dead tunnel is not a safety problem](#why-a-dead-tunnel-is-not-a-safety-problem)). |
| Tunnel journal: `remote port forwarding failed for listen port 4200` | A dropped connection left a stale listener on the the platform box. systemd retries every 15s and it clears when the old session times out. If it persists, look for an orphaned `sshd` on the the platform box, or set `ClientAliveInterval` in its `sshd_config`. |
| Env change had no effect | `docker compose restart` does not re-read `env_file`. Use `up -d --force-recreate`. |
| SSH to AlignDesk **times out** (rather than refusing) | `fail2ban` ban after ~5 bad attempts. Wait ~10 min, then use the exact user + key. |
| QR never appears for a tenant | Check `active` vs `max` on `/health` — at the cap of 2, extra grants are **queued** (logged, never silently dropped). Then check `/v1/status` for that grant. |
| Deploy refuses: `REFUSING: N capture session(s) are live` | Working as intended. Wait for the window, or `ALLOW_ACTIVE_SESSIONS=1` if this deploy is the fix for a live problem. |

---

## Known gaps in the surrounding repo

Neither is owned by this directory, both are worth fixing:

1. **`apps/wa-ingest/data/` is in neither `.gitignore` nor `.dockerignore`.** It is only created
   by running the service *natively* (`pnpm start`), and the container writes to the `/data`
   volume instead — but if anyone does run it natively, a `git add .` would commit live WhatsApp
   credentials. The `Dockerfile` already refuses to copy that path for the same reason.
2. **The tunnel unit lives only in this README** (as a heredoc), not in `infra/systemd/` where the
   the platform box's units are kept. Move it there when someone owns that directory next.
