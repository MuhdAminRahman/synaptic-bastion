# Synaptic Bastion

**High Availability Infrastructure for SMEs** — a distributed, self-healing cluster built on commodity hardware and open-source software, with automatic failover at every layer: load balancer, application, and database.

> FYP · Muhammad Amin bin Abd Rahman · B032310892 · UTeM BITS 2025/2026

---

## Architecture

```
                     ┌─────────────────────────┐
                     │   Floating IP (public)   │  ← keepalived VRRP reassigns
                     │   116.203.166.135         │     this on Hetzner 1 failure
                     └───────────┬───────────────┘
                                 │
                  ┌──────────────┴──────────────┐
                  │     Nginx Load Balancer       │  (Hetzner 1 primary,
                  │   weighted round-robin         │   Hetzner 2 standby)
                  └──────────────┬──────────────┘
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│   Hetzner 1    │      │   Hetzner 2    │      │   Hetzner 3    │
│  C++ App       │      │  C++ App       │      │  C++ App       │
│  PostgreSQL    │◄────►│  PostgreSQL    │◄────►│  PostgreSQL    │
│  (Patroni)     │      │  (Patroni)     │      │  (Patroni)     │
└───────┬───────┘      └───────┬───────┘      └───────┬───────┘
        └────────────────────────┼────────────────────────┘
                                 │
                     ┌───────────┴───────────┐
                     │   etcd (3-node quorum)  │  ← Patroni leader election
                     └─────────────────────────┘
```

All nodes communicate over a Tailscale WireGuard mesh. Only ports 22, 80, 443, and 8090 are exposed publicly; PostgreSQL and the internal management API are reachable only inside the mesh.

---

## What makes this "HA" — failure tolerance at every layer

| Layer | Single point of failure? | Mitigation |
|---|---|---|
| Load balancer | Was — Hetzner 1 only | Hetzner Floating IP + keepalived VRRP (~5s reassignment) |
| Application | No | 3 independent app instances, Nginx passive health checks, `systemd` auto-restart |
| Database | Was — manual promotion | **Patroni** + etcd quorum — automatic leader election (~15–25s), zero manual intervention |
| External monitoring | N/A | **Outpost** — quorum-based external uptime monitoring (see below) |

---

## Outpost — Double Check Method

A built-in external website monitor implementing and extending the methodology from:

> Naim, M.H. et al. (2025). *"Double Check Method: An Enhancement of Heartbeat Failure Detection by Fog Devices Through Socket and Port Engagement."* SSRN 5099955.

**Original method:** heartbeat fails → wait + retry (filters transient blips) → raw TCP socket check (distinguishes network outage from app-layer hang) → verdict.

**Extension implemented here:** the socket check runs from **every node in the cluster independently** (not a single fog device), and a verdict requires quorum agreement — reducing false positives caused by one node's own localized network path rather than the target's actual state.

---

## Mission Control Dashboard

Single-page operations dashboard with a military command sidebar:

| Group | Pages |
|---|---|
| **HQ** | Situation Room (live monitor) · Garrison (per-node metrics) · Enlistment (automated provisioning) |
| **WAR ROOM** | Drills (13-test failure-injection suite) · Siege Trial (uncapped load testing) |
| **SUPPLY LINE** | Convoy Watch (Patroni + replication status, dual chaos modes) |
| **FRONTIER** | Outpost (external monitoring) |

- 6 selectable color themes (3 game-inspired, 3 real-military-inspired) + adjustable text scale, persisted via `localStorage`
- Fully automated node provisioning: SSH key deployment → dependency install → Tailscale join → C++ compile → systemd setup → PostgreSQL/Patroni configuration → Nginx registration (11 steps, ~3 minutes)
- Live proof-of-failover: direct pass-through links to each node's raw `/health` response for side-by-side verification during chaos demos

---

## Automated Test Suite (13 tests)

| # | Test | Validates |
|---|---|---|
| T1 | Single Node Offline | LB redistribution |
| T2 | Patroni Leader Failure | Automatic DB failover + read continuity during election |
| T3 | Two Nodes Offline | Single-node survival at reduced capacity |
| T4 | Process Crash (all nodes) | systemd/launchctl auto-restart |
| T5 | Health Endpoint | Response shape validation |
| T6 | PostgreSQL /data Endpoint | Live DB connectivity, replica readability |
| T7 | LB Distribution | Round-robin across all backends |
| T8 | Latency | p50/p95 vs target |
| T9 | Throughput | Uncapped stress test vs target |
| T10 | RTO | App-level detect + recovery timing |
| T11 | Replication Lag | Live `pg_stat_replication` check vs target |
| T12 | Outpost Validation | Double Check pipeline correctly classifies known-good/known-bad targets |
| T13 | Floating IP Reachability | Public LB entry point sanity check |

---

## Measured Results

| Metric | Target | Result |
|---|---|---|
| RTO (app-level) | <5s | ~2.5–4s (post `RestartSec` tuning) |
| RPO | 0s | ✓ 0s — 2 live replicas |
| DB Failover (Patroni) | <30s | ~15–25s, fully automatic |
| Failure Detection | ≤5s | ~1–2s |
| Auto-Recovery | 100% | ✓ 100% |
| Latency p50 / p95 | ≤180ms / ≤250ms | ~7–30ms (Tailscale mesh) |
| Throughput | ≥1000 req/s | ~1300–2000 req/s @ 80 concurrency (uncapped) |
| Replication Lag | <50ms | <1ms (same-DC) |
| LB Failover (Floating IP) | — | ~5s reassignment (keepalived VRRP) |

---

## Repository Structure

```
synaptic-bastion/
├── mission-control/
│   ├── index.html              # thin shell — Nginx SSI assembles the rest
│   ├── styles.css
│   ├── favicon.svg
│   ├── partials/                # 11 SSI-included HTML fragments
│   └── js/                      # 13 ordered script files (shared global scope)
├── proxy/                       # Node.js/Express management API
│   ├── index.js
│   ├── config.js
│   ├── package.json
│   ├── nodes.json.example
│   ├── outposts.json.example
│   ├── lib/                     # ssh, nodes-store, chaos-lock, templates,
│   │                             # nginx, provisioning, outpost-engine
│   └── routes/                  # one file per API concern (10 files)
├── nginx/
│   ├── ha-upstream.conf         # LB config, auto-rewritten by the proxy
│   └── mission-control.conf     # dashboard + SSI + /proxy/ relay
├── keepalived/
│   ├── keepalived.conf.hetzner1 # MASTER
│   ├── keepalived.conf.hetzner2 # BACKUP
│   ├── failover.sh
│   ├── reclaim.sh
│   └── promote.sh
├── patroni/
│   └── config.yml.example
├── docs/
│   ├── architecture.md
│   └── deployment.md
├── .gitignore
├── LICENSE
└── README.md
```

---

## Security

- PostgreSQL bound to `localhost` + Tailscale IP only — never public
- Proxy management API (port 9000) reachable only via the `/proxy/` relay or the Tailscale mesh
- UFW firewall — only 22/80/443/8090 public
- `/api/node/:name/live` is the only intentionally unauthenticated endpoint (read-only health pass-through, used for live failover demos)
- Auth token required on all other proxy endpoints

> **Note:** the dashboard's bearer token is shipped client-side (acceptable for this FYP's demo scope, where the dashboard itself is the trust boundary). A production deployment would need session-based auth instead.

---

## License

MIT
