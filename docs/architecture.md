# Architecture

## Node Roles

| Node | Region | Role | DB Role (dynamic via Patroni) |
|------|--------|------|-------------------------------|
| Hetzner 1 | Nuremberg | Nginx LB (primary) + App | Replica or Leader |
| Hetzner 2 | Nuremberg | Nginx LB (standby) + App | Replica or Leader |
| Hetzner 3 | Nuremberg | App | Replica or Leader |

All three nodes run an identical PostgreSQL + Patroni stack. There is no statically configured "master" — **Patroni elects the leader dynamically** via etcd consensus, and any node can hold that role at any time. The dashboard always queries `/api/patroni` to find the current leader rather than relying on static config.

## Network Topology

```
Internet
   │
   ▼
Floating IP 116.203.166.135  ──┐
   │                            │ keepalived VRRP heartbeat
   ▼                            │ (reassigns Floating IP on failure)
Nginx LB (Hetzner 1) ◄──────────┘
   │
   ├──weight=2──→ App :8080 (Hetzner 1, local)
   ├──weight=1──→ App :8080 (Hetzner 2, via Tailscale)
   └──weight=1──→ App :8080 (Hetzner 3, via Tailscale)
```

All inter-node traffic (replication, SSH provisioning, Patroni/etcd, quorum socket checks) travels over a Tailscale WireGuard mesh. No node is reachable from the public internet except Hetzner 1/2 on ports 22, 80, 443, 8090.

## Load Balancer Failover (Floating IP + keepalived)

```
Hetzner 1 (MASTER, priority 110) ──┐
                                     │ VRRP advertisements every 1s
Hetzner 2 (BACKUP, priority 100) ◄──┘
```

- `vrrp_script chk_nginx` checks `systemctl is-active nginx` every 2s; failure drops priority by 20
- On Hetzner 1 losing MASTER state: `notify_backup`/`notify_fault` → releases the Floating IP locally and calls the Hetzner Cloud API to reassign it to Hetzner 2
- On Hetzner 1 recovering: `notify_master` → reclaims the Floating IP back
- Observed failover time: ~5 seconds

## Database Failover (Patroni + etcd)

```
etcd cluster (3 nodes, Raft consensus)
       │
       ▼
Patroni (1 per node) — watches etcd lease (ttl=30s, loop_wait=10s)
       │
       ▼
Exactly one node holds the lease → PostgreSQL primary
Lease lost (node dies) → remaining nodes race to acquire it → new primary
```

- `pg_hba.conf` on **every** node pre-authorizes the Tailscale subnet (`100.0.0.0/8`) for replication — this is required because leadership can move to any node at any time; whichever node becomes primary must already accept replica connections from the others
- Observed election time: ~15–25 seconds
- Replicas resume streaming from the new primary automatically — no manual `pg_basebackup` required

## C++ Application

- 8-thread pool, persistent PostgreSQL connection with auto-reconnect on `broken_connection`
- `/health` performs a **fresh** local connection probe (not the cached pool connection) with `connect_timeout=3` — this is what allows Nginx to detect a DB-down node via `503` rather than relying solely on TCP reachability
- Graceful SIGTERM shutdown; `systemd` `Restart=on-failure`, `RestartSec=2`

## Outpost — Distributed Quorum Verification

Extends Naim et al. (2025)'s Double Check Method by running the socket-check stage from every cluster node independently rather than a single fog device:

```
Heartbeat fails
   │
   ▼
Time Check (4s debounce + retry) — filters transient blips
   │  still failing
   ▼
Quorum Socket Check — every node opens its own TCP socket to the target
   │
   ├── all nodes reach it     → DEGRADED (app-layer issue, network confirmed fine)
   ├── no nodes reach it      → DOWN (confirmed outage, high confidence)
   └── split result           → re-check once with doubled debounce, then majority vote
                                  (flagged low-confidence)
```

## Management Proxy

Node.js/Express API (`proxy/`), modularized as:
- `lib/` — SSH pool, node config store, chaos locking, C++/systemd/launchctl/Dockerfile template generation, Nginx upstream rewriting, provisioning job runner, Outpost engine
- `routes/` — one file per API concern, each a factory function `module.exports = function(app) { ... }` mounted directly onto the shared Express app

## Mission Control Dashboard

Static files served by Nginx with **Server Side Includes** assembling the page server-side — `index.html` is a 3KB shell; the actual markup lives in 11 partial files under `partials/`. JavaScript is split into 13 ordered files sharing global scope (equivalent to one file, verified byte-for-byte against the original monolith during the refactor).
