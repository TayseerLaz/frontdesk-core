# Provisioning the HA VMs (DediStart / Redcluster)

You're on **DediStart** (Redcluster LTD), VMware-based VPS. The current box is a
VM with a **private NIC on `172.16.16.0/24`** (`ens33 = 172.16.16.32`), public
`91.92.108.178` NAT'd to it. That private LAN is what makes HA cheap and safe —
order the new VMs onto the **same VLAN** and all replication/cluster traffic
stays private.

There's no cloud API here, so provisioning = **order through the DediStart panel
or a support ticket.** Below is exactly what to order and what to ask for.

## 1. What to order

To reach **9.0** (no SPOF + zero-downtime deploys) order **3 VMs**:

| New VM | Role | Spec | OS |
|---|---|---|---|
| `vm-db-1` | Postgres primary | **8 vCPU / 32 GB / 200 GB SSD-NVMe** | Ubuntu 22.04 LTS |
| `vm-db-2` | Postgres standby | **8 vCPU / 32 GB / 200 GB SSD-NVMe** | Ubuntu 22.04 LTS |
| `vm-app-2` | api+worker+web #2 | **4 vCPU / 16 GB / 40 GB** | Ubuntu 22.04 LTS |

(Your current box becomes `vm-app-1`.) To reach only **8.5** first — DB
auto-failover, app still single — order just the two DB VMs and add `vm-app-2`
later. etcd/Sentinel quorum is 3 nodes = app-1 + db-1 + db-2, so **no separate
witness VM is needed.**

> Match Ubuntu 22.04 + Postgres 16 to the current box so configs line up.

## 2. What to explicitly REQUEST from DediStart (this is the important bit)

1. **Same private VLAN / L2 segment as the existing VM** (`172.16.16.0/24`), with
   a private IP on each new VM (e.g. `172.16.16.40/41/42`). Confirm the new VMs
   can reach `172.16.16.32` privately. *This is the single most important ask* —
   without it you'd be replicating Postgres over the public internet (slow + a
   security problem).
2. **Same datacenter / low-latency** between the VMs (sync replication wants
   <2 ms). DediStart VMs in one location are fine.
3. Public IP (or NAT port-forward) on `vm-app-2` only (it serves web/api traffic).
   The DB VMs need **no public IP** — private-only is safer.
4. Daily VM snapshots if they offer them (cheap extra safety net, independent of
   PITR).

If DediStart **cannot** put them on one VLAN, fall back to a **WireGuard overlay**:
install WireGuard on all four VMs, give each a `10.8.0.x` address, and use those
as the `<VM_*_IP>` values everywhere in this blueprint. (Ask me and I'll generate
the WireGuard configs.)

## 3. The moment the VMs exist — bootstrap order

Record the private IPs, then follow [README.md](README.md) §3. Concretely:

```
# on EVERY new VM (base):
apt update && apt install -y postgresql-16 postgresql-client-16   # db nodes
# app node: install Node 20, pnpm 9.12, clone repo to /opt/aligned/app, copy .env.production

# DB nodes (vm-db-1, vm-db-2):
1. install WAL-G + /etc/wal-g.d/env            → postgres/walg.README.md
2. install patroni + etcd (3-node)             → postgres/patroni.yml  (unique name per node)
3. patroni bootstraps PG with the tuned params; vm-db-2 auto-clones from Wasabi/primary
4. install HAProxy (on app nodes)              → postgres/haproxy.cfg  (points PgBouncer at the leader)
5. first base backup + verify archiver         → postgres/walg.README.md §4
6. RESTORE DRILL before trusting it            → ../scripts/pg-restore-drill.sh

# Cutover the app to the new DB:
7. point DATABASE_URL / PgBouncer at the HAProxy :5432 (leader) instead of localhost
8. one short window: dump current 31 MB DB → restore into the new cluster, OR
   set up the new cluster AS a standby of the current box, let it catch up, then
   promote (near-zero-downtime cutover — ask me for the exact steps).

# App HA (vm-app-2):
9. install infra/systemd units on both app nodes; Redis primary(app-1)/replica(app-2)+Sentinel → redis/
10. Caddy load-balances both app nodes        → caddy/Caddyfile.ha
```

## 4. Why not managed Postgres here?
DediStart is a bare-VPS host — no managed DB offering. Using a managed Postgres
from another vendor would add cross-provider latency + egress cost + a second
bill. Since you already have a private LAN, **self-hosted Patroni on DediStart
VMs is the coherent choice** — which is exactly what this blueprint provides.

## 5. Rough cost framing
3 VMs at these specs on a budget VPS host like DediStart is typically a low-
hundreds-of-€/month line item — trivial against an enterprise contract, and the
thing their security review will explicitly require. Get a quote for the 3 specs
above on the same VLAN.
```
