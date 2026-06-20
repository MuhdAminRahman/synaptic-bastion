# Deployment Guide

## Prerequisites

- 3+ Linux VMs (tested on Ubuntu 22.04/24.04/26.04) with Tailscale
- Node.js ≥ 18, Nginx with the `http_ssi_module` (default-compiled in standard builds)
- PostgreSQL 18, Patroni, etcd 3.5.x
- A Hetzner Cloud account + API token (if using the Floating IP failover)

## 1 — Initial Node Provisioning

Provisioning is fully automated via the Mission Control dashboard (Cluster → Enlistment page). For each node you only need:
- Public IP + root password (first run only — the dashboard deploys its own SSH key and switches to key auth automatically)
- Desired role (`app`, `load-balancer`) and DB role (`master`/`replica` — only matters for the very first node; Patroni takes over after that)

The 11-step wizard handles: SSH key deployment, OS detection, dependency install, Tailscale join (shows you the auth URL — one manual click required), C++ source deployment + compile, systemd service setup, PostgreSQL install/config, health check, and Nginx registration.

## 2 — etcd Cluster

```bash
# On each node — install etcd (not packaged for newer Ubuntu, install the binary directly)
ETCD_VER=v3.5.13
curl -sL https://github.com/etcd-io/etcd/releases/download/${ETCD_VER}/etcd-${ETCD_VER}-linux-amd64.tar.gz | tar xz -C /tmp
cp /tmp/etcd-${ETCD_VER}-linux-amd64/etcd* /usr/local/bin/
```

Configure `/etc/etcd.env` and `/etc/systemd/system/etcd.service` on each node with matching `ETCD_INITIAL_CLUSTER` listing all 3 Tailscale IPs, then start all 3 **simultaneously** (they must see each other within ~10s to form quorum on first boot).

```bash
systemctl daemon-reload && systemctl enable etcd && systemctl start etcd
# Verify
ETCDCTL_API=3 etcdctl --endpoints=http://NODE1:2379,http://NODE2:2379,http://NODE3:2379 member list
```

## 3 — Patroni

Install via `apt install patroni python3-psycopg2`. On Ubuntu versions where `etcd3:` support isn't pulled in via apt, the pure-Python `patroni.dcs.etcd3` module works without any extra native dependency — confirm with:

```bash
python3 -c "import patroni.dcs.etcd3; print('ok')"
```

Each node needs `/etc/patroni/config.yml` with matching `scope`, the 3 etcd endpoints, and **its own** `name`/`restapi.listen`/`postgresql.connect_address`. Critical gotchas learned during deployment:

- `postgresql.conf`, `pg_hba.conf`, and `pg_ident.conf` must exist **inside the data directory** (`/var/lib/postgresql/18/main/`), not just `/etc/postgresql/18/main/` — Patroni manages config from the data directory directly
- Add `local all postgres peer` as the **first** line of `pg_hba.conf` so you can set the `postgres` superuser password locally before Patroni takes over
- **Every** node's `pg_hba.conf` needs `host replication appuser 100.0.0.0/8 scram-sha-256` — not just the original master's. Leadership moves; whichever node becomes primary next must already accept replica connections

Start Patroni on what will become your first leader, verify with `patronictl -c /etc/patroni/config.yml list`, then start it on the remaining nodes — they'll join as replicas automatically.

## 4 — Floating IP (optional, eliminates the LB single point of failure)

```bash
# Hetzner Cloud panel → Floating IPs → Create → assign to your primary LB node
cat > /etc/netplan/60-floating-ip.yaml << 'EOF'
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - YOUR_FLOATING_IP/32
EOF
chmod 600 /etc/netplan/60-floating-ip.yaml
netplan apply
```

Install `keepalived` on the primary (MASTER, priority 110) and standby (BACKUP, priority 100) LB nodes — see `keepalived/` in this repo for the config templates and failover/reclaim scripts. The scripts call the Hetzner Cloud API directly; you'll need an API token with read/write access to Floating IPs.

## 5 — Nginx

```bash
cp nginx/ha-upstream.conf /etc/nginx/conf.d/
cp nginx/mission-control.conf /etc/nginx/conf.d/
# Remove the default site to avoid a duplicate default_server conflict
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

`mission-control.conf` requires `ssi on;` and a dedicated `location /partials/ { try_files $uri =404; }` block — **without the dedicated location**, a failed SSI subrequest falls back to `try_files`'s `/index.html` rule, which recursively re-serves the shell (which contains more includes) and can balloon a 51KB page into megabytes. This is a known gotcha, not a hypothetical — it happened during development and is documented here so it doesn't happen again.

Also verify `/var/www/mission-control/partials/` and `/js/` are **world-readable** (`chmod 755` on the directories, `644` on the files) — Nginx's worker process runs as `www-data`, not root, and silently 404s on permission-denied files in a way that's easy to misdiagnose as a routing bug.

## 6 — Proxy (Management API)

```bash
cd proxy
npm install
cp nodes.json.example nodes.json    # edit with your real node IPs
cp outposts.json.example outposts.json
node index.js   # or set up the systemd unit, RestartSec=2
```

## 7 — Mission Control Dashboard

```bash
cp -r mission-control/* /var/www/mission-control/
chmod 755 /var/www/mission-control/partials /var/www/mission-control/js
chmod 644 /var/www/mission-control/partials/* /var/www/mission-control/js/*
```

Open `http://<floating-ip-or-node-ip>:8090` — auto-connects on load.

## Common Pitfalls (encountered and fixed during this build)

| Symptom | Cause | Fix |
|---|---|---|
| Health check always 200 even with DB down | Probing the cached pooled connection, not a fresh one | Use a fresh `pqxx::connection` with short `connect_timeout` per health check |
| Health check probes wrong DB | Using the configured `dbHost` (master) instead of `localhost` | Health checks must always probe the **local** PostgreSQL instance |
| 11 includes → 3MB page | Recursive `try_files` fallback on failed SSI subrequest | Dedicated `location /partials/` with `try_files $uri =404;` |
| Partials 404 despite correct Nginx config | Directory permissions `700` (root-only) from `scp -r` | `chmod 755` dirs, `644` files |
| RTO test passing inconsistently around 10s+ | Live `RestartSec=10` on one node, drifted from the `RestartSec=2` in the provisioning template | Always verify the **deployed** unit file matches the template, not just the template itself |
| `ReferenceError: crypto is not defined` after modularizing the proxy | Missed a Node built-in module import during the lib/routes split | Audit for missing built-ins separately from custom function imports — they're easy to miss since they don't appear as "undefined identifiers" in casual review |
